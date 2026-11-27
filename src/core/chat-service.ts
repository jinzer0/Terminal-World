import { parseText } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { addDays, addHours, type Clock } from './clock.js';
import { generateId, sha256Hex } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';
import type { RealtimeHub } from './realtime-hub.js';

export const ROOFTOP_ROOM_ID = 'space:rooftop';
export const CHAT_RETENTION_DAYS = 14;
export const CHAT_HISTORY_LIMIT = 100;
export const CHAT_IDEMPOTENCY_TTL_HOURS = 24;

export interface ChatMessageRecord {
  id: string;
  roomId: string;
  authorMemberId: string | null;
  authorNickname: string;
  body: string;
  sentAt: string;
  expiresAt: string;
  deletedAt: string | null;
}

export interface SendChatMessageInput {
  memberId: string | null;
  body: string;
  roomId?: string;
  idempotencyKey?: string;
}

export interface SendChatMessageResult extends ChatMessageRecord {
  deduplicated: boolean;
}

export interface ListChatMessagesOptions {
  roomId?: string;
  limit?: number;
}

export interface DeleteChatMessageResult {
  id: string;
  roomId: string;
  deletedAt: string;
}

interface ChatMessageRow {
  id: string;
  room_id: string;
  author_member_id: string | null;
  author_nickname: string | null;
  body: string;
  sent_at: string;
  expires_at: string;
  deleted_at: string | null;
}

interface IdempotencyRow {
  scope_key: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_json: string | null;
  created_at: string;
  expires_at: string;
}

function mapChatRow(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    authorMemberId: row.author_member_id,
    authorNickname: row.author_nickname ?? '탈퇴한 사용자',
    body: row.body,
    sentAt: row.sent_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  };
}

function normalizeRoomId(roomId?: string): string {
  const target = roomId ?? ROOFTOP_ROOM_ID;
  if (target !== ROOFTOP_ROOM_ID) {
    throw new ServiceError('INVALID_INPUT', 'RoofTop 채팅방만 지원해요.', 'roomId');
  }
  return target;
}

function normalizeIdempotencyKey(key?: string): string | null {
  if (key === undefined) return null;
  if (typeof key !== 'string') {
    throw new ServiceError('INVALID_INPUT', '멱등 키는 문자열이어야 해요.', 'idempotencyKey');
  }
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new ServiceError('INVALID_INPUT', '올바른 멱등 키를 입력해 주세요.', 'idempotencyKey');
  }
  return trimmed;
}

