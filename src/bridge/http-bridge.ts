import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuthService } from '../core/auth-service.js';
import type { BoardService } from '../core/board-service.js';
import type { ChatService } from '../core/chat-service.js';
import type { Clock } from '../core/clock.js';
import { ServiceError, toServiceError } from '../core/errors.js';
import type { FocusService } from '../core/focus-service.js';
import type { GuestbookService } from '../core/guestbook-service.js';
import type {
  AuthenticatedIntegrationContext,
  IntegrationAuthService,
  IntegrationScope,
} from '../core/integration-auth-service.js';
import type { NoticePublicationState, NoticeService } from '../core/notice-service.js';
import type { PresenceService, SessionChannel } from '../core/presence-service.js';
import type { ProfileService } from '../core/profile-service.js';
import type { RealtimeEventType, RealtimeHub } from '../core/realtime-hub.js';
import type {
  ParticipationMode,
  RecruitmentService,
  RecruitmentState,
  RecruitmentType,
} from '../core/recruitment-service.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { PUBLIC_SPACES } from '../tui/world-map.js';

export interface AccountLifecycleHooks {
  recoverAccount(input: {
    loginId: string;
    recoveryCode: string;
    newPassword: string;
    ipAddress?: string;
  }): unknown;
  changePassword(input: {
    memberId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionId?: string;
  }): unknown;
  reissueRecoveryCode(input: {
    memberId: string;
    currentPassword: string;
  }): unknown;
  withdrawAccount(input: {
    memberId: string;
    password: string;
    confirm: boolean;
  }): unknown;
}

export type ModerationTargetKind = 'post' | 'comment' | 'guestbook' | 'chat';

export interface ModerationHooks {
  createReport(input: {
    reporterMemberId: string;
    targetKind: ModerationTargetKind;
    targetId: string;
    reason: string;
  }): unknown;
  listMyReports(memberId: string): unknown;
  listReportsForAdmin(adminMemberId: string, state?: string): unknown;
  reviewReport(input: {
    adminMemberId: string;
    reportId: string;
    outcome: 'deleted' | 'no_action';
    resolutionReason: string;
  }): unknown;
  adminDeleteContent(input: {
    adminMemberId: string;
    targetKind: ModerationTargetKind;
    targetId: string;
    reason: string;
  }): unknown;
  listDeletionHistory(adminMemberId: string): unknown;
}

export interface RetentionHooks {
  createDailyBackup(backupDir?: string): unknown;
  restoreFromBackup?(backupPath: string, targetDataDir?: string): unknown;
}

