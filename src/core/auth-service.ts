import { parseAccountName, parsePassword } from '../service/validation.js';
import type { ServiceTheme } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { addMinutes, type Clock } from './clock.js';
import {
  generateId,
  generateRecoveryCode,
  hashPassword,
  hashSecret,
  verifyPassword,
} from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MINUTES = 5;

export type MemberRole = 'member' | 'admin';
export type MemberState = 'active' | 'withdrawn';

export interface MemberRecord {
  id: string;
  loginId: string;
  loginIdKey: string;
  nickname: string;
  nicknameKey: string;
  role: MemberRole;
  roleVersion: number;
  state: MemberState;
  failedLoginCount: number;
  loginLockedUntil: string | null;
  failedRecoveryCount: number;
  recoveryLockedUntil: string | null;
  createdAt: string;
  withdrawnAt: string | null;
  piiPurgeAt: string | null;
}

export interface PersonalSpaceSummary {
  id: string;
  memberId: string;
  asciiArt: string;
  colorTheme: ServiceTheme;
  gridSlot: number;
  updatedAt: string;
}

export interface SignupInput {
  loginId: string;
  nickname: string;
  password: string;
  ipAddress?: string;
}

export interface SignupResult {
  member: MemberRecord;
  personalSpace: PersonalSpaceSummary;
  /** Formatted 32-char recovery code (XXXX-XXXX-...) returned ONCE on signup. */
  recoveryCode: string;
  /** Unformatted 32-char recovery code. */
  recoveryCodeRaw: string;
}

export interface LoginInput {
  loginId: string;
  password: string;
  ipAddress?: string;
}

export interface LoginResult {
  member: MemberRecord;
}

interface MemberRow {
  id: string;
  login_id: string;
  login_id_key: string;
  nickname: string;
  nickname_key: string;
  password_hash: string;
  role: MemberRole;
  role_version: number;
  state: MemberState;
  failed_login_count: number;
  login_locked_until: string | null;
  failed_recovery_count: number;
  recovery_locked_until: string | null;
  created_at: string;
  withdrawn_at: string | null;
  pii_purge_at: string | null;
}

function mapMemberRow(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    loginId: row.login_id,
    loginIdKey: row.login_id_key,
    nickname: row.nickname,
    nicknameKey: row.nickname_key,
    role: row.role,
    roleVersion: row.role_version,
    state: row.state,
    failedLoginCount: row.failed_login_count,
    loginLockedUntil: row.login_locked_until,
    failedRecoveryCount: row.failed_recovery_count,
    recoveryLockedUntil: row.recovery_locked_until,
    createdAt: row.created_at,
    withdrawnAt: row.withdrawn_at,
    piiPurgeAt: row.pii_purge_at,
  };
}

