import type { WorldDatabase } from '../store/sqlite/database.js';
import type { AuthService, MemberRecord, MemberRole, MemberState } from './auth-service.js';
import { normalizeIdempotencyKey } from './board-service.js';
import { addMinutes, addSeconds, type Clock } from './clock.js';
import { generateApprovalCode, generateId, generateToken, hashSecret, sha256Hex } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export type IntegrationChannel = 'cli' | 'mcp';
export type IntegrationScope = 'read' | 'write' | 'admin';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'exchanged' | 'expired';

export const APPROVAL_CODE_TTL_MINUTES = 5;
export const DEFAULT_GRANT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const MAX_NORMAL_GRANT_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
export const MAX_ADMIN_GRANT_TTL_SEC = 4 * 60 * 60; // 4 hours
export const NORMAL_ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const ADMIN_ACCESS_TOKEN_TTL_SEC = 30 * 60; // 30 minutes
export const NORMAL_REFRESH_TOKEN_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
export const ADMIN_REFRESH_TOKEN_TTL_SEC = 60 * 60; // 1 hour
export const IDEMPOTENCY_TTL_SEC = 24 * 60 * 60; // 24 hours

const VALID_SCOPES = new Set<IntegrationScope>(['read', 'write', 'admin']);
const VALID_CHANNELS = new Set<IntegrationChannel>(['cli', 'mcp']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface IntegrationGrantRecord {
  id: string;
  memberId: string;
  channel: IntegrationChannel;
  label: string;
  scopes: IntegrationScope[];
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface ApprovalRequestRecord {
  code: string;
  channel: IntegrationChannel;
  scopes: IntegrationScope[];
  requestedTtlSec: number;
  clientLabel: string;
  status: ApprovalStatus;
  approvedGrantId: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface StartApprovalInput {
  channel: IntegrationChannel;
  scopes: readonly IntegrationScope[];
  requestedTtlSec?: number;
  clientLabel: string;
}

export interface StartApprovalResult extends ApprovalRequestRecord {
  instructions: string;
}

export interface ApproveCodeInput {
  code: string;
  loginId: string;
  password: string;
  ttlSec?: number;
  ipAddress?: string;
}

export interface ApproveCodeResult {
  code: string;
  status: 'approved';
  grant: IntegrationGrantRecord;
  member: Pick<MemberRecord, 'id' | 'loginId' | 'nickname' | 'role'>;
}

export interface DenyCodeInput {
  code: string;
  loginId?: string;
  password?: string;
  ipAddress?: string;
}

export interface TokenPairResult {
  tokenType: 'Bearer';
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  grant: IntegrationGrantRecord;
  member: Pick<MemberRecord, 'id' | 'loginId' | 'nickname' | 'role'>;
  effectiveScopes: IntegrationScope[];
}

export interface AuthenticatedIntegrationContext {
  member: {
    id: string;
    loginId: string;
    nickname: string;
    role: MemberRole;
    roleVersion: number;
    state: MemberState;
  };
  grant: IntegrationGrantRecord;
  effectiveScopes: IntegrationScope[];
  accessTokenExpiresAt: string;
}

export interface ExecuteAuthorizedWriteOptions<T> {
  token: string;
  requiredScopes?: readonly IntegrationScope[];
  operation: string;
  idempotencyKey?: string;
  requestHash?: string;
  requestPayload?: unknown;
  fn: (auth: AuthenticatedIntegrationContext) => T;
}

interface ApprovalRow {
  code: string;
  requested_channel: IntegrationChannel;
  requested_scopes: string;
  requested_ttl_sec: number;
  client_label: string;
  status: ApprovalStatus;
  approved_grant_id: string | null;
  expires_at: string;
  created_at: string;
}

interface GrantRow {
  id: string;
  member_id: string;
  channel: IntegrationChannel;
  label: string;
  scopes: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

interface RefreshTokenJoinedRow {
  token_hash: string;
  grant_id: string;
  family_id: string;
  replaced_by_hash: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
  grant_member_id: string;
  grant_channel: IntegrationChannel;
  grant_label: string;
  grant_scopes: string;
  grant_expires_at: string;
  grant_revoked_at: string | null;
  grant_revoked_reason: string | null;
  grant_created_at: string;
  member_login_id: string;
  member_nickname: string;
  member_role: MemberRole;
  member_role_version: number;
  member_state: MemberState;
}

interface AccessTokenJoinedRow {
  token_hash: string;
  grant_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  grant_member_id: string;
  grant_channel: IntegrationChannel;
  grant_label: string;
  grant_scopes: string;
  grant_expires_at: string;
  grant_revoked_at: string | null;
  grant_revoked_reason: string | null;
  grant_created_at: string;
  member_login_id: string;
  member_nickname: string;
  member_role: MemberRole;
  member_role_version: number;
  member_state: MemberState;
}

interface IdempotencyRow {
  scope_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_json: string | null;
  expires_at: string;
}

function minIso(aIso: string, bIso: string): string {
  return new Date(aIso).getTime() <= new Date(bIso).getTime() ? aIso : bIso;
}

function parseChannel(channel: unknown): IntegrationChannel {
  if (typeof channel !== 'string' || !VALID_CHANNELS.has(channel as IntegrationChannel)) {
    throw new ServiceError('INVALID_INPUT', '연동 채널은 cli 또는 mcp여야 해요.', 'channel');
  }
  return channel as IntegrationChannel;
}

function parseScopes(scopes: unknown): IntegrationScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ServiceError('INVALID_INPUT', '최소 1개 이상의 권한 범위(read, write, admin)를 지정해 주세요.', 'scopes');
  }
  const deduped: IntegrationScope[] = [];
  for (const item of scopes) {
    if (typeof item !== 'string' || !VALID_SCOPES.has(item as IntegrationScope)) {
      throw new ServiceError('INVALID_INPUT', '권한 범위는 read, write, admin 중 하나여야 해요.', 'scopes');
    }
    const scope = item as IntegrationScope;
    if (!deduped.includes(scope)) {
      deduped.push(scope);
    }
  }
  return deduped;
}

function parseClientLabel(label: unknown): string {
  if (typeof label !== 'string') {
    throw new ServiceError('INVALID_INPUT', '클라이언트 이름을 입력해 주세요.', 'clientLabel');
  }
  const trimmed = label.normalize('NFC').trim();
  if (!trimmed || trimmed.length > 100 || CONTROL_CHARS.test(trimmed)) {
    throw new ServiceError('INVALID_INPUT', '클라이언트 이름은 제어문자 없이 1~100자로 입력해 주세요.', 'clientLabel');
  }
  return trimmed;
}

function parseApprovalCode(code: unknown): string {
  if (typeof code !== 'string') {
    throw new ServiceError('INVALID_INPUT', '6자리 승인 코드를 입력해 주세요.', 'code');
  }
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(normalized)) {
    throw new ServiceError('INVALID_INPUT', '승인 코드는 영문·숫자 6자리여야 해요.', 'code');
  }
  return normalized;
}

export function maxGrantTtlForScopes(scopes: readonly IntegrationScope[]): number {
  return scopes.includes('admin') ? MAX_ADMIN_GRANT_TTL_SEC : MAX_NORMAL_GRANT_TTL_SEC;
}

export function defaultGrantTtlForScopes(scopes: readonly IntegrationScope[]): number {
  return scopes.includes('admin') ? MAX_ADMIN_GRANT_TTL_SEC : DEFAULT_GRANT_TTL_SEC;
}

export function capGrantTtlSec(requestedSec: number | undefined, scopes: readonly IntegrationScope[]): number {
  const maxTtl = maxGrantTtlForScopes(scopes);
  if (requestedSec === undefined) {
    return defaultGrantTtlForScopes(scopes);
  }
  if (!Number.isInteger(requestedSec) || requestedSec <= 0) {
    throw new ServiceError('INVALID_INPUT', '유효 기간(초)은 1 이상의 정수여야 해요.', 'requestedTtlSec');
  }
  return Math.min(requestedSec, maxTtl);
}

export function computeEffectiveScopes(
  grantScopes: readonly IntegrationScope[],
  memberRole: MemberRole,
): IntegrationScope[] {
  if (memberRole === 'admin') {
    return [...grantScopes];
  }
  return grantScopes.filter(scope => scope !== 'admin');
}

function mapGrantRow(row: GrantRow): IntegrationGrantRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    channel: row.channel,
    label: row.label,
    scopes: JSON.parse(row.scopes) as IntegrationScope[],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
  };
}

