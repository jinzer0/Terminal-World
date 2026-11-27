import { parseText, ValidationError } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { addDays, addHours, type Clock } from './clock.js';
import { generateId, sha256Hex } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export const WITHDRAWN_AUTHOR_LABEL = '탈퇴한 사용자';
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const IDEMPOTENCY_TTL_HOURS = 24;
export const MODERATION_RETENTION_DAYS = 90;

export const BOARD_IDS = [
  'free',
  'dev-qna',
  'info',
  'mcp',
  'skills',
  'opensource',
  'recruitment',
] as const;

export type BoardId = (typeof BOARD_IDS)[number];

export interface BoardRecord {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
}

export interface LiveMember {
  id: string;
  role: 'member' | 'admin';
  state: 'active' | 'withdrawn';
  nickname: string;
}

export interface PostRecord {
  id: string;
  boardId: string;
  authorMemberId: string | null;
  authorNickname: string;
  title: string;
  body: string;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentRecord {
  id: string;
  postId: string;
  authorMemberId: string | null;
  authorNickname: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostDetail extends PostRecord {
  comments: CommentRecord[];
}

export interface ListPostsOptions {
  boardId: string;
  cursor?: string | null;
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface CreatePostInput {
  boardId: string;
  title: string;
  body: string;
  idempotencyKey?: string;
}

export interface UpdatePostInput {
  title?: string;
  body?: string;
}

export interface DeleteContentOptions {
  reason?: string;
}

export interface CreateCommentInput {
  postId: string;
  body: string;
  idempotencyKey?: string;
}

export interface UpdateCommentInput {
  body: string;
}

interface BoardRow {
  id: string;
  name: string;
  description: string;
  sort_order: number;
}

interface PostRow {
  id: string;
  board_id: string;
  author_member_id: string | null;
  author_nickname: string | null;
  author_state: string | null;
  title: string;
  body: string;
  comment_count: number;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  post_id: string;
  author_member_id: string | null;
  author_nickname: string | null;
  author_state: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

interface IdempotencyRow {
  scope_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_json: string | null;
  expires_at: string;
}

export function resolveAuthorNickname(
  authorMemberId: string | null,
  authorNickname: string | null,
  authorState: string | null,
): string {
  if (!authorMemberId || !authorNickname || authorState !== 'active') {
    return WITHDRAWN_AUTHOR_LABEL;
  }
  return authorNickname;
}

export function encodeTimeIdCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeTimeIdCursor(cursor: string | null | undefined): CursorPayload | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as CursorPayload).createdAt !== 'string' ||
      typeof (parsed as CursorPayload).id !== 'string' ||
      !(parsed as CursorPayload).createdAt ||
      !(parsed as CursorPayload).id
    ) {
      throw new Error('Invalid cursor structure');
    }
    return parsed as CursorPayload;
  } catch {
    throw new ServiceError('INVALID_INPUT', '유효하지 않은 페이지 커서예요.', 'cursor');
  }
}

export function normalizePageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ServiceError(
      'INVALID_INPUT',
      `조회 개수는 1~${MAX_PAGE_LIMIT} 사이의 정수로 지정해 주세요.`,
      'limit',
    );
  }
  return limit;
}

export function normalizeIdempotencyKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (typeof key !== 'string') {
    throw new ServiceError('INVALID_INPUT', '멱등성 키는 문자열이어야 해요.', 'idempotencyKey');
  }
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new ServiceError(
      'INVALID_INPUT',
      '멱등성 키는 1~128자의 비어 있지 않은 문자열이어야 해요.',
      'idempotencyKey',
    );
  }
  return trimmed;
}

/**
 * Verifies inside the active transaction that `actorMemberId` refers to an existing active member.
 */
export function requireActiveMember(
  worldDb: WorldDatabase,
  actorMemberId: string | null | undefined,
): LiveMember {
  if (typeof actorMemberId !== 'string' || !actorMemberId.trim()) {
    throw new ServiceError('UNAUTHORIZED', '로그인이 필요한 기능이에요.');
  }
  const row = worldDb.db.prepare(
    'SELECT id, role, state, nickname FROM members WHERE id = ?',
  ).get(actorMemberId) as unknown as LiveMember | undefined;

  if (!row || row.state !== 'active') {
    throw new ServiceError('UNAUTHORIZED', '유효한 로그인 계정을 찾을 수 없어요.');
  }
  return row;
}

/**
 * Executes a write operation with optional `idempotency_keys` protection inside an active transaction.
 */
