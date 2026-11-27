import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MemberRecord } from '../../core/auth-service.js';
import { ServiceError } from '../../core/errors.js';
import type {
  BookmarkedRecruitmentRecord,
  ParticipationMode,
  RecruitmentPostRecord,
  RecruitmentService,
  RecruitmentState,
  RecruitmentType,
} from '../../core/recruitment-service.js';
import type { ServiceTheme } from '../../service/validation.js';

export interface RecruitmentScreenProps {
  recruitmentService: RecruitmentService;
  currentMember: MemberRecord | null;
  theme?: ServiceTheme;
  onBack: () => void;
}

interface ThemeColors {
  text: string;
  muted: string;
  accent: string;
  border: string;
  error: string;
  success: string;
}

const THEME_COLORS: Record<ServiceTheme, ThemeColors> = {
  dark: { text: '#E5E7EB', muted: '#94A3B8', accent: '#38BDF8', border: '#334155', error: '#F87171', success: '#34D399' },
  light: { text: '#111827', muted: '#4B5563', accent: '#0284C7', border: '#CBD5E1', error: '#DC2626', success: '#059669' },
  green: { text: '#D1FAE5', muted: '#6EE7B7', accent: '#34D399', border: '#065F46', error: '#F87171', success: '#A7F3D0' },
  amber: { text: '#FEF3C7', muted: '#FCD34D', accent: '#F59E0B', border: '#78350F', error: '#F87171', success: '#FDE68A' },
};

type RecruitmentView = 'search' | 'bookmarks' | 'detail' | 'create';

const TYPE_CYCLE: Array<RecruitmentType | undefined> = [undefined, 'project', 'contest', 'hackathon'];
const MODE_CYCLE: Array<ParticipationMode | undefined> = [undefined, 'online', 'offline', 'hybrid'];
const STATE_CYCLE: Array<RecruitmentState | undefined> = [undefined, 'open', 'closed'];

const CREATE_FIELDS = [
  'title',
  'body',
  'recruitmentType',
  'progressNote',
  'roles',
  'requiredSkills',
  'noSkillRequired',
  'participationPeriod',
  'weeklyTime',
  'participationMode',
  'region',
  'contactMethod',
  'deadlineAt',
  'ackPublic',
] as const;

type CreateField = (typeof CREATE_FIELDS)[number];

function formatError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  if (err instanceof Error) return err.message;
  return '요청을 처리하지 못했어요.';
}

function cycleNext<T>(list: T[], current: T): T {
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length]!;
}

