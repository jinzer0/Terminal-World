import { parseText } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  executeIdempotent,
  normalizeIdempotencyKey,
  normalizePageLimit,
  requireActiveMember,
  resolveAuthorNickname,
  type LiveMember,
  type PaginatedResult,
} from './board-service.js';
import type { Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export type NoticePublicationState = 'published' | 'ended';

export interface NoticeRecord {
  id: string;
  authorMemberId: string | null;
  authorNickname: string;
  title: string;
  body: string;
  publicationState: NoticePublicationState;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface ListNoticesOptions {
  includeEnded?: boolean;
  state?: NoticePublicationState;
  cursor?: string | null;
  limit?: number;
}

export interface CreateNoticeInput {
  title: string;
  body: string;
  idempotencyKey?: string;
}

export interface UpdateNoticeInput {
  title?: string;
  body?: string;
  idempotencyKey?: string;
}

export interface EndNoticeOptions {
  idempotencyKey?: string;
}

interface NoticeRow {
  id: string;
  author_member_id: string | null;
  author_nickname: string | null;
  author_state: string | null;
  title: string;
  body: string;
  publication_state: NoticePublicationState;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

function mapNoticeRow(row: NoticeRow): NoticeRecord {
  return {
    id: row.id,
    authorMemberId: row.author_member_id,
    authorNickname: resolveAuthorNickname(row.author_member_id, row.author_nickname, row.author_state),
    title: row.title,
    body: row.body,
    publicationState: row.publication_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

function requireLiveAdmin(
  worldDb: WorldDatabase,
  actorMemberId: string | null | undefined,
): LiveMember {
  const actor = requireActiveMember(worldDb, actorMemberId);
  if (actor.role !== 'admin') {
    throw new ServiceError('FORBIDDEN', '관리자만 공지를 운영할 수 있어요.');
  }
  return actor;
}

export class NoticeService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  listNotices(options: ListNoticesOptions = {}): PaginatedResult<NoticeRecord> {
    const limit = normalizePageLimit(options.limit);
    const decoded = decodeTimeIdCursor(options.cursor);

    if (options.state !== undefined && options.state !== 'published' && options.state !== 'ended') {
      throw new ServiceError('INVALID_INPUT', '공지 상태는 published 또는 ended여야 해요.', 'state');
    }

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.state) {
      conditions.push('n.publication_state = ?');
      params.push(options.state);
    } else if (!options.includeEnded) {
      conditions.push("n.publication_state = 'published'");
    }

    if (decoded) {
      conditions.push('(n.created_at < ? OR (n.created_at = ? AND n.id < ?))');
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }
    params.push(limit + 1);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.worldDb.db.prepare(`
      SELECT
        n.id,
        n.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        n.title,
        n.body,
        n.publication_state,
        n.created_at,
        n.updated_at,
        n.ended_at
      FROM notices n
      LEFT JOIN members m ON m.id = n.author_member_id
      ${whereClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?
    `).all(...params) as unknown as NoticeRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapNoticeRow);
    const last = items[items.length - 1];

    return {
      items,
      cursor: hasMore && last ? encodeTimeIdCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  getNotice(noticeId: string): NoticeRecord {
    const row = this.worldDb.db.prepare(`
      SELECT
        n.id,
        n.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        n.title,
        n.body,
        n.publication_state,
        n.created_at,
        n.updated_at,
        n.ended_at
      FROM notices n
      LEFT JOIN members m ON m.id = n.author_member_id
      WHERE n.id = ?
    `).get(noticeId) as unknown as NoticeRow | undefined;

    if (!row) {
      throw new ServiceError('NOT_FOUND', '공지를 찾을 수 없어요.', 'noticeId');
    }
    return mapNoticeRow(row);
  }

  createNotice(actorMemberId: string | null | undefined, input: CreateNoticeInput): NoticeRecord {
    let title: string;
    let body: string;
    try {
      title = parseText('title', input.title);
      body = parseText('body', input.body);
    } catch (error) {
      throw toServiceError(error);
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const admin = requireLiveAdmin(this.worldDb, actorMemberId);

      return executeIdempotent(
        this.worldDb,
        nowIso,
        admin.id,
        'notice.create',
        idempotencyKey,
        { title, body },
        () => {
          const noticeId = generateId();
          this.worldDb.db.prepare(`
            INSERT INTO notices (
              id, author_member_id, title, body, publication_state, created_at, updated_at, ended_at
            ) VALUES (?, ?, ?, ?, 'published', ?, ?, NULL)
          `).run(noticeId, admin.id, title, body, nowIso, nowIso);

          this.worldDb.recordOperationalLog({
            occurredAt: nowIso,
            eventType: 'notice.create',
            outcome: 'success',
            memberId: admin.id,
            nicknameSnapshot: admin.nickname,
          });

          return this.getNotice(noticeId);
        },
      );
    });
  }

  updateNotice(
    actorMemberId: string | null | undefined,
    noticeId: string,
    input: UpdateNoticeInput,
  ): NoticeRecord {
    if (input.title === undefined && input.body === undefined) {
      throw new ServiceError('INVALID_INPUT', '수정할 제목이나 본문을 입력해 주세요.');
    }

    let nextTitle: string | undefined;
    let nextBody: string | undefined;
    try {
      if (input.title !== undefined) nextTitle = parseText('title', input.title);
      if (input.body !== undefined) nextBody = parseText('body', input.body);
    } catch (error) {
      throw toServiceError(error);
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const admin = requireLiveAdmin(this.worldDb, actorMemberId);

      return executeIdempotent(
        this.worldDb,
        nowIso,
        admin.id,
        'notice.update',
        idempotencyKey,
        { noticeId, title: nextTitle, body: nextBody },
        () => {
          const existing = this.worldDb.db.prepare(
            'SELECT id, title, body FROM notices WHERE id = ?',
          ).get(noticeId) as unknown as { id: string; title: string; body: string } | undefined;

          if (!existing) {
            throw new ServiceError('NOT_FOUND', '공지를 찾을 수 없어요.', 'noticeId');
          }

          this.worldDb.db.prepare(`
            UPDATE notices
            SET title = ?, body = ?, updated_at = ?
            WHERE id = ?
          `).run(nextTitle ?? existing.title, nextBody ?? existing.body, nowIso, noticeId);

          this.worldDb.recordOperationalLog({
            occurredAt: nowIso,
            eventType: 'notice.update',
            outcome: 'success',
            memberId: admin.id,
            nicknameSnapshot: admin.nickname,
          });

          return this.getNotice(noticeId);
        },
      );
    });
  }

  endNotice(
    actorMemberId: string | null | undefined,
    noticeId: string,
    options: EndNoticeOptions = {},
  ): NoticeRecord {
    const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const admin = requireLiveAdmin(this.worldDb, actorMemberId);

      return executeIdempotent(
        this.worldDb,
        nowIso,
        admin.id,
        'notice.end',
        idempotencyKey,
        { noticeId },
        () => {
          const existing = this.worldDb.db.prepare(
            'SELECT id, ended_at FROM notices WHERE id = ?',
          ).get(noticeId) as unknown as { id: string; ended_at: string | null } | undefined;

          if (!existing) {
            throw new ServiceError('NOT_FOUND', '공지를 찾을 수 없어요.', 'noticeId');
          }

          const endedAt = existing.ended_at ?? nowIso;
          this.worldDb.db.prepare(`
            UPDATE notices
            SET publication_state = 'ended', ended_at = ?, updated_at = ?
            WHERE id = ?
          `).run(endedAt, nowIso, noticeId);

          this.worldDb.recordOperationalLog({
            occurredAt: nowIso,
            eventType: 'notice.end',
            outcome: 'success',
            memberId: admin.id,
            nicknameSnapshot: admin.nickname,
          });

          return this.getNotice(noticeId);
        },
      );
    });
  }
}