function mapApprovalRow(row: ApprovalRow): ApprovalRequestRecord {
  return {
    code: row.code,
    channel: row.requested_channel,
    scopes: JSON.parse(row.requested_scopes) as IntegrationScope[],
    requestedTtlSec: row.requested_ttl_sec,
    clientLabel: row.client_label,
    status: row.status,
    approvedGrantId: row.approved_grant_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class IntegrationAuthService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    private readonly authService: AuthService,
  ) {}

  /**
   * Starts a browserless 6-character one-time approval flow (5-minute TTL).
   */
  startApproval(input: StartApprovalInput): StartApprovalResult {
    const channel = parseChannel(input.channel);
    const scopes = parseScopes(input.scopes);
    const clientLabel = parseClientLabel(input.clientLabel);
    const requestedTtlSec = capGrantTtlSec(input.requestedTtlSec, scopes);
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = addMinutes(now, APPROVAL_CODE_TTL_MINUTES);

    const record = this.worldDb.transaction(() => {
      let code = '';
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = generateApprovalCode();
        const exists = this.worldDb.db.prepare(
          'SELECT code FROM auth_approval_codes WHERE code = ?',
        ).get(candidate) as { code: string } | undefined;
        if (!exists) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        throw new ServiceError('INTERNAL_ERROR', '승인 코드를 생성하지 못했어요. 다시 시도해 주세요.');
      }

      this.worldDb.db.prepare(`
        INSERT INTO auth_approval_codes (
          code, requested_channel, requested_scopes, requested_ttl_sec,
          client_label, status, approved_grant_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `).run(
        code,
        channel,
        JSON.stringify(scopes),
        requestedTtlSec,
        clientLabel,
        expiresAt,
        nowIso,
      );

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.approval.start',
        outcome: 'success',
      });

      const row = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow;
      return mapApprovalRow(row);
    });

    return {
      ...record,
      instructions: `SSH TUI의 [a] 계정/연동 관리 또는 'terminal-world auth approve ${record.code}'에서 직접 로그인해 승인해 주세요. (5분 후 만료)`,
    };
  }

  getApprovalStatus(codeInput: string): ApprovalRequestRecord {
    const code = parseApprovalCode(codeInput);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow | undefined;

      if (!row) {
        throw new ServiceError('NOT_FOUND', '승인 코드를 찾을 수 없어요.', 'code');
      }

      if ((row.status === 'pending' || row.status === 'approved') && row.expires_at <= nowIso) {
        this.worldDb.db.prepare(
          "UPDATE auth_approval_codes SET status = 'expired' WHERE code = ?",
        ).run(code);
        return {
          ...mapApprovalRow(row),
          status: 'expired',
        };
      }

      return mapApprovalRow(row);
    });
  }

  /**
   * Approves a pending 6-character code after verifying credentials via `AuthService.login`.
   * Enforces active admin requirement for `admin` scope and absolute TTL caps (30d normal / 4h admin).
   */
  approveCode(input: ApproveCodeInput): ApproveCodeResult {
    const code = parseApprovalCode(input.code);
    const now = this.clock.now();
    const nowIso = now.toISOString();

    const initialRow = this.worldDb.transaction(() => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow | undefined;

      if (!row) {
        return { kind: 'not_found' as const };
      }
      if ((row.status === 'pending' || row.status === 'approved') && row.expires_at <= nowIso) {
        this.worldDb.db.prepare(
          "UPDATE auth_approval_codes SET status = 'expired' WHERE code = ?",
        ).run(code);
        return { kind: 'expired' as const };
      }
      return { kind: 'ok' as const, row };
    });

    if (initialRow.kind === 'not_found') {
      throw new ServiceError('NOT_FOUND', '승인 코드를 찾을 수 없어요.', 'code');
    }
    if (initialRow.kind === 'expired' || initialRow.row.status === 'expired') {
      throw new ServiceError('AUTH_EXPIRED', '승인 코드가 만료되었어요.', 'code');
    }
    if (initialRow.row.status === 'denied') {
      throw new ServiceError('AUTH_REVOKED', '이미 거부된 승인 코드예요.', 'code');
    }
    if (initialRow.row.status !== 'pending') {
      throw new ServiceError('CONFLICT', '이미 처리된 승인 코드예요.', 'code');
    }

    const scopes = JSON.parse(initialRow.row.requested_scopes) as IntegrationScope[];
    const effectiveTtlSec = capGrantTtlSec(input.ttlSec ?? initialRow.row.requested_ttl_sec, scopes);

    // Verify credentials outside the approval write transaction so login lockout counters commit on failure.
    const { member } = this.authService.login({
      loginId: input.loginId,
      password: input.password,
      ipAddress: input.ipAddress,
    });

    return this.worldDb.transaction(() => {
      const freshRow = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow | undefined;

      if (!freshRow) {
        throw new ServiceError('NOT_FOUND', '승인 코드를 찾을 수 없어요.', 'code');
      }
      if (freshRow.expires_at <= nowIso || freshRow.status === 'expired') {
        throw new ServiceError('AUTH_EXPIRED', '승인 코드가 만료되었어요.', 'code');
      }
      if (freshRow.status !== 'pending') {
        throw new ServiceError('CONFLICT', '이미 처리된 승인 코드예요.', 'code');
      }

      const liveMember = this.worldDb.db.prepare(
        'SELECT id, login_id, nickname, role, state FROM members WHERE id = ?',
      ).get(member.id) as {
        id: string;
        login_id: string;
        nickname: string;
        role: MemberRole;
        state: MemberState;
      } | undefined;

      if (!liveMember || liveMember.state !== 'active') {
        throw new ServiceError('UNAUTHORIZED', '활성 회원이 아니에요.');
      }

      if (scopes.includes('admin') && liveMember.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', '관리자 권한 범위는 현재 활성 관리자만 승인할 수 있어요.', 'scopes');
      }

      const grantId = generateId();
      const grantExpiresAt = addSeconds(nowIso, effectiveTtlSec);

      this.worldDb.db.prepare(`
        INSERT INTO integration_grants (
          id, member_id, channel, label, scopes, expires_at, revoked_at, revoked_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        grantId,
        liveMember.id,
        freshRow.requested_channel,
        freshRow.client_label,
        JSON.stringify(scopes),
        grantExpiresAt,
        nowIso,
      );

      const updateInfo = this.worldDb.db.prepare(`
        UPDATE auth_approval_codes
        SET status = 'approved', approved_grant_id = ?
        WHERE code = ? AND status = 'pending'
      `).run(grantId, code);

      if (updateInfo.changes !== 1) {
        throw new ServiceError('CONFLICT', '이미 처리된 승인 코드예요.', 'code');
      }

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.approval.approve',
        outcome: 'success',
        memberId: liveMember.id,
        loginIdSnapshot: liveMember.login_id,
        nicknameSnapshot: liveMember.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      const grantRow = this.worldDb.db.prepare(
        'SELECT * FROM integration_grants WHERE id = ?',
      ).get(grantId) as unknown as GrantRow;

      return {
        code,
        status: 'approved' as const,
        grant: mapGrantRow(grantRow),
        member: {
          id: liveMember.id,
          loginId: liveMember.login_id,
          nickname: liveMember.nickname,
          role: liveMember.role,
        },
      };
    });
  }

  /**
   * Denies a pending approval code. If credentials are provided, verifies them first.
   */
  denyCode(input: DenyCodeInput): ApprovalRequestRecord {
    const code = parseApprovalCode(input.code);
    const nowIso = this.clock.now().toISOString();

    let actorMember: MemberRecord | null = null;
    if (input.loginId !== undefined || input.password !== undefined) {
      if (!input.loginId || !input.password) {
        throw new ServiceError('INVALID_INPUT', '아이디와 비밀번호를 모두 입력해 주세요.');
      }
      actorMember = this.authService.login({
        loginId: input.loginId,
        password: input.password,
        ipAddress: input.ipAddress,
      }).member;
    }

    const outcome = this.worldDb.transaction((): { ok: true; record: ApprovalRequestRecord } | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow | undefined;

      if (!row) {
        return { ok: false, error: new ServiceError('NOT_FOUND', '승인 코드를 찾을 수 없어요.', 'code') };
      }
      if ((row.status === 'pending' || row.status === 'approved') && row.expires_at <= nowIso) {
        this.worldDb.db.prepare(
          "UPDATE auth_approval_codes SET status = 'expired' WHERE code = ?",
        ).run(code);
        return { ok: false, error: new ServiceError('AUTH_EXPIRED', '승인 코드가 만료되었어요.', 'code') };
      }
      if (row.status !== 'pending') {
        return { ok: false, error: new ServiceError('CONFLICT', '이미 처리된 승인 코드예요.', 'code') };
      }

      this.worldDb.db.prepare(
        "UPDATE auth_approval_codes SET status = 'denied' WHERE code = ? AND status = 'pending'",
      ).run(code);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.approval.deny',
        outcome: 'success',
        memberId: actorMember?.id ?? null,
        loginIdSnapshot: actorMember?.loginId ?? null,
        nicknameSnapshot: actorMember?.nickname ?? null,
        ipAddress: input.ipAddress ?? null,
      });

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow;
      return { ok: true, record: mapApprovalRow(updated) };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.record;
  }

  /**
   * Single-use exchange of an approved 6-char code for Access + one-time Refresh tokens.
   * Only SHA-256 hashes of tokens are stored in SQLite.
   */
  exchangeApprovalCode(codeInput: string): TokenPairResult {
    const code = parseApprovalCode(codeInput);
    const nowIso = this.clock.now().toISOString();

    const outcome = this.worldDb.transaction((): { ok: true; data: TokenPairResult } | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM auth_approval_codes WHERE code = ?',
      ).get(code) as unknown as ApprovalRow | undefined;

      if (!row) {
        return { ok: false, error: new ServiceError('NOT_FOUND', '승인 코드를 찾을 수 없어요.', 'code') };
      }
      if ((row.status === 'pending' || row.status === 'approved') && row.expires_at <= nowIso) {
        this.worldDb.db.prepare(
          "UPDATE auth_approval_codes SET status = 'expired' WHERE code = ?",
        ).run(code);
        return { ok: false, error: new ServiceError('AUTH_EXPIRED', '승인 코드가 만료되었어요.', 'code') };
      }
      if (row.status === 'pending') {
        return {
          ok: false,
          error: new ServiceError('CONFLICT', '아직 승인되지 않은 코드예요. 먼저 승인해 주세요.', 'code', { status: 'pending' }),
        };
      }
      if (row.status === 'denied') {
        return { ok: false, error: new ServiceError('AUTH_REVOKED', '거부된 승인 코드예요.', 'code', { status: 'denied' }) };
      }
      if (row.status === 'exchanged') {
        return { ok: false, error: new ServiceError('CONFLICT', '이미 교환된 승인 코드예요.', 'code', { status: 'exchanged' }) };
      }
      if (row.status === 'expired') {
        return { ok: false, error: new ServiceError('AUTH_EXPIRED', '승인 코드가 만료되었어요.', 'code', { status: 'expired' }) };
      }
      if (!row.approved_grant_id) {
        return { ok: false, error: new ServiceError('INTERNAL_ERROR', '승인된 연동 자격 정보를 찾을 수 없어요.') };
      }

      const grantRow = this.worldDb.db.prepare(
        'SELECT * FROM integration_grants WHERE id = ?',
      ).get(row.approved_grant_id) as unknown as GrantRow | undefined;

      if (!grantRow) {
        return { ok: false, error: new ServiceError('NOT_FOUND', '연동 자격을 찾을 수 없어요.') };
      }
      if (grantRow.revoked_at !== null) {
        return { ok: false, error: new ServiceError('AUTH_REVOKED', '회수된 연동 자격이에요.') };
      }
      if (grantRow.expires_at <= nowIso) {
        return { ok: false, error: new ServiceError('AUTH_EXPIRED', '연동 자격이 만료되었어요.') };
      }

      const memberRow = this.worldDb.db.prepare(
        'SELECT id, login_id, nickname, role, state FROM members WHERE id = ?',
      ).get(grantRow.member_id) as {
        id: string;
        login_id: string;
        nickname: string;
        role: MemberRole;
        state: MemberState;
      } | undefined;

      if (!memberRow || memberRow.state !== 'active') {
        return { ok: false, error: new ServiceError('AUTH_REVOKED', '유효한 활성 회원이 아니에요.') };
      }

      const grant = mapGrantRow(grantRow);
      const effectiveScopes = computeEffectiveScopes(grant.scopes, memberRow.role);
      if (effectiveScopes.length === 0) {
        return { ok: false, error: new ServiceError('FORBIDDEN', '유효한 권한 범위가 남아 있지 않아요.') };
      }

      const exchanged = this.worldDb.db.prepare(`
        UPDATE auth_approval_codes
        SET status = 'exchanged'
        WHERE code = ? AND status = 'approved'
      `).run(code);
      if (exchanged.changes !== 1) {
        return { ok: false, error: new ServiceError('CONFLICT', '이미 교환된 승인 코드예요.', 'code') };
      }

      const familyId = generateId();
      const pair = this.issueTokenPairInTx(grant, familyId, nowIso);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.approval.exchange',
        outcome: 'success',
        memberId: memberRow.id,
        loginIdSnapshot: memberRow.login_id,
        nicknameSnapshot: memberRow.nickname,
      });

      return {
        ok: true,
        data: {
          tokenType: 'Bearer',
          ...pair,
          grant,
          member: {
            id: memberRow.id,
            loginId: memberRow.login_id,
            nickname: memberRow.nickname,
            role: memberRow.role,
          },
          effectiveScopes,
        },
      };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.data;
  }

  /**
   * Rotates a one-time refresh token.
   * If a previously used refresh token is replayed (`used_at IS NOT NULL`), immediately revokes
   * the entire integration grant and all its access/refresh tokens and COMMITS before throwing
   * `ServiceError('TOKEN_REUSE_DETECTED', ...)`.
   */
  refreshTokens(refreshToken: string): TokenPairResult {
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      throw new ServiceError('UNAUTHORIZED', 'Refresh 토큰이 필요해요.');
    }

    const tokenHash = hashSecret(refreshToken.trim());
    const nowIso = this.clock.now().toISOString();

    const outcome = this.worldDb.transaction((): { ok: true; data: TokenPairResult } | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(`
        SELECT
          rt.token_hash,
          rt.grant_id,
          rt.family_id,
          rt.replaced_by_hash,
          rt.expires_at,
          rt.used_at,
          rt.revoked_at,
          rt.created_at,
          g.member_id AS grant_member_id,
          g.channel AS grant_channel,
          g.label AS grant_label,
          g.scopes AS grant_scopes,
          g.expires_at AS grant_expires_at,
          g.revoked_at AS grant_revoked_at,
          g.revoked_reason AS grant_revoked_reason,
          g.created_at AS grant_created_at,
          m.login_id AS member_login_id,
          m.nickname AS member_nickname,
          m.role AS member_role,
          m.role_version AS member_role_version,
          m.state AS member_state
        FROM refresh_tokens rt
        JOIN integration_grants g ON g.id = rt.grant_id
        JOIN members m ON m.id = g.member_id
        WHERE rt.token_hash = ?
      `).get(tokenHash) as unknown as RefreshTokenJoinedRow | undefined;

      if (!row) {
        return { ok: false, error: new ServiceError('AUTH_FAILED', '유효하지 않은 Refresh 토큰이에요.') };
      }

      if (row.used_at !== null) {
        this.revokeGrantInTx(row.grant_id, nowIso, 'refresh_token_reuse_detected');
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.refresh.reuse_detected',
          outcome: 'denied',
          errorCode: 'TOKEN_REUSE_DETECTED',
          memberId: row.grant_member_id,
          loginIdSnapshot: row.member_login_id,
          nicknameSnapshot: row.member_nickname,
        });
        return {
          ok: false,
          error: new ServiceError(
            'TOKEN_REUSE_DETECTED',
            '이미 사용된 Refresh 토큰이 다시 제출되어 해당 연동 승인과 모든 토큰을 즉시 회수했어요.',
          ),
        };
      }

      if (row.grant_revoked_at !== null || row.revoked_at !== null || row.member_state !== 'active') {
        return { ok: false, error: new ServiceError('AUTH_REVOKED', '회수되었거나 비활성화된 연동 자격이에요.') };
      }
      if (row.grant_expires_at <= nowIso || row.expires_at <= nowIso) {
        return { ok: false, error: new ServiceError('AUTH_EXPIRED', '만료된 Refresh 토큰이에요.') };
      }

      const grant: IntegrationGrantRecord = {
        id: row.grant_id,
        memberId: row.grant_member_id,
        channel: row.grant_channel,
        label: row.grant_label,
        scopes: JSON.parse(row.grant_scopes) as IntegrationScope[],
        expiresAt: row.grant_expires_at,
        revokedAt: row.grant_revoked_at,
        revokedReason: row.grant_revoked_reason,
        createdAt: row.grant_created_at,
      };

      const effectiveScopes = computeEffectiveScopes(grant.scopes, row.member_role);
      if (effectiveScopes.length === 0) {
        return { ok: false, error: new ServiceError('FORBIDDEN', '유효한 권한 범위가 남아 있지 않아요.') };
      }

      const pair = this.issueTokenPairInTx(grant, row.family_id, nowIso);
      const nextRefreshHash = hashSecret(pair.refreshToken);

      const usedUpdate = this.worldDb.db.prepare(`
        UPDATE refresh_tokens
        SET used_at = ?, replaced_by_hash = ?
        WHERE token_hash = ? AND used_at IS NULL
      `).run(nowIso, nextRefreshHash, tokenHash);

      if (usedUpdate.changes !== 1) {
        this.revokeGrantInTx(row.grant_id, nowIso, 'refresh_token_reuse_detected');
        return {
          ok: false,
          error: new ServiceError(
            'TOKEN_REUSE_DETECTED',
            'Refresh 토큰 동시 재사용이 감지되어 연동 승인을 회수했어요.',
          ),
        };
      }

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.refresh',
        outcome: 'success',
        memberId: row.grant_member_id,
        loginIdSnapshot: row.member_login_id,
        nicknameSnapshot: row.member_nickname,
      });

      return {
        ok: true,
        data: {
          tokenType: 'Bearer',
          ...pair,
          grant,
          member: {
            id: row.grant_member_id,
            loginId: row.member_login_id,
            nickname: row.member_nickname,
            role: row.member_role,
          },
          effectiveScopes,
        },
      };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.data;
  }

  /**
   * Authenticates an Access Token inside `BEGIN IMMEDIATE`, verifying live member state/role,
   * grant revocation/expiry, token revocation/expiry, and `member.role ∩ grant.scopes`.
   */
  authenticateAccessToken(
    token: string,
    requiredScopes: readonly IntegrationScope[] = [],
  ): AuthenticatedIntegrationContext {
    const nowIso = this.clock.now().toISOString();
    return this.worldDb.transaction(() => this.verifyAccessTokenInTx(token, requiredScopes, nowIso));
  }

  /**
   * Executes a protected write inside a SINGLE `BEGIN IMMEDIATE` transaction:
   * 1) Re-verifies member state/role, grant/token revocation & expiry, and `member.role ∩ grant.scopes`
   * 2) Enforces `idempotency_keys` (if provided)
   * 3) Executes `fn` and stores idempotent response before commit.
   */
  executeAuthorizedWrite<T>(options: ExecuteAuthorizedWriteOptions<T>): T {
    const requiredScopes = options.requiredScopes ?? ['write'];
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const auth = this.verifyAccessTokenInTx(options.token, requiredScopes, nowIso);

      if (!idempotencyKey) {
        return options.fn(auth);
      }

      const scopeKey = `${auth.member.id}:${options.operation}:${idempotencyKey}`;
      const requestHash = options.requestHash
        ?? sha256Hex(JSON.stringify(options.requestPayload ?? {}));

      const existing = this.worldDb.db.prepare(
        'SELECT scope_key, request_hash, status, response_json, expires_at FROM idempotency_keys WHERE scope_key = ?',
      ).get(scopeKey) as unknown as IdempotencyRow | undefined;

      if (existing) {
        if (existing.expires_at > nowIso) {
          if (existing.request_hash !== requestHash) {
            throw new ServiceError(
              'CONFLICT',
              '동일한 멱등성 키로 다른 요청을 전송할 수 없어요.',
              'idempotencyKey',
            );
          }
          if (existing.status === 'completed' && existing.response_json !== null) {
            return JSON.parse(existing.response_json) as T;
          }
          throw new ServiceError('CONFLICT', '동일한 요청이 이미 처리 중이에요.', 'idempotencyKey');
        }
        this.worldDb.db.prepare('DELETE FROM idempotency_keys WHERE scope_key = ?').run(scopeKey);
      }

      const expiresAt = addSeconds(nowIso, IDEMPOTENCY_TTL_SEC);
      this.worldDb.db.prepare(`
        INSERT INTO idempotency_keys (scope_key, request_hash, status, response_json, created_at, expires_at)
        VALUES (?, ?, 'in_progress', NULL, ?, ?)
      `).run(scopeKey, requestHash, nowIso, expiresAt);

      const result = options.fn(auth);

      this.worldDb.db.prepare(`
        UPDATE idempotency_keys
        SET status = 'completed', response_json = ?
        WHERE scope_key = ?
      `).run(JSON.stringify(result ?? null), scopeKey);

      return result;
    });
  }

  listGrants(memberId: string): IntegrationGrantRecord[] {
    try {
      const rows = this.worldDb.db.prepare(`
        SELECT * FROM integration_grants
        WHERE member_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(memberId) as unknown as GrantRow[];
      return rows.map(mapGrantRow);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  revokeGrant(memberId: string, grantId: string, reason = 'user_revoked'): IntegrationGrantRecord {
    const nowIso = this.clock.now().toISOString();
    return this.worldDb.transaction(() => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM integration_grants WHERE id = ?',
      ).get(grantId) as unknown as GrantRow | undefined;

      if (!row) {
        throw new ServiceError('NOT_FOUND', '연동 자격을 찾을 수 없어요.', 'grantId');
      }
      if (row.member_id !== memberId) {
        throw new ServiceError('FORBIDDEN', '본인의 연동 자격만 회수할 수 있어요.');
      }

      this.revokeGrantInTx(grantId, nowIso, reason);

      const member = this.worldDb.db.prepare(
        'SELECT login_id, nickname FROM members WHERE id = ?',
      ).get(memberId) as { login_id: string; nickname: string } | undefined;

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.grant.revoke',
        outcome: 'success',
        memberId,
        loginIdSnapshot: member?.login_id ?? null,
        nicknameSnapshot: member?.nickname ?? null,
      });

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM integration_grants WHERE id = ?',
      ).get(grantId) as unknown as GrantRow;
      return mapGrantRow(updated);
    });
  }

  revokeAllMemberGrants(memberId: string, reason = 'credentials_changed'): number {
    const nowIso = this.clock.now().toISOString();
    return this.worldDb.transaction(() => {
      const grants = this.worldDb.db.prepare(
        'SELECT id FROM integration_grants WHERE member_id = ? AND revoked_at IS NULL',
      ).all(memberId) as Array<{ id: string }>;

      for (const grant of grants) {
        this.revokeGrantInTx(grant.id, nowIso, reason);
      }
      return grants.length;
    });
  }

  private verifyAccessTokenInTx(
    token: string,
    requiredScopes: readonly IntegrationScope[],
    nowIso: string,
  ): AuthenticatedIntegrationContext {
    if (typeof token !== 'string' || !token.trim()) {
      throw new ServiceError('UNAUTHORIZED', '인증 토큰이 필요해요.');
    }

    const tokenHash = hashSecret(token.trim());
    const row = this.worldDb.db.prepare(`
      SELECT
        at.token_hash,
        at.grant_id,
        at.expires_at,
        at.revoked_at,
        at.created_at,
        g.member_id AS grant_member_id,
        g.channel AS grant_channel,
        g.label AS grant_label,
        g.scopes AS grant_scopes,
        g.expires_at AS grant_expires_at,
        g.revoked_at AS grant_revoked_at,
        g.revoked_reason AS grant_revoked_reason,
        g.created_at AS grant_created_at,
        m.login_id AS member_login_id,
        m.nickname AS member_nickname,
        m.role AS member_role,
        m.role_version AS member_role_version,
        m.state AS member_state
      FROM access_tokens at
      JOIN integration_grants g ON g.id = at.grant_id
      JOIN members m ON m.id = g.member_id
      WHERE at.token_hash = ?
    `).get(tokenHash) as unknown as AccessTokenJoinedRow | undefined;

    if (!row) {
      throw new ServiceError('UNAUTHORIZED', '유효하지 않은 인증 토큰이에요.');
    }
    if (row.member_state !== 'active') {
      throw new ServiceError('AUTH_REVOKED', '탈퇴했거나 비활성화된 계정이에요.');
    }
    if (row.grant_revoked_at !== null || row.revoked_at !== null) {
      throw new ServiceError('AUTH_REVOKED', '회수된 인증 토큰이에요.');
    }
    if (row.grant_expires_at <= nowIso || row.expires_at <= nowIso) {
      throw new ServiceError('AUTH_EXPIRED', '만료된 인증 토큰이에요.');
    }

    const grant: IntegrationGrantRecord = {
      id: row.grant_id,
      memberId: row.grant_member_id,
      channel: row.grant_channel,
      label: row.grant_label,
      scopes: JSON.parse(row.grant_scopes) as IntegrationScope[],
      expiresAt: row.grant_expires_at,
      revokedAt: row.grant_revoked_at,
      revokedReason: row.grant_revoked_reason,
      createdAt: row.grant_created_at,
    };

    const effectiveScopes = computeEffectiveScopes(grant.scopes, row.member_role);
    for (const required of requiredScopes) {
      if (!effectiveScopes.includes(required)) {
        throw new ServiceError('FORBIDDEN', `필요한 권한 범위(${required})가 없어요.`);
      }
    }

    return {
      member: {
        id: row.grant_member_id,
        loginId: row.member_login_id,
        nickname: row.member_nickname,
        role: row.member_role,
        roleVersion: row.member_role_version,
        state: row.member_state,
      },
      grant,
      effectiveScopes,
      accessTokenExpiresAt: row.expires_at,
    };
  }

  private issueTokenPairInTx(
    grant: IntegrationGrantRecord,
    familyId: string,
    nowIso: string,
  ): {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    refreshTokenExpiresAt: string;
  } {
    const hasAdmin = grant.scopes.includes('admin');
    const accessTtl = hasAdmin ? ADMIN_ACCESS_TOKEN_TTL_SEC : NORMAL_ACCESS_TOKEN_TTL_SEC;
    const refreshTtl = hasAdmin ? ADMIN_REFRESH_TOKEN_TTL_SEC : NORMAL_REFRESH_TOKEN_TTL_SEC;

    const accessToken = generateToken(32);
    const refreshToken = generateToken(32);
    const accessExpiresAt = minIso(addSeconds(nowIso, accessTtl), grant.expiresAt);
    const refreshExpiresAt = minIso(addSeconds(nowIso, refreshTtl), grant.expiresAt);

    this.worldDb.db.prepare(`
      INSERT INTO access_tokens (token_hash, grant_id, expires_at, revoked_at, created_at)
      VALUES (?, ?, ?, NULL, ?)
    `).run(hashSecret(accessToken), grant.id, accessExpiresAt, nowIso);

    this.worldDb.db.prepare(`
      INSERT INTO refresh_tokens (
        token_hash, grant_id, family_id, replaced_by_hash, expires_at, used_at, revoked_at, created_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?)
    `).run(hashSecret(refreshToken), grant.id, familyId, refreshExpiresAt, nowIso);

    return {
      accessToken,
      accessTokenExpiresAt: accessExpiresAt,
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }

  private revokeGrantInTx(grantId: string, nowIso: string, reason: string): void {
    this.worldDb.db.prepare(`
      UPDATE integration_grants
      SET revoked_at = COALESCE(revoked_at, ?),
          revoked_reason = COALESCE(revoked_reason, ?)
      WHERE id = ?
    `).run(nowIso, reason, grantId);

    this.worldDb.db.prepare(`
      UPDATE access_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE grant_id = ? AND revoked_at IS NULL
    `).run(nowIso, grantId);

    this.worldDb.db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE grant_id = ? AND revoked_at IS NULL
    `).run(nowIso, grantId);
  }
}
