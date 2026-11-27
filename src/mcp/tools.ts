import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type BridgeClient,
  type StoredCredentials,
} from '../cli-cmd/client.js';
import type {
  AccountLifecycleHooks,
  DiscoveryHooks,
  ModerationHooks,
  ModerationTargetKind,
  RetentionHooks,
} from '../bridge/http-bridge.js';
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
import type { NoticeService } from '../core/notice-service.js';
import type { PresenceService } from '../core/presence-service.js';
import type { ProfileService } from '../core/profile-service.js';
import type {
  ParticipationMode,
  RecruitmentService,
  RecruitmentType,
} from '../core/recruitment-service.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { PUBLIC_SPACES } from '../tui/world-map.js';

export interface InProcessMcpServices {
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
  accountLifecycle?: AccountLifecycleHooks;
  moderation?: ModerationHooks;
  retention?: RetentionHooks;
  discovery?: DiscoveryHooks;
}

export interface CredentialStoreAdapter {
  load(): StoredCredentials | null;
  save(credentials: StoredCredentials): void;
  clear(): void;
}

export interface McpToolDeps {
  services?: InProcessMcpServices;
  bridgeClient?: BridgeClient;
  credentialsPath?: string;
  credentialStore?: CredentialStoreAdapter;
  serverUrl?: string;
}

export interface UntrustedText {
  untrustedContent: true;
  text: string;
}

export function wrapUntrustedText(text: string): UntrustedText {
  return {
    untrustedContent: true,
    text,
  };
}

export function wrapUntrustedValue<T>(value: T): { untrustedContent: true; content: T } {
  return {
    untrustedContent: true,
    content: value,
  };
}

function createFileCredentialStore(credentialsPath?: string): CredentialStoreAdapter {
  return {
    load: () => loadCredentials(credentialsPath),
    save: creds => {
      saveCredentials(creds, credentialsPath);
    },
    clear: () => {
      clearCredentials(credentialsPath);
    },
  };
}

export function createInMemoryCredentialStore(): CredentialStoreAdapter {
  let current: StoredCredentials | null = null;
  return {
    load: () => current,
    save: creds => {
      current = creds;
    },
    clear: () => {
      current = null;
    },
  };
}

function mcpSuccess(data: unknown, meta: Record<string, unknown> = {}): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, data, meta }),
      },
    ],
  };
}

function mcpError(error: unknown): CallToolResult {
  const err = toServiceError(error);
  const payload: Record<string, unknown> = {
    ok: false,
    error: err.toJSON(),
  };
  if (
    err.code === 'UNAUTHORIZED'
    || err.code === 'AUTH_EXPIRED'
    || err.code === 'AUTH_REVOKED'
    || err.code === 'TOKEN_REUSE_DETECTED'
  ) {
    payload.guidance = 'auth_start_approval 도구를 호출해 6자리 승인 코드를 발급받고, SSH TUI [a] 또는 terminal-world auth approve <CODE>에서 직접 승인한 뒤 auth_complete_approval을 실행해 주세요.';
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}

function handoffRequiredResult(
  action: 'signup' | 'recover' | 'change-password' | 'withdraw',
  cliCommand: string,
  description: string,
): CallToolResult {
  const err = new ServiceError(
    'HANDOFF_REQUIRED',
    `${description} 비밀번호·복구 코드 등 민감한 정보는 AI 컨텍스트를 거치지 않고 사용자가 직접 입력해야 해요.`,
    undefined,
    {
      action,
      cliCommand,
      sshTuiPath: action === 'signup' || action === 'recover'
        ? 'SSH TUI 초기 인증 게이트'
        : 'SSH TUI 전역 단축키 [a] 계정/연동 관리',
    },
  );
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: err.toJSON() }),
      },
    ],
  };
}

function requireConfirm(confirm: boolean | undefined, actionName: string): void {
  if (confirm !== true) {
    throw new ServiceError(
      'INVALID_INPUT',
      `${actionName} 작업은 되돌릴 수 없거나 상태를 변경하므로 confirm: true 확인이 필요해요.`,
      'confirm',
    );
  }
}

function wrapPostFields(post: {
  id: string;
  boardId: string;
  authorMemberId: string | null;
  authorNickname: string;
  title: string;
  body: string;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  comments?: Array<{
    id: string;
    postId: string;
    authorMemberId: string | null;
    authorNickname: string;
    body: string;
    createdAt: string;
    updatedAt: string;
  }>;
}) {
  return {
    id: post.id,
    boardId: post.boardId,
    authorMemberId: post.authorMemberId,
    authorNickname: post.authorNickname,
    untrustedContent: true as const,
    title: wrapUntrustedText(post.title),
    body: wrapUntrustedText(post.body),
    commentCount: post.commentCount,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    ...(post.comments
      ? {
          comments: post.comments.map(c => ({
            id: c.id,
            postId: c.postId,
            authorMemberId: c.authorMemberId,
            authorNickname: c.authorNickname,
            untrustedContent: true as const,
            body: wrapUntrustedText(c.body),
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          })),
        }
      : {}),
  };
}

function wrapRecruitmentFields(rec: Record<string, unknown>) {
  return {
    ...rec,
    untrustedContent: true as const,
    title: wrapUntrustedText(String(rec.title ?? '')),
    body: wrapUntrustedText(String(rec.body ?? '')),
    progressNote: wrapUntrustedText(String(rec.progressNote ?? '')),
    contactMethod: wrapUntrustedText(String(rec.contactMethod ?? '')),
  };
}

function wrapNoticeFields(notice: Record<string, unknown>) {
  return {
    ...notice,
    untrustedContent: true as const,
    title: wrapUntrustedText(String(notice.title ?? '')),
    body: wrapUntrustedText(String(notice.body ?? '')),
  };
}

function wrapGuestbookEntry(entry: Record<string, unknown>) {
  return {
    ...entry,
    untrustedContent: true as const,
    body: wrapUntrustedText(String(entry.body ?? '')),
  };
}

function wrapChatMessage(msg: Record<string, unknown>) {
  return {
    ...msg,
    untrustedContent: true as const,
    body: wrapUntrustedText(String(msg.body ?? '')),
  };
}

class InProcessTokenRunner {
  constructor(
    private readonly services: InProcessMcpServices,
    private readonly store: CredentialStoreAdapter,
    private readonly serverUrl: string,
  ) {}

  private refreshAndSave(refreshToken: string): StoredCredentials {
    const refreshed = this.services.integrationAuthService.refreshTokens(refreshToken);
    const updated: StoredCredentials = {
      serverUrl: this.serverUrl,
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      refreshToken: refreshed.refreshToken,
      refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
      grantId: refreshed.grant.id,
      grantExpiresAt: refreshed.grant.expiresAt,
      channel: refreshed.grant.channel,
      scopes: refreshed.effectiveScopes,
      memberId: refreshed.member.id,
      loginId: refreshed.member.loginId,
      nickname: refreshed.member.nickname,
      role: refreshed.member.role,
    };
    this.store.save(updated);
    return updated;
  }