export class ChatService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    private readonly hub?: RealtimeHub,
  ) {}

  /**
   * Sends a RoofTop chat message from an active logged-in member.
   * Guests are forbidden, input is validated via `parseText('chat', body)`,
   * and idempotency keys are enforced inside `BEGIN IMMEDIATE`.
   */
  sendMessage(input: SendChatMessageInput): SendChatMessageResult {
    if (!input.memberId) {
      throw new ServiceError('FORBIDDEN', '게스트는 RoofTop 채팅 메시지를 보낼 수 없어요. 로그인해 주세요.');
    }

    const roomId = normalizeRoomId(input.roomId);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

    let validatedBody: string;
    try {
      validatedBody = parseText('chat', input.body);
    } catch (error) {
      throw toServiceError(error);
    }

    const nowIso = this.clock.now().toISOString();
    const requestHash = sha256Hex(JSON.stringify({ roomId, body: validatedBody }));

    const result = this.worldDb.transaction((): SendChatMessageResult => {
      const member = this.worldDb.db.prepare(
        'SELECT id, nickname, state FROM members WHERE id = ?',
      ).get(input.memberId!) as { id: string; nickname: string; state: string } | undefined;

      if (!member || member.state !== 'active') {
        throw new ServiceError('FORBIDDEN', '활성 회원만 RoofTop 채팅을 보낼 수 있어요.');
      }

      const scopeKey = idempotencyKey ? `${member.id}:chat.send:${idempotencyKey}` : null;
      if (scopeKey) {
        const existingKey = this.worldDb.db.prepare(
          'SELECT * FROM idempotency_keys WHERE scope_key = ?',
        ).get(scopeKey) as unknown as IdempotencyRow | undefined;

        if (existingKey) {
          if (existingKey.expires_at <= nowIso) {
            this.worldDb.db.prepare('DELETE FROM idempotency_keys WHERE scope_key = ?').run(scopeKey);
          } else {
            if (existingKey.request_hash !== requestHash) {
              throw new ServiceError(
                'CONFLICT',
                '동일한 멱등 키로 다른 내용의 메시지를 보낼 수 없어요.',
                'idempotencyKey',
              );
            }
            if (existingKey.status === 'completed' && existingKey.response_json) {
              const cached = JSON.parse(existingKey.response_json) as ChatMessageRecord;
              return { ...cached, deduplicated: true };
            }
            throw new ServiceError('CONFLICT', '동일한 요청이 이미 처리 중이에요.', 'idempotencyKey');
          }
        }
      }

      const messageId = generateId();
      const expiresAt = addDays(nowIso, CHAT_RETENTION_DAYS);

      this.worldDb.db.prepare(`
        INSERT INTO chat_messages (id, room_id, author_member_id, body, sent_at, expires_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(messageId, roomId, member.id, validatedBody, nowIso, expiresAt);

      const record: ChatMessageRecord = {
        id: messageId,
        roomId,
        authorMemberId: member.id,
        authorNickname: member.nickname,
        body: validatedBody,
        sentAt: nowIso,
        expiresAt,
        deletedAt: null,
      };

      if (scopeKey) {
        const keyExpiresAt = addHours(nowIso, CHAT_IDEMPOTENCY_TTL_HOURS);
        this.worldDb.db.prepare(`
          INSERT INTO idempotency_keys (scope_key, request_hash, status, response_json, created_at, expires_at)
          VALUES (?, ?, 'completed', ?, ?, ?)
        `).run(scopeKey, requestHash, JSON.stringify(record), nowIso, keyExpiresAt);
      }

      return { ...record, deduplicated: false };
    });

    if (!result.deduplicated) {
      this.hub?.publish('chat.message', {
        id: result.id,
        roomId: result.roomId,
        authorMemberId: result.authorMemberId,
        authorNickname: result.authorNickname,
        body: result.body,
        sentAt: result.sentAt,
        expiresAt: result.expiresAt,
      }, nowIso);
    }

    return result;
  }

  /**
   * Lists recent non-deleted RoofTop messages within the 14-day retention window,
   * ordered chronologically (oldest to newest), capped at 100 entries.
   */
  listRecentMessages(options: ListChatMessagesOptions = {}): ChatMessageRecord[] {
    const roomId = normalizeRoomId(options.roomId);
    const requested = options.limit ?? CHAT_HISTORY_LIMIT;
    const limit = Math.min(Math.max(Math.trunc(requested), 1), CHAT_HISTORY_LIMIT);
    const nowIso = this.clock.now().toISOString();

    const rows = this.worldDb.db.prepare(`
      SELECT
        c.id,
        c.room_id,
        c.author_member_id,
        m.nickname AS author_nickname,
        c.body,
        c.sent_at,
        c.expires_at,
        c.deleted_at
      FROM chat_messages c
      LEFT JOIN members m ON m.id = c.author_member_id
      WHERE c.room_id = ?
        AND c.deleted_at IS NULL
        AND c.expires_at > ?
      ORDER BY c.sent_at DESC, c.rowid DESC
      LIMIT ?
    `).all(roomId, nowIso, limit) as unknown as ChatMessageRow[];

    return rows.reverse().map(mapChatRow);
  }

  /**
   * Soft-deletes a RoofTop chat message as an active admin, records moderation metadata
   * and a tombstone without storing deleted message content, and emits `chat.deleted`.
   */
  deleteMessage(
    adminMemberId: string,
    messageId: string,
    reason?: string,
  ): DeleteChatMessageResult {
    const nowIso = this.clock.now().toISOString();
    let validatedReason = '관리자 삭제';
    if (reason !== undefined) {
      try {
        validatedReason = parseText('reason', reason);
      } catch (error) {
        throw toServiceError(error);
      }
    }

    const deleted = this.worldDb.transaction(() => {
      const admin = this.worldDb.db.prepare(
        'SELECT id, role, state FROM members WHERE id = ?',
      ).get(adminMemberId) as { id: string; role: string; state: string } | undefined;

      if (!admin || admin.state !== 'active') {
        throw new ServiceError('UNAUTHORIZED', '활성 회원만 요청할 수 있어요.');
      }
      if (admin.role !== 'admin') {
        throw new ServiceError('FORBIDDEN', '관리자만 채팅 메시지를 삭제할 수 있어요.');
      }

      const existing = this.worldDb.db.prepare(
        'SELECT id, room_id, deleted_at FROM chat_messages WHERE id = ?',
      ).get(messageId) as { id: string; room_id: string; deleted_at: string | null } | undefined;

      if (!existing || existing.deleted_at !== null) {
        throw new ServiceError('NOT_FOUND', '채팅 메시지를 찾을 수 없어요.');
      }

      this.worldDb.db.prepare(`
        UPDATE chat_messages
        SET deleted_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(nowIso, messageId);

      this.worldDb.db.prepare(`
        INSERT INTO moderation_deletions (
          id, admin_member_id, target_kind, target_id, reason, deleted_at, expires_at
        ) VALUES (?, ?, 'chat', ?, ?, ?, ?)
      `).run(
        generateId(),
        admin.id,
        messageId,
        validatedReason,
        nowIso,
        addDays(nowIso, 90),
      );

      this.worldDb.appendTombstone({
        recordedAt: nowIso,
        kind: 'delete_content',
        targetKind: 'chat',
        targetId: messageId,
        payload: {
          roomId: existing.room_id,
          reason: validatedReason,
        },
      });

      return {
        id: messageId,
        roomId: existing.room_id,
        deletedAt: nowIso,
      };
    });

    this.hub?.publish('chat.deleted', {
      id: deleted.id,
      roomId: deleted.roomId,
      deletedAt: deleted.deletedAt,
    }, nowIso);

    return deleted;
  }
}
