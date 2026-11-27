import { parseTechnologyStack, parseText } from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  executeIdempotent,
  normalizeIdempotencyKey,
  normalizePageLimit,
  requireActiveMember,
  resolveAuthorNickname,
  type PaginatedResult,
} from './board-service.js';
import { parseKstDeadline, type Clock } from './clock.js';
import { generateId } from './crypto.js';
import { ServiceError, toServiceError } from './errors.js';

export type RecruitmentType = 'project' | 'contest' | 'hackathon';
export type RecruitmentState = 'open' | 'closed';
export type ParticipationMode = 'online' | 'offline' | 'hybrid';

export interface RecruitmentPostRecord {
  id: string;
  boardId: 'recruitment';
  authorMemberId: string | null;
  authorNickname: string;
  title: string;
  body: string;
  recruitmentType: RecruitmentType;
  recruitmentState: RecruitmentState;
  storedState: RecruitmentState;
  progressNote: string;
  roles: string[];
  requiredSkills: string[];
  noSkillRequired: boolean;
  participationPeriod: string;
  weeklyTime: string;
  participationMode: ParticipationMode;
  region: string;
  contactMethod: string;
  deadlineAt: string;
  commentCount: number;
  isBookmarked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BookmarkedRecruitmentRecord extends RecruitmentPostRecord {
  savedAt: string;
}

export interface CreateRecruitmentInput {
  title: string;
  body: string;
  recruitmentType: RecruitmentType;
  progressNote: string;
  roles: string[];
  requiredSkills?: string[];
  noSkillRequired?: boolean;
  participationPeriod: string;
  weeklyTime: string;
  participationMode: ParticipationMode;
  region?: string;
  contactMethod: string;
  deadlineAt: string;
  ackPublic: boolean;
  idempotencyKey?: string;
}

export interface UpdateRecruitmentInput {
  title?: string;
  body?: string;
  recruitmentType?: RecruitmentType;
  progressNote?: string;
  roles?: string[];
  requiredSkills?: string[];
  noSkillRequired?: boolean;
  participationPeriod?: string;
  weeklyTime?: string;
  participationMode?: ParticipationMode;
  region?: string;
  contactMethod?: string;
  deadlineAt?: string;
}

export interface SearchRecruitmentsFilter {
  type?: RecruitmentType;
  role?: string;
  skill?: string;
  mode?: ParticipationMode;
  state?: RecruitmentState;
  cursor?: string | null;
  limit?: number;
}

interface RecruitmentRow {
  id: string;
  author_member_id: string | null;
  author_nickname: string | null;
  author_state: string | null;
  title: string;
  body: string;
  recruitment_type: RecruitmentType;
  recruitment_state: RecruitmentState;
  progress_note: string;
  roles_json: string;
  required_skills_json: string;
  no_skill_required: number;
  participation_period: string;
  weekly_time: string;
  participation_mode: ParticipationMode;
  region: string;
  contact_method: string;
  deadline_at: string;
  comment_count: number;
  is_bookmarked: number;
  created_at: string;
  updated_at: string;
  saved_at?: string;
}

const VALID_TYPES = new Set<RecruitmentType>(['project', 'contest', 'hackathon']);
const VALID_MODES = new Set<ParticipationMode>(['online', 'offline', 'hybrid']);
const VALID_STATES = new Set<RecruitmentState>(['open', 'closed']);
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function parseSingleLineField(field: string, value: unknown, max: number, required: boolean): string {
  if (typeof value !== 'string') {
    throw new ServiceError('INVALID_INPUT', '문자열을 입력해 주세요.', field);
  }
  if (/[\ud800-\udfff]/u.test(value)) {
    throw new ServiceError('INVALID_INPUT', '올바른 유니코드 문자를 입력해 주세요.', field);
  }
  const normalized = value.normalize('NFC');
  if (CONTROL_CHARS.test(normalized) || normalized.includes('\n')) {
    throw new ServiceError('INVALID_INPUT', '탭·줄바꿈·터미널 제어문자는 입력할 수 없어요.', field);
  }
  if (Array.from(normalized).length > max) {
    throw new ServiceError('INVALID_INPUT', `${max}자까지 입력할 수 있어요.`, field);
  }
  if (required && !normalized.trim()) {
    throw new ServiceError('INVALID_INPUT', '내용을 입력해 주세요.', field);
  }
  return normalized.trim();
}

function parseRoles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) {
    throw new ServiceError('INVALID_INPUT', '모집 역할은 1~10개 사이로 입력해 주세요.', 'roles');
  }
  return Array.from(value, item => parseSingleLineField('roles', item, 40, true));
}