export function executeIdempotent<T>(
  worldDb: WorldDatabase,
  nowIso: string,
  memberId: string,
  operation: string,
  idempotencyKey: string | null,
  requestPayload: unknown,
  fn: () => T,
): T {
  if (!idempotencyKey) {
    return fn();
  }

  const scopeKey = `${memberId}:${operation}:${idempotencyKey}`;
  const requestHash = sha256Hex(JSON.stringify(requestPayload));

  const existing = worldDb.db.prepare(
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
      throw new ServiceError(
        'CONFLICT',
        '동일한 요청이 이미 처리 중이에요.',
        'idempotencyKey',
      );
    }
    worldDb.db.prepare('DELETE FROM idempotency_keys WHERE scope_key = ?').run(scopeKey);
  }

  const expiresAt = addHours(nowIso, IDEMPOTENCY_TTL_HOURS);
  worldDb.db.prepare(`
    INSERT INTO idempotency_keys (scope_key, request_hash, status, response_json, created_at, expires_at)
    VALUES (?, ?, 'in_progress', NULL, ?, ?)
  `).run(scopeKey, requestHash, nowIso, expiresAt);

  const result = fn();

  worldDb.db.prepare(`
    UPDATE idempotency_keys
    SET status = 'completed', response_json = ?
    WHERE scope_key = ?
  `).run(JSON.stringify(result), scopeKey);

  return result;
}

export function resolveDeleteReason(reason: string | undefined): string {
  if (reason === undefined) return '관리자 삭제';
  try {
    return parseText('reason', reason);
  } catch (error) {
    throw toServiceError(error);
  }
}

