import type { WorldDatabase } from '../store/sqlite/database.js';
import type { Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError } from './errors.js';
import type { PresenceStatus, RealtimeHub } from './realtime-hub.js';

export const DEFAULT_SPACE_ID = 'space:lobby';
export const LIVING_ROOM_SPACE_ID = 'space:living';
export const DEFAULT_WORLD_X = 10;
export const DEFAULT_WORLD_Y = 6;

export type SessionChannel = 'ssh' | 'cli' | 'mcp';

export interface UserSessionRecord {
  id: string;
  memberId: string | null;
  isGuest: boolean;
  channel: SessionChannel;
  currentSpaceId: string;
  worldX: number;
  worldY: number;
  lastHeartbeatAt: string;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface OpenSessionInput {
  sessionId?: string;
  memberId?: string | null;
  isGuest?: boolean;
  channel: SessionChannel;
  spaceId?: string;
  worldX?: number;
  worldY?: number;
}

export interface CloseSessionOptions {
  reason?: string;
  mode?: 'normal' | 'disconnect';
}

export interface MemberPresenceSummary {
  memberId: string;
  nickname: string;
  status: PresenceStatus;
  activeSessionCount: number;
  spaces: string[];
}

export interface ActiveAvatarInfo {
  sessionId: string;
  memberId: string | null;
  nickname: string | null;
  isGuest: boolean;
  channel: SessionChannel;
  spaceId: string;
  worldX: number;
  worldY: number;
  status: PresenceStatus | 'guest';
}

export interface LobbyOverview {
  onlineMembers: MemberPresenceSummary[];
  awayMembers: MemberPresenceSummary[];
  members: MemberPresenceSummary[];
  onlineCount: number;
  awayCount: number;
  guestCount: number;
  activeAvatars: ActiveAvatarInfo[];
}

export interface SessionEndedNotification {
  sessionId: string;
  memberId: string | null;
  isGuest: boolean;
  mode: 'normal' | 'disconnect';
  reason: string;
  endedAt: string;
  lastHeartbeatAt: string;
}

export interface PresenceServiceOptions {
  onSessionEnded?: (info: SessionEndedNotification) => void;
}

interface UserSessionRow {
  id: string;
  member_id: string | null;
  is_guest: number;
  channel: SessionChannel;
  current_space_id: string;
  world_x: number;
  world_y: number;
  last_heartbeat_at: string;
  created_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

interface ActiveSessionWithMemberRow extends UserSessionRow {
  nickname: string | null;
  member_state: string | null;
}

function mapSessionRow(row: UserSessionRow): UserSessionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    isGuest: row.is_guest === 1,
    channel: row.channel,
    currentSpaceId: row.current_space_id,
    worldX: row.world_x,
    worldY: row.world_y,
    lastHeartbeatAt: row.last_heartbeat_at,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

function validateChannel(channel: unknown): SessionChannel {
  if (channel !== 'ssh' && channel !== 'cli' && channel !== 'mcp') {
    throw new ServiceError('INVALID_INPUT', '유효하지 않은 세션 채널이에요.', 'channel');
  }
  return channel;
}

function validateSpaceId(spaceId: unknown): string {
  if (typeof spaceId !== 'string') {
    throw new ServiceError('INVALID_INPUT', '유효한 공간 ID를 입력해 주세요.', 'spaceId');
  }
  const trimmed = spaceId.trim();
  if (!/^space:[a-z0-9:_-]+$/i.test(trimmed)) {
    throw new ServiceError('INVALID_INPUT', '유효하지 않은 공간 ID예요.', 'spaceId');
  }
  return trimmed;
}

function validateCoordinate(value: unknown, field: 'worldX' | 'worldY'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ServiceError('INVALID_INPUT', '좌표는 0 이상의 정수여야 해요.', field);
  }
  return value;
}

/**
 * Aggregates a member's presence status from their active `user_sessions`.
 * 0 active => offline; >=1 and ALL in space:living => away; >=1 and ANY outside => online.
 */
export function computePresenceStatus(activeSpaces: readonly string[]): PresenceStatus {
  if (activeSpaces.length === 0) return 'offline';
  return activeSpaces.every((spaceId) => spaceId === LIVING_ROOM_SPACE_ID) ? 'away' : 'online';
}

export class PresenceService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    private readonly hub?: RealtimeHub,
    private readonly options: PresenceServiceOptions = {},
  ) {}

  openSession(input: OpenSessionInput): UserSessionRecord {
    const channel = validateChannel(input.channel);
    const spaceId = input.spaceId !== undefined ? validateSpaceId(input.spaceId) : DEFAULT_SPACE_ID;
    const worldX = input.worldX !== undefined ? validateCoordinate(input.worldX, 'worldX') : DEFAULT_WORLD_X;
    const worldY = input.worldY !== undefined ? validateCoordinate(input.worldY, 'worldY') : DEFAULT_WORLD_Y;
    const isGuest = Boolean(input.isGuest) || !input.memberId;
    const memberId = isGuest ? null : input.memberId!;
    const sessionId = input.sessionId ?? generateId();
    const nowIso = this.clock.now().toISOString();

    const result = this.worldDb.transaction(() => {
      let nickname: string | null = null;
      let prevStatus: PresenceStatus = 'offline';
      let prevCount = 0;

      if (memberId !== null) {
        const member = this.worldDb.db.prepare(
          "SELECT id, nickname FROM members WHERE id = ? AND state = 'active'",
        ).get(memberId) as { id: string; nickname: string } | undefined;
        if (!member) {
          throw new ServiceError('UNAUTHORIZED', '활성 회원만 세션을 열 수 있어요.');
        }
        nickname = member.nickname;
        const prev = this.queryMemberActiveSpaces(memberId);
        prevCount = prev.length;
        prevStatus = computePresenceStatus(prev);
      }

      this.worldDb.db.prepare(`
        INSERT INTO user_sessions (
          id, member_id, is_guest, channel, current_space_id,
          world_x, world_y, last_heartbeat_at, created_at, ended_at, end_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        sessionId,
        memberId,
        isGuest ? 1 : 0,
        channel,
        spaceId,
        worldX,
        worldY,
        nowIso,
        nowIso,
      );

      const row = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ?',
      ).get(sessionId) as unknown as UserSessionRow;

      let nextStatus: PresenceStatus = 'offline';
      let nextCount = 0;
      if (memberId !== null) {
        const nextSpaces = this.queryMemberActiveSpaces(memberId);
        nextCount = nextSpaces.length;
        nextStatus = computePresenceStatus(nextSpaces);
      }

      return {
        session: mapSessionRow(row),
        nickname,
        prevStatus,
        prevCount,
        nextStatus,
        nextCount,
      };
    });

    if (result.session.memberId && result.nickname !== null) {
      if (result.prevStatus !== result.nextStatus || result.prevCount !== result.nextCount) {
        this.hub?.publish('presence.changed', {
          memberId: result.session.memberId,
          nickname: result.nickname,
          status: result.nextStatus,
          activeSessionCount: result.nextCount,
          occurredAt: nowIso,
        }, nowIso);
      }
    }

    this.hub?.publish('avatar.moved', {
      sessionId: result.session.id,
      memberId: result.session.memberId,
      nickname: result.nickname,
      isGuest: result.session.isGuest,
      spaceId: result.session.currentSpaceId,
      worldX: result.session.worldX,
      worldY: result.session.worldY,
      status: result.session.isGuest ? 'guest' : result.nextStatus,
      occurredAt: nowIso,
    }, nowIso);

    return result.session;
  }

  moveSpace(
    sessionId: string,
    spaceId: string,
    coords?: { worldX?: number; worldY?: number },
  ): UserSessionRecord {
    const validSpace = validateSpaceId(spaceId);
    const nextX = coords?.worldX !== undefined ? validateCoordinate(coords.worldX, 'worldX') : undefined;
    const nextY = coords?.worldY !== undefined ? validateCoordinate(coords.worldY, 'worldY') : undefined;
    const nowIso = this.clock.now().toISOString();

    const result = this.worldDb.transaction(() => {
      const existing = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ? AND ended_at IS NULL',
      ).get(sessionId) as unknown as UserSessionRow | undefined;
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '활성 세션을 찾을 수 없어요.');
      }

      let nickname: string | null = null;
      let prevStatus: PresenceStatus = 'offline';
      let prevCount = 0;

      if (existing.member_id) {
        const member = this.worldDb.db.prepare(
          'SELECT nickname FROM members WHERE id = ?',
        ).get(existing.member_id) as { nickname: string } | undefined;
        nickname = member?.nickname ?? null;
        const prevSpaces = this.queryMemberActiveSpaces(existing.member_id);
        prevCount = prevSpaces.length;
        prevStatus = computePresenceStatus(prevSpaces);
      }

      const targetX = nextX ?? existing.world_x;
      const targetY = nextY ?? existing.world_y;

      this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET current_space_id = ?, world_x = ?, world_y = ?, last_heartbeat_at = ?
        WHERE id = ? AND ended_at IS NULL
      `).run(validSpace, targetX, targetY, nowIso, sessionId);

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ?',
      ).get(sessionId) as unknown as UserSessionRow;

      let nextStatus: PresenceStatus = 'offline';
      let nextCount = 0;
      if (existing.member_id) {
        const nextSpaces = this.queryMemberActiveSpaces(existing.member_id);
        nextCount = nextSpaces.length;
        nextStatus = computePresenceStatus(nextSpaces);
      }

      return {
        session: mapSessionRow(updated),
        nickname,
        prevStatus,
        prevCount,
        nextStatus,
        nextCount,
      };
    });

    if (result.session.memberId && result.nickname !== null) {
      if (result.prevStatus !== result.nextStatus || result.prevCount !== result.nextCount) {
        this.hub?.publish('presence.changed', {
          memberId: result.session.memberId,
          nickname: result.nickname,
          status: result.nextStatus,
          activeSessionCount: result.nextCount,
          occurredAt: nowIso,
        }, nowIso);
      }
    }

    this.hub?.publish('avatar.moved', {
      sessionId: result.session.id,
      memberId: result.session.memberId,
      nickname: result.nickname,
      isGuest: result.session.isGuest,
      spaceId: result.session.currentSpaceId,
      worldX: result.session.worldX,
      worldY: result.session.worldY,
      status: result.session.isGuest ? 'guest' : result.nextStatus,
      occurredAt: nowIso,
    }, nowIso);

    return result.session;
  }

  moveAvatar(
    sessionId: string,
    worldX: number,
    worldY: number,
    spaceId?: string,
  ): UserSessionRecord {
    const validX = validateCoordinate(worldX, 'worldX');
    const validY = validateCoordinate(worldY, 'worldY');
    const validSpace = spaceId !== undefined ? validateSpaceId(spaceId) : undefined;
    const nowIso = this.clock.now().toISOString();

    const result = this.worldDb.transaction(() => {
      const existing = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ? AND ended_at IS NULL',
      ).get(sessionId) as unknown as UserSessionRow | undefined;
      if (!existing) {
        throw new ServiceError('NOT_FOUND', '활성 세션을 찾을 수 없어요.');
      }

      let nickname: string | null = null;
      let prevStatus: PresenceStatus = 'offline';
      let prevCount = 0;

      if (existing.member_id) {
        const member = this.worldDb.db.prepare(
          'SELECT nickname FROM members WHERE id = ?',
        ).get(existing.member_id) as { nickname: string } | undefined;
        nickname = member?.nickname ?? null;
        const prevSpaces = this.queryMemberActiveSpaces(existing.member_id);
        prevCount = prevSpaces.length;
        prevStatus = computePresenceStatus(prevSpaces);
      }

      const targetSpace = validSpace ?? existing.current_space_id;
      this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET world_x = ?, world_y = ?, current_space_id = ?, last_heartbeat_at = ?
        WHERE id = ? AND ended_at IS NULL
      `).run(validX, validY, targetSpace, nowIso, sessionId);

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ?',
      ).get(sessionId) as unknown as UserSessionRow;

      let nextStatus: PresenceStatus = 'offline';
      let nextCount = 0;
      if (existing.member_id) {
        const nextSpaces = this.queryMemberActiveSpaces(existing.member_id);
        nextCount = nextSpaces.length;
        nextStatus = computePresenceStatus(nextSpaces);
      }

      return {
        session: mapSessionRow(updated),
        nickname,
        prevStatus,
        prevCount,
        nextStatus,
        nextCount,
      };
    });

    if (result.session.memberId && result.nickname !== null && result.prevStatus !== result.nextStatus) {
      this.hub?.publish('presence.changed', {
        memberId: result.session.memberId,
        nickname: result.nickname,
        status: result.nextStatus,
        activeSessionCount: result.nextCount,
        occurredAt: nowIso,
      }, nowIso);
    }

    this.hub?.publish('avatar.moved', {
      sessionId: result.session.id,
      memberId: result.session.memberId,
      nickname: result.nickname,
      isGuest: result.session.isGuest,
      spaceId: result.session.currentSpaceId,
      worldX: result.session.worldX,
      worldY: result.session.worldY,
      status: result.session.isGuest ? 'guest' : result.nextStatus,
      occurredAt: nowIso,
    }, nowIso);

    return result.session;
  }

  heartbeat(sessionId: string): UserSessionRecord {
    const nowIso = this.clock.now().toISOString();
    return this.worldDb.transaction(() => {
      const info = this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET last_heartbeat_at = ?
        WHERE id = ? AND ended_at IS NULL
      `).run(nowIso, sessionId);

      if (info.changes === 0) {
        throw new ServiceError('NOT_FOUND', '활성 세션을 찾을 수 없어요.');
      }

      const row = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ?',
      ).get(sessionId) as unknown as UserSessionRow;
      return mapSessionRow(row);
    });
  }

  closeSession(
    sessionId: string,
    options: CloseSessionOptions = {},
  ): UserSessionRecord | null {
    const mode = options.mode ?? 'normal';
    const reason = options.reason ?? (mode === 'disconnect' ? 'disconnect' : 'normal_close');
    const nowIso = this.clock.now().toISOString();

    const closed = this.worldDb.transaction(() => {
      const existing = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ? AND ended_at IS NULL',
      ).get(sessionId) as unknown as UserSessionRow | undefined;
      if (!existing) return null;

      let nickname: string | null = null;
      let prevStatus: PresenceStatus = 'offline';
      let prevCount = 0;

      if (existing.member_id) {
        const member = this.worldDb.db.prepare(
          'SELECT nickname FROM members WHERE id = ?',
        ).get(existing.member_id) as { nickname: string } | undefined;
        nickname = member?.nickname ?? null;
        const prevSpaces = this.queryMemberActiveSpaces(existing.member_id);
        prevCount = prevSpaces.length;
        prevStatus = computePresenceStatus(prevSpaces);
      }

      // Keep last_heartbeat_at untouched so disconnect handling can use it accurately.
      this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET ended_at = ?, end_reason = ?
        WHERE id = ? AND ended_at IS NULL
      `).run(nowIso, reason, sessionId);

      const updated = this.worldDb.db.prepare(
        'SELECT * FROM user_sessions WHERE id = ?',
      ).get(sessionId) as unknown as UserSessionRow;

      let nextStatus: PresenceStatus = 'offline';
      let nextCount = 0;
      if (existing.member_id) {
        const nextSpaces = this.queryMemberActiveSpaces(existing.member_id);
        nextCount = nextSpaces.length;
        nextStatus = computePresenceStatus(nextSpaces);
      }

      return {
        session: mapSessionRow(updated),
        nickname,
        prevStatus,
        prevCount,
        nextStatus,
        nextCount,
      };
    });

    if (!closed) return null;

    this.notifyClosedSessions(
      [closed.session],
      mode,
      reason,
      nowIso,
      closed.session.memberId && closed.nickname !== null
        ? [{
            memberId: closed.session.memberId,
            nickname: closed.nickname,
            status: closed.nextStatus,
            activeSessionCount: closed.nextCount,
            changed: closed.prevStatus !== closed.nextStatus || closed.prevCount !== closed.nextCount,
          }]
        : [],
    );

    return closed.session;
  }

  closeAllMemberSessions(
    memberId: string,
    options: CloseSessionOptions = {},
  ): UserSessionRecord[] {
    return this.closeMemberSessionsWhere(memberId, null, options);
  }

  closeOtherMemberSessions(
    memberId: string,
    keepSessionId: string,
    options: CloseSessionOptions = {},
  ): UserSessionRecord[] {
    return this.closeMemberSessionsWhere(memberId, keepSessionId, options);
  }

  expireStaleSessions(timeoutMs: number): UserSessionRecord[] {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ServiceError('INVALID_INPUT', '만료 시간(ms)은 0보다 커야 해요.', 'timeoutMs');
    }

    const nowMs = this.clock.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso = new Date(nowMs - timeoutMs).toISOString();
    const reason = 'heartbeat_timeout';
    const mode = 'disconnect' as const;

    const outcome = this.worldDb.transaction(() => {
      const staleRows = this.worldDb.db.prepare(`
        SELECT * FROM user_sessions
        WHERE ended_at IS NULL AND last_heartbeat_at <= ?
        ORDER BY created_at ASC
      `).all(cutoffIso) as unknown as UserSessionRow[];

      if (staleRows.length === 0) {
        return { sessions: [] as UserSessionRecord[], presenceUpdates: [] as MemberPresenceUpdate[] };
      }

      const affectedMemberIds = [...new Set(
        staleRows.map((row) => row.member_id).filter((id): id is string => id !== null),
      )];
      const prevMap = this.snapshotMemberPresence(affectedMemberIds);

      const updateStmt = this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET ended_at = ?, end_reason = ?
        WHERE id = ? AND ended_at IS NULL
      `);
      for (const row of staleRows) {
        updateStmt.run(nowIso, reason, row.id);
      }

      const closedSessions: UserSessionRecord[] = [];
      for (const row of staleRows) {
        const updated = this.worldDb.db.prepare(
          'SELECT * FROM user_sessions WHERE id = ?',
        ).get(row.id) as unknown as UserSessionRow;
        closedSessions.push(mapSessionRow(updated));
      }

      const nextMap = this.snapshotMemberPresence(affectedMemberIds);
      const presenceUpdates = buildPresenceUpdates(affectedMemberIds, prevMap, nextMap);

      return { sessions: closedSessions, presenceUpdates };
    });

    if (outcome.sessions.length > 0) {
      this.notifyClosedSessions(outcome.sessions, mode, reason, nowIso, outcome.presenceUpdates);
    }

    return outcome.sessions;
  }

  getSessionById(sessionId: string): UserSessionRecord | null {
    const row = this.worldDb.db.prepare(
      'SELECT * FROM user_sessions WHERE id = ?',
    ).get(sessionId) as unknown as UserSessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  listMemberActiveSessions(memberId: string): UserSessionRecord[] {
    const rows = this.worldDb.db.prepare(
      'SELECT * FROM user_sessions WHERE member_id = ? AND ended_at IS NULL ORDER BY created_at ASC',
    ).all(memberId) as unknown as UserSessionRow[];
    return rows.map(mapSessionRow);
  }

  getMemberPresence(memberId: string): MemberPresenceSummary {
    const member = this.worldDb.db.prepare(
      "SELECT id, nickname, state FROM members WHERE id = ? AND state = 'active'",
    ).get(memberId) as { id: string; nickname: string; state: string } | undefined;

    if (!member) {
      throw new ServiceError('NOT_FOUND', '활성 회원을 찾을 수 없어요.');
    }

    const spaces = this.queryMemberActiveSpaces(memberId);
    return {
      memberId: member.id,
      nickname: member.nickname,
      status: computePresenceStatus(spaces),
      activeSessionCount: spaces.length,
      spaces,
    };
  }

  getLobbyOverview(): LobbyOverview {
    const rows = this.worldDb.db.prepare(`
      SELECT
        s.*,
        m.nickname AS nickname,
        m.state AS member_state
      FROM user_sessions s
      LEFT JOIN members m ON m.id = s.member_id
      WHERE s.ended_at IS NULL
      ORDER BY s.created_at ASC
    `).all() as unknown as ActiveSessionWithMemberRow[];

    const memberSessions = new Map<string, { nickname: string; spaces: string[] }>();
    let guestCount = 0;

    for (const row of rows) {
      if (row.is_guest === 1 || row.member_id === null) {
        guestCount += 1;
        continue;
      }
      if (row.member_state !== 'active' || row.nickname === null) {
        continue;
      }
      let entry = memberSessions.get(row.member_id);
      if (!entry) {
        entry = { nickname: row.nickname, spaces: [] };
        memberSessions.set(row.member_id, entry);
      }
      entry.spaces.push(row.current_space_id);
    }

    const onlineMembers: MemberPresenceSummary[] = [];
    const awayMembers: MemberPresenceSummary[] = [];
    const statusByMemberId = new Map<string, PresenceStatus>();

    for (const [memberId, entry] of memberSessions) {
      const status = computePresenceStatus(entry.spaces);
      statusByMemberId.set(memberId, status);
      const summary: MemberPresenceSummary = {
        memberId,
        nickname: entry.nickname,
        status,
        activeSessionCount: entry.spaces.length,
        spaces: entry.spaces,
      };
      if (status === 'away') {
        awayMembers.push(summary);
      } else {
        onlineMembers.push(summary);
      }
    }

    onlineMembers.sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));
    awayMembers.sort((a, b) => a.nickname.localeCompare(b.nickname, 'ko'));

    const activeAvatars: ActiveAvatarInfo[] = [];
    for (const row of rows) {
      if (row.is_guest === 1 || row.member_id === null) {
        activeAvatars.push({
          sessionId: row.id,
          memberId: null,
          nickname: null,
          isGuest: true,
          channel: row.channel,
          spaceId: row.current_space_id,
          worldX: row.world_x,
          worldY: row.world_y,
          status: 'guest',
        });
        continue;
      }
      const memberStatus = statusByMemberId.get(row.member_id);
      if (!memberStatus) continue;
      activeAvatars.push({
        sessionId: row.id,
        memberId: row.member_id,
        nickname: row.nickname,
        isGuest: false,
        channel: row.channel,
        spaceId: row.current_space_id,
        worldX: row.world_x,
        worldY: row.world_y,
        status: memberStatus,
      });
    }

    return {
      onlineMembers,
      awayMembers,
      members: [...onlineMembers, ...awayMembers],
      onlineCount: onlineMembers.length,
      awayCount: awayMembers.length,
      guestCount,
      activeAvatars,
    };
  }

  private closeMemberSessionsWhere(
    memberId: string,
    keepSessionId: string | null,
    options: CloseSessionOptions,
  ): UserSessionRecord[] {
    const mode = options.mode ?? 'normal';
    const reason = options.reason ?? (mode === 'disconnect' ? 'disconnect' : 'normal_close');
    const nowIso = this.clock.now().toISOString();

    const outcome = this.worldDb.transaction(() => {
      const targetRows = (
        keepSessionId === null
          ? this.worldDb.db.prepare(
              'SELECT * FROM user_sessions WHERE member_id = ? AND ended_at IS NULL ORDER BY created_at ASC',
            ).all(memberId)
          : this.worldDb.db.prepare(
              'SELECT * FROM user_sessions WHERE member_id = ? AND id != ? AND ended_at IS NULL ORDER BY created_at ASC',
            ).all(memberId, keepSessionId)
      ) as unknown as UserSessionRow[];

      if (targetRows.length === 0) {
        return { sessions: [] as UserSessionRecord[], presenceUpdates: [] as MemberPresenceUpdate[] };
      }

      const prevMap = this.snapshotMemberPresence([memberId]);

      const updateStmt = this.worldDb.db.prepare(`
        UPDATE user_sessions
        SET ended_at = ?, end_reason = ?
        WHERE id = ? AND ended_at IS NULL
      `);
      for (const row of targetRows) {
        updateStmt.run(nowIso, reason, row.id);
      }

      const closedSessions: UserSessionRecord[] = [];
      for (const row of targetRows) {
        const updated = this.worldDb.db.prepare(
          'SELECT * FROM user_sessions WHERE id = ?',
        ).get(row.id) as unknown as UserSessionRow;
        closedSessions.push(mapSessionRow(updated));
      }

      const nextMap = this.snapshotMemberPresence([memberId]);
      const presenceUpdates = buildPresenceUpdates([memberId], prevMap, nextMap);

      return { sessions: closedSessions, presenceUpdates };
    });

    if (outcome.sessions.length > 0) {
      this.notifyClosedSessions(outcome.sessions, mode, reason, nowIso, outcome.presenceUpdates);
    }

    return outcome.sessions;
  }

  private queryMemberActiveSpaces(memberId: string): string[] {
    const rows = this.worldDb.db.prepare(
      'SELECT current_space_id FROM user_sessions WHERE member_id = ? AND ended_at IS NULL ORDER BY created_at ASC',
    ).all(memberId) as Array<{ current_space_id: string }>;
    return rows.map((row) => row.current_space_id);
  }

  private snapshotMemberPresence(
    memberIds: readonly string[],
  ): Map<string, { nickname: string; status: PresenceStatus; activeSessionCount: number }> {
    const map = new Map<string, { nickname: string; status: PresenceStatus; activeSessionCount: number }>();
    for (const memberId of memberIds) {
      const member = this.worldDb.db.prepare(
        'SELECT nickname FROM members WHERE id = ?',
      ).get(memberId) as { nickname: string } | undefined;
      if (!member) continue;
      const spaces = this.queryMemberActiveSpaces(memberId);
      map.set(memberId, {
        nickname: member.nickname,
        status: computePresenceStatus(spaces),
        activeSessionCount: spaces.length,
      });
    }
    return map;
  }

  private notifyClosedSessions(
    sessions: readonly UserSessionRecord[],
    mode: 'normal' | 'disconnect',
    reason: string,
    endedAt: string,
    presenceUpdates: readonly MemberPresenceUpdate[],
  ): void {
    for (const session of sessions) {
      this.hub?.publish('session.ended', {
        sessionId: session.id,
        memberId: session.memberId,
        isGuest: session.isGuest,
        reason,
        mode,
        endedAt,
      }, endedAt);

      this.options.onSessionEnded?.({
        sessionId: session.id,
        memberId: session.memberId,
        isGuest: session.isGuest,
        mode,
        reason,
        endedAt,
        lastHeartbeatAt: session.lastHeartbeatAt,
      });
    }

    for (const update of presenceUpdates) {
      if (!update.changed) continue;
      this.hub?.publish('presence.changed', {
        memberId: update.memberId,
        nickname: update.nickname,
        status: update.status,
        activeSessionCount: update.activeSessionCount,
        occurredAt: endedAt,
      }, endedAt);
    }
  }
}

interface MemberPresenceUpdate {
  memberId: string;
  nickname: string;
  status: PresenceStatus;
  activeSessionCount: number;
  changed: boolean;
}

function buildPresenceUpdates(
  memberIds: readonly string[],
  prevMap: Map<string, { nickname: string; status: PresenceStatus; activeSessionCount: number }>,
  nextMap: Map<string, { nickname: string; status: PresenceStatus; activeSessionCount: number }>,
): MemberPresenceUpdate[] {
  const updates: MemberPresenceUpdate[] = [];
  for (const memberId of memberIds) {
    const prev = prevMap.get(memberId);
    const next = nextMap.get(memberId);
    if (!next) continue;
    updates.push({
      memberId,
      nickname: next.nickname,
      status: next.status,
      activeSessionCount: next.activeSessionCount,
      changed:
        !prev
        || prev.status !== next.status
        || prev.activeSessionCount !== next.activeSessionCount,
    });
  }
  return updates;
}