export function RecruitmentScreen({
  recruitmentService,
  currentMember,
  theme = 'dark',
  onBack,
}: RecruitmentScreenProps) {
  const palette = THEME_COLORS[theme] ?? THEME_COLORS.dark;
  const [view, setView] = useState<RecruitmentView>('search');
  const [typeFilter, setTypeFilter] = useState<RecruitmentType | undefined>(undefined);
  const [modeFilter, setModeFilter] = useState<ParticipationMode | undefined>(undefined);
  const [stateFilter, setStateFilter] = useState<RecruitmentState | undefined>(undefined);
  const [items, setItems] = useState<RecruitmentPostRecord[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkedRecruitmentRecord[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState<RecruitmentPostRecord | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Create form state
  const [fieldIndex, setFieldIndex] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [recruitmentType, setRecruitmentType] = useState<RecruitmentType>('project');
  const [progressNote, setProgressNote] = useState('');
  const [rolesText, setRolesText] = useState('');
  const [skillsText, setSkillsText] = useState('');
  const [noSkillRequired, setNoSkillRequired] = useState(false);
  const [participationPeriod, setParticipationPeriod] = useState('');
  const [weeklyTime, setWeeklyTime] = useState('');
  const [participationMode, setParticipationMode] = useState<ParticipationMode>('online');
  const [region, setRegion] = useState('');
  const [contactMethod, setContactMethod] = useState('');
  const [deadlineAt, setDeadlineAt] = useState('');
  const [ackPublic, setAckPublic] = useState(false);

  const activeField: CreateField = CREATE_FIELDS[fieldIndex] ?? 'title';

  const loadList = useCallback(() => {
    try {
      const res = recruitmentService.searchRecruitments(
        {
          type: typeFilter,
          mode: modeFilter,
          state: stateFilter,
          limit: 20,
        },
        currentMember?.id ?? null,
      );
      setItems(res.items);
      setSelectedIndex(prev => Math.max(0, Math.min(prev, Math.max(0, res.items.length - 1))));
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(formatError(err));
    }
  }, [recruitmentService, typeFilter, modeFilter, stateFilter, currentMember]);

  const loadBookmarks = useCallback(() => {
    if (!currentMember) {
      setBookmarks([]);
      return;
    }
    try {
      const list = recruitmentService.listMyBookmarks(currentMember.id);
      setBookmarks(list);
      setSelectedIndex(prev => Math.max(0, Math.min(prev, Math.max(0, list.length - 1))));
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(formatError(err));
    }
  }, [recruitmentService, currentMember]);

  useEffect(() => {
    if (view === 'search') loadList();
    else if (view === 'bookmarks') loadBookmarks();
  }, [view, loadList, loadBookmarks]);

  useInput((input, key) => {
    if (view === 'create') {
      if (key.escape) {
        setView('search');
        setErrorMessage('');
        return;
      }
      if (key.tab) {
        setFieldIndex(prev =>
          key.shift
            ? (prev - 1 + CREATE_FIELDS.length) % CREATE_FIELDS.length
            : (prev + 1) % CREATE_FIELDS.length,
        );
        return;
      }
      if (key.ctrl && input === 's') {
        if (!currentMember) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          const roles = rolesText.split(',').map(s => s.trim()).filter(Boolean);
          const requiredSkills = skillsText.split(',').map(s => s.trim()).filter(Boolean);
          const created = recruitmentService.createRecruitment(currentMember.id, {
            title,
            body,
            recruitmentType,
            progressNote,
            roles,
            requiredSkills,
            noSkillRequired,
            participationPeriod,
            weeklyTime,
            participationMode,
            region,
            contactMethod,
            deadlineAt,
            ackPublic,
          });
          setSelectedDetail(created);
          setStatusMessage('모집글을 등록했어요.');
          setErrorMessage('');
          setView('detail');
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (activeField === 'recruitmentType' && (input === ' ' || key.return)) {
        setRecruitmentType(prev => cycleNext(['project', 'contest', 'hackathon'], prev));
        return;
      }
      if (activeField === 'participationMode' && (input === ' ' || key.return)) {
        setParticipationMode(prev => cycleNext(['online', 'offline', 'hybrid'], prev));
        return;
      }
      if (activeField === 'noSkillRequired' && (input === ' ' || key.return)) {
        setNoSkillRequired(prev => !prev);
        return;
      }
      if (activeField === 'ackPublic' && (input === ' ' || key.return)) {
        setAckPublic(prev => !prev);
        return;
      }
      if (key.backspace || key.delete) {
        const dropLast = (s: string) => s.slice(0, -1);
        if (activeField === 'title') setTitle(dropLast);
        else if (activeField === 'body') setBody(dropLast);
        else if (activeField === 'progressNote') setProgressNote(dropLast);
        else if (activeField === 'roles') setRolesText(dropLast);
        else if (activeField === 'requiredSkills') setSkillsText(dropLast);
        else if (activeField === 'participationPeriod') setParticipationPeriod(dropLast);
        else if (activeField === 'weeklyTime') setWeeklyTime(dropLast);
        else if (activeField === 'region') setRegion(dropLast);
        else if (activeField === 'contactMethod') setContactMethod(dropLast);
        else if (activeField === 'deadlineAt') setDeadlineAt(dropLast);
        return;
      }
      if (key.return) {
        if (activeField === 'body') setBody(prev => `${prev}\n`);
        else setFieldIndex(prev => (prev + 1) % CREATE_FIELDS.length);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const append = (s: string) => s + input;
        if (activeField === 'title') setTitle(append);
        else if (activeField === 'body') setBody(append);
        else if (activeField === 'progressNote') setProgressNote(append);
        else if (activeField === 'roles') setRolesText(append);
        else if (activeField === 'requiredSkills') setSkillsText(append);
        else if (activeField === 'participationPeriod') setParticipationPeriod(append);
        else if (activeField === 'weeklyTime') setWeeklyTime(append);
        else if (activeField === 'region') setRegion(append);
        else if (activeField === 'contactMethod') setContactMethod(append);
        else if (activeField === 'deadlineAt') setDeadlineAt(append);
      }
      return;
    }

    if (view === 'detail' && selectedDetail) {
      if (key.escape) {
        setView('search');
        loadList();
        return;
      }
      if (input === 'b') {
        if (!currentMember) {
          setErrorMessage('로그인한 회원만 관심 글을 저장할 수 있어요.');
          return;
        }
        try {
          const nextSaved = !selectedDetail.isBookmarked;
          recruitmentService.setBookmark(currentMember.id, selectedDetail.id, nextSaved);
          setSelectedDetail(recruitmentService.getRecruitment(selectedDetail.id, currentMember.id));
          setStatusMessage(nextSaved ? '관심 목록에 저장했어요.' : '관심 목록에서 해제했어요.');
          setErrorMessage('');
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (input === 'c') {
        if (!currentMember) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          const closed = recruitmentService.closeRecruitment(currentMember.id, selectedDetail.id);
          setSelectedDetail(closed);
          setStatusMessage('모집을 마감했어요.');
          setErrorMessage('');
        } catch (err) {
          setErrorMessage(formatError(err));
        }
      }
      return;
    }

    const activeList = view === 'bookmarks' ? bookmarks : items;
    if (key.escape) {
      if (view === 'bookmarks') {
        setView('search');
        return;
      }
      onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(prev => Math.min(Math.max(0, activeList.length - 1), prev + 1));
      return;
    }
    if (key.return) {
      const target = activeList[selectedIndex];
      if (!target) return;
      try {
        setSelectedDetail(recruitmentService.getRecruitment(target.id, currentMember?.id ?? null));
        setView('detail');
        setErrorMessage('');
      } catch (err) {
        setErrorMessage(formatError(err));
      }
      return;
    }
    if (input === 'm') {
      if (!currentMember) {
        setErrorMessage('로그인한 회원만 내 저장 목록을 조회할 수 있어요.');
        return;
      }
      setView(prev => (prev === 'bookmarks' ? 'search' : 'bookmarks'));
      return;
    }
    if (input === 'b') {
      const target = activeList[selectedIndex];
      if (!target) return;
      if (!currentMember) {
        setErrorMessage('로그인한 회원만 관심 글을 저장할 수 있어요.');
        return;
      }
      try {
        const nextSaved = !target.isBookmarked;
        recruitmentService.setBookmark(currentMember.id, target.id, nextSaved);
        setStatusMessage(nextSaved ? '관심 목록에 저장했어요.' : '관심 목록에서 해제했어요.');
        if (view === 'bookmarks') loadBookmarks();
        else loadList();
      } catch (err) {
        setErrorMessage(formatError(err));
      }
      return;
    }
    if (view === 'search') {
      if (input === '1') setTypeFilter(prev => cycleNext(TYPE_CYCLE, prev));
      else if (input === '2') setModeFilter(prev => cycleNext(MODE_CYCLE, prev));
      else if (input === '3') setStateFilter(prev => cycleNext(STATE_CYCLE, prev));
      else if (input === 'w') {
        if (!currentMember) {
          setErrorMessage('로그인한 회원만 모집글을 작성할 수 있어요.');
          return;
        }
        setFieldIndex(0);
        setAckPublic(false);
        setView('create');
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text color={palette.accent} bold>
        RECRUITMENT · 프로젝트/공모전 모집 {view === 'bookmarks' ? '(내 비공개 저장 목록)' : ''}
      </Text>

      {view === 'search' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.muted}>
            필터 [1] 유형: {typeFilter ?? '전체'} · [2] 방식: {modeFilter ?? '전체'} · [3] 상태: {stateFilter ?? '전체'}
          </Text>
          {items.length === 0 ? (
            <Text color={palette.muted}>조건에 맞는 모집글이 없어요.</Text>
          ) : (
            items.map((item, idx) => (
              <Text key={item.id} color={idx === selectedIndex ? palette.accent : palette.text}>
                {idx === selectedIndex ? '› ' : '  '}
                {item.isBookmarked ? '★ ' : '  '}
                [{item.recruitmentState === 'open' ? '모집 중' : '마감'}] [{item.recruitmentType}] {item.title} · {item.participationMode}
                {item.region ? `(${item.region})` : ''}
              </Text>
            ))
          )}
          <Box marginTop={1}>
            <Text color={palette.muted}>
              1/2/3 필터 · ↑↓ 선택 · Enter 상세 · b 북마크 · m 내 저장목록 · w 모집작성 · Esc 복귀
            </Text>
          </Box>
        </Box>
      )}

      {view === 'bookmarks' && (
        <Box marginTop={1} flexDirection="column">
          {bookmarks.length === 0 ? (
            <Text color={palette.muted}>저장한 관심 모집글이 없어요.</Text>
          ) : (
            bookmarks.map((item, idx) => (
              <Text key={item.id} color={idx === selectedIndex ? palette.accent : palette.text}>
                {idx === selectedIndex ? '› ' : '  '}★ [{item.recruitmentState === 'open' ? '모집 중' : '마감'}] {item.title}
              </Text>
            ))
          )}
          <Box marginTop={1}>
            <Text color={palette.muted}>↑↓ 선택 · Enter 상세 · b 저장 해제 · m/Esc 모집 목록</Text>
          </Box>
        </Box>
      )}

      {view === 'detail' && selectedDetail && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.accent} bold>
            [{selectedDetail.recruitmentState === 'open' ? '모집 중' : '마감'}] {selectedDetail.title}
          </Text>
          <Text color={palette.muted}>
            작성자: {selectedDetail.authorNickname} · 유형: {selectedDetail.recruitmentType} · 마감(UTC): {selectedDetail.deadlineAt}
          </Text>
          <Text color={palette.text}>진행 상태: {selectedDetail.progressNote}</Text>
          <Text color={palette.text}>모집 역할: {selectedDetail.roles.join(', ')}</Text>
          <Text color={palette.text}>
            필요 기술: {selectedDetail.noSkillRequired ? '기술 무관' : selectedDetail.requiredSkills.join(', ')}
          </Text>
          <Text color={palette.text}>
            참여 기간/시간: {selectedDetail.participationPeriod} / {selectedDetail.weeklyTime}
          </Text>
          <Text color={palette.text}>
            참여 방식: {selectedDetail.participationMode}{selectedDetail.region ? ` (${selectedDetail.region})` : ''}
          </Text>
          <Text color={palette.accent}>연락 수단(공개): {selectedDetail.contactMethod}</Text>
          <Box marginTop={1}>
            <Text color={palette.text}>{selectedDetail.body}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={palette.muted}>
              b {selectedDetail.isBookmarked ? '북마크 해제' : '북마크 저장'} · c 작성자 마감 · Esc 목록으로
            </Text>
          </Box>
        </Box>
      )}

      {view === 'create' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.accent} bold>새 모집글 작성 (연락처 포함 전체 공개)</Text>
          <Text color={activeField === 'title' ? palette.accent : palette.text}>제목: {title}</Text>
          <Text color={activeField === 'body' ? palette.accent : palette.text}>본문: {body}</Text>
          <Text color={activeField === 'recruitmentType' ? palette.accent : palette.text}>
            유형(Space 전환): {recruitmentType}
          </Text>
          <Text color={activeField === 'progressNote' ? palette.accent : palette.text}>진행 상태: {progressNote}</Text>
          <Text color={activeField === 'roles' ? palette.accent : palette.text}>역할(쉼표 구분): {rolesText}</Text>
          <Text color={activeField === 'requiredSkills' ? palette.accent : palette.text}>기술(쉼표 구분): {skillsText}</Text>
          <Text color={activeField === 'noSkillRequired' ? palette.accent : palette.text}>
            기술 무관(Space): [{noSkillRequired ? 'x' : ' '}]
          </Text>
          <Text color={activeField === 'participationPeriod' ? palette.accent : palette.text}>참여 기간: {participationPeriod}</Text>
          <Text color={activeField === 'weeklyTime' ? palette.accent : palette.text}>주당 시간: {weeklyTime}</Text>
          <Text color={activeField === 'participationMode' ? palette.accent : palette.text}>
            방식(Space 전환): {participationMode}
          </Text>
          <Text color={activeField === 'region' ? palette.accent : palette.text}>지역(오프라인/혼합 필수): {region}</Text>
          <Text color={activeField === 'contactMethod' ? palette.accent : palette.text}>연락 수단: {contactMethod}</Text>
          <Text color={activeField === 'deadlineAt' ? palette.accent : palette.text}>마감일(KST YYYY-MM-DD): {deadlineAt}</Text>
          <Text color={activeField === 'ackPublic' ? palette.accent : palette.text}>
            공개 동의(Space): [{ackPublic ? 'x' : ' '}] 연락처 포함 전체 내용이 공개됩니다.
          </Text>
          <Text color={palette.muted}>Tab 다음 항목 · Ctrl+S 게시 · Esc 취소</Text>
        </Box>
      )}

      {statusMessage ? <Text color={palette.success}>{statusMessage}</Text> : null}
      {errorMessage ? <Text color={palette.error}>{errorMessage}</Text> : null}
    </Box>
  );
}