function mapPostRow(row: PostRow): PostRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    authorMemberId: row.author_member_id,
    authorNickname: resolveAuthorNickname(row.author_member_id, row.author_nickname, row.author_state),
    title: row.title,
    body: row.body,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommentRow(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    postId: row.post_id,
    authorMemberId: row.author_member_id,
    authorNickname: resolveAuthorNickname(row.author_member_id, row.author_nickname, row.author_state),
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BoardService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  listBoards(): BoardRecord[] {
    const rows = this.worldDb.db.prepare(
      'SELECT id, name, description, sort_order FROM boards ORDER BY sort_order ASC',
    ).all() as unknown as BoardRow[];
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
    }));
  }

  getBoard(boardId: string): BoardRecord | null {
    const row = this.worldDb.db.prepare(
      'SELECT id, name, description, sort_order FROM boards WHERE id = ?',
    ).get(boardId) as unknown as BoardRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
    };
  }

  listPosts(options: ListPostsOptions): PaginatedResult<PostRecord> {
    if (!this.getBoard(options.boardId)) {
      throw new ServiceError('NOT_FOUND', '게시판을 찾을 수 없어요.', 'boardId');
    }

    const limit = normalizePageLimit(options.limit);
    const decoded = decodeTimeIdCursor(options.cursor);

    const params: Array<string | number> = [options.boardId];
    let cursorClause = '';
    if (decoded) {
      cursorClause = 'AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))';
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }
    params.push(limit + 1);

    const rows = this.worldDb.db.prepare(`
      SELECT
        p.id,
        p.board_id,
        p.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        p.title,
        p.body,
        (
          SELECT COUNT(*)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS comment_count,
        p.created_at,
        p.updated_at
      FROM posts p
      LEFT JOIN members m ON m.id = p.author_member_id
      WHERE p.board_id = ? AND p.deleted_at IS NULL
      ${cursorClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?
    `).all(...params) as unknown as PostRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(mapPostRow);
    const last = items[items.length - 1];

    return {
      items,
      cursor: hasMore && last ? encodeTimeIdCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  getPost(postId: string): PostDetail {
    const row = this.worldDb.db.prepare(`
      SELECT
        p.id,
        p.board_id,
        p.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        p.title,
        p.body,
        (
          SELECT COUNT(*)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS comment_count,
        p.created_at,
        p.updated_at
      FROM posts p
      LEFT JOIN members m ON m.id = p.author_member_id
      WHERE p.id = ? AND p.deleted_at IS NULL
    `).get(postId) as unknown as PostRow | undefined;

    if (!row) {
      throw new ServiceError('NOT_FOUND', '게시글을 찾을 수 없어요.', 'postId');
    }

    const commentRows = this.worldDb.db.prepare(`
      SELECT
        c.id,
        c.post_id,
        c.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        c.body,
        c.created_at,
        c.updated_at
      FROM comments c
      LEFT JOIN members m ON m.id = c.author_member_id
      WHERE c.post_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC, c.rowid ASC
    `).all(postId) as unknown as CommentRow[];

    return {
      ...mapPostRow(row),
      comments: commentRows.map(mapCommentRow),
    };
  }

  createPost(actorMemberId: string | null | undefined, input: CreatePostInput): PostRecord {
    let title: string;
    let body: string;
    try {
      title = parseText('title', input.title);
      body = parseText('body', input.body);
    } catch (error) {
      if (error instanceof ValidationError) throw toServiceError(error);
      throw toServiceError(error);
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      if (!this.getBoard(input.boardId)) {
        throw new ServiceError('NOT_FOUND', '게시판을 찾을 수 없어요.', 'boardId');
      }

      return executeIdempotent(
        this.worldDb,
        nowIso,
        actor.id,
        'board.createPost',
        idempotencyKey,
        { boardId: input.boardId, title, body },
        () => {
          const postId = generateId();
          this.worldDb.db.prepare(`
            INSERT INTO posts (id, board_id, author_member_id, title, body, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          `).run(postId, input.boardId, actor.id, title, body, nowIso, nowIso);

          return {
            id: postId,
            boardId: input.boardId,
            authorMemberId: actor.id,
            authorNickname: actor.nickname,
            title,
            body,
            commentCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
        },
      );
    });
  }

  updatePost(
    actorMemberId: string | null | undefined,
    postId: string,
    input: UpdatePostInput,
  ): PostRecord {
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

    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const existing = this.worldDb.db.prepare(
        'SELECT id, board_id, author_member_id, title, body FROM posts WHERE id = ? AND deleted_at IS NULL',
      ).get(postId) as unknown as {
        id: string;
        board_id: string;
        author_member_id: string | null;
        title: string;
        body: string;
      } | undefined;

      if (!existing) {
        throw new ServiceError('NOT_FOUND', '게시글을 찾을 수 없어요.', 'postId');
      }
      if (existing.author_member_id !== actor.id) {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 게시글만 수정할 수 있어요.');
      }

      const finalTitle = nextTitle ?? existing.title;
      const finalBody = nextBody ?? existing.body;

      this.worldDb.db.prepare(`
        UPDATE posts
        SET title = ?, body = ?, updated_at = ?
        WHERE id = ?
      `).run(finalTitle, finalBody, nowIso, postId);

      const updated = this.getPost(postId);
      return {
        id: updated.id,
        boardId: updated.boardId,
        authorMemberId: updated.authorMemberId,
        authorNickname: updated.authorNickname,
        title: updated.title,
        body: updated.body,
        commentCount: updated.commentCount,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
    });
  }

  deletePost(
    actorMemberId: string | null | undefined,
    postId: string,
    options: DeleteContentOptions = {},
  ): { deletedPostId: string; deletedCommentCount: number } {
    const nowIso = this.clock.now().toISOString();
    const moderationReason = resolveDeleteReason(options.reason);

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const existing = this.worldDb.db.prepare(
        'SELECT id, author_member_id FROM posts WHERE id = ? AND deleted_at IS NULL',
      ).get(postId) as unknown as { id: string; author_member_id: string | null } | undefined;

      if (!existing) {
        throw new ServiceError('NOT_FOUND', '게시글을 찾을 수 없어요.', 'postId');
      }

      const isAuthor = existing.author_member_id === actor.id;
      if (!isAuthor && actor.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 글만 삭제할 수 있어요.');
      }

      this.worldDb.db.prepare(`
        UPDATE posts
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, postId);

      const commentResult = this.worldDb.db.prepare(`
        UPDATE comments
        SET deleted_at = ?, updated_at = ?
        WHERE post_id = ? AND deleted_at IS NULL
      `).run(nowIso, nowIso, postId);

      this.worldDb.db.prepare(
        'DELETE FROM recruitment_bookmarks WHERE post_id = ?',
      ).run(postId);

      this.worldDb.appendTombstone({
        recordedAt: nowIso,
        kind: 'delete_content',
        targetKind: 'post',
        targetId: postId,
        payload: { byAdmin: !isAuthor },
      });

      if (!isAuthor) {
        this.worldDb.db.prepare(`
          INSERT INTO moderation_deletions (id, admin_member_id, target_kind, target_id, reason, deleted_at, expires_at)
          VALUES (?, ?, 'post', ?, ?, ?, ?)
        `).run(
          generateId(),
          actor.id,
          postId,
          moderationReason,
          nowIso,
          addDays(nowIso, MODERATION_RETENTION_DAYS),
        );
      }

      return {
        deletedPostId: postId,
        deletedCommentCount: Number(commentResult.changes),
      };
    });
  }

  createComment(actorMemberId: string | null | undefined, input: CreateCommentInput): CommentRecord {
    let body: string;
    try {
      body = parseText('comment', input.body);
    } catch (error) {
      throw toServiceError(error);
    }
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const post = this.worldDb.db.prepare(
        'SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL',
      ).get(input.postId) as unknown as { id: string } | undefined;

      if (!post) {
        throw new ServiceError('NOT_FOUND', '게시글을 찾을 수 없어요.', 'postId');
      }

      return executeIdempotent(
        this.worldDb,
        nowIso,
        actor.id,
        'board.createComment',
        idempotencyKey,
        { postId: input.postId, body },
        () => {
          const commentId = generateId();
          this.worldDb.db.prepare(`
            INSERT INTO comments (id, post_id, author_member_id, body, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL)
          `).run(commentId, input.postId, actor.id, body, nowIso, nowIso);

          return {
            id: commentId,
            postId: input.postId,
            authorMemberId: actor.id,
            authorNickname: actor.nickname,
            body,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
        },
      );
    });
  }

  updateComment(
    actorMemberId: string | null | undefined,
    commentId: string,
    input: UpdateCommentInput,
  ): CommentRecord {
    let body: string;
    try {
      body = parseText('comment', input.body);
    } catch (error) {
      throw toServiceError(error);
    }
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const existing = this.worldDb.db.prepare(`
        SELECT c.id, c.post_id, c.author_member_id, c.created_at
        FROM comments c
        JOIN posts p ON p.id = c.post_id
        WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL
      `).get(commentId) as unknown as {
        id: string;
        post_id: string;
        author_member_id: string | null;
        created_at: string;
      } | undefined;

      if (!existing) {
        throw new ServiceError('NOT_FOUND', '댓글을 찾을 수 없어요.', 'commentId');
      }
      if (existing.author_member_id !== actor.id) {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 댓글만 수정할 수 있어요.');
      }

      this.worldDb.db.prepare(`
        UPDATE comments
        SET body = ?, updated_at = ?
        WHERE id = ?
      `).run(body, nowIso, commentId);

      return {
        id: existing.id,
        postId: existing.post_id,
        authorMemberId: actor.id,
        authorNickname: actor.nickname,
        body,
        createdAt: existing.created_at,
        updatedAt: nowIso,
      };
    });
  }

  deleteComment(
    actorMemberId: string | null | undefined,
    commentId: string,
    options: DeleteContentOptions = {},
  ): { deletedCommentId: string; postId: string } {
    const nowIso = this.clock.now().toISOString();
    const moderationReason = resolveDeleteReason(options.reason);

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const existing = this.worldDb.db.prepare(
        'SELECT id, post_id, author_member_id FROM comments WHERE id = ? AND deleted_at IS NULL',
      ).get(commentId) as unknown as {
        id: string;
        post_id: string;
        author_member_id: string | null;
      } | undefined;

      if (!existing) {
        throw new ServiceError('NOT_FOUND', '댓글을 찾을 수 없어요.', 'commentId');
      }

      const isAuthor = existing.author_member_id === actor.id;
      if (!isAuthor && actor.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 댓글만 삭제할 수 있어요.');
      }

      this.worldDb.db.prepare(`
        UPDATE comments
        SET deleted_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, commentId);

      this.worldDb.appendTombstone({
        recordedAt: nowIso,
        kind: 'delete_content',
        targetKind: 'comment',
        targetId: commentId,
        payload: { postId: existing.post_id, byAdmin: !isAuthor },
      });

      if (!isAuthor) {
        this.worldDb.db.prepare(`
          INSERT INTO moderation_deletions (id, admin_member_id, target_kind, target_id, reason, deleted_at, expires_at)
          VALUES (?, ?, 'comment', ?, ?, ?, ?)
        `).run(
          generateId(),
          actor.id,
          commentId,
          moderationReason,
          nowIso,
          addDays(nowIso, MODERATION_RETENTION_DAYS),
        );
      }

      return {
        deletedCommentId: commentId,
        postId: existing.post_id,
      };
    });
  }
}
