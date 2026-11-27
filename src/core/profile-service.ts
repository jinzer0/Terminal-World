import {
  parseAsciiArt,
  parseProjectUrl,
  parseTechnologyStack,
  parseText,
  parseTheme,
  type ServiceTheme,
} from '../service/validation.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import type { MemberRole } from './auth-service.js';
import type { Clock } from './clock.js';
import { ServiceError, toServiceError } from './errors.js';

export interface ProfileRecord {
  memberId: string;
  nickname: string;
  introduction: string;
  technologyStack: string[];
  currentStatus: string;
  projectUrl: string;
  updatedAt: string;
}

export interface PersonalSpaceRecord {
  id: string;
  memberId: string;
  nickname: string;
  asciiArt: string;
  colorTheme: ServiceTheme;
  gridSlot: number;
  updatedAt: string;
}

export interface PersonalSpaceDetail {
  member: {
    id: string;
    nickname: string;
    role: MemberRole;
  };
  profile: ProfileRecord;
  personalSpace: PersonalSpaceRecord;
}

export interface PublicPersonalSpaceItem {
  spaceId: string;
  memberId: string;
  nickname: string;
  introduction: string;
  technologyStack: string[];
  currentStatus: string;
  projectUrl: string;
  asciiArt: string;
  colorTheme: ServiceTheme;
  gridSlot: number;
  updatedAt: string;
}

export interface ProfileUpdateInput {
  introduction?: unknown;
  technologyStack?: unknown;
  currentStatus?: unknown;
  projectUrl?: unknown;
  asciiArt?: unknown;
  colorTheme?: unknown;
}

export interface ProfilePreviewResult {
  memberId: string;
  nickname: string;
  profile: ProfileRecord;
  personalSpace: PersonalSpaceRecord;
  previewOnly: true;
  changedFields: string[];
}

interface JoinedSpaceRow {
  member_id: string;
  login_id: string;
  nickname: string;
  role: MemberRole;
  state: string;
  introduction: string;
  technology_stack_json: string;
  current_status: string;
  project_url: string;
  profile_updated_at: string;
  space_id: string;
  ascii_art: string;
  color_theme: ServiceTheme;
  grid_slot: number;
  space_updated_at: string;
}

function parseStackJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapDetail(row: JoinedSpaceRow): PersonalSpaceDetail {
  return {
    member: {
      id: row.member_id,
      nickname: row.nickname,
      role: row.role,
    },
    profile: {
      memberId: row.member_id,
      nickname: row.nickname,
      introduction: row.introduction,
      technologyStack: parseStackJson(row.technology_stack_json),
      currentStatus: row.current_status,
      projectUrl: row.project_url,
      updatedAt: row.profile_updated_at,
    },
    personalSpace: {
      id: row.space_id,
      memberId: row.member_id,
      nickname: row.nickname,
      asciiArt: row.ascii_art,
      colorTheme: row.color_theme,
      gridSlot: row.grid_slot,
      updatedAt: row.space_updated_at,
    },
  };
}

function mapPublicItem(row: JoinedSpaceRow): PublicPersonalSpaceItem {
  return {
    spaceId: row.space_id,
    memberId: row.member_id,
    nickname: row.nickname,
    introduction: row.introduction,
    technologyStack: parseStackJson(row.technology_stack_json),
    currentStatus: row.current_status,
    projectUrl: row.project_url,
    asciiArt: row.ascii_art,
    colorTheme: row.color_theme,
    gridSlot: row.grid_slot,
    updatedAt: row.space_updated_at,
  };
}

export class ProfileService {
  constructor(
    private readonly worldDb: WorldDatabase,
    private readonly clock: Clock,
  ) {}

