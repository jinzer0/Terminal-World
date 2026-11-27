import type { WorldDatabase } from '../store/sqlite/database.js';
import { splitByKstMidnight, toKstDateString, type Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError } from './errors.js';
import type { RealtimeHub } from './realtime-hub.js';

export interface FocusSessionRecord {
  id: string;
  memberId: string;
  startedSessionId: string;
  startedAt: string;
  endedAt: string | null;
  countedSeconds: number | null;
}

export interface FocusDailyTotalRecord {
  kstDate: string;
  totalSeconds: number;
}

export interface FocusStatusSummary {
  memberId: string;
  nickname: string;
  activeSession: FocusSessionRecord | null;
  currentElapsedSeconds: number;
  todayKstDate: string;
  todayCompletedSeconds: number;
  todayTotalSeconds: number;
}

export interface FocusHistoryResult {
  memberId: string;
  sessions: FocusSessionRecord[];
  dailyTotals: FocusDailyTotalRecord[];
}

export interface FocusRankingEntry {
  rank: number;
  nickname: string;
  totalSeconds: number;
}

interface FocusSessionRow {
  id: string;
  member_id: string;
  started_session_id: string;
  started_at: string;
  ended_at: string | null;
  counted_seconds: number | null;
}

function mapFocusRow(row: FocusSessionRow): FocusSessionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    startedSessionId: row.started_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    countedSeconds: row.counted_seconds,
  };
}

function validateKstDate(kstDate: string): string {
  const trimmed = kstDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ServiceError('INVALID_INPUT', '날짜는 YYYY-MM-DD 형식으로 입력해 주세요.', 'kstDate');
  }
  const [y, m, d] = trimmed.split('-').map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d!));
  if (
    utc.getUTCFullYear() !== y
    || utc.getUTCMonth() + 1 !== m
    || utc.getUTCDate() !== d
  ) {
    throw new ServiceError('INVALID_INPUT', '올바른 달력 날짜를 입력해 주세요.', 'kstDate');
  }
  return trimmed;
}