export interface DiscoveryHooks {
  listPopularRepos(filter?: {
    language?: string;
    topic?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown> | unknown;
  searchContributionIssues(filter?: {
    language?: string;
    topic?: string;
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<unknown> | unknown;
  getIssueDetail(issueId: string): Promise<unknown> | unknown;
  explainIssue(issueId: string): Promise<unknown> | unknown;
}

export interface HttpBridgeOptions {
  host?: string;
  port?: number;
  worldDb: WorldDatabase;
  clock: Clock;
  authService: AuthService;
  integrationAuthService: IntegrationAuthService;
  profileService: ProfileService;
  guestbookService: GuestbookService;
  boardService: BoardService;
  recruitmentService: RecruitmentService;
  noticeService: NoticeService;
  presenceService: PresenceService;
  chatService: ChatService;
  focusService: FocusService;
  realtimeHub: RealtimeHub;
  accountLifecycle?: AccountLifecycleHooks;
  moderation?: ModerationHooks;
  retention?: RetentionHooks;
  discovery?: DiscoveryHooks;
  onError?: (error: unknown) => void;
}

export interface RunningHttpBridge {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface BridgeResponseMeta {
  cursor?: string | null;
  hasMore?: boolean;
  checkedAt?: string;
  [key: string]: unknown;
}

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const ALL_REALTIME_EVENTS: readonly RealtimeEventType[] = [
  'presence.changed',
  'avatar.moved',
  'chat.message',
  'chat.deleted',
  'focus.changed',
  'session.ended',
];

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendOk(
  res: ServerResponse,
  data: unknown,
  meta: BridgeResponseMeta = {},
  statusCode = 200,
): void {
  sendJson(res, statusCode, { ok: true, data, meta });
}

function sendError(res: ServerResponse, error: unknown): void {
  const err = toServiceError(error);
  sendJson(res, err.httpStatus, { ok: false, error: err.toJSON() });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new ServiceError('INVALID_INPUT', '요청 본문이 너무 큽니다 (최대 1MB).');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ServiceError('INVALID_INPUT', '요청 본문은 JSON 객체여야 해요.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INVALID_INPUT', '올바른 JSON 형식이 아니에요.');
  }
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match ? match[1]!.trim() : null;
}

function extractIdempotencyKey(req: IncomingMessage, body: Record<string, unknown>): string | undefined {
  const header = req.headers['idempotency-key'];
  if (typeof header === 'string' && header.trim()) {
    return header.trim();
  }
  if (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()) {
    return body.idempotencyKey.trim();
  }
  return undefined;
}

function parseOptionalLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new ServiceError('INVALID_INPUT', 'limit은 정수여야 해요.', 'limit');
  }
  return num;
}

function parseOptionalBool(raw: string | null): boolean | undefined {
  if (raw === null || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ServiceError('INVALID_INPUT', '불리언 값이 올바르지 않아요.');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ServiceError('INVALID_INPUT', `${field} 값을 입력해 주세요.`, field);
  }
  return value;
}

function requireHook<T>(hook: T | undefined, name: string): T {
  if (!hook) {
    throw new ServiceError('EXTERNAL_UNAVAILABLE', `${name} 서비스가 아직 연결되지 않았어요.`);
  }
  return hook;
}

export async function startHttpBridgeServer(options: HttpBridgeOptions): Promise<RunningHttpBridge> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 4310;
  const activeSseResponses = new Set<{ close: () => void }>();

  const requireAuth = (req: IncomingMessage, requiredScopes: readonly IntegrationScope[] = []): AuthenticatedIntegrationContext => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ServiceError('UNAUTHORIZED', 'Bearer 인증 토큰이 필요해요.');
    }
    return options.integrationAuthService.authenticateAccessToken(token, requiredScopes);
  };

  const optionalAuth = (req: IncomingMessage): AuthenticatedIntegrationContext | null => {
    const token = extractBearerToken(req);
    if (!token) return null;
    return options.integrationAuthService.authenticateAccessToken(token, []);
  };

  const runWrite = <T>(
    req: IncomingMessage,
    body: Record<string, unknown>,
    operation: string,
    requiredScopes: readonly IntegrationScope[],
    fn: (auth: AuthenticatedIntegrationContext) => T,
  ): T => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ServiceError('UNAUTHORIZED', 'Bearer 인증 토큰이 필요해요.');
    }
    const idempotencyKey = extractIdempotencyKey(req, body);
    const { idempotencyKey: _ignored, ...payloadForHash } = body;
    return options.integrationAuthService.executeAuthorizedWrite({
      token,
      requiredScopes,
      operation,
      idempotencyKey,
      requestPayload: payloadForHash,
      fn,
    });
  };

  const handleSseStream = (
    req: IncomingMessage,
    res: ServerResponse,
    eventTypes: readonly RealtimeEventType[],
  ) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(`: connected ${options.clock.now().toISOString()}\n\n`);

    const unsubscribe = options.realtimeHub.subscribeMany(eventTypes, event => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': ping\n\n');
      }
    }, 15_000);
    keepAlive.unref();

    const cleanup = () => {
      activeSseResponses.delete(handle);
      clearInterval(keepAlive);
      unsubscribe();
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    };
    const handle = { close: cleanup };
    activeSseResponses.add(handle);

    req.on('close', cleanup);
    res.on('close', cleanup);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${requestedPort}`}`);
    const pathname = url.pathname;
    const segments = pathname.split('/').filter(Boolean).map(seg => decodeURIComponent(seg));
    const checkedAt = options.clock.now().toISOString();

    // --- Health ---
    if (method === 'GET' && pathname === '/health') {
      sendOk(res, { status: 'ok', time: checkedAt }, { checkedAt });
      return;
    }

    // --- SSE Streams ---
    if (method === 'GET' && pathname === '/chat/stream') {
      handleSseStream(req, res, ['chat.message', 'chat.deleted']);
      return;
    }
    if (method === 'GET' && pathname === '/events/stream') {
      const rawTypes = url.searchParams.get('types');
      const requested = rawTypes
        ? rawTypes.split(',').map(s => s.trim()).filter((s): s is RealtimeEventType =>
            (ALL_REALTIME_EVENTS as readonly string[]).includes(s),
          )
        : ALL_REALTIME_EVENTS;
      handleSseStream(req, res, requested.length > 0 ? requested : ALL_REALTIME_EVENTS);
      return;
    }

    // --- Auth ---
    if (method === 'POST' && pathname === '/auth/signup') {
      const body = await readJsonBody(req);
      const result = options.authService.signup({
        loginId: String(body.loginId ?? ''),
        nickname: String(body.nickname ?? ''),
        password: String(body.password ?? ''),
        ipAddress: req.socket.remoteAddress,
      });
      sendOk(res, result, { checkedAt }, 201);
      return;
    }

    if (method === 'POST' && pathname === '/auth/login') {
      const body = await readJsonBody(req);
      const result = options.authService.login({
        loginId: String(body.loginId ?? ''),
        password: String(body.password ?? ''),
        ipAddress: req.socket.remoteAddress,
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && (pathname === '/auth/device-code' || pathname === '/auth/approval/start')) {
      const body = await readJsonBody(req);
      const result = options.integrationAuthService.startApproval({
        channel: (body.channel ?? 'cli') as 'cli' | 'mcp',
        scopes: (body.scopes ?? ['read', 'write']) as ('read' | 'write' | 'admin')[],
        requestedTtlSec: typeof body.requestedTtlSec === 'number' ? body.requestedTtlSec : undefined,
        clientLabel: String(body.clientLabel ?? 'terminal-world-client'),
      });
      sendOk(res, result, { checkedAt }, 201);
      return;
    }

    if (method === 'GET' && segments[0] === 'auth' && segments[1] === 'approval' && segments[2]) {
      const status = options.integrationAuthService.getApprovalStatus(segments[2]);
      sendOk(res, status, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/approve') {
      const body = await readJsonBody(req);
      const result = options.integrationAuthService.approveCode({
        code: String(body.code ?? ''),
        loginId: String(body.loginId ?? ''),
        password: String(body.password ?? ''),
        ttlSec: typeof body.ttlSec === 'number' ? body.ttlSec : undefined,
        ipAddress: req.socket.remoteAddress,
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/deny') {
      const body = await readJsonBody(req);
      const result = options.integrationAuthService.denyCode({
        code: String(body.code ?? ''),
        loginId: typeof body.loginId === 'string' ? body.loginId : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
        ipAddress: req.socket.remoteAddress,
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && (pathname === '/auth/token' || pathname === '/auth/approval/exchange')) {
      const body = await readJsonBody(req);
      const result = options.integrationAuthService.exchangeApprovalCode(
        String(body.code ?? body.deviceCode ?? ''),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/refresh') {
      const body = await readJsonBody(req);
      const result = options.integrationAuthService.refreshTokens(String(body.refreshToken ?? ''));
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/auth/grants') {
      const auth = requireAuth(req, []);
      const grants = options.integrationAuthService.listGrants(auth.member.id);
      sendOk(res, { items: grants, currentGrantId: auth.grant.id }, { checkedAt });
      return;
    }

    if (
      (method === 'DELETE' && segments[0] === 'auth' && segments[1] === 'grants' && segments[2] && segments.length === 3)
      || (method === 'POST' && segments[0] === 'auth' && segments[1] === 'grants' && segments[2] && segments[3] === 'revoke')
    ) {
      const body = method === 'POST' ? await readJsonBody(req) : {};
      const reason = typeof body.reason === 'string' ? body.reason : 'user_revoked';
      const revoked = runWrite(req, body, 'auth.revokeGrant', [], auth =>
        options.integrationAuthService.revokeGrant(auth.member.id, segments[2], reason),
      );
      sendOk(res, revoked, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/change-password') {
      const body = await readJsonBody(req);
      const lifecycle = requireHook(options.accountLifecycle, 'AccountLifecycle');
      const result = runWrite(req, body, 'auth.changePassword', ['write'], auth =>
        lifecycle.changePassword({
          memberId: auth.member.id,
          currentPassword: requireString(body.currentPassword, 'currentPassword'),
          newPassword: requireString(body.newPassword, 'newPassword'),
          currentSessionId: typeof body.currentSessionId === 'string' ? body.currentSessionId : undefined,
        }),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/recover') {
      const body = await readJsonBody(req);
      const lifecycle = requireHook(options.accountLifecycle, 'AccountLifecycle');
      const result = lifecycle.recoverAccount({
        loginId: requireString(body.loginId, 'loginId'),
        recoveryCode: requireString(body.recoveryCode, 'recoveryCode'),
        newPassword: requireString(body.newPassword, 'newPassword'),
        ipAddress: req.socket.remoteAddress,
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/recovery-code/reissue') {
      const body = await readJsonBody(req);
      const lifecycle = requireHook(options.accountLifecycle, 'AccountLifecycle');
      const result = runWrite(req, body, 'auth.reissueRecoveryCode', ['write'], auth =>
        lifecycle.reissueRecoveryCode({
          memberId: auth.member.id,
          currentPassword: requireString(body.currentPassword, 'currentPassword'),
        }),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/auth/withdraw') {
      const body = await readJsonBody(req);
      const lifecycle = requireHook(options.accountLifecycle, 'AccountLifecycle');
      const result = runWrite(req, body, 'auth.withdraw', ['write'], auth =>
        lifecycle.withdrawAccount({
          memberId: auth.member.id,
          password: requireString(body.password, 'password'),
          confirm: body.confirm === true,
        }),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    // --- World / Sessions ---
    if (method === 'GET' && pathname === '/world/spaces') {
      const personalSpaces = options.profileService.listPublicPersonalSpaces();
      sendOk(res, {
        publicSpaces: PUBLIC_SPACES,
        personalSpaces,
      }, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/world/lobby') {
      const presence = options.presenceService.getLobbyOverview();
      const notices = options.noticeService.listNotices({ includeEnded: false, limit: 20 });
      sendOk(res, {
        presence,
        notices: notices.items,
      }, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/world/presence') {
      const presence = options.presenceService.getLobbyOverview();
      sendOk(res, presence, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/sessions') {
      const body = await readJsonBody(req);
      const auth = optionalAuth(req);
      const session = options.presenceService.openSession({
        memberId: auth?.member.id ?? null,
        isGuest: !auth,
        channel: (typeof body.channel === 'string' ? body.channel : 'cli') as SessionChannel,
        spaceId: typeof body.spaceId === 'string' ? body.spaceId : undefined,
        worldX: typeof body.worldX === 'number' ? body.worldX : undefined,
        worldY: typeof body.worldY === 'number' ? body.worldY : undefined,
      });
      sendOk(res, session, { checkedAt }, 201);
      return;
    }

    if (method === 'POST' && segments[0] === 'sessions' && segments[1] && segments[2] === 'enter') {
      const body = await readJsonBody(req);
      const auth = optionalAuth(req);
      const existing = options.presenceService.getSessionById(segments[1]);
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
      }
      if (existing.memberId && (!auth || auth.member.id !== existing.memberId)) {
        throw new ServiceError('FORBIDDEN', '본인의 세션만 이동할 수 있어요.');
      }
      const updated = options.presenceService.moveSpace(
        segments[1],
        requireString(body.spaceId, 'spaceId'),
        {
          worldX: typeof body.worldX === 'number' ? body.worldX : undefined,
          worldY: typeof body.worldY === 'number' ? body.worldY : undefined,
        },
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'sessions' && segments[1] && segments[2] === 'move') {
      const body = await readJsonBody(req);
      const auth = optionalAuth(req);
      const existing = options.presenceService.getSessionById(segments[1]);
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
      }
      if (existing.memberId && (!auth || auth.member.id !== existing.memberId)) {
        throw new ServiceError('FORBIDDEN', '본인의 세션만 이동할 수 있어요.');
      }
      const updated = options.presenceService.moveAvatar(
        segments[1],
        Number(body.worldX),
        Number(body.worldY),
        typeof body.spaceId === 'string' ? body.spaceId : undefined,
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'sessions' && segments[1] && segments[2] === 'heartbeat') {
      const auth = optionalAuth(req);
      const existing = options.presenceService.getSessionById(segments[1]);
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
      }
      if (existing.memberId && (!auth || auth.member.id !== existing.memberId)) {
        throw new ServiceError('FORBIDDEN', '본인의 세션만 갱신할 수 있어요.');
      }
      const updated = options.presenceService.heartbeat(segments[1]);
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'sessions' && segments[1] && segments[2] === 'close') {
      const body = await readJsonBody(req);
      const auth = optionalAuth(req);
      const existing = options.presenceService.getSessionById(segments[1]);
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
      }
      if (existing.memberId && (!auth || auth.member.id !== existing.memberId)) {
        throw new ServiceError('FORBIDDEN', '본인의 세션만 종료할 수 있어요.');
      }
      const mode = body.mode === 'disconnect' ? 'disconnect' : 'normal';
      const closed = options.presenceService.closeSession(segments[1], {
        mode,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      sendOk(res, closed, { checkedAt });
      return;
    }

    // --- Profile ---
    if (method === 'POST' && pathname === '/profiles/me/preview') {
      const body = await readJsonBody(req);
      const auth = requireAuth(req, []);
      const preview = options.profileService.previewProfileUpdate(auth.member.id, body);
      sendOk(res, preview, { checkedAt });
      return;
    }

    if (method === 'PATCH' && pathname === '/profiles/me') {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'profile.update', ['write'], auth =>
        options.profileService.updateProfile(auth.member.id, body),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'GET' && segments[0] === 'profiles' && segments[1] && segments.length === 2) {
      const identifier = segments[1] === 'me'
        ? requireAuth(req, []).member.id
        : segments[1];
      const detail = options.profileService.getPersonalSpaceDetail(identifier);
      sendOk(res, detail, { checkedAt });
      return;
    }

    // --- Guestbook ---
    if (method === 'GET' && pathname === '/guestbook/archived') {
      const items = options.guestbookService.listArchivedEntries();
      sendOk(res, { items }, { checkedAt });
      return;
    }

    if (method === 'GET' && segments[0] === 'guestbook' && segments[1] && segments.length === 2) {
      const items = options.guestbookService.listEntries(segments[1]);
      sendOk(res, { items }, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'guestbook' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'guestbook.create', ['write'], auth =>
        options.guestbookService.createEntry(auth.member.id, segments[1], body.body),
      );
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'PATCH' && segments[0] === 'guestbook' && segments[1] === 'entries' && segments[2]) {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'guestbook.update', ['write'], auth =>
        options.guestbookService.updateEntry(auth.member.id, segments[2], body.body),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'DELETE' && segments[0] === 'guestbook' && segments[1] === 'entries' && segments[2]) {
      const body = await readJsonBody(req);
      const deleted = runWrite(req, body, 'guestbook.delete', ['write'], auth =>
        options.guestbookService.deleteEntry(
          auth.member.id,
          segments[2],
          typeof body.reason === 'string' ? body.reason : undefined,
          { allowAdmin: auth.effectiveScopes.includes('admin') },
        ),
      );
      sendOk(res, deleted, { checkedAt });
      return;
    }

    // --- Boards / Posts / Comments ---
    if (method === 'GET' && pathname === '/boards') {
      const items = options.boardService.listBoards();
      sendOk(res, { items }, { checkedAt });
      return;
    }

    if (method === 'GET' && segments[0] === 'boards' && segments[1] && segments[2] === 'posts') {
      const page = options.boardService.listPosts({
        boardId: segments[1],
        cursor: url.searchParams.get('cursor'),
        limit: parseOptionalLimit(url.searchParams.get('limit')),
      });
      sendOk(res, { items: page.items }, {
        cursor: page.cursor,
        hasMore: page.hasMore,
        checkedAt,
      });
      return;
    }

    if (method === 'POST' && segments[0] === 'boards' && segments[1] && segments[2] === 'posts') {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'board.createPost', ['write'], auth =>
        options.boardService.createPost(auth.member.id, {
          boardId: segments[1],
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
        }),
      );
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'GET' && segments[0] === 'posts' && segments[1] && segments.length === 2) {
      const post = options.boardService.getPost(segments[1]);
      sendOk(res, post, { checkedAt });
      return;
    }

    if (method === 'PATCH' && segments[0] === 'posts' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'board.updatePost', ['write'], auth =>
        options.boardService.updatePost(auth.member.id, segments[1], {
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
        }),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'DELETE' && segments[0] === 'posts' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const deleted = runWrite(req, body, 'board.deletePost', ['write'], auth =>
        options.boardService.deletePost(auth.member.id, segments[1], {
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          allowAdmin: auth.effectiveScopes.includes('admin'),
        }),
      );
      sendOk(res, deleted, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'posts' && segments[1] && segments[2] === 'comments') {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'board.createComment', ['write'], auth =>
        options.boardService.createComment(auth.member.id, {
          postId: segments[1],
          body: String(body.body ?? ''),
        }),
      );
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'PATCH' && segments[0] === 'comments' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'board.updateComment', ['write'], auth =>
        options.boardService.updateComment(auth.member.id, segments[1], {
          body: String(body.body ?? ''),
        }),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'DELETE' && segments[0] === 'comments' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const deleted = runWrite(req, body, 'board.deleteComment', ['write'], auth =>
        options.boardService.deleteComment(auth.member.id, segments[1], {
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          allowAdmin: auth.effectiveScopes.includes('admin'),
        }),
      );
      sendOk(res, deleted, { checkedAt });
      return;
    }

    // --- Recruitment ---
    if (method === 'GET' && pathname === '/recruitments/bookmarks') {
      const auth = requireAuth(req, ['read']);
      const items = options.recruitmentService.listMyBookmarks(auth.member.id);
      sendOk(res, { items }, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/recruitments') {
      const viewer = optionalAuth(req);
      const page = options.recruitmentService.searchRecruitments(
        {
          type: (url.searchParams.get('type') || undefined) as RecruitmentType | undefined,
          role: url.searchParams.get('role') || undefined,
          skill: url.searchParams.get('skill') || undefined,
          mode: (url.searchParams.get('mode') || undefined) as ParticipationMode | undefined,
          state: (url.searchParams.get('state') || undefined) as RecruitmentState | undefined,
          cursor: url.searchParams.get('cursor'),
          limit: parseOptionalLimit(url.searchParams.get('limit')),
        },
        viewer?.member.id,
      );
      sendOk(res, { items: page.items }, {
        cursor: page.cursor,
        hasMore: page.hasMore,
        checkedAt,
      });
      return;
    }

    if (method === 'POST' && pathname === '/recruitments') {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'recruitment.create', ['write'], auth =>
        options.recruitmentService.createRecruitment(auth.member.id, {
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
          recruitmentType: body.recruitmentType as RecruitmentType,
          progressNote: String(body.progressNote ?? ''),
          roles: Array.isArray(body.roles) ? body.roles.map(String) : [],
          requiredSkills: Array.isArray(body.requiredSkills) ? body.requiredSkills.map(String) : undefined,
          noSkillRequired: body.noSkillRequired === true,
          participationPeriod: String(body.participationPeriod ?? ''),
          weeklyTime: String(body.weeklyTime ?? ''),
          participationMode: body.participationMode as ParticipationMode,
          region: typeof body.region === 'string' ? body.region : undefined,
          contactMethod: String(body.contactMethod ?? ''),
          deadlineAt: String(body.deadlineAt ?? ''),
          ackPublic: body.ackPublic === true,
        }),
      );
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'GET' && segments[0] === 'recruitments' && segments[1] && segments.length === 2) {
      const viewer = optionalAuth(req);
      const item = options.recruitmentService.getRecruitment(segments[1], viewer?.member.id);
      sendOk(res, item, { checkedAt });
      return;
    }

    if (method === 'PATCH' && segments[0] === 'recruitments' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'recruitment.update', ['write'], auth =>
        options.recruitmentService.updateRecruitment(auth.member.id, segments[1], {
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
          recruitmentType: typeof body.recruitmentType === 'string' ? body.recruitmentType as RecruitmentType : undefined,
          progressNote: typeof body.progressNote === 'string' ? body.progressNote : undefined,
          roles: Array.isArray(body.roles) ? body.roles.map(String) : undefined,
          requiredSkills: Array.isArray(body.requiredSkills) ? body.requiredSkills.map(String) : undefined,
          noSkillRequired: typeof body.noSkillRequired === 'boolean' ? body.noSkillRequired : undefined,
          participationPeriod: typeof body.participationPeriod === 'string' ? body.participationPeriod : undefined,
          weeklyTime: typeof body.weeklyTime === 'string' ? body.weeklyTime : undefined,
          participationMode: typeof body.participationMode === 'string' ? body.participationMode as ParticipationMode : undefined,
          region: typeof body.region === 'string' ? body.region : undefined,
          contactMethod: typeof body.contactMethod === 'string' ? body.contactMethod : undefined,
          deadlineAt: typeof body.deadlineAt === 'string' ? body.deadlineAt : undefined,
        }),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'recruitments' && segments[1] && segments[2] === 'close') {
      const body = await readJsonBody(req);
      const closed = runWrite(req, body, 'recruitment.close', ['write'], auth =>
        options.recruitmentService.closeRecruitment(auth.member.id, segments[1]),
      );
      sendOk(res, closed, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'recruitments' && segments[1] && segments[2] === 'bookmark') {
      const body = await readJsonBody(req);
      const saved = body.saved !== false;
      const result = runWrite(req, body, 'recruitment.bookmark', ['write'], auth =>
        options.recruitmentService.setBookmark(auth.member.id, segments[1], saved),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    // --- Notices ---
    if (method === 'GET' && pathname === '/notices') {
      const page = options.noticeService.listNotices({
        includeEnded: parseOptionalBool(url.searchParams.get('includeEnded')),
        state: (url.searchParams.get('state') || undefined) as NoticePublicationState | undefined,
        cursor: url.searchParams.get('cursor'),
        limit: parseOptionalLimit(url.searchParams.get('limit')),
      });
      sendOk(res, { items: page.items }, {
        cursor: page.cursor,
        hasMore: page.hasMore,
        checkedAt,
      });
      return;
    }

    if (method === 'GET' && segments[0] === 'notices' && segments[1] && segments.length === 2) {
      const notice = options.noticeService.getNotice(segments[1]);
      sendOk(res, notice, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/notices') {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'notice.create', ['write', 'admin'], auth =>
        options.noticeService.createNotice(auth.member.id, {
          title: String(body.title ?? ''),
          body: String(body.body ?? ''),
        }),
      );
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'PATCH' && segments[0] === 'notices' && segments[1] && segments.length === 2) {
      const body = await readJsonBody(req);
      const updated = runWrite(req, body, 'notice.update', ['write', 'admin'], auth =>
        options.noticeService.updateNotice(auth.member.id, segments[1], {
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
        }),
      );
      sendOk(res, updated, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'notices' && segments[1] && segments[2] === 'end') {
      const body = await readJsonBody(req);
      const ended = runWrite(req, body, 'notice.end', ['write', 'admin'], auth =>
        options.noticeService.endNotice(auth.member.id, segments[1]),
      );
      sendOk(res, ended, { checkedAt });
      return;
    }

    // --- Chat ---
    if (method === 'GET' && pathname === '/chat/messages') {
      const limit = parseOptionalLimit(url.searchParams.get('limit'));
      const items = options.chatService.listRecentMessages({ limit });
      sendOk(res, { items }, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/chat/messages') {
      const body = await readJsonBody(req);
      const sent = runWrite(req, body, 'chat.send', ['write'], auth =>
        options.chatService.sendMessage({
          memberId: auth.member.id,
          body: String(body.body ?? body.text ?? ''),
          roomId: typeof body.roomId === 'string' ? body.roomId : undefined,
        }),
      );
      sendOk(res, sent, { checkedAt }, 201);
      return;
    }

    if (method === 'DELETE' && segments[0] === 'chat' && segments[1] === 'messages' && segments[2]) {
      const body = await readJsonBody(req);
      const deleted = runWrite(req, body, 'chat.delete', ['write', 'admin'], auth =>
        options.chatService.deleteMessage(
          auth.member.id,
          segments[2],
          typeof body.reason === 'string' ? body.reason : undefined,
        ),
      );
      sendOk(res, deleted, { checkedAt });
      return;
    }

    // --- Focus ---
    if (method === 'GET' && pathname === '/focus/status') {
      const auth = requireAuth(req, ['read']);
      const status = options.focusService.getFocusStatus(auth.member.id);
      sendOk(res, status, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/focus/start') {
      const body = await readJsonBody(req);
      const result = runWrite(req, body, 'focus.start', ['write'], auth => {
        let sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        let openedSession = null;
        if (!sessionId) {
          openedSession = options.presenceService.openSession({
            memberId: auth.member.id,
            channel: (typeof body.channel === 'string' ? body.channel : 'cli') as SessionChannel,
            spaceId: 'space:focus',
          });
          sessionId = openedSession.id;
        }
        const focus = options.focusService.startFocus(auth.member.id, sessionId);
        return { focus, session: openedSession };
      });
      sendOk(res, result, { checkedAt }, 201);
      return;
    }

    if (method === 'POST' && pathname === '/focus/stop') {
      const body = await readJsonBody(req);
      const stopped = runWrite(req, body, 'focus.stop', ['write'], auth =>
        options.focusService.stopFocus(auth.member.id),
      );
      sendOk(res, stopped, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/focus/history') {
      const auth = requireAuth(req, ['read']);
      const targetMemberId = url.searchParams.get('memberId') ?? auth.member.id;
      const limit = parseOptionalLimit(url.searchParams.get('limit'));
      const history = options.focusService.getFocusHistory(auth.member.id, targetMemberId, { limit });
      sendOk(res, history, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/focus/ranking') {
      const date = url.searchParams.get('date') || undefined;
      const items = options.focusService.getDailyRanking(date);
      sendOk(res, { items }, { checkedAt });
      return;
    }

    // --- Reports & Admin ---
    if (method === 'POST' && pathname === '/reports') {
      const body = await readJsonBody(req);
      const created = runWrite(req, body, 'report.create', ['write'], auth => {
        const moderation = requireHook(options.moderation, 'Moderation');
        return moderation.createReport({
          reporterMemberId: auth.member.id,
          targetKind: requireString(body.targetKind, 'targetKind') as ModerationTargetKind,
          targetId: requireString(body.targetId, 'targetId'),
          reason: requireString(body.reason, 'reason'),
        });
      });
      sendOk(res, created, { checkedAt }, 201);
      return;
    }

    if (method === 'GET' && pathname === '/reports/mine') {
      const auth = requireAuth(req, ['read']);
      const moderation = requireHook(options.moderation, 'Moderation');
      const items = moderation.listMyReports(auth.member.id);
      sendOk(res, Array.isArray(items) ? { items } : items, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/admin/reports') {
      const auth = requireAuth(req, ['admin']);
      const moderation = requireHook(options.moderation, 'Moderation');
      const state = url.searchParams.get('state') || undefined;
      const items = moderation.listReportsForAdmin(auth.member.id, state);
      sendOk(res, Array.isArray(items) ? { items } : items, { checkedAt });
      return;
    }

    if (method === 'POST' && segments[0] === 'admin' && segments[1] === 'reports' && segments[2] && segments[3] === 'review') {
      const body = await readJsonBody(req);
      const result = runWrite(req, body, 'admin.reviewReport', ['write', 'admin'], auth => {
        const moderation = requireHook(options.moderation, 'Moderation');
        return moderation.reviewReport({
          adminMemberId: auth.member.id,
          reportId: segments[2],
          outcome: requireString(body.outcome, 'outcome') as 'deleted' | 'no_action',
          resolutionReason: requireString(body.resolutionReason ?? body.reason, 'resolutionReason'),
        });
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/admin/deletions') {
      const auth = requireAuth(req, ['admin']);
      const moderation = requireHook(options.moderation, 'Moderation');
      const items = moderation.listDeletionHistory(auth.member.id);
      sendOk(res, Array.isArray(items) ? { items } : items, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/admin/delete') {
      const body = await readJsonBody(req);
      const result = runWrite(req, body, 'admin.deleteContent', ['write', 'admin'], auth => {
        const targetKind = requireString(body.targetKind, 'targetKind') as ModerationTargetKind;
        const targetId = requireString(body.targetId, 'targetId');
        const reason = requireString(body.reason, 'reason');
        if (options.moderation) {
          return options.moderation.adminDeleteContent({
            adminMemberId: auth.member.id,
            targetKind,
            targetId,
            reason,
          });
        }
        switch (targetKind) {
          case 'post':
            return options.boardService.deletePost(auth.member.id, targetId, { reason });
          case 'comment':
            return options.boardService.deleteComment(auth.member.id, targetId, { reason });
          case 'guestbook':
            return options.guestbookService.deleteEntry(auth.member.id, targetId, reason);
          case 'chat':
            return options.chatService.deleteMessage(auth.member.id, targetId, reason);
        }
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'POST' && pathname === '/admin/backup') {
      const body = await readJsonBody(req);
      const retention = requireHook(options.retention, 'Retention');
      const result = runWrite(req, body, 'admin.backup', ['admin'], () =>
        retention.createDailyBackup(
          typeof body.backupDir === 'string' ? body.backupDir : undefined,
        ),
      );
      sendOk(res, result, { checkedAt });
      return;
    }

    // --- OSS Discovery ---
    if (method === 'GET' && pathname === '/oss/popular') {
      const discovery = requireHook(options.discovery, 'Discovery');
      const result = await discovery.listPopularRepos({
        language: url.searchParams.get('language') ?? url.searchParams.get('lang') ?? undefined,
        topic: url.searchParams.get('topic') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: parseOptionalLimit(url.searchParams.get('limit')),
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/oss/issues') {
      const discovery = requireHook(options.discovery, 'Discovery');
      const result = await discovery.searchContributionIssues({
        language: url.searchParams.get('language') ?? url.searchParams.get('lang') ?? undefined,
        topic: url.searchParams.get('topic') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
        limit: parseOptionalLimit(url.searchParams.get('limit')),
      });
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/oss/issue') {
      const discovery = requireHook(options.discovery, 'Discovery');
      const issueId = url.searchParams.get('id');
      if (!issueId) {
        throw new ServiceError('INVALID_INPUT', '이슈 ID(?id=owner/repo#number)를 지정해 주세요.', 'id');
      }
      const result = await discovery.getIssueDetail(issueId);
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && pathname === '/oss/issue/explain') {
      const discovery = requireHook(options.discovery, 'Discovery');
      const issueId = url.searchParams.get('id');
      if (!issueId) {
        throw new ServiceError('INVALID_INPUT', '이슈 ID(?id=owner/repo#number)를 지정해 주세요.', 'id');
      }
      const result = await discovery.explainIssue(issueId);
      sendOk(res, result, { checkedAt });
      return;
    }

    if (method === 'GET' && segments[0] === 'oss' && segments[1] === 'issues' && segments[2]) {
      const discovery = requireHook(options.discovery, 'Discovery');
      if (segments[3] === 'explain') {
        const result = await discovery.explainIssue(segments[2]);
        sendOk(res, result, { checkedAt });
        return;
      }
      if (segments.length === 3) {
        const result = await discovery.getIssueDetail(segments[2]);
        sendOk(res, result, { checkedAt });
        return;
      }
    }

    throw new ServiceError('NOT_FOUND', `요청한 경로를 찾을 수 없어요: ${method} ${pathname}`);
  };

  const server = createServer((req, res) => {
    void route(req, res).catch(error => {
      options.onError?.(error);
      if (!res.headersSent) {
        sendError(res, error);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
  const baseUrl = `http://${host}:${actualPort}`;

  return {
    server,
    host,
    port: actualPort,
    baseUrl,
    close: async () => {
      for (const sse of Array.from(activeSseResponses)) {
        sse.close();
      }
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