  getCredentials(): StoredCredentials | null {
    return this.store.load();
  }

  authenticate(requiredScopes: readonly IntegrationScope[] = []) {
    const creds = this.store.load();
    if (!creds) {
      throw new ServiceError('UNAUTHORIZED', '인증된 MCP 연동 자격이 없어요.');
    }
    try {
      return this.services.integrationAuthService.authenticateAccessToken(creds.accessToken, requiredScopes);
    } catch (error) {
      const err = toServiceError(error);
      if (err.code === 'AUTH_EXPIRED' && creds.refreshToken) {
        const refreshed = this.refreshAndSave(creds.refreshToken);
        return this.services.integrationAuthService.authenticateAccessToken(refreshed.accessToken, requiredScopes);
      }
      throw err;
    }
  }

  optionalMemberId(): string | null {
    const creds = this.store.load();
    if (!creds) return null;
    try {
      return this.authenticate([]).member.id;
    } catch {
      return null;
    }
  }

  executeWrite<T>(
    operation: string,
    requiredScopes: readonly IntegrationScope[],
    idempotencyKey: string | undefined,
    requestPayload: unknown,
    fn: (memberId: string, auth: AuthenticatedIntegrationContext) => T,
  ): T {
    const creds = this.store.load();
    if (!creds) {
      throw new ServiceError('UNAUTHORIZED', '인증된 MCP 연동 자격이 없어요.');
    }
    try {
      return this.services.integrationAuthService.executeAuthorizedWrite({
        token: creds.accessToken,
        requiredScopes,
        operation,
        idempotencyKey,
        requestPayload,
        fn: auth => fn(auth.member.id, auth),
      });
    } catch (error) {
      const err = toServiceError(error);
      if (err.code === 'AUTH_EXPIRED' && creds.refreshToken) {
        const refreshed = this.refreshAndSave(creds.refreshToken);
        return this.services.integrationAuthService.executeAuthorizedWrite({
          token: refreshed.accessToken,
          requiredScopes,
          operation,
          idempotencyKey,
          requestPayload,
          fn: auth => fn(auth.member.id, auth),
        });
      }
      throw err;
    }
  }
}