export class FocusService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
    private readonly hub?: RealtimeHub,
  ) {}

  /**
   * Starts a focus interval for an active member on an active persistent session.
   * Enforces at most 1 active focus interval per member with no goal time.
   */
  startFocus(memberId: string, sessionId: string): FocusSessionRecord {
    const nowIso = this.clock.now().toISOString();

    const started = this.worldDb.transaction(() => {
      const member = this.worldDb.db.prepare(
        "SELECT id, nickname, state FROM members WHERE id = ? AND state = 'active'",
      ).get(memberId) as { id: string; nickname: string; state: string } | undefined;
      if (!member) {
        throw new ServiceError('UNAUTHORIZED', '활성 회원만 집중 추적을 시작할 수 있어요.');
      }

      const session = this.worldDb.db.prepare(`
        SELECT id, member_id, is_guest, ended_at
        FROM user_sessions
        WHERE id = ? AND ended_at IS NULL
      `).get(sessionId) as { id: string; member_id: string | null; is_guest: number; ended_at: string | null } | undefined;

      if (!session || session.is_guest === 1 || session.member_id !== memberId) {
        throw new ServiceError('FORBIDDEN', '본인의 활성 지속 세션에서만 집중 추적을 시작할 수 있어요.');
      }

      const active = this.worldDb.db.prepare(
        'SELECT id FROM focus_sessions WHERE member_id = ? AND ended_at IS NULL',
      ).get(memberId) as { id: string } | undefined;
      if (active) {
        throw new ServiceError('CONFLICT', '이미 집중 추적이 진행 중이에요.');
      }

      const focusId = generateId();
      try {
        this.worldDb.db.prepare(`
          INSERT INTO focus_sessions (id, member_id, started_session_id, started_at, ended_at, counted_seconds)
          VALUES (?, ?, ?, ?, NULL, NULL)
        `).run(focusId, memberId, sessionId, nowIso);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('idx_focus_active_per_member') || message.includes('UNIQUE constraint')) {
          throw new ServiceError('CONFLICT', '이미 집중 추적이 진행 중이에요.');
        }
        throw error;
      }

      const row = this.worldDb.db.prepare(
        'SELECT * FROM focus_sessions WHERE id = ?',
      ).get(focusId) as unknown as FocusSessionRow;

      return {
        record: mapFocusRow(row),
        nickname: member.nickname,
      };
    });

    this.hub?.publish('focus.changed', {
      memberId: started.record.memberId,
      nickname: started.nickname,
      state: 'started',
      focusSessionId: started.record.id,
      startedAt: started.record.startedAt,
      endedAt: null,
      countedSeconds: null,
      occurredAt: nowIso,
    }, nowIso);

    return started.record;
  }

  /**
   * Stops the member's currently active focus interval using `clock.now()`
   * and splits elapsed integer seconds across Asia/Seoul midnight boundaries.
   */
  stopFocus(memberId: string): FocusSessionRecord {
    const nowIso = this.clock.now().toISOString();

    const stopped = this.worldDb.transaction(() => {
      const active = this.worldDb.db.prepare(
        'SELECT * FROM focus_sessions WHERE member_id = ? AND ended_at IS NULL',
      ).get(memberId) as unknown as FocusSessionRow | undefined;

      if (!active) {
        throw new ServiceError('NOT_FOUND', '진행 중인 집중 추적이 없어요.');
      }

      const member = this.worldDb.db.prepare(
        'SELECT nickname FROM members WHERE id = ?',
      ).get(memberId) as { nickname: string } | undefined;

      const record = this.finalizeFocusRow(active, nowIso);
      return { record, nickname: member?.nickname ?? '알 수 없음' };
    });

    this.hub?.publish('focus.changed', {
      memberId: stopped.record.memberId,
      nickname: stopped.nickname,
      state: 'stopped',
      focusSessionId: stopped.record.id,
      startedAt: stopped.record.startedAt,
      endedAt: stopped.record.endedAt,
      countedSeconds: stopped.record.countedSeconds,
      occurredAt: nowIso,
    }, nowIso);

    return stopped.record;
  }

  /**
   * Closes an active focus interval ONLY if `started_session_id === sessionId`.
   * Ending a different session of the same member never stops focus.
   * Disconnect mode ends the focus interval at `last_heartbeat_at`.
   */
  handleSessionEnded(
    sessionId: string,
    mode: 'normal' | 'disconnect',
  ): FocusSessionRecord | null {
    const nowIso = this.clock.now().toISOString();

    const stopped = this.worldDb.transaction(() => {
      const active = this.worldDb.db.prepare(
        'SELECT * FROM focus_sessions WHERE started_session_id = ? AND ended_at IS NULL',
      ).get(sessionId) as unknown as FocusSessionRow | undefined;

      if (!active) return null;

      let endIso = nowIso;
      if (mode === 'disconnect') {
        const session = this.worldDb.db.prepare(
          'SELECT last_heartbeat_at FROM user_sessions WHERE id = ?',
        ).get(sessionId) as { last_heartbeat_at: string } | undefined;
        if (session?.last_heartbeat_at) {
          endIso = session.last_heartbeat_at;
        }
      }

      const member = this.worldDb.db.prepare(
        'SELECT nickname FROM members WHERE id = ?',
      ).get(active.member_id) as { nickname: string } | undefined;

      const record = this.finalizeFocusRow(active, endIso);
      return { record, nickname: member?.nickname ?? '알 수 없음' };
    });

    if (!stopped) return null;

    this.hub?.publish('focus.changed', {
      memberId: stopped.record.memberId,
      nickname: stopped.nickname,
      state: 'stopped',
      focusSessionId: stopped.record.id,
      startedAt: stopped.record.startedAt,
      endedAt: stopped.record.endedAt,
      countedSeconds: stopped.record.countedSeconds,
      occurredAt: nowIso,
    }, nowIso);

    return stopped.record;
  }

  /**
   * Gracefully closes all active focus intervals on server shutdown using `clock.now()`.
   */
  closeAllActiveFocusForShutdown(): FocusSessionRecord[] {
    const nowIso = this.clock.now().toISOString();

    const closed = this.worldDb.transaction(() => {
      const activeRows = this.worldDb.db.prepare(
        'SELECT * FROM focus_sessions WHERE ended_at IS NULL ORDER BY started_at ASC',
      ).all() as unknown as FocusSessionRow[];

      const results: Array<{ record: FocusSessionRecord; nickname: string }> = [];
      for (const row of activeRows) {
        const member = this.worldDb.db.prepare(
          'SELECT nickname FROM members WHERE id = ?',
        ).get(row.member_id) as { nickname: string } | undefined;
        const record = this.finalizeFocusRow(row, nowIso);
        results.push({ record, nickname: member?.nickname ?? '알 수 없음' });
      }
      return results;
    });

    for (const item of closed) {
      this.hub?.publish('focus.changed', {
        memberId: item.record.memberId,
        nickname: item.nickname,
        state: 'stopped',
        focusSessionId: item.record.id,
        startedAt: item.record.startedAt,
        endedAt: item.record.endedAt,
        countedSeconds: item.record.countedSeconds,
        occurredAt: nowIso,
      }, nowIso);
    }

    return closed.map((item) => item.record);
  }

  getFocusStatus(memberId: string): FocusStatusSummary {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const todayKstDate = toKstDateString(now);

    const member = this.worldDb.db.prepare(
      "SELECT id, nickname, state FROM members WHERE id = ? AND state = 'active'",
    ).get(memberId) as { id: string; nickname: string; state: string } | undefined;

    if (!member) {
      throw new ServiceError('NOT_FOUND', '활성 회원을 찾을 수 없어요.');
    }

    const activeRow = this.worldDb.db.prepare(
      'SELECT * FROM focus_sessions WHERE member_id = ? AND ended_at IS NULL',
    ).get(memberId) as unknown as FocusSessionRow | undefined;

    const totalRow = this.worldDb.db.prepare(
      'SELECT total_seconds FROM focus_daily_totals WHERE member_id = ? AND kst_date = ?',
    ).get(memberId, todayKstDate) as { total_seconds: number } | undefined;

    const todayCompletedSeconds = totalRow?.total_seconds ?? 0;
    const activeSession = activeRow ? mapFocusRow(activeRow) : null;

    let currentElapsedSeconds = 0;
    let currentTodayActiveSeconds = 0;
    if (activeSession) {
      const startMs = new Date(activeSession.startedAt).getTime();
      currentElapsedSeconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
      const liveSlices = splitByKstMidnight(activeSession.startedAt, now);
      currentTodayActiveSeconds = liveSlices
        .filter((slice) => slice.kstDate === todayKstDate)
        .reduce((sum, slice) => sum + slice.seconds, 0);
    }

    return {
      memberId: member.id,
      nickname: member.nickname,
      activeSession,
      currentElapsedSeconds,
      todayKstDate,
      todayCompletedSeconds,
      todayTotalSeconds: todayCompletedSeconds + currentTodayActiveSeconds,
    };
  }

  /**
   * Returns detailed focus interval history only when `actorMemberId === targetMemberId`.
   * Viewing another member's (or any member's as guest) detailed focus history throws FORBIDDEN.
   */
  getFocusHistory(
    actorMemberId: string | null,
    targetMemberId: string,
    options: { limit?: number } = {},
  ): FocusHistoryResult {
    if (!actorMemberId || actorMemberId !== targetMemberId) {
      throw new ServiceError('FORBIDDEN', '다른 회원의 상세 집중 기록은 조회할 수 없어요.');
    }

    const member = this.worldDb.db.prepare(
      "SELECT id FROM members WHERE id = ? AND state = 'active'",
    ).get(targetMemberId) as { id: string } | undefined;
    if (!member) {
      throw new ServiceError('NOT_FOUND', '활성 회원을 찾을 수 없어요.');
    }

    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const sessionRows = this.worldDb.db.prepare(`
      SELECT * FROM focus_sessions
      WHERE member_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(targetMemberId, limit) as unknown as FocusSessionRow[];

    const dailyRows = this.worldDb.db.prepare(`
      SELECT kst_date, total_seconds
      FROM focus_daily_totals
      WHERE member_id = ?
      ORDER BY kst_date DESC
    `).all(targetMemberId) as Array<{ kst_date: string; total_seconds: number }>;

    return {
      memberId: targetMemberId,
      sessions: sessionRows.map(mapFocusRow),
      dailyTotals: dailyRows.map((row) => ({
        kstDate: row.kst_date,
        totalSeconds: row.total_seconds,
      })),
    };
  }

  /**
   * Returns public daily focus ranking for a KST date using SQL standard competition ranking
   * (`RANK() OVER (ORDER BY total_seconds DESC)` -> 1, 1, 3).
   * Exposes only `rank`, `nickname`, and `totalSeconds`.
   */
  getDailyRanking(kstDate?: string): FocusRankingEntry[] {
    const targetDate = kstDate !== undefined
      ? validateKstDate(kstDate)
      : toKstDateString(this.clock.now());

    const rows = this.worldDb.db.prepare(`
      SELECT
        RANK() OVER (ORDER BY f.total_seconds DESC) AS rank,
        m.nickname AS nickname,
        f.total_seconds AS total_seconds
      FROM focus_daily_totals f
      JOIN members m ON m.id = f.member_id
      WHERE f.kst_date = ?
        AND m.state = 'active'
        AND f.total_seconds > 0
      ORDER BY rank ASC, m.nickname ASC
    `).all(targetDate) as Array<{
      rank: number | bigint;
      nickname: string;
      total_seconds: number;
    }>;

    return rows.map((row) => ({
      rank: Number(row.rank),
      nickname: row.nickname,
      totalSeconds: row.total_seconds,
    }));
  }

  private finalizeFocusRow(row: FocusSessionRow, endIso: string): FocusSessionRecord {
    const startMs = new Date(row.started_at).getTime();
    const rawEndMs = new Date(endIso).getTime();
    const clampedEndMs = Math.max(startMs, rawEndMs);
    const effectiveEndIso = new Date(clampedEndMs).toISOString();
    const countedSeconds = Math.floor((clampedEndMs - startMs) / 1000);

    const updateInfo = this.worldDb.db.prepare(`
      UPDATE focus_sessions
      SET ended_at = ?, counted_seconds = ?
      WHERE id = ? AND ended_at IS NULL
    `).run(effectiveEndIso, countedSeconds, row.id);

    if (updateInfo.changes !== 1) {
      throw new ServiceError('CONFLICT', '집중 구간이 이미 종료되었어요.');
    }

    const slices = splitByKstMidnight(row.started_at, effectiveEndIso);
    const upsertDaily = this.worldDb.db.prepare(`
      INSERT INTO focus_daily_totals (member_id, kst_date, total_seconds)
      VALUES (?, ?, ?)
      ON CONFLICT(member_id, kst_date) DO UPDATE SET
        total_seconds = focus_daily_totals.total_seconds + excluded.total_seconds
    `);

    for (const slice of slices) {
      upsertDaily.run(row.member_id, slice.kstDate, slice.seconds);
    }

    const updated = this.worldDb.db.prepare(
      'SELECT * FROM focus_sessions WHERE id = ?',
    ).get(row.id) as unknown as FocusSessionRow;
    return mapFocusRow(updated);
  }
}
