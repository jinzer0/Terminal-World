import { parseText } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { requireActiveMember, type LiveMember } from './board-service.js';
import { addDays, type Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';
import type { RealtimeHub } from './realtime-hub.js';

export const REPORT_RATE_LIMIT_MAX = 30;
export const REPORT_RATE_LIMIT_WINDOW_MS = 180 * 1000;
export const MODERATION_RETENTION_DAYS = 90;

export type ReportTargetKind = 'post' | 'comment' | 'guestbook' | 'chat';
export type ReportReviewState = 'received' | 'reviewed';
export type ReportOutcome = 'deleted' | 'no_action';

export interface ContentReportRecord {
  id: string;
  reporterMemberId: string | null;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: string;
  reviewState: ReportReviewState;
  outcome: ReportOutcome | null;
  resolutionReason: string | null;
  reviewerMemberId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
}

export interface ModerationDeletionRecord {
  id: string;
  adminMemberId: string | null;
  adminNickname: string | null;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: string;
  deletedAt: string;
  expiresAt: string;
}

export interface CreateReportInput {
  reporterMemberId: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: string;
}

export interface ReviewReportInput {
  adminMemberId: string;
  reportId: string;
  outcome: ReportOutcome;
  resolutionReason: string;
}

export interface ReviewReportResult {
  report: ContentReportRecord;
  deletion: ModerationDeletionRecord | null;
}

export interface AdminDeleteContentInput {
  adminMemberId: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: string;
}

export interface ModerationServiceOptions {
  hub?: RealtimeHub;
}

interface ContentReportRow {
  id: string;
  reporter_member_id: string | null;
  target_kind: ReportTargetKind;
  target_id: string;
  reason: string;
  review_state: ReportReviewState;
  outcome: ReportOutcome | null;
  resolution_reason: string | null;
  reviewer_member_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  expires_at: string | null;
}

interface ModerationDeletionRow {
  id: string;
  admin_member_id: string | null;
  admin_nickname: string | null;
  admin_state: string | null;
  target_kind: ReportTargetKind;
  target_id: string;
  reason: string;
  deleted_at: string;
  expires_at: string;
}

function validateTargetKind(kind: unknown): ReportTargetKind {
  if (kind !== 'post' && kind !== 'comment' && kind !== 'guestbook' && kind !== 'chat') {
    throw new ServiceError('INVALID_INPUT', '유효하지 않은 신고/삭제 대상 종류예요.', 'targetKind');
  }
  return kind;
}

function validateTargetId(targetId: unknown): string {
  if (typeof targetId !== 'string' || !targetId.trim()) {
    throw new ServiceError('INVALID_INPUT', '대상 ID를 입력해 주세요.', 'targetId');
  }
  return targetId.trim();
}

function requireLiveAdmin(worldDb: WorldDatabase, adminMemberId: string | null | undefined): LiveMember {
  const actor = requireActiveMember(worldDb, adminMemberId);
  if (actor.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', '관리자 권한이 필요해요.');
  }
  return actor;
}

function mapReportRow(row: ContentReportRow): ContentReportRecord {
  return {
    id: row.id,
    reporterMemberId: row.reporter_member_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    reason: row.reason,
    reviewState: row.review_state,
    outcome: row.outcome,
    resolutionReason: row.resolution_reason,
    reviewerMemberId: row.reviewer_member_id,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    expiresAt: row.expires_at,
  };
}

function mapDeletionRow(row: ModerationDeletionRow): ModerationDeletionRecord {
  const adminActive = row.admin_member_id !== null && row.admin_state === 'active' && row.admin_nickname !== null;
  return {
    id: row.id,
    adminMemberId: row.admin_member_id,
    adminNickname: adminActive ? row.admin_nickname : null,
    targetKind: row.target_kind,
    targetId: row.target_id,
    reason: row.reason,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
  };
}

export class ModerationService {
  private readonly hub?: RealtimeHub;

  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    options: ModerationServiceOptions = {},
  ) {
    this.hub = options.hub;
  }

  /**
   * Files a content report against an existing non-deleted post, comment, guestbook entry, or chat message.
   * Enforces 1 report per member per target (`report_dedup_keys`) and 30 accepted reports per 180s window.
   * Duplicate or rate-limited rejections never mutate `report_rate_limits`.
   */
  createReport(input: CreateReportInput): ContentReportRecord {
    const targetKind = validateTargetKind(input.targetKind);
    const targetId = validateTargetId(input.targetId);
    let reason: string;
    try {
      reason = parseText('reason', input.reason);
    } catch (error) {
      throw toServiceError(error);
    }

    const now = this.clock.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    return this.worldDb.transaction(() => {
      const reporter = requireActiveMember(this.worldDb, input.reporterMemberId);

      if (!this.isTargetActiveInTx(targetKind, targetId)) {
        throw new ServiceError('NOT_FOUND', '신고할 콘텐츠를 찾을 수 없어요.', 'targetId');
      }

      const duplicate = this.worldDb.db.prepare(`
        SELECT 1 FROM report_dedup_keys
        WHERE reporter_member_id = ? AND target_kind = ? AND target_id = ?
      `).get(reporter.id, targetKind, targetId);

      if (duplicate) {
        throw new ServiceError('CONFLICT', '이미 신고한 콘텐츠예요.');
      }

      const rateRow = this.worldDb.db.prepare(
        'SELECT count, last_accepted_at FROM report_rate_limits WHERE member_id = ?',
      ).get(reporter.id) as { count: number; last_accepted_at: string } | undefined;

      let effectiveCount = 0;
      if (rateRow) {
        const lastMs = new Date(rateRow.last_accepted_at).getTime();
        const elapsedMs = nowMs - lastMs;
        effectiveCount = elapsedMs >= REPORT_RATE_LIMIT_WINDOW_MS ? 0 : rateRow.count;
      }

      if (effectiveCount >= REPORT_RATE_LIMIT_MAX) {
        throw new ServiceError(
          'RATE_LIMITED',
          '신고는 3분 동안 최대 30건까지 접수할 수 있어요. 잠시 후 다시 시도해 주세요.',
        );
      }

      const reportId = generateId();
      this.worldDb.db.prepare(`
        INSERT INTO content_reports (
          id, reporter_member_id, target_kind, target_id, reason,
          review_state, outcome, resolution_reason, reviewer_member_id,
          created_at, reviewed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'received', NULL, NULL, NULL, ?, NULL, NULL)
      `).run(reportId, reporter.id, targetKind, targetId, reason, nowIso);

      this.worldDb.db.prepare(`
        INSERT INTO report_dedup_keys (reporter_member_id, target_kind, target_id)
        VALUES (?, ?, ?)
      `).run(reporter.id, targetKind, targetId);

      const nextCount = effectiveCount + 1;
      this.worldDb.db.prepare(`
        INSERT INTO report_rate_limits (member_id, count, last_accepted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(member_id) DO UPDATE SET
          count = excluded.count,
          last_accepted_at = excluded.last_accepted_at
      `).run(reporter.id, nextCount, nowIso);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'report.create',
        outcome: 'success',
        memberId: reporter.id,
      });

      const created = this.worldDb.db.prepare(
        'SELECT * FROM content_reports WHERE id = ?',
      ).get(reportId) as unknown as ContentReportRow;
      return mapReportRow(created);
    });
  }

  /**
   * Lists non-expired reports submitted by `memberId`.
   */
  listMyReports(memberId: string): ContentReportRecord[] {
    requireActiveMember(this.worldDb, memberId);
    const nowIso = this.clock.now().toISOString();
    const rows = this.worldDb.db.prepare(`
      SELECT * FROM content_reports
      WHERE reporter_member_id = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, rowid DESC
    `).all(memberId, nowIso) as unknown as ContentReportRow[];
    return rows.map(mapReportRow);
  }

  /**
   * Lists non-expired reports for a live admin, optionally filtered by `review_state`.
   */
  listReportsForAdmin(adminMemberId: string, state?: ReportReviewState): ContentReportRecord[] {
    if (state !== undefined && state !== 'received' && state !== 'reviewed') {
      throw new ServiceError('INVALID_INPUT', '신고 검토 상태는 received 또는 reviewed여야 해요.', 'state');
    }
    requireLiveAdmin(this.worldDb, adminMemberId);
    const nowIso = this.clock.now().toISOString();

    const rows = (
      state !== undefined
        ? this.worldDb.db.prepare(`
            SELECT * FROM content_reports
            WHERE review_state = ?
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY created_at DESC, rowid DESC
          `).all(state, nowIso)
        : this.worldDb.db.prepare(`
            SELECT * FROM content_reports
            WHERE expires_at IS NULL OR expires_at > ?
            ORDER BY created_at DESC, rowid DESC
          `).all(nowIso)
    ) as unknown as ContentReportRow[];

    return rows.map(mapReportRow);
  }

  /**
   * Reviews a pending report inside `BEGIN IMMEDIATE`, re-verifying live admin privilege.
   * Sets `expires_at = reviewed_at + 90d`. If outcome is `'deleted'`, soft-deletes the target
   * (cascading post comments), records `moderation_deletions` without storing content body,
   * and appends a `delete_content` tombstone.
   */
  reviewReport(input: ReviewReportInput): ReviewReportResult {
    if (input.outcome !== 'deleted' && input.outcome !== 'no_action') {
      throw new ServiceError('INVALID_INPUT', '검토 결과는 deleted 또는 no_action이어야 해요.', 'outcome');
    }
    let resolutionReason: string;
    try {
      resolutionReason = parseText('reason', input.resolutionReason);
    } catch (error) {
      throw toServiceError(error);
    }

    const nowIso = this.clock.now().toISOString();
    const expiresAt = addDays(nowIso, MODERATION_RETENTION_DAYS);

    const outcome = this.worldDb.transaction(() => {
      const admin = requireLiveAdmin(this.worldDb, input.adminMemberId);

      const report = this.worldDb.db.prepare(
        'SELECT * FROM content_reports WHERE id = ?',
      ).get(input.reportId) as unknown as ContentReportRow | undefined;

      if (!report || (report.expires_at !== null && report.expires_at <= nowIso)) {
        throw new ServiceError('NOT_FOUND', '신고 내역을 찾을 수 없어요.', 'reportId');
      }

      if (report.review_state === 'reviewed') {
        throw new ServiceError('CONFLICT', '이미 검토가 완료된 신고예요.');
      }

      this.worldDb.db.prepare(`
        UPDATE content_reports
        SET review_state = 'reviewed',
            outcome = ?,
            resolution_reason = ?,
            reviewer_member_id = ?,
            reviewed_at = ?,
            expires_at = ?
        WHERE id = ?
      `).run(input.outcome, resolutionReason, admin.id, nowIso, expiresAt, report.id);

      let deletion: ModerationDeletionRecord | null = null;
      let deletedChatRoomId: string | null = null;

      if (input.outcome === 'deleted' && this.isTargetActiveInTx(report.target_kind, report.target_id)) {
        const applied = this.softDeleteTargetInTx(
          admin,
          report.target_kind,
          report.target_id,
          resolutionReason,
          nowIso,
          report.id,
        );
        deletion = applied.deletion;
        deletedChatRoomId = applied.chatRoomId;
      }

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'admin.report.review',
        outcome: 'success',
        memberId: admin.id,
      });

      const updatedReport = this.worldDb.db.prepare(
        'SELECT * FROM content_reports WHERE id = ?',
      ).get(report.id) as unknown as ContentReportRow;

      return {
        report: mapReportRow(updatedReport),
        deletion,
        deletedChatRoomId,
      };
    });

    if (outcome.deletedChatRoomId && this.hub) {
      this.hub.publish('chat.deleted', {
        id: outcome.report.targetId,
        roomId: outcome.deletedChatRoomId,
        deletedAt: nowIso,
      }, nowIso);
    }

    return {
      report: outcome.report,
      deletion: outcome.deletion,
    };
  }

  /**
   * Directly soft-deletes target content as a live admin inside `BEGIN IMMEDIATE`,
   * recording `moderation_deletions` (90d expiry, no content body) and a `delete_content` tombstone.
   */
  adminDeleteContent(input: AdminDeleteContentInput): ModerationDeletionRecord {
    const targetKind = validateTargetKind(input.targetKind);
    const targetId = validateTargetId(input.targetId);
    let reason: string;
    try {
      reason = parseText('reason', input.reason);
    } catch (error) {
      throw toServiceError(error);
    }

    const nowIso = this.clock.now().toISOString();

    const outcome = this.worldDb.transaction(() => {
      const admin = requireLiveAdmin(this.worldDb, input.adminMemberId);

      if (!this.isTargetActiveInTx(targetKind, targetId)) {
        throw new ServiceError('NOT_FOUND', '삭제할 대상을 찾을 수 없어요.', 'targetId');
      }

      const applied = this.softDeleteTargetInTx(admin, targetKind, targetId, reason, nowIso);

      this.worldDb.recordOperationalLog({
        occurredAt: nowIso,
        eventType: 'admin.content.delete',
        outcome: 'success',
        memberId: admin.id,
      });

      return applied;
    });

    if (outcome.chatRoomId && this.hub) {
      this.hub.publish('chat.deleted', {
        id: targetId,
        roomId: outcome.chatRoomId,
        deletedAt: nowIso,
      }, nowIso);
    }

    return outcome.deletion;
  }

  /**
   * Lists non-expired moderation deletion records (no deleted content body copy) for a live admin.
   */
  listDeletionHistory(adminMemberId: string): ModerationDeletionRecord[] {
    requireLiveAdmin(this.worldDb, adminMemberId);
    const nowIso = this.clock.now().toISOString();

    const rows = this.worldDb.db.prepare(`
      SELECT
        md.id,
        md.admin_member_id,
        m.nickname AS admin_nickname,
        m.state AS admin_state,
        md.target_kind,
        md.target_id,
        md.reason,
        md.deleted_at,
        md.expires_at
      FROM moderation_deletions md
      LEFT JOIN members m ON m.id = md.admin_member_id
      WHERE md.expires_at > ?
      ORDER BY md.deleted_at DESC, md.rowid DESC
    `).all(nowIso) as unknown as ModerationDeletionRow[];

    return rows.map(mapDeletionRow);
  }

  private isTargetActiveInTx(targetKind: ReportTargetKind, targetId: string): boolean {
    switch (targetKind) {
      case 'post':
        return Boolean(
          this.worldDb.db.prepare('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL').get(targetId),
        );
      case 'comment':
        return Boolean(
          this.worldDb.db.prepare(`
            SELECT c.id
            FROM comments c
            JOIN posts p ON p.id = c.post_id
            WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL
          `).get(targetId),
        );
      case 'guestbook':
        return Boolean(
          this.worldDb.db.prepare('SELECT id FROM guestbook_entries WHERE id = ? AND deleted_at IS NULL').get(targetId),
        );
      case 'chat':
        return Boolean(
          this.worldDb.db.prepare('SELECT id FROM chat_messages WHERE id = ? AND deleted_at IS NULL').get(targetId),
        );
    }
  }

  private softDeleteTargetInTx(
    admin: LiveMember,
    targetKind: ReportTargetKind,
    targetId: string,
    reason: string,
    nowIso: string,
    reportId?: string,
  ): { deletion: ModerationDeletionRecord; chatRoomId: string | null } {
    let chatRoomId: string | null = null;

    switch (targetKind) {
      case 'post': {
        this.worldDb.db.prepare(`
          UPDATE posts
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(nowIso, nowIso, targetId);

        this.worldDb.db.prepare(`
          UPDATE comments
          SET deleted_at = ?, updated_at = ?
          WHERE post_id = ? AND deleted_at IS NULL
        `).run(nowIso, nowIso, targetId);

        this.worldDb.db.prepare(
          'DELETE FROM recruitment_bookmarks WHERE post_id = ?',
        ).run(targetId);
        break;
      }
      case 'comment': {
        this.worldDb.db.prepare(`
          UPDATE comments
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(nowIso, nowIso, targetId);
        break;
      }
      case 'guestbook': {
        this.worldDb.db.prepare(`
          UPDATE guestbook_entries
          SET deleted_at = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(nowIso, nowIso, targetId);
        break;
      }
      case 'chat': {
        const row = this.worldDb.db.prepare(
          'SELECT room_id FROM chat_messages WHERE id = ?',
        ).get(targetId) as { room_id: string } | undefined;
        chatRoomId = row?.room_id ?? 'space:rooftop';
        this.worldDb.db.prepare(`
          UPDATE chat_messages
          SET deleted_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(nowIso, targetId);
        break;
      }
    }

    const deletionId = generateId();
    const expiresAt = addDays(nowIso, MODERATION_RETENTION_DAYS);
    this.worldDb.db.prepare(`
      INSERT INTO moderation_deletions (
        id, admin_member_id, target_kind, target_id, reason, deleted_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(deletionId, admin.id, targetKind, targetId, reason, nowIso, expiresAt);

    this.worldDb.appendTombstone({
      recordedAt: nowIso,
      kind: 'delete_content',
      targetKind,
      targetId,
      payload: {
        deletedAt: nowIso,
        adminMemberId: admin.id,
        reason,
        ...(reportId ? { reportId } : {}),
      },
    });

    return {
      deletion: {
        id: deletionId,
        adminMemberId: admin.id,
        adminNickname: admin.nickname,
        targetKind,
        targetId,
        reason,
        deletedAt: nowIso,
        expiresAt,
      },
      chatRoomId,
    };
  }
}