export function registerTerminalWorldTools(server: McpServer, deps: McpToolDeps): void {
  if (!deps.services && !deps.bridgeClient) {
    throw new Error('McpToolDeps requires either `services` or `bridgeClient`.');
  }

  const store = deps.credentialStore ?? createFileCredentialStore(deps.credentialsPath);
  const serverUrl = deps.bridgeClient?.baseUrl ?? deps.serverUrl ?? 'in-process';
  const runner = deps.services ? new InProcessTokenRunner(deps.services, store, serverUrl) : null;
  const bridge = deps.bridgeClient ?? null;

  const getBridgeCreds = () => (bridge ? (deps.credentialStore ? store.load() : bridge.getCredentials()) : runner!.getCredentials());
  const saveBridgeCreds = (creds: StoredCredentials) => {
    if (bridge && !deps.credentialStore) {
      bridge.storeCredentials(creds);
    } else {
      store.save(creds);
    }
  };
  const clearBridgeCreds = () => {
    if (bridge && !deps.credentialStore) {
      bridge.removeCredentials();
    } else {
      store.clear();
    }
  };

  const bridgeRequest = async <T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, unknown>;
      auth?: boolean | 'optional';
      idempotencyKey?: string;
    } = {},
  ) => {
    const creds = getBridgeCreds();
    if (opts.auth === true && !creds) {
      throw new ServiceError('UNAUTHORIZED', '인증된 MCP 연동 자격이 없어요.');
    }
    try {
      return await bridge!.request<T>(method, path, {
        ...opts,
        token: creds?.accessToken,
      });
    } catch (error) {
      const err = toServiceError(error);
      if (err.code === 'AUTH_EXPIRED' && creds?.refreshToken && opts.auth !== false) {
        const refreshed = await bridge!.refreshStoredCredentials(creds.refreshToken);
        saveBridgeCreds(refreshed);
        return await bridge!.request<T>(method, path, {
          ...opts,
          token: refreshed.accessToken,
        });
      }
      throw err;
    }
  };

  // ========================
  // 1. Auth & Integration
  // ========================
  server.registerTool('auth_status', {
    description: '현재 MCP 연동 인증 상태와 유효 권한 범위·만료 시각을 확인합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner) {
        const creds = runner.getCredentials();
        if (!creds) {
          return mcpSuccess({ authenticated: false, role: 'guest', scopes: [] });
        }
        try {
          const auth = runner.authenticate([]);
          return mcpSuccess({
            authenticated: true,
            member: auth.member,
            grantId: auth.grant.id,
            channel: auth.grant.channel,
            scopes: auth.effectiveScopes,
            grantExpiresAt: auth.grant.expiresAt,
            accessTokenExpiresAt: auth.accessTokenExpiresAt,
          });
        } catch (err) {
          const se = toServiceError(err);
          return mcpSuccess({
            authenticated: false,
            role: 'guest',
            reason: se.code,
            message: se.message,
          });
        }
      }

      const creds = getBridgeCreds();
      if (!creds) {
        return mcpSuccess({ authenticated: false, role: 'guest', scopes: [] });
      }
      try {
        const res = await bridgeRequest<{ items: Array<{ id: string; expiresAt: string; revokedAt: string | null }>; currentGrantId: string }>('GET', '/auth/grants', { auth: true });
        const current = res.data.items.find(g => g.id === res.data.currentGrantId);
        return mcpSuccess({
          authenticated: true,
          member: {
            id: creds.memberId,
            loginId: creds.loginId,
            nickname: creds.nickname,
            role: creds.role,
          },
          grantId: creds.grantId,
          channel: creds.channel,
          scopes: creds.scopes,
          grantExpiresAt: current?.expiresAt ?? creds.grantExpiresAt,
        });
      } catch (err) {
        const se = toServiceError(err);
        return mcpSuccess({
          authenticated: false,
          role: 'guest',
          reason: se.code,
          message: se.message,
        });
      }
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('auth_start_approval', {
    description: '비밀번호 없이 6자리 원타임 승인 코드(5분 만료)를 발급합니다. 사용자가 SSH TUI 또는 CLI에서 직접 승인해야 합니다.',
    inputSchema: {
      scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).default(['read', 'write']),
      requestedTtlSec: z.number().int().positive().optional(),
      clientLabel: z.string().min(1).max(100).default('mcp-host'),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const started = deps.services.integrationAuthService.startApproval({
          channel: 'mcp',
          scopes: args.scopes,
          requestedTtlSec: args.requestedTtlSec,
          clientLabel: args.clientLabel,
        });
        return mcpSuccess(started);
      }
      const res = await bridgeRequest('POST', '/auth/device-code', {
        body: {
          channel: 'mcp',
          scopes: args.scopes,
          requestedTtlSec: args.requestedTtlSec,
          clientLabel: args.clientLabel,
        },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('auth_complete_approval', {
    description: '사용자가 승인한 6자리 코드를 Access/Refresh 토큰으로 교환해 로컬 보안 저장소(0600)에 저장합니다.',
    inputSchema: {
      code: z.string().length(6),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const pair = deps.services.integrationAuthService.exchangeApprovalCode(args.code);
        store.save({
          serverUrl,
          accessToken: pair.accessToken,
          accessTokenExpiresAt: pair.accessTokenExpiresAt,
          refreshToken: pair.refreshToken,
          refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
          grantId: pair.grant.id,
          grantExpiresAt: pair.grant.expiresAt,
          channel: pair.grant.channel,
          scopes: pair.effectiveScopes,
          memberId: pair.member.id,
          loginId: pair.member.loginId,
          nickname: pair.member.nickname,
          role: pair.member.role,
        });
        return mcpSuccess({
          authenticated: true,
          member: pair.member,
          grant: pair.grant,
          effectiveScopes: pair.effectiveScopes,
        });
      }

      const res = await bridgeRequest<{
        accessToken: string;
        accessTokenExpiresAt: string;
        refreshToken: string;
        refreshTokenExpiresAt: string;
        grant: { id: string; channel: 'cli' | 'mcp'; scopes: IntegrationScope[]; expiresAt: string };
        member: { id: string; loginId: string; nickname: string; role: 'member' | 'admin' };
        effectiveScopes: IntegrationScope[];
      }>('POST', '/auth/token', {
        body: { code: args.code },
      });
      saveBridgeCreds({
        serverUrl,
        accessToken: res.data.accessToken,
        accessTokenExpiresAt: res.data.accessTokenExpiresAt,
        refreshToken: res.data.refreshToken,
        refreshTokenExpiresAt: res.data.refreshTokenExpiresAt,
        grantId: res.data.grant.id,
        grantExpiresAt: res.data.grant.expiresAt,
        channel: res.data.grant.channel,
        scopes: res.data.effectiveScopes,
        memberId: res.data.member.id,
        loginId: res.data.member.loginId,
        nickname: res.data.member.nickname,
        role: res.data.member.role,
      });
      return mcpSuccess({
        authenticated: true,
        member: res.data.member,
        grant: res.data.grant,
        effectiveScopes: res.data.effectiveScopes,
      });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('auth_list_grants', {
    description: '현재 회원의 연동 승인(Grant) 목록을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate([]);
        const items = deps.services.integrationAuthService.listGrants(auth.member.id);
        return mcpSuccess({ items, currentGrantId: auth.grant.id });
      }
      const res = await bridgeRequest('GET', '/auth/grants', { auth: true });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('auth_revoke_grant', {
    description: '연동 승인(Grant)을 즉시 회수합니다. 파괴적 작업이므로 confirm: true가 필요합니다.',
    inputSchema: {
      grantId: z.string().min(1),
      reason: z.string().max(200).optional(),
      confirm: z.boolean().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '연동 승인 회수');
      if (runner && deps.services) {
        const auth = runner.authenticate([]);
        const revoked = deps.services.integrationAuthService.revokeGrant(
          auth.member.id,
          args.grantId,
          args.reason ?? 'mcp_revoked',
        );
        if (auth.grant.id === args.grantId) {
          store.clear();
        }
        return mcpSuccess(revoked);
      }
      const creds = getBridgeCreds();
      const res = await bridgeRequest('POST', `/auth/grants/${encodeURIComponent(args.grantId)}/revoke`, {
        auth: true,
        body: { reason: args.reason ?? 'mcp_revoked' },
      });
      if (creds?.grantId === args.grantId) {
        clearBridgeCreds();
      }
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // Sensitive Handoff-only tools (never accept passwords/recovery codes)
  server.registerTool('auth_signup', {
    description: '회원가입은 비밀번호·복구 코드 보호를 위해 직접 입력 경로(CLI/SSH)로 인계합니다.',
    inputSchema: {},
  }, async () => handoffRequiredResult('signup', 'terminal-world auth signup --login-id <id> --nickname <nick>', '회원가입은'));

  server.registerTool('auth_recover', {
    description: '계정 복구는 복구 코드·새 비밀번호 보호를 위해 직접 입력 경로(CLI/SSH)로 인계합니다.',
    inputSchema: {},
  }, async () => handoffRequiredResult('recover', 'terminal-world auth recover --login-id <id>', '계정 복구는'));

  server.registerTool('auth_change_password', {
    description: '비밀번호 변경은 직접 입력 경로(CLI/SSH)로 인계합니다.',
    inputSchema: {},
  }, async () => handoffRequiredResult('change-password', 'terminal-world auth change-password', '비밀번호 변경은'));

  server.registerTool('auth_withdraw', {
    description: '회원 탈퇴는 비밀번호 확인과 최종 확인 보호를 위해 직접 입력 경로(CLI/SSH)로 인계합니다.',
    inputSchema: {},
  }, async () => handoffRequiredResult('withdraw', 'terminal-world auth withdraw --confirm', '회원 탈퇴는'));

  // ========================
  // 2. World & Profile
  // ========================
  server.registerTool('world_list_spaces', {
    description: '공용 공간과 공개된 개인 터미널 공간 목록을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (deps.services) {
        const personalSpaces = deps.services.profileService.listPublicPersonalSpaces().map(space => ({
          ...space,
          untrustedContent: true as const,
          introduction: wrapUntrustedText(space.introduction),
          currentStatus: wrapUntrustedText(space.currentStatus),
          asciiArt: wrapUntrustedText(space.asciiArt),
        }));
        return mcpSuccess({ publicSpaces: PUBLIC_SPACES, personalSpaces });
      }
      const res = await bridgeRequest<{ publicSpaces: unknown; personalSpaces: Array<Record<string, unknown>> }>('GET', '/world/spaces');
      return mcpSuccess({
        publicSpaces: res.data.publicSpaces,
        personalSpaces: res.data.personalSpaces.map(space => ({
          ...space,
          untrustedContent: true as const,
          introduction: wrapUntrustedText(String(space.introduction ?? '')),
          currentStatus: wrapUntrustedText(String(space.currentStatus ?? '')),
          asciiArt: wrapUntrustedText(String(space.asciiArt ?? '')),
        })),
      }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('lobby_get_overview', {
    description: '로비의 현재 접속자(온라인/자리비움/게스트 수)와 게시 중인 공지 목록을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (deps.services) {
        const presence = deps.services.presenceService.getLobbyOverview();
        const notices = deps.services.noticeService.listNotices({ includeEnded: false, limit: 20 });
        return mcpSuccess({
          presence,
          notices: notices.items.map(n => wrapNoticeFields(n as unknown as Record<string, unknown>)),
        });
      }
      const res = await bridgeRequest<{ presence: unknown; notices: Array<Record<string, unknown>> }>('GET', '/world/lobby');
      return mcpSuccess({
        presence: res.data.presence,
        notices: res.data.notices.map(wrapNoticeFields),
      }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('profile_get', {
    description: '회원 닉네임 또는 공간 ID로 프로필과 개인 공간을 조회합니다.',
    inputSchema: {
      identifier: z.string().min(1),
    },
  }, async args => {
    try {
      const data = deps.services
        ? deps.services.profileService.getPersonalSpaceDetail(args.identifier)
        : (await bridgeRequest<ReturnType<ProfileService['getPersonalSpaceDetail']>>('GET', `/profiles/${encodeURIComponent(args.identifier)}`)).data;

      return mcpSuccess({
        member: data.member,
        untrustedContent: true as const,
        profile: {
          ...data.profile,
          untrustedContent: true as const,
          introduction: wrapUntrustedText(data.profile.introduction),
          currentStatus: wrapUntrustedText(data.profile.currentStatus),
          projectUrl: wrapUntrustedText(data.profile.projectUrl),
        },
        personalSpace: {
          ...data.personalSpace,
          untrustedContent: true as const,
          asciiArt: wrapUntrustedText(data.personalSpace.asciiArt),
        },
      });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('profile_preview_update', {
    description: '프로필·개인 공간 수정 내용을 저장하지 않고 검증·미리보기합니다.',
    inputSchema: {
      introduction: z.string().optional(),
      technologyStack: z.array(z.string()).optional(),
      currentStatus: z.string().optional(),
      projectUrl: z.string().optional(),
      asciiArt: z.string().optional(),
      colorTheme: z.enum(['dark', 'light', 'green', 'amber']).optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate([]);
        const preview = deps.services.profileService.previewProfileUpdate(auth.member.id, args);
        return mcpSuccess(preview);
      }
      const res = await bridgeRequest('POST', '/profiles/me/preview', {
        auth: true,
        body: args,
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('profile_update', {
    description: '본인 프로필과 개인 공간 설정을 저장합니다.',
    inputSchema: {
      introduction: z.string().optional(),
      technologyStack: z.array(z.string()).optional(),
      currentStatus: z.string().optional(),
      projectUrl: z.string().optional(),
      asciiArt: z.string().optional(),
      colorTheme: z.enum(['dark', 'light', 'green', 'amber']).optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      const { idempotencyKey, ...payload } = args;
      if (runner && deps.services) {
        const updated = runner.executeWrite('profile.update', ['write'], idempotencyKey, payload, memberId =>
          deps.services!.profileService.updateProfile(memberId, payload),
        );
        return mcpSuccess(updated);
      }
      const res = await bridgeRequest('PATCH', '/profiles/me', {
        auth: true,
        idempotencyKey,
        body: payload,
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 3. Guestbook
  // ========================
  server.registerTool('guestbook_list', {
    description: '특정 회원의 개인 공간 방명록을 조회합니다.',
    inputSchema: {
      targetSpace: z.string().min(1),
    },
  }, async args => {
    try {
      const items = deps.services
        ? deps.services.guestbookService.listEntries(args.targetSpace)
        : (await bridgeRequest<{ items: Array<Record<string, unknown>> }>('GET', `/guestbook/${encodeURIComponent(args.targetSpace)}`)).data.items;
      return mcpSuccess({
        items: items.map(e => wrapGuestbookEntry(e as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('guestbook_list_archived', {
    description: '탈퇴한 사용자의 보관 방명록(읽기 전용)을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      const items = deps.services
        ? deps.services.guestbookService.listArchivedEntries()
        : (await bridgeRequest<{ items: Array<Record<string, unknown>> }>('GET', '/guestbook/archived')).data.items;
      return mcpSuccess({
        items: items.map(e => wrapGuestbookEntry(e as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('guestbook_create', {
    description: '대상 개인 공간에 방명록을 남깁니다.',
    inputSchema: {
      targetSpace: z.string().min(1),
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const created = runner.executeWrite(
          'guestbook.create',
          ['write'],
          args.idempotencyKey,
          { targetSpace: args.targetSpace, body: args.body },
          memberId => deps.services!.guestbookService.createEntry(memberId, args.targetSpace, args.body),
        );
        return mcpSuccess(wrapGuestbookEntry(created as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('POST', `/guestbook/${encodeURIComponent(args.targetSpace)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { body: args.body },
      });
      return mcpSuccess(wrapGuestbookEntry(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('guestbook_update', {
    description: '본인이 작성한 방명록 글을 수정합니다.',
    inputSchema: {
      entryId: z.string().min(1),
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const updated = runner.executeWrite(
          'guestbook.update',
          ['write'],
          args.idempotencyKey,
          { entryId: args.entryId, body: args.body },
          memberId => deps.services!.guestbookService.updateEntry(memberId, args.entryId, args.body),
        );
        return mcpSuccess(wrapGuestbookEntry(updated as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('PATCH', `/guestbook/entries/${encodeURIComponent(args.entryId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { body: args.body },
      });
      return mcpSuccess(wrapGuestbookEntry(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('guestbook_delete', {
    description: '방명록 글을 삭제합니다(작성자 또는 관리자). 파괴적 작업이므로 confirm: true가 필요합니다.',
    inputSchema: {
      entryId: z.string().min(1),
      reason: z.string().optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '방명록 삭제');
      if (runner && deps.services) {
        const deleted = runner.executeWrite(
          'guestbook.delete',
          ['write'],
          args.idempotencyKey,
          { entryId: args.entryId, reason: args.reason },
          (memberId, auth) =>
            deps.services!.guestbookService.deleteEntry(memberId, args.entryId, args.reason, {
              allowAdmin: auth.effectiveScopes.includes('admin'),
            }),
        );
        return mcpSuccess(deleted);
      }
      const res = await bridgeRequest('DELETE', `/guestbook/entries/${encodeURIComponent(args.entryId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: args.reason ? { reason: args.reason } : {},
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 4. Boards, Posts, Comments
  // ========================
  server.registerTool('board_list', {
    description: 'Cafe 7개 고정 게시판 목록을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      const items = deps.services
        ? deps.services.boardService.listBoards()
        : (await bridgeRequest<{ items: unknown[] }>('GET', '/boards')).data.items;
      return mcpSuccess({ items });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('post_list', {
    description: '특정 게시판의 게시글 목록을 커서 페이지네이션으로 조회합니다.',
    inputSchema: {
      boardId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    try {
      if (deps.services) {
        const page = deps.services.boardService.listPosts(args);
        return mcpSuccess(
          { items: page.items.map(wrapPostFields) },
          { cursor: page.cursor, hasMore: page.hasMore },
        );
      }
      const res = await bridgeRequest<{ items: Array<Parameters<typeof wrapPostFields>[0]> }>('GET', `/boards/${encodeURIComponent(args.boardId)}/posts`, {
        query: { cursor: args.cursor, limit: args.limit },
      });
      return mcpSuccess({ items: res.data.items.map(wrapPostFields) }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('post_get', {
    description: '게시글 상세와 댓글 목록을 조회합니다.',
    inputSchema: {
      postId: z.string().min(1),
    },
  }, async args => {
    try {
      const post = deps.services
        ? deps.services.boardService.getPost(args.postId)
        : (await bridgeRequest<Parameters<typeof wrapPostFields>[0]>('GET', `/posts/${encodeURIComponent(args.postId)}`)).data;
      return mcpSuccess(wrapPostFields(post));
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('post_create', {
    description: '게시판에 새 글을 작성합니다.',
    inputSchema: {
      boardId: z.string().min(1),
      title: z.string().min(1),
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const created = runner.executeWrite(
          'board.createPost',
          ['write'],
          args.idempotencyKey,
          { boardId: args.boardId, title: args.title, body: args.body },
          memberId => deps.services!.boardService.createPost(memberId, {
            boardId: args.boardId,
            title: args.title,
            body: args.body,
          }),
        );
        return mcpSuccess(wrapPostFields(created));
      }
      const res = await bridgeRequest<Parameters<typeof wrapPostFields>[0]>('POST', `/boards/${encodeURIComponent(args.boardId)}/posts`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { title: args.title, body: args.body },
      });
      return mcpSuccess(wrapPostFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('post_update', {
    description: '본인이 작성한 게시글을 수정합니다.',
    inputSchema: {
      postId: z.string().min(1),
      title: z.string().optional(),
      body: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const updated = runner.executeWrite(
          'board.updatePost',
          ['write'],
          args.idempotencyKey,
          { postId: args.postId, title: args.title, body: args.body },
          memberId => deps.services!.boardService.updatePost(memberId, args.postId, {
            title: args.title,
            body: args.body,
          }),
        );
        return mcpSuccess(wrapPostFields(updated));
      }
      const res = await bridgeRequest<Parameters<typeof wrapPostFields>[0]>('PATCH', `/posts/${encodeURIComponent(args.postId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { title: args.title, body: args.body },
      });
      return mcpSuccess(wrapPostFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('post_delete', {
    description: '게시글을 삭제합니다(작성자 또는 관리자). 파괴적 작업이므로 confirm: true가 필요합니다.',
    inputSchema: {
      postId: z.string().min(1),
      reason: z.string().optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '게시글 삭제');
      if (runner && deps.services) {
        const deleted = runner.executeWrite(
          'board.deletePost',
          ['write'],
          args.idempotencyKey,
          { postId: args.postId, reason: args.reason },
          (memberId, auth) =>
            deps.services!.boardService.deletePost(memberId, args.postId, {
              reason: args.reason,
              allowAdmin: auth.effectiveScopes.includes('admin'),
            }),
        );
        return mcpSuccess(deleted);
      }
      const res = await bridgeRequest('DELETE', `/posts/${encodeURIComponent(args.postId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: args.reason ? { reason: args.reason } : {},
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('comment_create', {
    description: '게시글에 댓글을 작성합니다.',
    inputSchema: {
      postId: z.string().min(1),
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const created = runner.executeWrite(
          'board.createComment',
          ['write'],
          args.idempotencyKey,
          { postId: args.postId, body: args.body },
          memberId => deps.services!.boardService.createComment(memberId, {
            postId: args.postId,
            body: args.body,
          }),
        );
        return mcpSuccess({
          ...created,
          untrustedContent: true as const,
          body: wrapUntrustedText(created.body),
        });
      }
      const res = await bridgeRequest<{ body: string } & Record<string, unknown>>('POST', `/posts/${encodeURIComponent(args.postId)}/comments`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { body: args.body },
      });
      return mcpSuccess({
        ...res.data,
        untrustedContent: true as const,
        body: wrapUntrustedText(res.data.body),
      }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('comment_update', {
    description: '본인이 작성한 댓글을 수정합니다.',
    inputSchema: {
      commentId: z.string().min(1),
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const updated = runner.executeWrite(
          'board.updateComment',
          ['write'],
          args.idempotencyKey,
          { commentId: args.commentId, body: args.body },
          memberId => deps.services!.boardService.updateComment(memberId, args.commentId, { body: args.body }),
        );
        return mcpSuccess({
          ...updated,
          untrustedContent: true as const,
          body: wrapUntrustedText(updated.body),
        });
      }
      const res = await bridgeRequest<{ body: string } & Record<string, unknown>>('PATCH', `/comments/${encodeURIComponent(args.commentId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { body: args.body },
      });
      return mcpSuccess({
        ...res.data,
        untrustedContent: true as const,
        body: wrapUntrustedText(res.data.body),
      }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('comment_delete', {
    description: '댓글을 삭제합니다(작성자 또는 관리자). 파괴적 작업이므로 confirm: true가 필요합니다.',
    inputSchema: {
      commentId: z.string().min(1),
      reason: z.string().optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '댓글 삭제');
      if (runner && deps.services) {
        const deleted = runner.executeWrite(
          'board.deleteComment',
          ['write'],
          args.idempotencyKey,
          { commentId: args.commentId, reason: args.reason },
          (memberId, auth) =>
            deps.services!.boardService.deleteComment(memberId, args.commentId, {
              reason: args.reason,
              allowAdmin: auth.effectiveScopes.includes('admin'),
            }),
        );
        return mcpSuccess(deleted);
      }
      const res = await bridgeRequest('DELETE', `/comments/${encodeURIComponent(args.commentId)}`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: args.reason ? { reason: args.reason } : {},
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 5. Recruitment & Bookmarks
  // ========================
  server.registerTool('recruitment_search', {
    description: '프로젝트·공모전·해커톤 모집 글을 조건별로 검색합니다.',
    inputSchema: {
      type: z.enum(['project', 'contest', 'hackathon']).optional(),
      role: z.string().optional(),
      skill: z.string().optional(),
      mode: z.enum(['online', 'offline', 'hybrid']).optional(),
      state: z.enum(['open', 'closed']).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const viewerId = runner.optionalMemberId();
        const page = deps.services.recruitmentService.searchRecruitments(args, viewerId);
        return mcpSuccess(
          { items: page.items.map(i => wrapRecruitmentFields(i as unknown as Record<string, unknown>)) },
          { cursor: page.cursor, hasMore: page.hasMore },
        );
      }
      const res = await bridgeRequest<{ items: Array<Record<string, unknown>> }>('GET', '/recruitments', {
        auth: 'optional',
        query: args,
      });
      return mcpSuccess({ items: res.data.items.map(wrapRecruitmentFields) }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('recruitment_create', {
    description: '새 프로젝트/공모전 모집 글을 작성합니다.',
    inputSchema: {
      title: z.string().min(1),
      body: z.string().min(1),
      recruitmentType: z.enum(['project', 'contest', 'hackathon']),
      progressNote: z.string().min(1),
      roles: z.array(z.string()).min(1),
      requiredSkills: z.array(z.string()).optional(),
      noSkillRequired: z.boolean().optional(),
      participationPeriod: z.string().min(1),
      weeklyTime: z.string().min(1),
      participationMode: z.enum(['online', 'offline', 'hybrid']),
      region: z.string().optional(),
      contactMethod: z.string().min(1),
      deadlineAt: z.string().min(1),
      ackPublic: z.boolean(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      const { idempotencyKey, ...payload } = args;
      if (runner && deps.services) {
        const created = runner.executeWrite('recruitment.create', ['write'], idempotencyKey, payload, memberId =>
          deps.services!.recruitmentService.createRecruitment(memberId, payload),
        );
        return mcpSuccess(wrapRecruitmentFields(created as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('POST', '/recruitments', {
        auth: true,
        idempotencyKey,
        body: payload,
      });
      return mcpSuccess(wrapRecruitmentFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('recruitment_update', {
    description: '본인이 작성한 모집 글을 수정합니다.',
    inputSchema: {
      postId: z.string().min(1),
      title: z.string().optional(),
      body: z.string().optional(),
      recruitmentType: z.enum(['project', 'contest', 'hackathon']).optional(),
      progressNote: z.string().optional(),
      roles: z.array(z.string()).optional(),
      requiredSkills: z.array(z.string()).optional(),
      noSkillRequired: z.boolean().optional(),
      participationPeriod: z.string().optional(),
      weeklyTime: z.string().optional(),
      participationMode: z.enum(['online', 'offline', 'hybrid']).optional(),
      region: z.string().optional(),
      contactMethod: z.string().optional(),
      deadlineAt: z.string().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      const { postId, idempotencyKey, ...payload } = args;
      if (runner && deps.services) {
        const updated = runner.executeWrite(
          'recruitment.update',
          ['write'],
          idempotencyKey,
          { postId, ...payload },
          memberId => deps.services!.recruitmentService.updateRecruitment(memberId, postId, payload as {
            title?: string;
            body?: string;
            recruitmentType?: RecruitmentType;
            participationMode?: ParticipationMode;
          }),
        );
        return mcpSuccess(wrapRecruitmentFields(updated as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('PATCH', `/recruitments/${encodeURIComponent(postId)}`, {
        auth: true,
        idempotencyKey,
        body: payload,
      });
      return mcpSuccess(wrapRecruitmentFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('recruitment_close', {
    description: '본인이 작성한 모집 글을 수동 마감합니다. confirm: true가 필요합니다.',
    inputSchema: {
      postId: z.string().min(1),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '모집 마감');
      if (runner && deps.services) {
        const closed = runner.executeWrite(
          'recruitment.close',
          ['write'],
          args.idempotencyKey,
          { postId: args.postId },
          memberId => deps.services!.recruitmentService.closeRecruitment(memberId, args.postId),
        );
        return mcpSuccess(wrapRecruitmentFields(closed as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('POST', `/recruitments/${encodeURIComponent(args.postId)}/close`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: {},
      });
      return mcpSuccess(wrapRecruitmentFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('recruitment_bookmark_set', {
    description: '관심 모집 글을 내 비공개 목록에 저장하거나 해제합니다.',
    inputSchema: {
      postId: z.string().min(1),
      saved: z.boolean(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const res = runner.executeWrite(
          'recruitment.bookmark',
          ['write'],
          args.idempotencyKey,
          { postId: args.postId, saved: args.saved },
          memberId => deps.services!.recruitmentService.setBookmark(memberId, args.postId, args.saved),
        );
        return mcpSuccess(res);
      }
      const res = await bridgeRequest('POST', `/recruitments/${encodeURIComponent(args.postId)}/bookmark`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { saved: args.saved },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('recruitment_bookmark_list', {
    description: '본인이 저장한 비공개 관심 모집 글 목록을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        const items = deps.services.recruitmentService.listMyBookmarks(auth.member.id);
        return mcpSuccess({
          items: items.map(i => wrapRecruitmentFields(i as unknown as Record<string, unknown>)),
        });
      }
      const res = await bridgeRequest<{ items: Array<Record<string, unknown>> }>('GET', '/recruitments/bookmarks', {
        auth: true,
      });
      return mcpSuccess({ items: res.data.items.map(wrapRecruitmentFields) }, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 6. Chat, Live Session, Focus
  // ========================
  server.registerTool('chat_history', {
    description: 'RoofTop 실시간 채팅방의 최근 메시지(14일 보관, 최대 100건)를 조회합니다.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    try {
      const items = deps.services
        ? deps.services.chatService.listRecentMessages({ limit: args.limit })
        : (await bridgeRequest<{ items: Array<Record<string, unknown>> }>('GET', '/chat/messages', {
            query: { limit: args.limit },
          })).data.items;
      return mcpSuccess({
        items: items.map(m => wrapChatMessage(m as unknown as Record<string, unknown>)),
      });
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('chat_send', {
    description: 'RoofTop 채팅방에 메시지를 전송합니다(멱등성 키 지원).',
    inputSchema: {
      body: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const sent = runner.executeWrite(
          'chat.send',
          ['write'],
          args.idempotencyKey,
          { body: args.body },
          memberId => deps.services!.chatService.sendMessage({ memberId, body: args.body }),
        );
        return mcpSuccess(wrapChatMessage(sent as unknown as Record<string, unknown>));
      }
      const res = await bridgeRequest<Record<string, unknown>>('POST', '/chat/messages', {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { body: args.body },
      });
      return mcpSuccess(wrapChatMessage(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('session_open_live', {
    description: '명시적 지속 업무 세션(online/away/focus 소유용)을 엽니다.',
    inputSchema: {
      spaceId: z.string().default('space:lobby'),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        const session = deps.services.presenceService.openSession({
          memberId: auth.member.id,
          channel: 'mcp',
          spaceId: args.spaceId,
        });
        return mcpSuccess(session);
      }
      const res = await bridgeRequest('POST', '/sessions', {
        auth: true,
        body: { channel: 'mcp', spaceId: args.spaceId },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('session_move_space', {
    description: '열려 있는 지속 세션을 다른 공간(예: space:living 자리비움)으로 이동합니다.',
    inputSchema: {
      sessionId: z.string().min(1),
      spaceId: z.string().min(1),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        const existing = deps.services.presenceService.getSessionById(args.sessionId);
        if (!existing) {
          throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
        }
        if (existing.memberId !== auth.member.id) {
          throw new ServiceError('FORBIDDEN', '본인의 세션만 이동할 수 있어요.');
        }
        const updated = deps.services.presenceService.moveSpace(args.sessionId, args.spaceId);
        return mcpSuccess(updated);
      }
      const res = await bridgeRequest('POST', `/sessions/${encodeURIComponent(args.sessionId)}/enter`, {
        auth: true,
        body: { spaceId: args.spaceId },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('session_close_live', {
    description: '열려 있는 지속 세션을 정상 종료합니다.',
    inputSchema: {
      sessionId: z.string().min(1),
      reason: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        const existing = deps.services.presenceService.getSessionById(args.sessionId);
        if (!existing) {
          throw new ServiceError('NOT_FOUND', '세션을 찾을 수 없어요.');
        }
        if (existing.memberId !== auth.member.id) {
          throw new ServiceError('FORBIDDEN', '본인의 세션만 종료할 수 있어요.');
        }
        const closed = deps.services.presenceService.closeSession(args.sessionId, {
          mode: 'normal',
          reason: args.reason ?? 'mcp_close',
        });
        return mcpSuccess(closed);
      }
      const res = await bridgeRequest('POST', `/sessions/${encodeURIComponent(args.sessionId)}/close`, {
        auth: true,
        body: { mode: 'normal', reason: args.reason ?? 'mcp_close' },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('focus_status', {
    description: '본인의 현재 집중 상태와 오늘 누적 집중 시간을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        return mcpSuccess(deps.services.focusService.getFocusStatus(auth.member.id));
      }
      const res = await bridgeRequest('GET', '/focus/status', { auth: true });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('focus_start', {
    description: '열려 있는 지속 세션(sessionId)을 소유자로 지정해 집중 추적을 시작합니다.',
    inputSchema: {
      sessionId: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const started = runner.executeWrite(
          'focus.start',
          ['write'],
          args.idempotencyKey,
          { sessionId: args.sessionId },
          memberId => deps.services!.focusService.startFocus(memberId, args.sessionId),
        );
        return mcpSuccess(started);
      }
      const res = await bridgeRequest('POST', '/focus/start', {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { sessionId: args.sessionId },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('focus_stop', {
    description: '진행 중인 집중 추적을 종료하고 Asia/Seoul 자정 기준으로 일별 누적을 반영합니다.',
    inputSchema: {
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const stopped = runner.executeWrite(
          'focus.stop',
          ['write'],
          args.idempotencyKey,
          {},
          memberId => deps.services!.focusService.stopFocus(memberId),
        );
        return mcpSuccess(stopped);
      }
      const res = await bridgeRequest('POST', '/focus/stop', {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: {},
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('focus_history', {
    description: '본인의 상세 집중 구간 이력을 조회합니다(타인 조회는 차단됩니다).',
    inputSchema: {
      memberId: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        const auth = runner.authenticate(['read']);
        const targetId = args.memberId ?? auth.member.id;
        return mcpSuccess(deps.services.focusService.getFocusHistory(auth.member.id, targetId, { limit: args.limit }));
      }
      const res = await bridgeRequest('GET', '/focus/history', {
        auth: true,
        query: { memberId: args.memberId, limit: args.limit },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('focus_ranking', {
    description: '일별 집중 시간 공개 랭킹(공동 순위)을 조회합니다.',
    inputSchema: {
      kstDate: z.string().optional(),
    },
  }, async args => {
    try {
      const items = deps.services
        ? deps.services.focusService.getDailyRanking(args.kstDate)
        : (await bridgeRequest<{ items: unknown[] }>('GET', '/focus/ranking', {
            query: { date: args.kstDate },
          })).data.items;
      return mcpSuccess({ items });
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 7. Reports & Admin
  // ========================
  server.registerTool('report_create', {
    description: '부적절한 게시글·댓글·방명록·채팅 메시지를 신고합니다.',
    inputSchema: {
      targetKind: z.enum(['post', 'comment', 'guestbook', 'chat']),
      targetId: z.string().min(1),
      reason: z.string().min(1),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        if (!deps.services.moderation) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '신고 모듈이 아직 연결되지 않았어요.');
        }
        const created = runner.executeWrite(
          'report.create',
          ['write'],
          args.idempotencyKey,
          { targetKind: args.targetKind, targetId: args.targetId, reason: args.reason },
          memberId => deps.services!.moderation!.createReport({
            reporterMemberId: memberId,
            targetKind: args.targetKind,
            targetId: args.targetId,
            reason: args.reason,
          }),
        );
        return mcpSuccess(created);
      }
      const res = await bridgeRequest('POST', '/reports', {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { targetKind: args.targetKind, targetId: args.targetId, reason: args.reason },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('report_list_mine', {
    description: '본인이 접수한 신고 내역과 처리 결과를 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner && deps.services) {
        if (!deps.services.moderation) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '신고 모듈이 아직 연결되지 않았어요.');
        }
        const auth = runner.authenticate(['read']);
        const items = deps.services.moderation.listMyReports(auth.member.id);
        return mcpSuccess(wrapUntrustedValue(items));
      }
      const res = await bridgeRequest('GET', '/reports/mine', { auth: true });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('admin_notice_manage', {
    description: '관리자가 공지사항을 작성·수정·게시 종료합니다(end 시 confirm: true 필요).',
    inputSchema: {
      action: z.enum(['create', 'update', 'end']),
      noticeId: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (args.action === 'end') {
        requireConfirm(args.confirm, '공지 게시 종료');
      }
      if (runner && deps.services) {
        const result = runner.executeWrite(
          `notice.${args.action}`,
          ['write', 'admin'],
          args.idempotencyKey,
          args,
          memberId => {
            if (args.action === 'create') {
              return deps.services!.noticeService.createNotice(memberId, {
                title: args.title ?? '',
                body: args.body ?? '',
              });
            }
            if (!args.noticeId) {
              throw new ServiceError('INVALID_INPUT', 'noticeId가 필요해요.', 'noticeId');
            }
            if (args.action === 'update') {
              return deps.services!.noticeService.updateNotice(memberId, args.noticeId, {
                title: args.title,
                body: args.body,
              });
            }
            return deps.services!.noticeService.endNotice(memberId, args.noticeId);
          },
        );
        return mcpSuccess(wrapNoticeFields(result as unknown as Record<string, unknown>));
      }

      if (args.action === 'create') {
        const res = await bridgeRequest<Record<string, unknown>>('POST', '/notices', {
          auth: true,
          idempotencyKey: args.idempotencyKey,
          body: { title: args.title ?? '', body: args.body ?? '' },
        });
        return mcpSuccess(wrapNoticeFields(res.data), res.meta);
      }
      if (!args.noticeId) {
        throw new ServiceError('INVALID_INPUT', 'noticeId가 필요해요.', 'noticeId');
      }
      if (args.action === 'update') {
        const res = await bridgeRequest<Record<string, unknown>>('PATCH', `/notices/${encodeURIComponent(args.noticeId)}`, {
          auth: true,
          idempotencyKey: args.idempotencyKey,
          body: { title: args.title, body: args.body },
        });
        return mcpSuccess(wrapNoticeFields(res.data), res.meta);
      }
      const res = await bridgeRequest<Record<string, unknown>>('POST', `/notices/${encodeURIComponent(args.noticeId)}/end`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: {},
      });
      return mcpSuccess(wrapNoticeFields(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('admin_report_list', {
    description: '관리자가 접수된 콘텐츠 신고 목록을 조회합니다.',
    inputSchema: {
      state: z.enum(['received', 'reviewed']).optional(),
    },
  }, async args => {
    try {
      if (runner && deps.services) {
        if (!deps.services.moderation) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '신고 관리 모듈이 아직 연결되지 않았어요.');
        }
        const auth = runner.authenticate(['admin']);
        const items = deps.services.moderation.listReportsForAdmin(auth.member.id, args.state);
        return mcpSuccess(wrapUntrustedValue(items));
      }
      const res = await bridgeRequest('GET', '/admin/reports', {
        auth: true,
        query: { state: args.state },
      });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('admin_report_review', {
    description: '관리자가 신고를 검토(deleted 또는 no_action) 처리합니다. 삭제 결정 시 confirm: true가 필요합니다.',
    inputSchema: {
      reportId: z.string().min(1),
      outcome: z.enum(['deleted', 'no_action']),
      resolutionReason: z.string().min(1),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      if (args.outcome === 'deleted') {
        requireConfirm(args.confirm, '신고 콘텐츠 삭제');
      }
      if (runner && deps.services) {
        if (!deps.services.moderation) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '신고 관리 모듈이 아직 연결되지 않았어요.');
        }
        const result = runner.executeWrite(
          'admin.reviewReport',
          ['write', 'admin'],
          args.idempotencyKey,
          args,
          memberId => deps.services!.moderation!.reviewReport({
            adminMemberId: memberId,
            reportId: args.reportId,
            outcome: args.outcome,
            resolutionReason: args.resolutionReason,
          }),
        );
        return mcpSuccess(result);
      }
      const res = await bridgeRequest('POST', `/admin/reports/${encodeURIComponent(args.reportId)}/review`, {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { outcome: args.outcome, resolutionReason: args.resolutionReason },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('admin_delete_content', {
    description: '관리자가 게시글·댓글·방명록·채팅 메시지를 사유와 함께 삭제합니다. confirm: true가 필요합니다.',
    inputSchema: {
      targetKind: z.enum(['post', 'comment', 'guestbook', 'chat']),
      targetId: z.string().min(1),
      reason: z.string().min(1),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().optional(),
    },
  }, async args => {
    try {
      requireConfirm(args.confirm, '관리자 콘텐츠 삭제');
      if (runner && deps.services) {
        const result = runner.executeWrite(
          'admin.deleteContent',
          ['write', 'admin'],
          args.idempotencyKey,
          { targetKind: args.targetKind, targetId: args.targetId, reason: args.reason },
          memberId => {
            if (deps.services!.moderation) {
              return deps.services!.moderation.adminDeleteContent({
                adminMemberId: memberId,
                targetKind: args.targetKind as ModerationTargetKind,
                targetId: args.targetId,
                reason: args.reason,
              });
            }
            switch (args.targetKind) {
              case 'post':
                return deps.services!.boardService.deletePost(memberId, args.targetId, { reason: args.reason });
              case 'comment':
                return deps.services!.boardService.deleteComment(memberId, args.targetId, { reason: args.reason });
              case 'guestbook':
                return deps.services!.guestbookService.deleteEntry(memberId, args.targetId, args.reason);
              case 'chat':
                return deps.services!.chatService.deleteMessage(memberId, args.targetId, args.reason);
            }
          },
        );
        return mcpSuccess(result);
      }
      const res = await bridgeRequest('POST', '/admin/delete', {
        auth: true,
        idempotencyKey: args.idempotencyKey,
        body: { targetKind: args.targetKind, targetId: args.targetId, reason: args.reason },
      });
      return mcpSuccess(res.data, res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('admin_deletion_history', {
    description: '관리자가 최근 90일 삭제 메타 이력(본문 사본 미저장)을 조회합니다.',
    inputSchema: {},
  }, async () => {
    try {
      if (runner && deps.services) {
        if (!deps.services.moderation) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '삭제 이력 모듈이 아직 연결되지 않았어요.');
        }
        const auth = runner.authenticate(['admin']);
        const items = deps.services.moderation.listDeletionHistory(auth.member.id);
        return mcpSuccess(wrapUntrustedValue(items));
      }
      const res = await bridgeRequest('GET', '/admin/deletions', { auth: true });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  // ========================
  // 8. Open Source Discovery & Demo AI
  // ========================
  server.registerTool('oss_list_popular_repos', {
    description: '공개 오픈소스 인기 저장소(누적 스타 순위, 대규모 포함)를 조회합니다.',
    inputSchema: {
      language: z.string().optional(),
      topic: z.string().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    try {
      if (deps.services) {
        if (!deps.services.discovery) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '오픈소스 탐색 모듈이 아직 연결되지 않았어요.');
        }
        const data = await deps.services.discovery.listPopularRepos(args);
        return mcpSuccess(wrapUntrustedValue(data));
      }
      const res = await bridgeRequest('GET', '/oss/popular', { query: args });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('oss_search_issues', {
    description: '중소규모·신생(365일)·7일 트렌드 기준의 열린 오픈소스 기여 이슈를 탐색합니다.',
    inputSchema: {
      language: z.string().optional(),
      topic: z.string().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async args => {
    try {
      if (deps.services) {
        if (!deps.services.discovery) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '오픈소스 탐색 모듈이 아직 연결되지 않았어요.');
        }
        const data = await deps.services.discovery.searchContributionIssues(args);
        return mcpSuccess(wrapUntrustedValue(data));
      }
      const res = await bridgeRequest('GET', '/oss/issues', { query: args });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('oss_get_issue', {
    description: '외부 오픈소스 이슈 원문 상세와 최신 상태·확인 시점을 조회합니다.',
    inputSchema: {
      issueId: z.string().min(1),
    },
  }, async args => {
    try {
      if (deps.services) {
        if (!deps.services.discovery) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '오픈소스 탐색 모듈이 아직 연결되지 않았어요.');
        }
        const data = await deps.services.discovery.getIssueDetail(args.issueId);
        return mcpSuccess(wrapUntrustedValue(data));
      }
      const res = await bridgeRequest('GET', '/oss/issue', { query: { id: args.issueId } });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });

  server.registerTool('oss_explain_issue_demo', {
    description: '오픈소스 이슈에 대한 데모 AI 설명(mode: demo, 원문 사실/추론/미확인 구분, 근거 링크)을 조회합니다.',
    inputSchema: {
      issueId: z.string().min(1),
    },
  }, async args => {
    try {
      if (deps.services) {
        if (!deps.services.discovery) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', '오픈소스 탐색 모듈이 아직 연결되지 않았어요.');
        }
        const data = await deps.services.discovery.explainIssue(args.issueId);
        return mcpSuccess(wrapUntrustedValue(data));
      }
      const res = await bridgeRequest('GET', '/oss/issue/explain', { query: { id: args.issueId } });
      return mcpSuccess(wrapUntrustedValue(res.data), res.meta);
    } catch (error) {
      return mcpError(error);
    }
  });
}

export function createTerminalWorldMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({
    name: 'terminal-world',
    version: '0.1.0',
  });
  registerTerminalWorldTools(server, deps);
  return server;
}
