import { parseText } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import type { MemberRole } from './auth-service.js';
import { addDays, type Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export const ARCHIVED_SPACE_LABEL = '탈퇴한 사용자의 공간';
export const WITHDRAWN_AUTHOR_LABEL = '탈퇴한 사용자';

export interface GuestbookEntryRecord {
  id: string;
  targetSpaceId: string | null;
  targetSpaceLabel: string;
  isArchivedSpace: boolean;
  authorMemberId: string | null;
  authorNickname: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DeleteGuestbookResult {
  deleted: true;
  entryId: string;
  deletedAt: string;
  byAdmin: boolean;
}

interface GuestbookRow {
  id: string;
  target_space_id: string | null;
  author_member_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author_nickname: string | null;
  author_state: string | null;
  owner_nickname: string | null;
  owner_state: string | null;
}

interface SpaceLookupRow {
  space_id: string;
  owner_id: string;
  owner_nickname: string;
  owner_state: string;
}

interface ActorRow {
  id: string;
  login_id: string;
  nickname: string;
  role: MemberRole;
  state: string;
}

function mapGuestbookRow(row: GuestbookRow): GuestbookEntryRecord {
  const isArchivedSpace = row.target_space_id === null || row.owner_state !== 'active';
  const targetSpaceLabel = isArchivedSpace
    ? ARCHIVED_SPACE_LABEL
    : `${row.owner_nickname ?? ARCHIVED_SPACE_LABEL}의 공간`;
  const authorActive = row.author_member_id !== null && row.author_state === 'active' && row.author_nickname !== null;
  return {
    id: row.id,
    targetSpaceId: row.target_space_id,
    targetSpaceLabel,
    isArchivedSpace,
    authorMemberId: row.author_member_id,
    authorNickname: authorActive ? row.author_nickname! : WITHDRAWN_AUTHOR_LABEL,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export class GuestbookService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  private findSpace(identifier: string): SpaceLookupRow | undefined {
    const trimmed = typeof identifier === 'string' ? identifier.normalize('NFC').trim() : '';
    if (!trimmed) return undefined;
    const key = trimmed.toLowerCase();

    return this.worldDb.db.prepare(`
      SELECT
        ps.id AS space_id,
        m.id AS owner_id,
        m.nickname AS owner_nickname,
        m.state AS owner_state
      FROM personal_spaces ps
      JOIN members m ON m.id = ps.member_id
      WHERE ps.id = ? OR ps.member_id = ? OR m.nickname_key = ?
    `).get(trimmed, trimmed, key) as unknown as SpaceLookupRow | undefined;
  }

  private getEntryRowById(entryId: string): GuestbookRow | undefined {
    return this.worldDb.db.prepare(`
      SELECT
        g.id,
        g.target_space_id,
        g.author_member_id,
        g.body,
        g.created_at,
        g.updated_at,
        g.deleted_at,
        author.nickname AS author_nickname,
        author.state AS author_state,
        owner.nickname AS owner_nickname,
        owner.state AS owner_state
      FROM guestbook_entries g
      LEFT JOIN members author ON author.id = g.author_member_id
      LEFT JOIN personal_spaces ps ON ps.id = g.target_space_id
      LEFT JOIN members owner ON owner.id = ps.member_id
      WHERE g.id = ? AND g.deleted_at IS NULL
    `).get(entryId) as unknown as GuestbookRow | undefined;
  }

  listEntries(targetSpaceIdentifier: string): GuestbookEntryRecord[] {
    try {
      const space = this.findSpace(targetSpaceIdentifier);
      if (!space || space.owner_state !== 'active') {
        throw new ServiceError('NOT_FOUND', '개인 공간을 찾을 수 없어요.');
      }

      const rows = this.worldDb.db.prepare(`
        SELECT
          g.id,
          g.target_space_id,
          g.author_member_id,
          g.body,
          g.created_at,
          g.updated_at,
          g.deleted_at,
          author.nickname AS author_nickname,
          author.state AS author_state,
          owner.nickname AS owner_nickname,
          owner.state AS owner_state
        FROM guestbook_entries g
        LEFT JOIN members author ON author.id = g.author_member_id
        LEFT JOIN personal_spaces ps ON ps.id = g.target_space_id
        LEFT JOIN members owner ON owner.id = ps.member_id
        WHERE g.target_space_id = ? AND g.deleted_at IS NULL
        ORDER BY g.created_at DESC, g.rowid DESC
      `).all(space.space_id) as unknown as GuestbookRow[];

      return rows.map(mapGuestbookRow);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  listArchivedEntries(): GuestbookEntryRecord[] {
    try {
      const rows = this.worldDb.db.prepare(`
        SELECT
          g.id,
          g.target_space_id,
          g.author_member_id,
          g.body,
          g.created_at,
          g.updated_at,
          g.deleted_at,
          author.nickname AS author_nickname,
          author.state AS author_state,
          NULL AS owner_nickname,
          NULL AS owner_state
        FROM guestbook_entries g
        LEFT JOIN members author ON author.id = g.author_member_id
        WHERE g.target_space_id IS NULL AND g.deleted_at IS NULL
        ORDER BY g.created_at DESC, g.rowid DESC
      `).all() as unknown as GuestbookRow[];

      return rows.map(mapGuestbookRow);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  createEntry(
    actorMemberId: string,
    targetSpaceIdentifier: string | null | undefined,
    body: unknown,
  ): GuestbookEntryRecord {
    try {
      const validatedBody = parseText('guestbook', body);
      if (
        targetSpaceIdentifier === null ||
        targetSpaceIdentifier === undefined ||
        targetSpaceIdentifier.trim() === '' ||
        targetSpaceIdentifier === 'archived' ||
        targetSpaceIdentifier === ARCHIVED_SPACE_LABEL
      ) {
        throw new ServiceError('FORBIDDEN', '탈퇴한 사용자의 보관 공간에는 방명록을 작성할 수 없어요.');
      }

      const nowIso = this.clock.now().toISOString();
      return this.worldDb.transaction(() => {
        const actor = this.worldDb.db.prepare(
          "SELECT id, login_id, nickname, role, state FROM members WHERE id = ? AND state = 'active'",
        ).get(actorMemberId) as unknown as ActorRow | undefined;
        if (!actor) {
          throw new ServiceError('FORBIDDEN', '로그인한 활성 회원만 방명록을 작성할 수 있어요.');
        }

        const space = this.findSpace(targetSpaceIdentifier);
        if (!space) {
          throw new ServiceError('NOT_FOUND', '대상 개인 공간을 찾을 수 없어요.');
        }
        if (space.owner_state !== 'active') {
          throw new ServiceError('FORBIDDEN', '탈퇴한 사용자의 보관 공간에는 방명록을 작성할 수 없어요.');
        }

        const entryId = generateId();
        this.worldDb.db.prepare(`
          INSERT INTO guestbook_entries (id, target_space_id, author_member_id, body, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(entryId, space.space_id, actor.id, validatedBody, nowIso, nowIso);

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'guestbook.create',
          outcome: 'success',
          memberId: actor.id,
          loginIdSnapshot: actor.login_id,
          nicknameSnapshot: actor.nickname,
        });

        return this.getEntryRowById(entryId)
          ? mapGuestbookRow(this.getEntryRowById(entryId)!)
          : {
              id: entryId,
              targetSpaceId: space.space_id,
              targetSpaceLabel: `${space.owner_nickname}의 공간`,
              isArchivedSpace: false,
              authorMemberId: actor.id,
              authorNickname: actor.nickname,
              body: validatedBody,
              createdAt: nowIso,
              updatedAt: nowIso,
              deletedAt: null,
            };
      });
    } catch (error) {
      throw toServiceError(error);
    }
  }

  /**
   * Updates an existing guestbook entry. Allowed for the original author even in an archived space.
   */
  updateEntry(actorMemberId: string, entryId: string, body: unknown): GuestbookEntryRecord {
    try {
      const validatedBody = parseText('guestbook', body);
      const nowIso = this.clock.now().toISOString();

      return this.worldDb.transaction(() => {
        const actor = this.worldDb.db.prepare(
          "SELECT id, login_id, nickname, role, state FROM members WHERE id = ? AND state = 'active'",
        ).get(actorMemberId) as unknown as ActorRow | undefined;
        if (!actor) {
          throw new ServiceError('FORBIDDEN', '활성 회원만 방명록을 수정할 수 있어요.');
        }

        const existing = this.getEntryRowById(entryId);
        if (!existing) {
          throw new ServiceError('NOT_FOUND', '방명록 글을 찾을 수 없어요.');
        }
        if (existing.author_member_id !== actor.id) {
          throw new ServiceError('FORBIDDEN', '본인이 작성한 방명록만 수정할 수 있어요.');
        }

        this.worldDb.db.prepare(`
          UPDATE guestbook_entries
          SET body = ?, updated_at = ?
          WHERE id = ?
        `).run(validatedBody, nowIso, entryId);

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'guestbook.update',
          outcome: 'success',
          memberId: actor.id,
          loginIdSnapshot: actor.login_id,
          nicknameSnapshot: actor.nickname,
        });

        const updated = this.getEntryRowById(entryId)!;
        return mapGuestbookRow(updated);
      });
    } catch (error) {
      throw toServiceError(error);
    }
  }

  /**
   * Soft-deletes a guestbook entry (author or active admin).
   * Admin moderation deletions also record `moderation_deletions` and a `delete_content` tombstone.
   */
  deleteEntry(actorMemberId: string, entryId: string, reason?: unknown): DeleteGuestbookResult {
    try {
      const nowIso = this.clock.now().toISOString();

      return this.worldDb.transaction(() => {
        const actor = this.worldDb.db.prepare(
          "SELECT id, login_id, nickname, role, state FROM members WHERE id = ? AND state = 'active'",
        ).get(actorMemberId) as unknown as ActorRow | undefined;
        if (!actor) {
          throw new ServiceError('FORBIDDEN', '활성 회원만 방명록을 삭제할 수 있어요.');
        }

        const existing = this.getEntryRowById(entryId);
        if (!existing) {
          throw new ServiceError('NOT_FOUND', '방명록 글을 찾을 수 없어요.');
        }

        const isAuthor = existing.author_member_id === actor.id;
        const isAdmin = actor.role === 'admin';
        if (!isAuthor && !isAdmin) {
          throw new ServiceError('FORBIDDEN', '작성자 또는 관리자만 방명록을 삭제할 수 있어요.');
        }

        const byAdmin = !isAuthor && isAdmin;
        let effectiveReason = '관리자 삭제';
        if (byAdmin && reason !== undefined) {
          effectiveReason = parseText('reason', reason);
        }

        this.worldDb.db.prepare(`
          UPDATE guestbook_entries
          SET deleted_at = ?, updated_at = ?
          WHERE id = ?
        `).run(nowIso, nowIso, entryId);

        if (byAdmin) {
          this.worldDb.db.prepare(`
            INSERT INTO moderation_deletions (id, admin_member_id, target_kind, target_id, reason, deleted_at, expires_at)
            VALUES (?, ?, 'guestbook', ?, ?, ?, ?)
          `).run(
            generateId(),
            actor.id,
            entryId,
            effectiveReason,
            nowIso,
            addDays(nowIso, 90),
          );

          this.worldDb.appendTombstone({
            recordedAt: nowIso,
            kind: 'delete_content',
            targetKind: 'guestbook',
            targetId: entryId,
            payload: {
              deletedAt: nowIso,
              adminMemberId: actor.id,
              reason: effectiveReason,
            },
          });
        }

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: byAdmin ? 'admin.guestbook.delete' : 'guestbook.delete',
          outcome: 'success',
          memberId: actor.id,
          loginIdSnapshot: actor.login_id,
          nicknameSnapshot: actor.nickname,
        });

        return {
          deleted: true,
          entryId,
          deletedAt: nowIso,
          byAdmin,
        };
      });
    } catch (error) {
      throw toServiceError(error);
    }
  }
}