  private findJoinedRow(identifier: string): JoinedSpaceRow | undefined {
    const trimmed = typeof identifier === 'string' ? identifier.normalize('NFC').trim() : '';
    if (!trimmed) return undefined;
    const key = trimmed.toLowerCase();

    return this.worldDb.db.prepare(`
      SELECT
        m.id AS member_id,
        m.login_id,
        m.nickname,
        m.role,
        m.state,
        p.introduction,
        p.technology_stack_json,
        p.current_status,
        p.project_url,
        p.updated_at AS profile_updated_at,
        ps.id AS space_id,
        ps.ascii_art,
        ps.color_theme,
        ps.grid_slot,
        ps.updated_at AS space_updated_at
      FROM members m
      JOIN profiles p ON p.member_id = m.id
      JOIN personal_spaces ps ON ps.member_id = m.id
      WHERE m.state = 'active'
        AND (m.id = ? OR ps.id = ? OR m.nickname_key = ?)
    `).get(trimmed, trimmed, key) as unknown as JoinedSpaceRow | undefined;
  }

  getProfile(memberIdOrNickname: string): ProfileRecord {
    try {
      const row = this.findJoinedRow(memberIdOrNickname);
      if (!row) {
        throw new ServiceError('NOT_FOUND', '활성 회원의 프로필을 찾을 수 없어요.');
      }
      return mapDetail(row).profile;
    } catch (error) {
      throw toServiceError(error);
    }
  }

  getPersonalSpace(identifier: string): PersonalSpaceRecord {
    try {
      const row = this.findJoinedRow(identifier);
      if (!row) {
        throw new ServiceError('NOT_FOUND', '개인 공간을 찾을 수 없어요.');
      }
      return mapDetail(row).personalSpace;
    } catch (error) {
      throw toServiceError(error);
    }
  }

