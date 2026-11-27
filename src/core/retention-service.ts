import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  WorldDatabase,
  type TombstoneRecord,
} from '../store/sqlite/database.js';
import { addDays, DAY_MS, type Clock } from './clock.js';
import { ServiceError } from './errors.js';

export const BACKUP_RETENTION_DAYS = 7;

export interface RetentionSweepResult {
  sweptAt: string;
  deletedChatMessages: number;
  deletedOperationalLogs: number;
  deletedContentReports: number;
  deletedModerationDeletions: number;
  deletedPrivacyRequests: number;
  deletedIdempotencyKeys: number;
  deletedNameReservations: number;
  purgedWithdrawnMembers: number;
}

export interface CreateDailyBackupResult {
  backupPath: string;
  fileName: string;
  createdAt: string;
  prunedFiles: string[];
}

export interface RestoreBackupOptions {
  tombstoneLogPath?: string;
}

export interface RestoreBackupResult {
  ready: true;
  dbPath: string;
  replayedTombstones: number;
  sweepResult: RetentionSweepResult;
}

interface WithdrawnMemberRow {
  id: string;
  login_id_key: string;
  nickname_key: string;
  pii_purge_at: string;
}

export class RetentionService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * Purges expired transient records (14d chat/logs, 90d reports/deletions/privacy, 24h idempotency)
   * and completely scrubs PII of withdrawn members whose `pii_purge_at <= now`.
   */
  runRetentionSweep(): RetentionSweepResult {
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const deletedChatMessages = Number(
        this.worldDb.db.prepare('DELETE FROM chat_messages WHERE expires_at <= ?').run(nowIso).changes,
      );
      const deletedOperationalLogs = Number(
        this.worldDb.db.prepare('DELETE FROM operational_logs WHERE expires_at <= ?').run(nowIso).changes,
      );
      const deletedContentReports = Number(
        this.worldDb.db.prepare(
          'DELETE FROM content_reports WHERE expires_at IS NOT NULL AND expires_at <= ?',
        ).run(nowIso).changes,
      );
      const deletedModerationDeletions = Number(
        this.worldDb.db.prepare('DELETE FROM moderation_deletions WHERE expires_at <= ?').run(nowIso).changes,
      );
      const deletedPrivacyRequests = Number(
        this.worldDb.db.prepare(
          'DELETE FROM privacy_deletion_requests WHERE expires_at IS NOT NULL AND expires_at <= ?',
        ).run(nowIso).changes,
      );
      const deletedIdempotencyKeys = Number(
        this.worldDb.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(nowIso).changes,
      );
      const deletedNameReservations = Number(
        this.worldDb.db.prepare('DELETE FROM name_reservations WHERE reserved_until <= ?').run(nowIso).changes,
      );

      const expiredWithdrawn = this.worldDb.db.prepare(`
        SELECT id, login_id_key, nickname_key, pii_purge_at
        FROM members
        WHERE state = 'withdrawn'
          AND pii_purge_at IS NOT NULL
          AND pii_purge_at <= ?
      `).all(nowIso) as unknown as WithdrawnMemberRow[];

      for (const member of expiredWithdrawn) {
        this.purgeMemberPiiInTx(member.id, member.login_id_key, member.nickname_key, nowIso);
        this.worldDb.appendTombstone({
          recordedAt: nowIso,
          kind: 'purge_member_pii',
          targetKind: 'member',
          targetId: member.id,
          payload: { purgedAt: nowIso },
        });
      }

      return {
        sweptAt: nowIso,
        deletedChatMessages,
        deletedOperationalLogs,
        deletedContentReports,
        deletedModerationDeletions,
        deletedPrivacyRequests,
        deletedIdempotencyKeys,
        deletedNameReservations,
        purgedWithdrawnMembers: expiredWithdrawn.length,
      };
    });
  }

  /**
   * Creates `world-YYYYMMDD.db` via `VACUUM INTO` (`worldDb.backupTo`) and removes backups older than 7 days.
   */
  createDailyBackup(backupDir: string): CreateDailyBackupResult {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const yyyymmdd = nowIso.slice(0, 10).replaceAll('-', '');
    const fileName = `world-${yyyymmdd}.db`;
    const backupPath = join(backupDir, fileName);

    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(backupDir, 0o700);
    } catch {
      // Ignore chmod error on non-POSIX filesystems
    }

    this.worldDb.backupTo(backupPath);
    try {
      chmodSync(backupPath, 0o600);
    } catch {
      // Ignore chmod error on non-POSIX filesystems
    }

    const todayUtcMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const cutoffUtcMs = todayUtcMs - BACKUP_RETENTION_DAYS * DAY_MS;

    const prunedFiles: string[] = [];
    for (const entry of readdirSync(backupDir)) {
      const match = /^world-(\d{4})(\d{2})(\d{2})\.db$/.exec(entry);
      if (!match) continue;
      const fileUtcMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (fileUtcMs <= cutoffUtcMs && entry !== fileName) {
        unlinkSync(join(backupDir, entry));
        prunedFiles.push(entry);
      }
    }

    return {
      backupPath,
      fileName,
      createdAt: nowIso,
      prunedFiles,
    };
  }

  /**
   * Replays tombstone records onto `this.worldDb` idempotently inside `BEGIN IMMEDIATE`
   * so deleted content and withdrawn/purged accounts never resurrect after snapshot restore.
   */
  replayTombstones(records?: readonly TombstoneRecord[]): number {
    const list = records ? [...records] : this.worldDb.readTombstoneLog();
    if (list.length === 0) return 0;

    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      let applied = 0;

      for (const record of list) {
        this.applySingleTombstoneInTx(record, nowIso);
        const existingSeq = this.worldDb.db.prepare(
          'SELECT seq FROM tombstones WHERE seq = ?',
        ).get(record.seq);
        if (!existingSeq) {
          this.worldDb.db.prepare(`
            INSERT INTO tombstones (seq, recorded_at, kind, target_kind, target_id, payload_json)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            record.seq,
            record.recordedAt,
            record.kind,
            record.targetKind,
            record.targetId,
            JSON.stringify(record.payload ?? {}),
          );
        }
        applied += 1;
      }

      return applied;
    });
  }

  /**
   * Restores a SQLite backup file into `targetDataDir`, opens it, replays external `tombstones.log`,
   * and runs `runRetentionSweep()` before closing & returning ready so deleted content,
   * withdrawn members, and expired records never resurrect.
   */
  restoreFromBackup(
    backupPath: string,
    targetDataDir: string,
    options: RestoreBackupOptions = {},
  ): RestoreBackupResult {
    if (!existsSync(backupPath)) {
      throw new ServiceError('NOT_FOUND', '복구할 백업 파일을 찾을 수 없어요.', 'backupPath');
    }

    mkdirSync(targetDataDir, { recursive: true, mode: 0o700 });
    const targetDbPath = join(targetDataDir, 'world.db');
    const externalLogPath = options.tombstoneLogPath ?? join(targetDataDir, 'tombstones.log');

    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${targetDbPath}${suffix}`;
      if (existsSync(candidate)) {
        unlinkSync(candidate);
      }
    }

    copyFileSync(backupPath, targetDbPath);
    try {
      chmodSync(targetDbPath, 0o600);
    } catch {
      // Ignore chmod error on non-POSIX filesystems
    }

    const restoredDb = new WorldDatabase({
      dbPath: targetDbPath,
      dataDir: targetDataDir,
      tombstoneLogPath: externalLogPath,
    });

    try {
      const restoredRetention = new RetentionService(restoredDb, this.clock);
      const replayedTombstones = restoredRetention.replayTombstones();
      const sweepResult = restoredRetention.runRetentionSweep();
      restoredDb.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');

      return {
        ready: true,
        dbPath: targetDbPath,
        replayedTombstones,
        sweepResult,
      };
    } finally {
      restoredDb.close();
    }
  }

  private purgeMemberPiiInTx(
    memberId: string,
    loginIdKey: string | null,
    nicknameKey: string | null,
    nowIso: string,
  ): void {
    this.worldDb.db.prepare('DELETE FROM report_dedup_keys WHERE reporter_member_id = ?').run(memberId);
    this.worldDb.db.prepare('DELETE FROM report_rate_limits WHERE member_id = ?').run(memberId);

    if (loginIdKey) {
      this.worldDb.db.prepare(
        "DELETE FROM name_reservations WHERE kind = 'login_id' AND lookup_key = ? AND reserved_until <= ?",
      ).run(loginIdKey, nowIso);
    }
    if (nicknameKey) {
      this.worldDb.db.prepare(
        "DELETE FROM name_reservations WHERE kind = 'nickname' AND lookup_key = ? AND reserved_until <= ?",
      ).run(nicknameKey, nowIso);
    }

    this.worldDb.db.prepare(`
      UPDATE operational_logs
      SET member_id = NULL,
          login_id_snapshot = NULL,
          nickname_snapshot = NULL,
          ip_address = NULL
      WHERE member_id = ?
    `).run(memberId);

    this.worldDb.db.prepare(
      'UPDATE content_reports SET reporter_member_id = NULL WHERE reporter_member_id = ?',
    ).run(memberId);
    this.worldDb.db.prepare(
      'UPDATE content_reports SET reviewer_member_id = NULL WHERE reviewer_member_id = ?',
    ).run(memberId);
    this.worldDb.db.prepare(
      'UPDATE moderation_deletions SET admin_member_id = NULL WHERE admin_member_id = ?',
    ).run(memberId);

    this.worldDb.db.prepare('UPDATE posts SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
    this.worldDb.db.prepare('UPDATE comments SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
    this.worldDb.db.prepare('UPDATE guestbook_entries SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
    this.worldDb.db.prepare('UPDATE chat_messages SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
    this.worldDb.db.prepare('UPDATE notices SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);

    this.worldDb.db.prepare(`
      UPDATE guestbook_entries
      SET target_space_id = NULL
      WHERE target_space_id IN (SELECT id FROM personal_spaces WHERE member_id = ?)
    `).run(memberId);

    this.worldDb.db.prepare('DELETE FROM members WHERE id = ?').run(memberId);
  }

  private applySingleTombstoneInTx(record: TombstoneRecord, nowIso: string): void {
    switch (record.kind) {
      case 'delete_content':
      case 'privacy_delete': {
        this.applyDeleteContentTombstone(record.targetKind, record.targetId, record.recordedAt);
        return;
      }
      case 'withdraw_member': {
        const memberId = record.targetId;
        const withdrawnAt = typeof record.payload.withdrawnAt === 'string'
          ? record.payload.withdrawnAt
          : record.recordedAt;
        const piiPurgeAt = typeof record.payload.piiPurgeAt === 'string'
          ? record.payload.piiPurgeAt
          : addDays(withdrawnAt, 90);

        const memberRow = this.worldDb.db.prepare(
          'SELECT id, login_id_key, nickname_key FROM members WHERE id = ?',
        ).get(memberId) as { id: string; login_id_key: string; nickname_key: string } | undefined;

        const loginIdKey = memberRow?.login_id_key
          ?? (typeof record.payload.loginIdKey === 'string' ? record.payload.loginIdKey : null);
        const nicknameKey = memberRow?.nickname_key
          ?? (typeof record.payload.nicknameKey === 'string' ? record.payload.nicknameKey : null);

        if (piiPurgeAt > nowIso) {
          const upsertReservation = this.worldDb.db.prepare(`
            INSERT INTO name_reservations (kind, lookup_key, reserved_until)
            VALUES (?, ?, ?)
            ON CONFLICT(kind, lookup_key) DO UPDATE SET
              reserved_until = excluded.reserved_until
          `);
          if (loginIdKey) upsertReservation.run('login_id', loginIdKey, piiPurgeAt);
          if (nicknameKey) upsertReservation.run('nickname', nicknameKey, piiPurgeAt);
        }

        if (memberRow) {
          this.worldDb.db.prepare(`
            UPDATE members
            SET state = 'withdrawn',
                withdrawn_at = COALESCE(withdrawn_at, ?),
                pii_purge_at = COALESCE(pii_purge_at, ?)
            WHERE id = ?
          `).run(withdrawnAt, piiPurgeAt, memberId);
        }

        this.worldDb.db.prepare(`
          UPDATE user_sessions
          SET ended_at = COALESCE(ended_at, ?),
              end_reason = COALESCE(end_reason, 'account_withdrawn')
          WHERE member_id = ? AND ended_at IS NULL
        `).run(withdrawnAt, memberId);

        this.worldDb.db.prepare(`
          UPDATE focus_sessions
          SET ended_at = COALESCE(ended_at, ?),
              counted_seconds = COALESCE(counted_seconds, 0)
          WHERE member_id = ? AND ended_at IS NULL
        `).run(withdrawnAt, memberId);

        this.worldDb.db.prepare(`
          UPDATE integration_grants
          SET revoked_at = COALESCE(revoked_at, ?),
              revoked_reason = COALESCE(revoked_reason, 'account_withdrawn')
          WHERE member_id = ? AND revoked_at IS NULL
        `).run(withdrawnAt, memberId);

        this.worldDb.db.prepare(`
          UPDATE access_tokens
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE grant_id IN (SELECT id FROM integration_grants WHERE member_id = ?)
            AND revoked_at IS NULL
        `).run(withdrawnAt, memberId);

        this.worldDb.db.prepare(`
          UPDATE refresh_tokens
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE grant_id IN (SELECT id FROM integration_grants WHERE member_id = ?)
            AND revoked_at IS NULL
        `).run(withdrawnAt, memberId);

        this.worldDb.db.prepare(`
          UPDATE guestbook_entries
          SET target_space_id = NULL
          WHERE target_space_id IN (SELECT id FROM personal_spaces WHERE member_id = ?)
        `).run(memberId);

        this.worldDb.db.prepare('DELETE FROM profiles WHERE member_id = ?').run(memberId);
        this.worldDb.db.prepare('DELETE FROM personal_spaces WHERE member_id = ?').run(memberId);
        this.worldDb.db.prepare('DELETE FROM recruitment_bookmarks WHERE member_id = ?').run(memberId);
        this.worldDb.db.prepare('DELETE FROM recovery_credentials WHERE member_id = ?').run(memberId);

        this.worldDb.db.prepare('UPDATE posts SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
        this.worldDb.db.prepare('UPDATE comments SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
        this.worldDb.db.prepare('UPDATE guestbook_entries SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
        this.worldDb.db.prepare('UPDATE chat_messages SET author_member_id = NULL WHERE author_member_id = ?').run(memberId);
        return;
      }
      case 'purge_member_pii': {
        const memberRow = this.worldDb.db.prepare(
          'SELECT id, login_id_key, nickname_key FROM members WHERE id = ?',
        ).get(record.targetId) as { id: string; login_id_key: string; nickname_key: string } | undefined;
        this.purgeMemberPiiInTx(
          record.targetId,
          memberRow?.login_id_key ?? null,
          memberRow?.nickname_key ?? null,
          nowIso,
        );
        return;
      }
    }
  }

  private applyDeleteContentTombstone(targetKind: string, targetId: string, recordedAt: string): void {
    switch (targetKind) {
      case 'post':
        this.worldDb.db.prepare(`
          UPDATE posts
          SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(recordedAt, recordedAt, targetId);
        this.worldDb.db.prepare(`
          UPDATE comments
          SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
          WHERE post_id = ? AND deleted_at IS NULL
        `).run(recordedAt, recordedAt, targetId);
        this.worldDb.db.prepare('DELETE FROM recruitment_bookmarks WHERE post_id = ?').run(targetId);
        return;
      case 'comment':
        this.worldDb.db.prepare(`
          UPDATE comments
          SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(recordedAt, recordedAt, targetId);
        return;
      case 'guestbook':
        this.worldDb.db.prepare(`
          UPDATE guestbook_entries
          SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(recordedAt, recordedAt, targetId);
        return;
      case 'chat':
        this.worldDb.db.prepare(`
          UPDATE chat_messages
          SET deleted_at = COALESCE(deleted_at, ?)
          WHERE id = ? AND deleted_at IS NULL
        `).run(recordedAt, targetId);
        return;
    }
  }
}
