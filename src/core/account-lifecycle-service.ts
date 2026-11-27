import { parsePassword } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import type { MemberRecord, MemberRole, MemberState } from './auth-service.js';
import { addDays, addMinutes, splitByKstMidnight, type Clock } from './clock.js';
import {
  generateRecoveryCode,
  hashPassword,
  hashSecret,
  verifyPassword,
} from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';
import { computePresenceStatus } from './presence-service.js';
import type { PresenceStatus, RealtimeHub } from './realtime-hub.js';

export const RECOVERY_MAX_FAILURES = 5;
export const RECOVERY_LOCK_MINUTES = 30;
export const WITHDRAWAL_RETENTION_DAYS = 90;

export interface AccountLifecycleOptions {
  hub?: RealtimeHub;
}

export interface RecoverAccountInput {
  loginId: string;
  recoveryCode: string;
  newPassword: string;
  ipAddress?: string;
}

export interface RecoverAccountResult {
  member: MemberRecord;
  /** Formatted 32-char recovery code (XXXX-XXXX-...) returned ONCE. */
  recoveryCode: string;
  /** Unformatted 32-char recovery code. */
  recoveryCodeRaw: string;
  closedSessionCount: number;
  revokedGrantCount: number;
}

export interface ChangePasswordInput {
  memberId: string;
  currentPassword: string;
  newPassword: string;
  currentSessionId?: string | null;
  ipAddress?: string;
}

export interface ChangePasswordResult {
  changed: true;
  preservedSessionId: string | null;
  closedSessionCount: number;
  revokedGrantCount: number;
}

export interface ReissueRecoveryCodeInput {
  memberId: string;
  currentPassword: string;
  ipAddress?: string;
}

export interface ReissueRecoveryCodeResult {
  recoveryCode: string;
  recoveryCodeRaw: string;
  issuedAt: string;
}

export interface WithdrawAccountInput {
  memberId: string;
  password: string;
  confirm: boolean;
  ipAddress?: string;
}

export interface WithdrawAccountResult {
  withdrawn: true;
  memberId: string;
  withdrawnAt: string;
  piiPurgeAt: string;
  closedSessionCount: number;
  revokedGrantCount: number;
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

interface SessionRow {
  id: string;
  member_id: string | null;
  is_guest: number;
  current_space_id: string;
}

interface FocusSessionRow {
  id: string;
  member_id: string;
  started_session_id: string;
  started_at: string;
  ended_at: string | null;
  counted_seconds: number | null;
}

interface ClosedSessionSideEffects {
  closedSessions: Array<{ id: string; memberId: string | null; isGuest: boolean }>;
  stoppedFocus: {
    id: string;
    memberId: string;
    nickname: string;
    startedAt: string;
    endedAt: string;
    countedSeconds: number;
  } | null;
  presenceAfter: {
    memberId: string;
    nickname: string;
    status: PresenceStatus;
    activeSessionCount: number;
  } | null;
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

export class AccountLifecycleService {
  private readonly hub?: RealtimeHub;

  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    options: AccountLifecycleOptions = {},
  ) {
    this.hub = options.hub;
  }

  /**
   * Recovers an active account using its single-use 32-char recovery code.
   * Tracks `failed_recovery_count` separately from login failures (5 failures => 30m lock)
   * and commits failure counters before throwing.
   */
  recoverAccount(input: RecoverAccountInput): RecoverAccountResult {
    let parsedNewPassword: string;
    try {
      parsedNewPassword = parsePassword(input.newPassword);
    } catch (error) {
      throw toServiceError(error);
    }

    const rawLoginId = typeof input.loginId === 'string' ? input.loginId.normalize('NFC').trim() : '';
    const normalizedCode = typeof input.recoveryCode === 'string'
      ? input.recoveryCode.trim().replaceAll('-', '').toUpperCase()
      : '';

    if (!rawLoginId || !normalizedCode) {
      throw new ServiceError('RECOVERY_FAILED', '아이디 또는 복구 코드를 확인해 주세요.');
    }

    const loginIdKey = rawLoginId.toLowerCase();
    const codeHash = hashSecret(normalizedCode);
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const nextPasswordHash = hashPassword(parsedNewPassword);
    const nextRecovery = generateRecoveryCode();
    const nextRecoveryHash = hashSecret(nextRecovery.raw);

    const outcome = this.worldDb.transaction(():
      | {
          ok: true;
          member: MemberRecord;
          closedSessionCount: number;
          revokedGrantCount: number;
          sideEffects: ClosedSessionSideEffects;
        }
      | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE login_id_key = ?',
      ).get(loginIdKey) as unknown as MemberRow | undefined;

      if (!row || row.state !== 'active') {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.recover',
          outcome: 'failure',
          errorCode: 'RECOVERY_FAILED',
          loginIdSnapshot: rawLoginId,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError('RECOVERY_FAILED', '아이디 또는 복구 코드를 확인해 주세요.'),
        };
      }