  getPersonalSpaceDetail(identifier: string): PersonalSpaceDetail {
    try {
      const row = this.findJoinedRow(identifier);
      if (!row) {
        throw new ServiceError('NOT_FOUND', '개인 공간을 찾을 수 없어요.');
      }
      return mapDetail(row);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  listPublicPersonalSpaces(): PublicPersonalSpaceItem[] {
    try {
      const rows = this.worldDb.db.prepare(`
        SELECT
          m.id AS member_id,
          m.login_id,
          m.nickname,
          m.role,
          m.state,
          p.introduction,
          p.technology_stack_json,
          p.current_status,
          p.project_url,
          p.updated_at AS profile_updated_at,
          ps.id AS space_id,
          ps.ascii_art,
          ps.color_theme,
          ps.grid_slot,
          ps.updated_at AS space_updated_at
        FROM members m
        JOIN profiles p ON p.member_id = m.id
        JOIN personal_spaces ps ON ps.member_id = m.id
        WHERE m.state = 'active'
        ORDER BY ps.grid_slot ASC
      `).all() as unknown as JoinedSpaceRow[];
      return rows.map(mapPublicItem);
    } catch (error) {
      throw toServiceError(error);
    }
  }

  private validateAndMerge(
    current: PersonalSpaceDetail,
    input: ProfileUpdateInput,
    nowIso: string,
  ): {
    nextProfile: ProfileRecord;
    nextSpace: PersonalSpaceRecord;
    changedFields: string[];
  } {
    const changedFields: string[] = [];

    const introduction = input.introduction !== undefined
      ? parseText('introduction', input.introduction)
      : current.profile.introduction;
    if (input.introduction !== undefined && introduction !== current.profile.introduction) {
      changedFields.push('introduction');
    }

    const technologyStack = input.technologyStack !== undefined
      ? parseTechnologyStack(input.technologyStack)
      : [...current.profile.technologyStack];
    if (
      input.technologyStack !== undefined &&
      JSON.stringify(technologyStack) !== JSON.stringify(current.profile.technologyStack)
    ) {
      changedFields.push('technologyStack');
    }

    const currentStatus = input.currentStatus !== undefined
      ? parseText('status', input.currentStatus)
      : current.profile.currentStatus;
    if (input.currentStatus !== undefined && currentStatus !== current.profile.currentStatus) {
      changedFields.push('currentStatus');
    }

    const projectUrl = input.projectUrl !== undefined
      ? parseProjectUrl(input.projectUrl)
      : current.profile.projectUrl;
    if (input.projectUrl !== undefined && projectUrl !== current.profile.projectUrl) {
      changedFields.push('projectUrl');
    }

    const asciiArt = input.asciiArt !== undefined
      ? parseAsciiArt(input.asciiArt)
      : current.personalSpace.asciiArt;
    if (input.asciiArt !== undefined && asciiArt !== current.personalSpace.asciiArt) {
      changedFields.push('asciiArt');
    }

    const colorTheme = input.colorTheme !== undefined
      ? parseTheme(input.colorTheme)
      : current.personalSpace.colorTheme;
    if (input.colorTheme !== undefined && colorTheme !== current.personalSpace.colorTheme) {
      changedFields.push('colorTheme');
    }

    return {
      nextProfile: {
        ...current.profile,
        introduction,
        technologyStack,
        currentStatus,
        projectUrl,
        updatedAt: nowIso,
      },
      nextSpace: {
        ...current.personalSpace,
        asciiArt,
        colorTheme,
        updatedAt: nowIso,
      },
      changedFields,
    };
  }

  /**
   * Validates a proposed profile/space update without persisting any changes to SQLite.
   */
  previewProfileUpdate(actorMemberId: string, input: ProfileUpdateInput): ProfilePreviewResult {
    try {
      const row = this.findJoinedRow(actorMemberId);
      if (!row || row.member_id !== actorMemberId) {
        throw new ServiceError('FORBIDDEN', '활성 회원 본인만 프로필을 미리보기할 수 있어요.');
      }
      const current = mapDetail(row);
      const nowIso = this.clock.now().toISOString();
      const { nextProfile, nextSpace, changedFields } = this.validateAndMerge(current, input, nowIso);
      return {
        memberId: current.member.id,
        nickname: current.member.nickname,
        profile: nextProfile,
        personalSpace: nextSpace,
        previewOnly: true,
        changedFields,
      };
    } catch (error) {
      throw toServiceError(error);
    }
  }

  /**
   * Atomically validates and updates the member's profile and personal space settings.
   */
  updateProfile(actorMemberId: string, input: ProfileUpdateInput): PersonalSpaceDetail {
    try {
      const nowIso = this.clock.now().toISOString();
      return this.worldDb.transaction(() => {
        const row = this.findJoinedRow(actorMemberId);
        if (!row || row.member_id !== actorMemberId) {
          throw new ServiceError('FORBIDDEN', '활성 회원 본인만 프로필을 수정할 수 있어요.');
        }
        const current = mapDetail(row);
        const { nextProfile, nextSpace } = this.validateAndMerge(current, input, nowIso);

        this.worldDb.db.prepare(`
          UPDATE profiles
          SET introduction = ?, technology_stack_json = ?, current_status = ?, project_url = ?, updated_at = ?
          WHERE member_id = ?
        `).run(
          nextProfile.introduction,
          JSON.stringify(nextProfile.technologyStack),
          nextProfile.currentStatus,
          nextProfile.projectUrl,
          nowIso,
          actorMemberId,
        );

        this.worldDb.db.prepare(`
          UPDATE personal_spaces
          SET ascii_art = ?, color_theme = ?, updated_at = ?
          WHERE member_id = ?
        `).run(
          nextSpace.asciiArt,
          nextSpace.colorTheme,
          nowIso,
          actorMemberId,
        );

        this.worldDb.recordOperationalLog({
          occurredAt: nowIso,
          eventType: 'profile.update',
          outcome: 'success',
          memberId: actorMemberId,
          loginIdSnapshot: row.login_id,
          nicknameSnapshot: row.nickname,
        });

        return {
          member: current.member,
          profile: nextProfile,
          personalSpace: nextSpace,
        };
      });
    } catch (error) {
      throw toServiceError(error);
    }
  }
}