export class AuthService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * Atomically creates member, default profile, personal space (grid_slot), and one-time recovery code.
   * Enforces case-insensitive loginId/nickname uniqueness and 90-day withdrawn name reservations.
   */
  signup(input: SignupInput): SignupResult {
    let parsedLoginId: { value: string; lookupKey: string };
    let parsedNickname: { value: string; lookupKey: string };
    let parsedPassword: string;
    try {
      parsedLoginId = parseAccountName('loginId', input.loginId);
      parsedNickname = parseAccountName('nickname', input.nickname);
      parsedPassword = parsePassword(input.password);
    } catch (error) {
      throw toServiceError(error);
    }

    const nowIso = this.clock.now().toISOString();
    const memberId = generateId();
    const spaceId = `space:member:${memberId}`;
    const passwordHash = hashPassword(parsedPassword);
    const recovery = generateRecoveryCode();
    const recoveryHash = hashSecret(recovery.raw);

    const created = this.worldDb.transaction(() => {
      const reservedLogin = this.worldDb.db.prepare(`
        SELECT reserved_until FROM name_reservations
        WHERE kind = 'login_id' AND lookup_key = ? AND reserved_until > ?
      `).get(parsedLoginId.lookupKey, nowIso) as { reserved_until: string } | undefined;
      if (reservedLogin) {
        throw new ServiceError('CONFLICT', '이미 사용 중이거나 재사용이 제한된 아이디예요.', 'loginId');
      }

      const reservedNickname = this.worldDb.db.prepare(`
        SELECT reserved_until FROM name_reservations
        WHERE kind = 'nickname' AND lookup_key = ? AND reserved_until > ?
      `).get(parsedNickname.lookupKey, nowIso) as { reserved_until: string } | undefined;
      if (reservedNickname) {
        throw new ServiceError('CONFLICT', '이미 사용 중이거나 재사용이 제한된 닉네임이에요.', 'nickname');
      }

      const existingLogin = this.worldDb.db.prepare(
        'SELECT id FROM members WHERE login_id_key = ?',
      ).get(parsedLoginId.lookupKey) as { id: string } | undefined;
      if (existingLogin) {
        throw new ServiceError('CONFLICT', '이미 사용 중인 아이디예요.', 'loginId');
      }

      const existingNickname = this.worldDb.db.prepare(
        'SELECT id FROM members WHERE nickname_key = ?',
      ).get(parsedNickname.lookupKey) as { id: string } | undefined;
      if (existingNickname) {
        throw new ServiceError('CONFLICT', '이미 사용 중인 닉네임예요.', 'nickname');
      }

      try {
        this.worldDb.db.prepare(`
          INSERT INTO members (
            id, login_id, login_id_key, nickname, nickname_key, password_hash,
            role, role_version, state, failed_login_count, failed_recovery_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'member', 1, 'active', 0, 0, ?)
        `).run(
          memberId,
          parsedLoginId.value,
          parsedLoginId.lookupKey,
          parsedNickname.value,
          parsedNickname.lookupKey,
          passwordHash,
          nowIso,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('members.login_id_key')) {
          throw new ServiceError('CONFLICT', '이미 사용 중인 아이디예요.', 'loginId');
        }
        if (message.includes('members.nickname_key')) {
          throw new ServiceError('CONFLICT', '이미 사용 중인 닉네임예요.', 'nickname');
        }
        throw toServiceError(error);
      }

      this.worldDb.db.prepare(`
        INSERT INTO profiles (member_id, introduction, technology_stack_json, current_status, project_url, updated_at)
        VALUES (?, '', '[]', '', '', ?)
      `).run(memberId, nowIso);

      const usedSlots = this.worldDb.db.prepare(
        'SELECT grid_slot FROM personal_spaces ORDER BY grid_slot ASC',
      ).all() as Array<{ grid_slot: number }>;
      let gridSlot = 0;
      for (const row of usedSlots) {
        if (row.grid_slot === gridSlot) {
          gridSlot += 1;
        } else if (row.grid_slot > gridSlot) {
          break;
        }
      }

      this.worldDb.db.prepare(`
        INSERT INTO personal_spaces (id, member_id, ascii_art, color_theme, grid_slot, updated_at)
        VALUES (?, ?, '', 'dark', ?, ?)
      `).run(spaceId, memberId, gridSlot, nowIso);

      this.worldDb.db.prepare(`
        INSERT INTO recovery_credentials (member_id, code_hash, issued_at, consumed_at)
        VALUES (?, ?, ?, NULL)
      `).run(memberId, recoveryHash, nowIso);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.signup',
        outcome: 'success',
        memberId,
        loginIdSnapshot: parsedLoginId.value,
        nicknameSnapshot: parsedNickname.value,
        ipAddress: input.ipAddress ?? null,
      });

      const memberRow = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE id = ?',
      ).get(memberId) as unknown as MemberRow;

      return {
        member: mapMemberRow(memberRow),
        personalSpace: {
          id: spaceId,
          memberId,
          asciiArt: '',
          colorTheme: 'dark' as ServiceTheme,
          gridSlot,
          updatedAt: nowIso,
        },
      };
    });

    return {
      ...created,
      recoveryCode: recovery.formatted,
      recoveryCodeRaw: recovery.raw,
    };
  }

  /**
   * Authenticates an active member by case-insensitive loginId and password.
   * Locks login for 5 minutes after 5 consecutive failures.
   */
  login(input: LoginInput): LoginResult {
    const rawLoginId = typeof input.loginId === 'string' ? input.loginId.normalize('NFC').trim() : '';
    const rawPassword = typeof input.password === 'string' ? input.password : '';
    if (!rawLoginId || !rawPassword) {
      throw new ServiceError('AUTH_FAILED', '아이디 또는 비밀번호를 확인해 주세요.');
    }

    const loginIdKey = rawLoginId.toLowerCase();
    const now = this.clock.now();
    const nowIso = now.toISOString();

    const outcome = this.worldDb.transaction((): { ok: true; member: MemberRecord } | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE login_id_key = ?',
      ).get(loginIdKey) as unknown as MemberRow | undefined;

      if (!row || row.state !== 'active') {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.login',
          outcome: 'failure',
          errorCode: 'AUTH_FAILED',
          loginIdSnapshot: rawLoginId,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError('AUTH_FAILED', '아이디 또는 비밀번호를 확인해 주세요.'),
        };
      }

      if (row.login_locked_until && row.login_locked_until > nowIso) {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.login',
          outcome: 'denied',
          errorCode: 'AUTH_LOCKED',
          memberId: row.id,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError(
            'AUTH_LOCKED',
            '로그인 시도가 5회 연속 실패해 5분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.',
            undefined,
            { lockedUntil: row.login_locked_until },
          ),
        };
      }

      // If a previous lock expired, reset the counter before evaluating this attempt.
      const baseFailures = row.login_locked_until && row.login_locked_until <= nowIso
        ? 0
        : row.failed_login_count;

      if (!verifyPassword(rawPassword, row.password_hash)) {
        const nextFailures = baseFailures + 1;
        const lockedUntil = nextFailures >= LOGIN_MAX_FAILURES
          ? addMinutes(now, LOGIN_LOCK_MINUTES)
          : null;

        this.worldDb.db.prepare(`
          UPDATE members
          SET failed_login_count = ?, login_locked_until = ?
          WHERE id = ?
        `).run(nextFailures, lockedUntil, row.id);

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.login',
          outcome: 'failure',
          errorCode: lockedUntil ? 'AUTH_LOCKED' : 'AUTH_FAILED',
          memberId: row.id,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
          ipAddress: input.ipAddress ?? null,
        });

        if (lockedUntil) {
          return {
            ok: false,
            error: new ServiceError(
              'AUTH_LOCKED',
              '로그인 시도가 5회 연속 실패해 5분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.',
              undefined,
              { lockedUntil },
            ),
          };
        }
        return {
          ok: false,
          error: new ServiceError('AUTH_FAILED', '아이디 또는 비밀번호를 확인해 주세요.'),
        };
      }

      this.worldDb.db.prepare(`
        UPDATE members
        SET failed_login_count = 0, login_locked_until = NULL
        WHERE id = ?
      `).run(row.id);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.login',
        outcome: 'success',
        memberId: row.id,
        loginIdSnapshot: row.login_id,
        nicknameSnapshot: row.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE id = ?',
      ).get(row.id) as unknown as MemberRow;

      return { ok: true, member: mapMemberRow(updated) };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }
    return { member: outcome.member };
  }

  /**
   * Changes a member's role and increments `role_version` so privilege revocation takes immediate effect.
   */
  setMemberRole(memberId: string, role: MemberRole): MemberRecord {
    const nowIso = this.clock.now().toISOString();
    return this.worldDb.transaction(() => {
      const existing = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE id = ? AND state = \'active\'',
      ).get(memberId) as unknown as MemberRow | undefined;
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '활성 회원을 찾을 수 없어요.');
      }

      this.worldDb.db.prepare(`
        UPDATE members
        SET role = ?, role_version = role_version + 1
        WHERE id = ?
      `).run(role, memberId);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'admin.role_change',
        outcome: 'success',
        memberId,
        loginIdSnapshot: existing.login_id,
        nicknameSnapshot: existing.nickname,
      });

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE id = ?',
      ).get(memberId) as unknown as MemberRow;
      return mapMemberRow(updated);
    });
  }

  getMemberById(memberId: string): MemberRecord | null {
    const row = this.worldDb.db.prepare(
      'SELECT * FROM members WHERE id = ?',
    ).get(memberId) as unknown as MemberRow | undefined;
    return row ? mapMemberRow(row) : null;
  }

  getMemberByLoginId(loginId: string): MemberRecord | null {
    const key = loginId.normalize('NFC').toLowerCase();
    const row = this.worldDb.db.prepare(
      'SELECT * FROM members WHERE login_id_key = ?',
    ).get(key) as unknown as MemberRow | undefined;
    return row ? mapMemberRow(row) : null;
  }

  getMemberByNickname(nickname: string): MemberRecord | null {
    const key = nickname.normalize('NFC').toLowerCase();
    const row = this.worldDb.db.prepare(
      'SELECT * FROM members WHERE nickname_key = ?',
    ).get(key) as unknown as MemberRow | undefined;
    return row ? mapMemberRow(row) : null;
  }

  listActiveMembers(): MemberRecord[] {
    const rows = this.worldDb.db.prepare(
      "SELECT * FROM members WHERE state = 'active' ORDER BY created_at ASC",
    ).all() as unknown as MemberRow[];
    return rows.map(mapMemberRow);
  }
}