      if (row.recovery_locked_until && row.recovery_locked_until > nowIso) {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.recover',
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
            '복구 시도가 5회 연속 실패해 30분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.',
            undefined,
            { lockedUntil: row.recovery_locked_until },
          ),
        };
      }

      const baseFailures = row.recovery_locked_until && row.recovery_locked_until <= nowIso
        ? 0
        : row.failed_recovery_count;

      const consumeInfo = this.worldDb.db.prepare(`
        UPDATE recovery_credentials
        SET consumed_at = ?
        WHERE member_id = ? AND code_hash = ? AND consumed_at IS NULL
      `).run(nowIso, row.id, codeHash);

      if (consumeInfo.changes !== 1) {
        const nextFailures = baseFailures + 1;
        const lockedUntil = nextFailures >= RECOVERY_MAX_FAILURES
          ? addMinutes(now, RECOVERY_LOCK_MINUTES)
          : null;

        this.worldDb.db.prepare(`
          UPDATE members
          SET failed_recovery_count = ?, recovery_locked_until = ?
          WHERE id = ?
        `).run(nextFailures, lockedUntil, row.id);

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.recover',
          outcome: 'failure',
          errorCode: lockedUntil ? 'AUTH_LOCKED' : 'RECOVERY_FAILED',
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
              '복구 시도가 5회 연속 실패해 30분 동안 잠겼어요. 잠시 후 다시 시도해 주세요.',
              undefined,
              { lockedUntil },
            ),
          };
        }
        return {
          ok: false,
          error: new ServiceError('RECOVERY_FAILED', '아이디 또는 복구 코드를 확인해 주세요.'),
        };
      }

      this.worldDb.db.prepare(`
        UPDATE members
        SET password_hash = ?,
            failed_recovery_count = 0,
            recovery_locked_until = NULL,
            failed_login_count = 0,
            login_locked_until = NULL
        WHERE id = ?
      `).run(nextPasswordHash, row.id);

      this.worldDb.db.prepare(`
        INSERT INTO recovery_credentials (member_id, code_hash, issued_at, consumed_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(member_id) DO UPDATE SET
          code_hash = excluded.code_hash,
          issued_at = excluded.issued_at,
          consumed_at = NULL
      `).run(row.id, nextRecoveryHash, nowIso);

      const sideEffects = this.closeMemberSessionsInTx(row.id, row.nickname, null, nowIso, 'account_recovered');
      const revokedGrantCount = this.revokeAllIntegrationsInTx(row.id, nowIso, 'account_recovered');

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.recover',
        outcome: 'success',
        memberId: row.id,
        loginIdSnapshot: row.login_id,
        nicknameSnapshot: row.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM members WHERE id = ?',
      ).get(row.id) as unknown as MemberRow;

      return {
        ok: true,
        member: mapMemberRow(updated),
        closedSessionCount: sideEffects.closedSessions.length,
        revokedGrantCount,
        sideEffects,
      };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }

    this.publishSessionSideEffects(outcome.sideEffects, nowIso, 'account_recovered');

    return {
      member: outcome.member,
      recoveryCode: nextRecovery.formatted,
      recoveryCodeRaw: nextRecovery.raw,
      closedSessionCount: outcome.closedSessionCount,
      revokedGrantCount: outcome.revokedGrantCount,
    };
  }

  /**
   * Changes an active member's password, preserves `currentSessionId` and `recovery_credentials`,
   * closes all OTHER active `user_sessions` (stopping focus only if a closed session started it),
   * and revokes all `integration_grants`, `access_tokens`, and `refresh_tokens`.
   */
  changePassword(input: ChangePasswordInput): ChangePasswordResult {
    let parsedNewPassword: string;
    try {
      parsedNewPassword = parsePassword(input.newPassword);
    } catch (error) {
      throw toServiceError(error);
    }

    const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    if (!currentPassword) {
      throw new ServiceError('AUTH_FAILED', '현재 비밀번호를 입력해 주세요.', 'currentPassword');
    }

    const nowIso = this.clock.now().toISOString();
    const nextPasswordHash = hashPassword(parsedNewPassword);
    const keepSessionId = input.currentSessionId ?? null;

    const outcome = this.worldDb.transaction(():
      | {
          ok: true;
          closedSessionCount: number;
          revokedGrantCount: number;
          sideEffects: ClosedSessionSideEffects;
        }
      | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        "SELECT * FROM members WHERE id = ? AND state = 'active'",
      ).get(input.memberId) as unknown as MemberRow | undefined;

      if (!row) {
        return {
          ok: false,
          error: new ServiceError('UNAUTHORIZED', '활성 회원 계정을 찾을 수 없어요.'),
        };
      }

      if (!verifyPassword(currentPassword, row.password_hash)) {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.change_password',
          outcome: 'failure',
          errorCode: 'AUTH_FAILED',
          memberId: row.id,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError('AUTH_FAILED', '현재 비밀번호가 일치하지 않아요.', 'currentPassword'),
        };
      }

      this.worldDb.db.prepare(
        'UPDATE members SET password_hash = ? WHERE id = ?',
      ).run(nextPasswordHash, row.id);

      const sideEffects = this.closeMemberSessionsInTx(
        row.id,
        row.nickname,
        keepSessionId,
        nowIso,
        'password_changed',
      );
      const revokedGrantCount = this.revokeAllIntegrationsInTx(row.id, nowIso, 'password_changed');

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.change_password',
        outcome: 'success',
        memberId: row.id,
        loginIdSnapshot: row.login_id,
        nicknameSnapshot: row.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      return {
        ok: true,
        closedSessionCount: sideEffects.closedSessions.length,
        revokedGrantCount,
        sideEffects,
      };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }

    this.publishSessionSideEffects(outcome.sideEffects, nowIso, 'password_changed');

    return {
      changed: true,
      preservedSessionId: keepSessionId,
      closedSessionCount: outcome.closedSessionCount,
      revokedGrantCount: outcome.revokedGrantCount,
    };
  }

  /**
   * Verifies the current password and replaces `recovery_credentials`, returning the new 32-char code once.
   */
  reissueRecoveryCode(input: ReissueRecoveryCodeInput): ReissueRecoveryCodeResult {
    const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : '';
    if (!currentPassword) {
      throw new ServiceError('AUTH_FAILED', '현재 비밀번호를 입력해 주세요.', 'currentPassword');
    }

    const nowIso = this.clock.now().toISOString();
    const nextRecovery = generateRecoveryCode();
    const nextRecoveryHash = hashSecret(nextRecovery.raw);

    const outcome = this.worldDb.transaction((): { ok: true } | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        "SELECT * FROM members WHERE id = ? AND state = 'active'",
      ).get(input.memberId) as unknown as MemberRow | undefined;

      if (!row) {
        return {
          ok: false,
          error: new ServiceError('UNAUTHORIZED', '활성 회원 계정을 찾을 수 없어요.'),
        };
      }

      if (!verifyPassword(currentPassword, row.password_hash)) {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.recovery_code_reissue',
          outcome: 'failure',
          errorCode: 'AUTH_FAILED',
          memberId: row.id,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError('AUTH_FAILED', '현재 비밀번호가 일치하지 않아요.', 'currentPassword'),
        };
      }

      this.worldDb.db.prepare(`
        INSERT INTO recovery_credentials (member_id, code_hash, issued_at, consumed_at)
        VALUES (?, ?, ?, NULL)
        ON CONFLICT(member_id) DO UPDATE SET
          code_hash = excluded.code_hash,
          issued_at = excluded.issued_at,
          consumed_at = NULL
      `).run(row.id, nextRecoveryHash, nowIso);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.recovery_code_reissue',
        outcome: 'success',
        memberId: row.id,
        loginIdSnapshot: row.login_id,
        nicknameSnapshot: row.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      return { ok: true };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }

    return {
      recoveryCode: nextRecovery.formatted,
      recoveryCodeRaw: nextRecovery.raw,
      issuedAt: nowIso,
    };
  }

  /**
   * Withdraws an active member account after password and `confirm === true` verification.
   * Reserves loginId & nickname for 90 days, closes all sessions & focus, revokes all grants/tokens,
   * deletes profile/personal_space/bookmarks/recovery_credentials, anonymizes authored content,
   * and appends a `withdraw_member` tombstone.
   */
  withdrawAccount(input: WithdrawAccountInput): WithdrawAccountResult {
    if (input.confirm !== true) {
      throw new ServiceError('INVALID_INPUT', '회원 탈퇴를 진행하려면 최종 확인이 필요해요.', 'confirm');
    }
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password) {
      throw new ServiceError('AUTH_FAILED', '비밀번호를 입력해 주세요.', 'password');
    }

    const nowIso = this.clock.now().toISOString();
    const piiPurgeAt = addDays(nowIso, WITHDRAWAL_RETENTION_DAYS);

    const outcome = this.worldDb.transaction(():
      | {
          ok: true;
          closedSessionCount: number;
          revokedGrantCount: number;
          sideEffects: ClosedSessionSideEffects;
        }
      | { ok: false; error: ServiceError } => {
      const row = this.worldDb.db.prepare(
        "SELECT * FROM members WHERE id = ? AND state = 'active'",
      ).get(input.memberId) as unknown as MemberRow | undefined;

      if (!row) {
        return {
          ok: false,
          error: new ServiceError('UNAUTHORIZED', '활성 회원 계정을 찾을 수 없어요.'),
        };
      }

      if (!verifyPassword(password, row.password_hash)) {
        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'auth.withdraw',
          outcome: 'failure',
          errorCode: 'AUTH_FAILED',
          memberId: row.id,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
          ipAddress: input.ipAddress ?? null,
        });
        return {
          ok: false,
          error: new ServiceError('AUTH_FAILED', '비밀번호가 일치하지 않아요.', 'password'),
        };
      }

      this.worldDb.db.prepare(`
        UPDATE members
        SET state = 'withdrawn', withdrawn_at = ?, pii_purge_at = ?
        WHERE id = ?
      `).run(nowIso, piiPurgeAt, row.id);

      const upsertReservation = this.worldDb.db.prepare(`
        INSERT INTO name_reservations (kind, lookup_key, reserved_until)
        VALUES (?, ?, ?)
        ON CONFLICT(kind, lookup_key) DO UPDATE SET
          reserved_until = excluded.reserved_until
      `);
      upsertReservation.run('login_id', row.login_id_key, piiPurgeAt);
      upsertReservation.run('nickname', row.nickname_key, piiPurgeAt);

      const sideEffects = this.closeMemberSessionsInTx(
        row.id,
        row.nickname,
        null,
        nowIso,
        'account_withdrawn',
      );
      const revokedGrantCount = this.revokeAllIntegrationsInTx(row.id, nowIso, 'account_withdrawn');

      // Delete personal data & credentials; leave guestbook_entries.target_space_id = NULL
      this.worldDb.db.prepare(`
        UPDATE guestbook_entries
        SET target_space_id = NULL
        WHERE target_space_id IN (SELECT id FROM personal_spaces WHERE member_id = ?)
      `).run(row.id);

      this.worldDb.db.prepare('DELETE FROM profiles WHERE member_id = ?').run(row.id);
      this.worldDb.db.prepare('DELETE FROM personal_spaces WHERE member_id = ?').run(row.id);
      this.worldDb.db.prepare('DELETE FROM recruitment_bookmarks WHERE member_id = ?').run(row.id);
      this.worldDb.db.prepare('DELETE FROM recovery_credentials WHERE member_id = ?').run(row.id);

      // Anonymize authored content
      this.worldDb.db.prepare('UPDATE posts SET author_member_id = NULL WHERE author_member_id = ?').run(row.id);
      this.worldDb.db.prepare('UPDATE comments SET author_member_id = NULL WHERE author_member_id = ?').run(row.id);
      this.worldDb.db.prepare('UPDATE guestbook_entries SET author_member_id = NULL WHERE author_member_id = ?').run(row.id);
      this.worldDb.db.prepare('UPDATE chat_messages SET author_member_id = NULL WHERE author_member_id = ?').run(row.id);

      this.worldDb.appendTombstone({
        recordedAt: nowIso,
        kind: 'withdraw_member',
        targetKind: 'member',
        targetId: row.id,
        payload: {
          withdrawnAt: nowIso,
          piiPurgeAt,
          loginIdKey: row.login_id_key,
          nicknameKey: row.nickname_key,
        },
      });

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'auth.withdraw',
        outcome: 'success',
        memberId: row.id,
        loginIdSnapshot: row.login_id,
        nicknameSnapshot: row.nickname,
        ipAddress: input.ipAddress ?? null,
      });

      return {
        ok: true,
        closedSessionCount: sideEffects.closedSessions.length,
        revokedGrantCount,
        sideEffects,
      };
    });

    if (!outcome.ok) {
      throw outcome.error;
    }

    this.publishSessionSideEffects(outcome.sideEffects, nowIso, 'account_withdrawn');

    return {
      withdrawn: true,
      memberId: input.memberId,
      withdrawnAt: nowIso,
      piiPurgeAt,
      closedSessionCount: outcome.closedSessionCount,
      revokedGrantCount: outcome.revokedGrantCount,
    };
  }

  private closeMemberSessionsInTx(
    memberId: string,
    nickname: string,
    keepSessionId: string | null,
    nowIso: string,
    reason: string,
  ): ClosedSessionSideEffects {
    const targetRows = (
      keepSessionId === null
        ? this.worldDb.db.prepare(
            'SELECT id, member_id, is_guest, current_space_id FROM user_sessions WHERE member_id = ? AND ended_at IS NULL ORDER BY created_at ASC',
          ).all(memberId)
        : this.worldDb.db.prepare(
            'SELECT id, member_id, is_guest, current_space_id FROM user_sessions WHERE member_id = ? AND id != ? AND ended_at IS NULL ORDER BY created_at ASC',
          ).all(memberId, keepSessionId)
    ) as unknown as SessionRow[];

    const updateSession = this.worldDb.db.prepare(`
      UPDATE user_sessions
      SET ended_at = ?, end_reason = ?
      WHERE id = ? AND ended_at IS NULL
    `);
    for (const row of targetRows) {
      updateSession.run(nowIso, reason, row.id);
    }

    const closedIds = new Set(targetRows.map(r => r.id));
    let stoppedFocus: ClosedSessionSideEffects['stoppedFocus'] = null;

    const activeFocus = this.worldDb.db.prepare(
      'SELECT * FROM focus_sessions WHERE member_id = ? AND ended_at IS NULL',
    ).get(memberId) as unknown as FocusSessionRow | undefined;

    if (activeFocus && (keepSessionId === null || closedIds.has(activeFocus.started_session_id))) {
      const startMs = new Date(activeFocus.started_at).getTime();
      const endMs = Math.max(startMs, new Date(nowIso).getTime());
      const effectiveEndIso = new Date(endMs).toISOString();
      const countedSeconds = Math.floor((endMs - startMs) / 1000);

      const focusUpdate = this.worldDb.db.prepare(`
        UPDATE focus_sessions
        SET ended_at = ?, counted_seconds = ?
        WHERE id = ? AND ended_at IS NULL
      `).run(effectiveEndIso, countedSeconds, activeFocus.id);

      if (focusUpdate.changes === 1) {
        const slices = splitByKstMidnight(activeFocus.started_at, effectiveEndIso);
        const upsertDaily = this.worldDb.db.prepare(`
          INSERT INTO focus_daily_totals (member_id, kst_date, total_seconds)
          VALUES (?, ?, ?)
          ON CONFLICT(member_id, kst_date) DO UPDATE SET
            total_seconds = focus_daily_totals.total_seconds + excluded.total_seconds
        `);
        for (const slice of slices) {
          upsertDaily.run(memberId, slice.kstDate, slice.seconds);
        }

        stoppedFocus = {
          id: activeFocus.id,
          memberId,
          nickname,
          startedAt: activeFocus.started_at,
          endedAt: effectiveEndIso,
          countedSeconds,
        };
      }
    }

    let presenceAfter: ClosedSessionSideEffects['presenceAfter'] = null;
    if (targetRows.length > 0) {
      const remainingSpaces = (
        this.worldDb.db.prepare(
          'SELECT current_space_id FROM user_sessions WHERE member_id = ? AND ended_at IS NULL',
        ).all(memberId) as Array<{ current_space_id: string }>
      ).map(r => r.current_space_id);
      presenceAfter = {
        memberId,
        nickname,
        status: computePresenceStatus(remainingSpaces),
        activeSessionCount: remainingSpaces.length,
      };
    }

    return {
      closedSessions: targetRows.map(r => ({
        id: r.id,
        memberId: r.member_id,
        isGuest: r.is_guest === 1,
      })),
      stoppedFocus,
      presenceAfter,
    };
  }

  private revokeAllIntegrationsInTx(memberId: string, nowIso: string, reason: string): number {
    const grantInfo = this.worldDb.db.prepare(`
      UPDATE integration_grants
      SET revoked_at = ?, revoked_reason = ?
      WHERE member_id = ? AND revoked_at IS NULL
    `).run(nowIso, reason, memberId);

    this.worldDb.db.prepare(`
      UPDATE access_tokens
      SET revoked_at = ?
      WHERE grant_id IN (SELECT id FROM integration_grants WHERE member_id = ?)
        AND revoked_at IS NULL
    `).run(nowIso, memberId);

    this.worldDb.db.prepare(`
      UPDATE refresh_tokens
      SET revoked_at = ?
      WHERE grant_id IN (SELECT id FROM integration_grants WHERE member_id = ?)
        AND revoked_at IS NULL
    `).run(nowIso, memberId);

    return Number(grantInfo.changes);
  }

  private publishSessionSideEffects(
    sideEffects: ClosedSessionSideEffects,
    nowIso: string,
    reason: string,
  ): void {
    if (!this.hub) return;

    if (sideEffects.stoppedFocus) {
      const f = sideEffects.stoppedFocus;
      this.hub.publish('focus.changed', {
        memberId: f.memberId,
        nickname: f.nickname,
        state: 'stopped',
        focusSessionId: f.id,
        startedAt: f.startedAt,
        endedAt: f.endedAt,
        countedSeconds: f.countedSeconds,
        occurredAt: nowIso,
      }, nowIso);
    }

    for (const s of sideEffects.closedSessions) {
      this.hub.publish('session.ended', {
        sessionId: s.id,
        memberId: s.memberId,
        isGuest: s.isGuest,
        reason,
        mode: 'normal',
        endedAt: nowIso,
      }, nowIso);
    }

    if (sideEffects.presenceAfter) {
      this.hub.publish('presence.changed', {
        memberId: sideEffects.presenceAfter.memberId,
        nickname: sideEffects.presenceAfter.nickname,
        status: sideEffects.presenceAfter.status,
        activeSessionCount: sideEffects.presenceAfter.activeSessionCount,
        occurredAt: nowIso,
      }, nowIso);
    }
  }
}