function parseRecruitmentType(value: unknown): RecruitmentType {
  if (typeof value !== 'string' || !VALID_TYPES.has(value as RecruitmentType)) {
    throw new ServiceError(
      'INVALID_INPUT',
      '모집 유형은 project, contest, hackathon 중 하나여야 해요.',
      'recruitmentType',
    );
  }
  return value as RecruitmentType;
}

function parseParticipationMode(value: unknown): ParticipationMode {
  if (typeof value !== 'string' || !VALID_MODES.has(value as ParticipationMode)) {
    throw new ServiceError(
      'INVALID_INPUT',
      '참여 방식은 online, offline, hybrid 중 하나여야 해요.',
      'participationMode',
    );
  }
  return value as ParticipationMode;
}

function parseSkillsAndFlag(
  requiredSkills: unknown,
  noSkillRequired: boolean,
): { skills: string[]; noSkillRequired: boolean } {
  if (noSkillRequired) {
    if (requiredSkills === undefined) {
      return { skills: [], noSkillRequired: true };
    }
    try {
      const parsed = parseTechnologyStack(requiredSkills);
      return { skills: parsed, noSkillRequired: true };
    } catch (error) {
      throw toServiceError(error);
    }
  }

  let parsed: string[];
  try {
    parsed = parseTechnologyStack(requiredSkills);
  } catch (error) {
    throw toServiceError(error);
  }
  if (parsed.length === 0) {
    throw new ServiceError(
      'INVALID_INPUT',
      '필요 기술을 1개 이상 입력하거나 기술 무관(noSkillRequired)을 선택해 주세요.',
      'requiredSkills',
    );
  }
  return { skills: parsed, noSkillRequired: false };
}

export function effectiveRecruitmentState(
  storedState: RecruitmentState,
  deadlineAt: string,
  nowIso: string,
): RecruitmentState {
  if (storedState === 'closed' || deadlineAt <= nowIso) {
    return 'closed';
  }
  return 'open';
}

