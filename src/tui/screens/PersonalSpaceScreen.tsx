import { useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { toServiceError } from '../../core/errors.js';
import {
  ARCHIVED_SPACE_LABEL,
  type GuestbookEntryRecord,
  type GuestbookService,
} from '../../core/guestbook-service.js';
import type {
  PersonalSpaceDetail,
  ProfilePreviewResult,
  ProfileService,
} from '../../core/profile-service.js';
import type { ServiceTheme } from '../../service/validation.js';
import { inputActions } from '../../ui/Input.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { MultilineInput } from '../components/MultilineInput.js';
import { PreviewPane } from '../components/PreviewPane.js';
import { getThemePalette, THEME_LABELS, THEME_ORDER } from '../components/Themes.js';

export interface SpaceViewer {
  isGuest: boolean;
  memberId: string | null;
  nickname: string;
  role: 'member' | 'admin' | 'guest';
}

export interface PersonalSpaceScreenProps {
  profileService: ProfileService;
  guestbookService: GuestbookService;
  viewer: SpaceViewer;
  spaceIdentifier?: string;
  mode?: 'space' | 'archived';
  width: number;
  height: number;
  onBack: () => void;
  onReportTarget?: (targetKind: 'guestbook', targetId: string) => void;
}

type SubView = 'browse' | 'write-gb' | 'edit-gb' | 'delete-gb' | 'edit-profile' | 'preview-profile';
type EditField = 'status' | 'intro' | 'stack' | 'url' | 'ascii' | 'theme' | 'preview' | 'save' | 'cancel';

const EDIT_FIELDS: readonly EditField[] = [
  'status',
  'intro',
  'stack',
  'url',
  'ascii',
  'theme',
  'preview',
  'save',
  'cancel',
];

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function InlineLineInput({
  value,
  onChange,
  focused,
  placeholder,
  width,
  borderColor,
  textColor,
  mutedColor,
}: {
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  placeholder: string;
  width: number;
  borderColor: string;
  textColor: string;
  mutedColor: string;
}) {
  usePaste(
    pasted => {
      if (!focused) return;
      const clean = pasted.replace(CONTROL_CHARS, '').normalize('NFC');
      if (clean) onChange(value + clean);
    },
    { isActive: focused },
  );

  useInput(
    (input, key) => {
      if (!focused) return;
      for (const action of inputActions(input, key)) {
        if (action.kind === 'backspace' || action.kind === 'delete') {
          const pts = Array.from(value);
          if (pts.length > 0) onChange(pts.slice(0, -1).join(''));
          return;
        }
        if (action.kind === 'text') {
          const clean = action.text.replace(CONTROL_CHARS, '').normalize('NFC');
          if (clean) onChange(value + clean);
        }
      }
    },
    { isActive: focused },
  );

  return (
    <Box width={width} borderStyle="single" borderColor={borderColor} paddingX={1}>
      <Text color={value ? textColor : mutedColor}>
        {value || placeholder}
        {focused ? '_' : ''}
      </Text>
    </Box>
  );
}

export function PersonalSpaceScreen({
  profileService,
  guestbookService,
  viewer,
  spaceIdentifier,
  mode = 'space',
  width,
  height,
  onBack,
  onReportTarget,
}: PersonalSpaceScreenProps) {
  const isArchived = mode === 'archived';
  const [detail, setDetail] = useState<PersonalSpaceDetail | null>(null);
  const [entries, setEntries] = useState<GuestbookEntryRecord[]>([]);
  const [cursor, setCursor] = useState(0);
  const [subView, setSubView] = useState<SubView>('browse');
  const [gbDraft, setGbDraft] = useState('');
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // Profile editor draft states (preserved across resizes)
  const [editFieldIdx, setEditFieldIdx] = useState(0);
  const [draftStatus, setDraftStatus] = useState('');
  const [draftIntro, setDraftIntro] = useState('');
  const [draftStack, setDraftStack] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftAscii, setDraftAscii] = useState('');
  const [draftTheme, setDraftTheme] = useState<ServiceTheme>('dark');
  const [previewResult, setPreviewResult] = useState<ProfilePreviewResult | null>(null);

  const reload = () => {
    try {
      if (isArchived) {
        setDetail(null);
        const list = guestbookService.listArchivedEntries();
        setEntries(list);
        setCursor(c => Math.max(0, Math.min(c, Math.max(0, list.length - 1))));
      } else if (spaceIdentifier) {
        const loaded = profileService.getPersonalSpaceDetail(spaceIdentifier);
        const list = guestbookService.listEntries(loaded.personalSpace.id);
        setDetail(loaded);
        setEntries(list);
        setCursor(c => Math.max(0, Math.min(c, Math.max(0, list.length - 1))));
      }
      setError('');
    } catch (err) {
      setError(toServiceError(err).message);
    }
  };

  useEffect(() => {
    reload();
  }, [spaceIdentifier, mode]);

  const palette = getThemePalette(detail?.personalSpace.colorTheme ?? 'dark');
  const isOwner = Boolean(!isArchived && detail && !viewer.isGuest && viewer.memberId === detail.member.id);
  const selectedEntry = entries[cursor] ?? null;

  const canEditSelected = Boolean(
    selectedEntry && !viewer.isGuest && viewer.memberId && selectedEntry.authorMemberId === viewer.memberId,
  );
  const canDeleteSelected = Boolean(
    selectedEntry &&
      !viewer.isGuest &&
      viewer.memberId &&
      (selectedEntry.authorMemberId === viewer.memberId || viewer.role === 'admin'),
  );

  const buildDraftPatch = () => ({
    currentStatus: draftStatus,
    introduction: draftIntro,
    technologyStack: draftStack
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    projectUrl: draftUrl,
    asciiArt: draftAscii,
    colorTheme: draftTheme,
  });

  const openProfileEditor = () => {
    if (!detail) return;
    setDraftStatus(detail.profile.currentStatus);
    setDraftIntro(detail.profile.introduction);
    setDraftStack(detail.profile.technologyStack.join(', '));
    setDraftUrl(detail.profile.projectUrl);
    setDraftAscii(detail.personalSpace.asciiArt);
    setDraftTheme(detail.personalSpace.colorTheme);
    setEditFieldIdx(0);
    setPreviewResult(null);
    setError('');
    setNotice('');
    setSubView('edit-profile');
  };

  const handlePreviewProfile = () => {
    if (!viewer.memberId) return;
    try {
      const result = profileService.previewProfileUpdate(viewer.memberId, buildDraftPatch());
      setPreviewResult(result);
      setError('');
      setSubView('preview-profile');
    } catch (err) {
      setError(toServiceError(err).message);
    }
  };

  const handleSaveProfile = () => {
    if (!viewer.memberId) return;
    try {
      const updated = profileService.updateProfile(viewer.memberId, buildDraftPatch());
      setDetail(updated);
      setSubView('browse');
      setPreviewResult(null);
      setError('');
      setNotice('프로필과 개인 공간 테마가 저장되었습니다.');
    } catch (err) {
      setError(toServiceError(err).message);
    }
  };

  const handleSubmitGuestbook = () => {
    if (!viewer.memberId) {
      setError('로그인한 회원만 방명록을 작성·수정할 수 있어요.');
      return;
    }
    try {
      if (subView === 'write-gb' && detail) {
        guestbookService.createEntry(viewer.memberId, detail.personalSpace.id, gbDraft);
        setNotice('방명록을 남겼습니다.');
      } else if (subView === 'edit-gb' && editingEntryId) {
        guestbookService.updateEntry(viewer.memberId, editingEntryId, gbDraft);
        setNotice('방명록을 수정했습니다.');
      }
      setGbDraft('');
      setEditingEntryId(null);
      setSubView('browse');
      reload();
    } catch (err) {
      setError(toServiceError(err).message);
    }
  };

  const handleConfirmDelete = () => {
    if (!viewer.memberId || !selectedEntry) return;
    try {
      const res = guestbookService.deleteEntry(viewer.memberId, selectedEntry.id);
      setSubView('browse');
      setNotice(res.byAdmin ? '관리자 권한으로 방명록을 삭제했습니다.' : '방명록을 삭제했습니다.');
      reload();
    } catch (err) {
      setSubView('browse');
      setError(toServiceError(err).message);
    }
  };

  useInput(
    (input, key) => {
      if (subView === 'delete-gb') return;

      if (subView === 'preview-profile') {
        if (key.escape || input === 'p') {
          setSubView('edit-profile');
          return;
        }
        if (key.return) {
          handleSaveProfile();
        }
        return;
      }

      if (subView === 'edit-profile') {
        const currentField = EDIT_FIELDS[editFieldIdx] ?? 'status';
        if (key.escape) {
          setSubView('browse');
          setError('');
          setNotice('프로필 편집을 취소했습니다.');
          return;
        }
        if (key.ctrl && input === 's') {
          handleSaveProfile();
          return;
        }
        if (key.tab) {
          const delta = key.shift ? -1 : 1;
          setEditFieldIdx(prev => (prev + delta + EDIT_FIELDS.length) % EDIT_FIELDS.length);
          return;
        }
        if (currentField === 'theme' && (key.leftArrow || key.rightArrow || input === ' ')) {
          const idx = THEME_ORDER.indexOf(draftTheme);
          const delta = key.leftArrow ? -1 : 1;
          setDraftTheme(THEME_ORDER[(idx + delta + THEME_ORDER.length) % THEME_ORDER.length]!);
          return;
        }
        if (key.return) {
          if (currentField === 'preview') handlePreviewProfile();
          else if (currentField === 'save') handleSaveProfile();
          else if (currentField === 'cancel') setSubView('browse');
        }
        return;
      }

      if (subView === 'write-gb' || subView === 'edit-gb') {
        if (key.escape) {
          setSubView('browse');
          setEditingEntryId(null);
          setError('');
          return;
        }
        if (key.ctrl && input === 's') {
          handleSubmitGuestbook();
        }
        return;
      }

      // browse mode
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow || input === 'k') {
        setCursor(c => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor(c => Math.min(Math.max(0, entries.length - 1), c + 1));
        return;
      }
      if (input === 'e' && isOwner) {
        openProfileEditor();
        return;
      }
      if (input === 'w' && !isArchived) {
        if (viewer.isGuest || !viewer.memberId) {
          setError('게스트는 방명록을 작성할 수 없습니다. 로그인 후 이용해 주세요.');
          return;
        }
        setGbDraft('');
        setEditingEntryId(null);
        setError('');
        setSubView('write-gb');
        return;
      }
      if (input === 'u' && canEditSelected && selectedEntry) {
        setGbDraft(selectedEntry.body);
        setEditingEntryId(selectedEntry.id);
        setError('');
        setSubView('edit-gb');
        return;
      }
      if (input === 'd' && canDeleteSelected && selectedEntry) {
        setError('');
        setSubView('delete-gb');
        return;
      }
      if (input === 'r' && selectedEntry && !viewer.isGuest && onReportTarget) {
        onReportTarget('guestbook', selectedEntry.id);
      }
    },
    { isActive: true },
  );

  if (subView === 'preview-profile' && previewResult) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        backgroundColor={palette.background}
        padding={1}
      >
        <PreviewPane preview={previewResult} width={Math.min(76, width - 2)} />
        <Box marginTop={1}>
          <Text color={palette.muted}>Enter 저장 확정 · Esc/p 편집 화면으로 복귀</Text>
        </Box>
      </Box>
    );
  }

  if (subView === 'edit-profile') {
    const activeField = EDIT_FIELDS[editFieldIdx]!;
    const editorWidth = Math.min(72, Math.max(40, width - 6));
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        backgroundColor={palette.background}
        paddingX={2}
        paddingY={1}
      >
        <Text bold color={palette.accent}>
          프로필 · 개인 공간 편집 (Tab 항목 이동 · Ctrl+S 저장 · Esc 취소)
        </Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={activeField === 'status' ? palette.accent : palette.muted}>
            한 줄 상태 (최대 80자)
          </Text>
          <InlineLineInput
            value={draftStatus}
            onChange={setDraftStatus}
            focused={activeField === 'status'}
            placeholder="현재 상태를 입력하세요"
            width={editorWidth}
            borderColor={activeField === 'status' ? palette.accent : palette.border}
            textColor={palette.text}
            mutedColor={palette.muted}
          />

          <Text color={activeField === 'intro' ? palette.accent : palette.muted}>
            자기소개 (최대 500자)
          </Text>
          <MultilineInput
            value={draftIntro}
            onChange={setDraftIntro}
            focused={activeField === 'intro'}
            maxLength={500}
            visibleLines={3}
            width={editorWidth}
            theme={palette}
            onSaveShortcut={handleSaveProfile}
          />

          <Text color={activeField === 'stack' ? palette.accent : palette.muted}>
            기술 스택 (쉼표 구분, 최대 10개 · 각 20자)
          </Text>
          <InlineLineInput
            value={draftStack}
            onChange={setDraftStack}
            focused={activeField === 'stack'}
            placeholder="TypeScript, Node.js, SQLite"
            width={editorWidth}
            borderColor={activeField === 'stack' ? palette.accent : palette.border}
            textColor={palette.text}
            mutedColor={palette.muted}
          />

          <Text color={activeField === 'url' ? palette.accent : palette.muted}>
            프로젝트 URL (HTTPS만 허용)
          </Text>
          <InlineLineInput
            value={draftUrl}
            onChange={setDraftUrl}
            focused={activeField === 'url'}
            placeholder="https://github.com/..."
            width={editorWidth}
            borderColor={activeField === 'url' ? palette.accent : palette.border}
            textColor={palette.text}
            mutedColor={palette.muted}
          />

          <Text color={activeField === 'ascii' ? palette.accent : palette.muted}>
            ASCII 아트 (40열 × 12줄 · 출력 가능 ASCII)
          </Text>
          <MultilineInput
            value={draftAscii}
            onChange={setDraftAscii}
            focused={activeField === 'ascii'}
            asciiMode
            asciiMaxCols={40}
            asciiMaxLines={12}
            visibleLines={4}
            width={editorWidth}
            theme={palette}
            onSaveShortcut={handleSaveProfile}
          />

          <Box marginTop={1} gap={2}>
            <Text color={activeField === 'theme' ? palette.accent : palette.muted}>
              테마 (←/→):
            </Text>
            {THEME_ORDER.map(t => (
              <Text
                key={t}
                bold={draftTheme === t}
                color={draftTheme === t ? palette.accent : palette.muted}
                inverse={activeField === 'theme' && draftTheme === t}
              >
                {` ${draftTheme === t ? '●' : '○'} ${THEME_LABELS[t]} `}
              </Text>
            ))}
          </Box>

          <Box marginTop={1} gap={3}>
            <Text inverse={activeField === 'preview'} color={palette.warning}>
              {' [미리보기] '}
            </Text>
            <Text inverse={activeField === 'save'} color={palette.success}>
              {' [저장] '}
            </Text>
            <Text inverse={activeField === 'cancel'} color={palette.muted}>
              {' [취소] '}
            </Text>
          </Box>
          {error ? <Text color={palette.error}>오류: {error}</Text> : null}
        </Box>
      </Box>
    );
  }

  const artLines = detail?.personalSpace.asciiArt
    ? detail.personalSpace.asciiArt.split('\n').slice(0, 12)
    : ['(설정된 ASCII 아트가 없습니다)'];

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={palette.background}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={palette.accent}>
          {isArchived
            ? `보관 방명록 · ${ARCHIVED_SPACE_LABEL} (읽기 전용 · 새 글 불가)`
            : `@${detail?.member.nickname ?? '...'}의 개인 공간 [${THEME_LABELS[palette.id]}]`}
        </Text>
        <Text color={palette.muted}>Esc 월드 복귀</Text>
      </Box>

      {!isArchived && detail && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={palette.border}
          paddingX={1}
          flexDirection="column"
        >
          <Box gap={2}>
            <Box flexDirection="column" width={42} borderStyle="single" borderColor={palette.border} paddingX={1}>
              {artLines.slice(0, 6).map((line, i) => (
                <Text key={i} color={palette.text}>
                  {line || ' '}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1}>
              <Text color={palette.text}>상태: {detail.profile.currentStatus || '(없음)'}</Text>
              <Text color={palette.text} wrap="wrap">
                소개: {detail.profile.introduction || '(없음)'}
              </Text>
              <Text color={palette.muted}>
                스택: {detail.profile.technologyStack.length > 0 ? detail.profile.technologyStack.join(', ') : '(없음)'}
              </Text>
              <Text color={palette.accent}>
                URL: {detail.profile.projectUrl || '(없음)'}
              </Text>
            </Box>
          </Box>
        </Box>
      )}

      {subView === 'delete-gb' && selectedEntry ? (
        <Box marginTop={1}>
          <ConfirmDialog
            title="방명록 삭제 확인"
            message={`@${selectedEntry.authorNickname}님의 방명록을 삭제할까요? 삭제 후 복구되지 않습니다.`}
            confirmLabel="삭제"
            cancelLabel="취소"
            destructive
            theme={palette}
            onConfirm={handleConfirmDelete}
            onCancel={() => setSubView('browse')}
          />
        </Box>
      ) : subView === 'write-gb' || subView === 'edit-gb' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={palette.accent}>
            {subView === 'write-gb' ? '방명록 작성' : '방명록 수정'} (Ctrl+S 저장 · Esc 취소)
          </Text>
          <MultilineInput
            value={gbDraft}
            onChange={setGbDraft}
            focused
            maxLength={1000}
            visibleLines={4}
            width={Math.min(72, width - 6)}
            theme={palette}
            onSaveShortcut={handleSubmitGuestbook}
            onEscape={() => setSubView('browse')}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          <Text bold color={palette.text}>
            방명록 ({entries.length}건)
          </Text>
          <Box
            flexDirection="column"
            borderStyle="single"
            borderColor={palette.border}
            paddingX={1}
            flexGrow={1}
          >
            {entries.length === 0 ? (
              <Text color={palette.muted}>아직 남겨진 방명록이 없습니다.</Text>
            ) : (
              entries.slice(Math.max(0, cursor - 4), Math.max(0, cursor - 4) + 6).map((entry, idx) => {
                const actualIdx = Math.max(0, cursor - 4) + idx;
                const selected = actualIdx === cursor;
                return (
                  <Box key={entry.id} flexDirection="column">
                    <Text
                      color={selected ? palette.accent : palette.text}
                      backgroundColor={selected ? palette.selected : undefined}
                    >
                      {selected ? '› ' : '  '}@{entry.authorNickname} · {entry.createdAt.slice(0, 10)} —{' '}
                      {entry.body.replace(/\n/g, ' ')}
                    </Text>
                  </Box>
                );
              })
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1} justifyContent="space-between">
        <Text color={palette.muted}>
          {isArchived
            ? '↑↓ 이동 · u 본인 글 수정 · d 삭제 · Esc 복귀 (새 글 작성 불가)'
            : `${isOwner ? 'e 프로필편집 · ' : ''}w 작성 · u 수정 · d 삭제 · ↑↓ 선택 · Esc 복귀`}
        </Text>
      </Box>
      {notice ? <Text color={palette.success}>{notice}</Text> : null}
      {error ? <Text color={palette.error}>오류: {error}</Text> : null}
    </Box>
  );
}