function mapRecruitmentRow(row: RecruitmentRow, nowIso: string): RecruitmentPostRecord {
  const effectiveState = effectiveRecruitmentState(row.recruitment_state, row.deadline_at, nowIso);
  return {
    id: row.id,
    boardId: 'recruitment',
    authorMemberId: row.author_member_id,
    authorNickname: resolveAuthorNickname(row.author_member_id, row.author_nickname, row.author_state),
    title: row.title,
    body: row.body,
    recruitmentType: row.recruitment_type,
    recruitmentState: effectiveState,
    storedState: row.recruitment_state,
    progressNote: row.progress_note,
    roles: JSON.parse(row.roles_json) as string[],
    requiredSkills: JSON.parse(row.required_skills_json) as string[],
    noSkillRequired: row.no_skill_required === 1,
    participationPeriod: row.participation_period,
    weeklyTime: row.weekly_time,
    participationMode: row.participation_mode,
    region: row.region,
    contactMethod: row.contact_method,
    deadlineAt: row.deadline_at,
    commentCount: row.comment_count,
    isBookmarked: row.is_bookmarked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RecruitmentService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  createRecruitment(
    actorMemberId: string | null | undefined,
    input: CreateRecruitmentInput,
  ): RecruitmentPostRecord {
    if (input.ackPublic !== true) {
      throw new ServiceError(
        'INVALID_INPUT',
        '연락 수단을 포함한 모집글 전체 내용이 공개됨을 확인해 주세요.',
        'ackPublic',
      );
    }

    let title: string;
    let body: string;
    try {
      title = parseText('title', input.title);
      body = parseText('body', input.body);
    } catch (error) {
      throw toServiceError(error);
    }

    const recruitmentType = parseRecruitmentType(input.recruitmentType);
    const progressNote = parseSingleLineField('progressNote', input.progressNote, 500, true);
    const roles = parseRoles(input.roles);
    const noSkillRequired = Boolean(input.noSkillRequired);
    const { skills } = parseSkillsAndFlag(input.requiredSkills, noSkillRequired);
    const participationPeriod = parseSingleLineField('participationPeriod', input.participationPeriod, 100, true);
    const weeklyTime = parseSingleLineField('weeklyTime', input.weeklyTime, 100, true);
    const participationMode = parseParticipationMode(input.participationMode);
    const region = parseSingleLineField(
      'region',
      input.region ?? '',
      100,
      participationMode === 'offline' || participationMode === 'hybrid',
    );
    const contactMethod = parseSingleLineField('contactMethod', input.contactMethod, 300, true);
    const deadlineAt = parseKstDeadline(input.deadlineAt, 'deadlineAt');
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);

      return executeIdempotent(
        this.worldDb,
        nowIso,
        actor.id,
        'recruitment.create',
        idempotencyKey,
        {
          title,
          body,
          recruitmentType,
          progressNote,
          roles,
          skills,
          noSkillRequired,
          participationPeriod,
          weeklyTime,
          participationMode,
          region,
          contactMethod,
          deadlineAt,
        },
        () => {
          const postId = generateId();
          this.worldDb.db.prepare(`
            INSERT INTO posts (id, board_id, author_member_id, title, body, created_at, updated_at, deleted_at)
            VALUES (?, 'recruitment', ?, ?, ?, ?, ?, NULL)
          `).run(postId, actor.id, title, body, nowIso, nowIso);

          this.worldDb.db.prepare(`
            INSERT INTO recruitment_details (
              post_id, recruitment_type, recruitment_state, progress_note,
              roles_json, required_skills_json, no_skill_required,
              participation_period, weekly_time, participation_mode,
              region, contact_method, deadline_at
            ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            postId,
            recruitmentType,
            progressNote,
            JSON.stringify(roles),
            JSON.stringify(skills),
            noSkillRequired ? 1 : 0,
            participationPeriod,
            weeklyTime,
            participationMode,
            region,
            contactMethod,
            deadlineAt,
          );

          return this.getRecruitment(postId, actor.id);
        },
      );
    });
  }

  getRecruitment(postId: string, viewerMemberId?: string | null): RecruitmentPostRecord {
    const nowIso = this.clock.now().toISOString();
    const row = this.worldDb.db.prepare(`
      SELECT
        p.id,
        p.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        p.title,
        p.body,
        rd.recruitment_type,
        rd.recruitment_state,
        rd.progress_note,
        rd.roles_json,
        rd.required_skills_json,
        rd.no_skill_required,
        rd.participation_period,
        rd.weekly_time,
        rd.participation_mode,
        rd.region,
        rd.contact_method,
        rd.deadline_at,
        (
          SELECT COUNT(*)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS comment_count,
        EXISTS(
          SELECT 1
          FROM recruitment_bookmarks rb
          WHERE rb.post_id = p.id AND rb.member_id = ?
        ) AS is_bookmarked,
        p.created_at,
        p.updated_at
      FROM posts p
      JOIN recruitment_details rd ON rd.post_id = p.id
      LEFT JOIN members m ON m.id = p.author_member_id
      WHERE p.id = ? AND p.board_id = 'recruitment' AND p.deleted_at IS NULL
    `).get(viewerMemberId ?? '', postId) as unknown as RecruitmentRow | undefined;

    if (!row) {
      throw new ServiceError('NOT_FOUND', '모집글을 찾을 수 없어요.', 'postId');
    }

    return mapRecruitmentRow(row, nowIso);
  }

  updateRecruitment(
    actorMemberId: string | null | undefined,
    postId: string,
    input: UpdateRecruitmentInput,
  ): RecruitmentPostRecord {
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const current = this.worldDb.db.prepare(`
        SELECT
          p.id, p.author_member_id, p.title, p.body,
          rd.recruitment_type, rd.recruitment_state, rd.progress_note,
          rd.roles_json, rd.required_skills_json, rd.no_skill_required,
          rd.participation_period, rd.weekly_time, rd.participation_mode,
          rd.region, rd.contact_method, rd.deadline_at
        FROM posts p
        JOIN recruitment_details rd ON rd.post_id = p.id
        WHERE p.id = ? AND p.board_id = 'recruitment' AND p.deleted_at IS NULL
      `).get(postId) as unknown as {
        id: string;
        author_member_id: string | null;
        title: string;
        body: string;
        recruitment_type: RecruitmentType;
        recruitment_state: RecruitmentState;
        progress_note: string;
        roles_json: string;
        required_skills_json: string;
        no_skill_required: number;
        participation_period: string;
        weekly_time: string;
        participation_mode: ParticipationMode;
        region: string;
        contact_method: string;
        deadline_at: string;
      } | undefined;

      if (!current) {
        throw new ServiceError('NOT_FOUND', '모집글을 찾을 수 없어요.', 'postId');
      }
      if (current.author_member_id !== actor.id) {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 모집글만 수정할 수 있어요.');
      }

      let nextTitle = current.title;
      let nextBody = current.body;
      try {
        if (input.title !== undefined) nextTitle = parseText('title', input.title);
        if (input.body !== undefined) nextBody = parseText('body', input.body);
      } catch (error) {
        throw toServiceError(error);
      }

      const nextType = input.recruitmentType !== undefined
        ? parseRecruitmentType(input.recruitmentType)
        : current.recruitment_type;
      const nextProgressNote = input.progressNote !== undefined
        ? parseSingleLineField('progressNote', input.progressNote, 500, true)
        : current.progress_note;
      const nextRoles = input.roles !== undefined
        ? parseRoles(input.roles)
        : (JSON.parse(current.roles_json) as string[]);

      const nextNoSkill = input.noSkillRequired !== undefined
        ? Boolean(input.noSkillRequired)
        : current.no_skill_required === 1;
      const rawSkills = input.requiredSkills !== undefined
        ? input.requiredSkills
        : (JSON.parse(current.required_skills_json) as string[]);
      const { skills: nextSkills } = parseSkillsAndFlag(rawSkills, nextNoSkill);

      const nextPeriod = input.participationPeriod !== undefined
        ? parseSingleLineField('participationPeriod', input.participationPeriod, 100, true)
        : current.participation_period;
      const nextWeeklyTime = input.weeklyTime !== undefined
        ? parseSingleLineField('weeklyTime', input.weeklyTime, 100, true)
        : current.weekly_time;
      const nextMode = input.participationMode !== undefined
        ? parseParticipationMode(input.participationMode)
        : current.participation_mode;
      const rawRegion = input.region !== undefined ? input.region : current.region;
      const nextRegion = parseSingleLineField(
        'region',
        rawRegion,
        100,
        nextMode === 'offline' || nextMode === 'hybrid',
      );
      const nextContact = input.contactMethod !== undefined
        ? parseSingleLineField('contactMethod', input.contactMethod, 300, true)
        : current.contact_method;
      const nextDeadline = input.deadlineAt !== undefined
        ? parseKstDeadline(input.deadlineAt, 'deadlineAt')
        : current.deadline_at;

      this.worldDb.db.prepare(`
        UPDATE posts
        SET title = ?, body = ?, updated_at = ?
        WHERE id = ?
      `).run(nextTitle, nextBody, nowIso, postId);

      this.worldDb.db.prepare(`
        UPDATE recruitment_details
        SET
          recruitment_type = ?,
          progress_note = ?,
          roles_json = ?,
          required_skills_json = ?,
          no_skill_required = ?,
          participation_period = ?,
          weekly_time = ?,
          participation_mode = ?,
          region = ?,
          contact_method = ?,
          deadline_at = ?
        WHERE post_id = ?
      `).run(
        nextType,
        nextProgressNote,
        JSON.stringify(nextRoles),
        JSON.stringify(nextSkills),
        nextNoSkill ? 1 : 0,
        nextPeriod,
        nextWeeklyTime,
        nextMode,
        nextRegion,
        nextContact,
        nextDeadline,
        postId,
      );

      return this.getRecruitment(postId, actor.id);
    });
  }

  closeRecruitment(
    actorMemberId: string | null | undefined,
    postId: string,
    options?: { idempotencyKey?: string },
  ): RecruitmentPostRecord {
    const idempotencyKey = normalizeIdempotencyKey(options?.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const existing = this.worldDb.db.prepare(`
        SELECT p.id, p.author_member_id
        FROM posts p
        JOIN recruitment_details rd ON rd.post_id = p.id
        WHERE p.id = ? AND p.board_id = 'recruitment' AND p.deleted_at IS NULL
      `).get(postId) as unknown as { id: string; author_member_id: string | null } | undefined;

      if (!existing) {
        throw new ServiceError('NOT_FOUND', '모집글을 찾을 수 없어요.', 'postId');
      }
      if (existing.author_member_id !== actor.id) {
        throw new ServiceError('FORBIDDEN', '본인이 작성한 모집글만 마감할 수 있어요.');
      }

      return executeIdempotent(
        this.worldDb,
        nowIso,
        actor.id,
        'recruitment.close',
        idempotencyKey,
        { postId },
        () => {
          this.worldDb.db.prepare(`
            UPDATE recruitment_details
            SET recruitment_state = 'closed'
            WHERE post_id = ?
          `).run(postId);

          this.worldDb.db.prepare(`
            UPDATE posts
            SET updated_at = ?
            WHERE id = ?
          `).run(nowIso, postId);

          return this.getRecruitment(postId, actor.id);
        },
      );
    });
  }

  searchRecruitments(
    filter: SearchRecruitmentsFilter = {},
    viewerMemberId?: string | null,
  ): PaginatedResult<RecruitmentPostRecord> {
    if (filter.type !== undefined) parseRecruitmentType(filter.type);
    if (filter.mode !== undefined) parseParticipationMode(filter.mode);
    if (filter.state !== undefined && !VALID_STATES.has(filter.state)) {
      throw new ServiceError('INVALID_INPUT', '모집 상태는 open 또는 closed여야 해요.', 'state');
    }

    const limit = normalizePageLimit(filter.limit);
    const decoded = decodeTimeIdCursor(filter.cursor);
    const nowIso = this.clock.now().toISOString();

    const conditions: string[] = [
      "p.board_id = 'recruitment'",
      'p.deleted_at IS NULL',
    ];
    const params: Array<string | number> = [viewerMemberId ?? ''];

    if (filter.type) {
      conditions.push('rd.recruitment_type = ?');
      params.push(filter.type);
    }
    if (filter.mode) {
      conditions.push('rd.participation_mode = ?');
      params.push(filter.mode);
    }
    if (filter.state === 'open') {
      conditions.push("rd.recruitment_state = 'open' AND rd.deadline_at > ?");
      params.push(nowIso);
    } else if (filter.state === 'closed') {
      conditions.push("(rd.recruitment_state = 'closed' OR rd.deadline_at <= ?)");
      params.push(nowIso);
    }

    if (decoded) {
      conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }

    const rows = this.worldDb.db.prepare(`
      SELECT
        p.id,
        p.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        p.title,
        p.body,
        rd.recruitment_type,
        rd.recruitment_state,
        rd.progress_note,
        rd.roles_json,
        rd.required_skills_json,
        rd.no_skill_required,
        rd.participation_period,
        rd.weekly_time,
        rd.participation_mode,
        rd.region,
        rd.contact_method,
        rd.deadline_at,
        (
          SELECT COUNT(*)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS comment_count,
        EXISTS(
          SELECT 1
          FROM recruitment_bookmarks rb
          WHERE rb.post_id = p.id AND rb.member_id = ?
        ) AS is_bookmarked,
        p.created_at,
        p.updated_at
      FROM posts p
      JOIN recruitment_details rd ON rd.post_id = p.id
      LEFT JOIN members m ON m.id = p.author_member_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC, p.id DESC
    `).all(...params) as unknown as RecruitmentRow[];

    const roleFilter = filter.role?.trim().toLowerCase();
    const skillFilter = filter.skill?.trim().toLowerCase();

    const matched: RecruitmentPostRecord[] = [];
    for (const row of rows) {
      const record = mapRecruitmentRow(row, nowIso);
      if (roleFilter && !record.roles.some(r => r.toLowerCase().includes(roleFilter))) {
        continue;
      }
      if (skillFilter && !record.requiredSkills.some(s => s.toLowerCase().includes(skillFilter))) {
        continue;
      }
      matched.push(record);
      if (matched.length > limit) {
        break;
      }
    }

    const hasMore = matched.length > limit;
    const items = hasMore ? matched.slice(0, limit) : matched;
    const last = items[items.length - 1];

    return {
      items,
      cursor: hasMore && last ? encodeTimeIdCursor(last.createdAt, last.id) : null,
      hasMore,
    };
  }

  setBookmark(
    actorMemberId: string | null | undefined,
    postId: string,
    saved: boolean,
    options?: { idempotencyKey?: string },
  ): { postId: string; saved: boolean } {
    const idempotencyKey = normalizeIdempotencyKey(options?.idempotencyKey);
    const nowIso = this.clock.now().toISOString();

    return this.worldDb.transaction(() => {
      const actor = requireActiveMember(this.worldDb, actorMemberId);
      const exists = this.worldDb.db.prepare(`
        SELECT p.id
        FROM posts p
        JOIN recruitment_details rd ON rd.post_id = p.id
        WHERE p.id = ? AND p.board_id = 'recruitment' AND p.deleted_at IS NULL
      `).get(postId) as unknown as { id: string } | undefined;

      if (!exists) {
        throw new ServiceError('NOT_FOUND', '모집글을 찾을 수 없어요.', 'postId');
      }

      return executeIdempotent(
        this.worldDb,
        nowIso,
        actor.id,
        'recruitment.setBookmark',
        idempotencyKey,
        { postId, saved },
        () => {
          if (saved) {
            this.worldDb.db.prepare(`
              INSERT INTO recruitment_bookmarks (member_id, post_id, saved_at)
              VALUES (?, ?, ?)
              ON CONFLICT(member_id, post_id) DO NOTHING
            `).run(actor.id, postId, nowIso);
          } else {
            this.worldDb.db.prepare(
              'DELETE FROM recruitment_bookmarks WHERE member_id = ? AND post_id = ?',
            ).run(actor.id, postId);
          }
          return { postId, saved };
        },
      );
    });
  }

  addBookmark(
    actorMemberId: string | null | undefined,
    postId: string,
    options?: { idempotencyKey?: string },
  ): { postId: string; saved: boolean } {
    return this.setBookmark(actorMemberId, postId, true, options);
  }

  removeBookmark(
    actorMemberId: string | null | undefined,
    postId: string,
    options?: { idempotencyKey?: string },
  ): { postId: string; saved: boolean } {
    return this.setBookmark(actorMemberId, postId, false, options);
  }

  listMyBookmarks(
    actorMemberId: string | null | undefined,
    targetMemberId?: string,
  ): BookmarkedRecruitmentRecord[] {
    const actor = requireActiveMember(this.worldDb, actorMemberId);
    if (targetMemberId !== undefined && targetMemberId !== actor.id) {
      throw new ServiceError('FORBIDDEN', '다른 사용자의 저장 목록은 조회할 수 없어요.');
    }

    const nowIso = this.clock.now().toISOString();
    const rows = this.worldDb.db.prepare(`
      SELECT
        p.id,
        p.author_member_id,
        m.nickname AS author_nickname,
        m.state AS author_state,
        p.title,
        p.body,
        rd.recruitment_type,
        rd.recruitment_state,
        rd.progress_note,
        rd.roles_json,
        rd.required_skills_json,
        rd.no_skill_required,
        rd.participation_period,
        rd.weekly_time,
        rd.participation_mode,
        rd.region,
        rd.contact_method,
        rd.deadline_at,
        (
          SELECT COUNT(*)
          FROM comments c
          WHERE c.post_id = p.id AND c.deleted_at IS NULL
        ) AS comment_count,
        1 AS is_bookmarked,
        p.created_at,
        p.updated_at,
        rb.saved_at
      FROM recruitment_bookmarks rb
      JOIN posts p ON p.id = rb.post_id
      JOIN recruitment_details rd ON rd.post_id = p.id
      LEFT JOIN members m ON m.id = p.author_member_id
      WHERE rb.member_id = ? AND p.deleted_at IS NULL
      ORDER BY rb.saved_at DESC, p.id DESC
    `).all(actor.id) as unknown as RecruitmentRow[];

    return rows.map(row => ({
      ...mapRecruitmentRow(row, nowIso),
      savedAt: row.saved_at ?? nowIso,
    }));
  }
}
