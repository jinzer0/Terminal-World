import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MemberRecord } from '../../core/auth-service.js';
import { ServiceError } from '../../core/errors.js';
import type { NoticeRecord, NoticeService } from '../../core/notice-service.js';
import type { ServiceTheme } from '../../service/validation.js';

export interface LobbyPresenceSummary {
  onlineMembers: Array<{ memberId: string; nickname: string }>;
  awayMembers: Array<{ memberId: string; nickname: string }>;
  guestCount: number;
}

export interface LobbyScreenProps {
  noticeService: NoticeService;
  currentMember: MemberRecord | null;
  presence?: LobbyPresenceSummary;
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

type LobbyMode = 'list' | 'detail' | 'create' | 'edit';

function formatError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  if (err instanceof Error) return err.message;
  return '요청을 처리하지 못했어요.';
}

export function LobbyScreen({
  noticeService,
  currentMember,
  presence = { onlineMembers: [], awayMembers: [], guestCount: 0 },
  theme = 'dark',
  onBack,
}: LobbyScreenProps) {
  const palette = THEME_COLORS[theme] ?? THEME_COLORS.dark;
  const [mode, setMode] = useState<LobbyMode>('list');
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedNotice, setSelectedNotice] = useState<NoticeRecord | null>(null);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [formField, setFormField] = useState<'title' | 'body'>('title');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const refreshNotices = useCallback(() => {
    try {
      const page = noticeService.listNotices({ includeEnded, limit: 50 });
      setNotices(page.items);
      setSelectedIndex(prev => Math.max(0, Math.min(prev, Math.max(0, page.items.length - 1))));
      setErrorMessage('');
    } catch (err) {
      setErrorMessage(formatError(err));
    }
  }, [noticeService, includeEnded]);

  useEffect(() => {
    refreshNotices();
  }, [refreshNotices]);

  const isAdmin = currentMember?.role === 'admin';

  useInput((input, key) => {
    if (mode === 'create' || mode === 'edit') {
      if (key.escape) {
        setMode(selectedNotice && mode === 'edit' ? 'detail' : 'list');
        setErrorMessage('');
        return;
      }
      if (key.tab) {
        setFormField(prev => (prev === 'title' ? 'body' : 'title'));
        return;
      }
      if (key.ctrl && input === 's') {
        if (!currentMember) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          if (mode === 'create') {
            const created = noticeService.createNotice(currentMember.id, {
              title: draftTitle,
              body: draftBody,
            });
            setSelectedNotice(created);
            setStatusMessage('공지를 게시했어요.');
            setErrorMessage('');
            setMode('detail');
            refreshNotices();
          } else if (selectedNotice) {
            const updated = noticeService.updateNotice(currentMember.id, selectedNotice.id, {
              title: draftTitle,
              body: draftBody,
            });
            setSelectedNotice(updated);
            setStatusMessage('공지를 수정했어요.');
            setErrorMessage('');
            setMode('detail');
            refreshNotices();
          }
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (formField === 'title') {
          setDraftTitle(prev => prev.slice(0, -1));
        } else {
          setDraftBody(prev => prev.slice(0, -1));
        }
        return;
      }
      if (key.return) {
        if (formField === 'title') {
          setFormField('body');
        } else {
          setDraftBody(prev => `${prev}\n`);
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (formField === 'title') {
          setDraftTitle(prev => prev + input);
        } else {
          setDraftBody(prev => prev + input);
        }
      }
      return;
    }

    if (mode === 'detail') {
      if (key.escape) {
        setMode('list');
        setErrorMessage('');
        return;
      }
      if (isAdmin && currentMember && selectedNotice) {
        if (input === 'e') {
          setDraftTitle(selectedNotice.title);
          setDraftBody(selectedNotice.body);
          setFormField('title');
          setMode('edit');
          setErrorMessage('');
          return;
        }
        if (input === 'x') {
          try {
            const ended = noticeService.endNotice(currentMember.id, selectedNotice.id);
            setSelectedNotice(ended);
            setStatusMessage('공지 게시를 종료했어요.');
            setErrorMessage('');
            refreshNotices();
          } catch (err) {
            setErrorMessage(formatError(err));
          }
        }
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(prev => Math.min(Math.max(0, notices.length - 1), prev + 1));
      return;
    }
    if (key.return) {
      const target = notices[selectedIndex];
      if (!target) return;
      try {
        setSelectedNotice(noticeService.getNotice(target.id));
        setMode('detail');
        setErrorMessage('');
      } catch (err) {
        setErrorMessage(formatError(err));
      }
      return;
    }
    if (input === 'r') {
      refreshNotices();
      setStatusMessage('공지 목록을 새로고침했어요.');
      return;
    }
    if (input === 'a') {
      setIncludeEnded(prev => !prev);
      return;
    }
    if (input === 'n' && isAdmin) {
      setDraftTitle('');
      setDraftBody('');
      setFormField('title');
      setMode('create');
      setErrorMessage('');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text color={palette.accent} bold>
        LOBBY · 공지사항 & 접속 현황
      </Text>
      <Text color={palette.muted}>
        온라인 회원 {presence.onlineMembers.length}명 · 자리비움 {presence.awayMembers.length}명 · 게스트 {presence.guestCount}명
      </Text>
      {presence.onlineMembers.length > 0 && (
        <Text color={palette.text}>
          온라인: {presence.onlineMembers.map(m => `@${m.nickname}`).join(', ')}
        </Text>
      )}
      {presence.awayMembers.length > 0 && (
        <Text color={palette.muted}>
          자리비움: {presence.awayMembers.map(m => `@${m.nickname}`).join(', ')}
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {mode === 'list' && (
          <>
            <Text color={palette.text} bold>
              공지 목록 ({includeEnded ? '종료 포함' : '게시 중'})
            </Text>
            {notices.length === 0 ? (
              <Text color={palette.muted}>등록된 공지가 없어요.</Text>
            ) : (
              notices.map((notice, idx) => (
                <Text
                  key={notice.id}
                  color={idx === selectedIndex ? palette.accent : palette.text}
                >
                  {idx === selectedIndex ? '› ' : '  '}
                  [{notice.publicationState === 'published' ? '게시 중' : '종료'}] {notice.title} · {notice.authorNickname}
                </Text>
              ))
            )}
            <Box marginTop={1}>
              <Text color={palette.muted}>
                ↑↓ 선택 · Enter 보기 · a 종료공지 토글 · r 새로고침{isAdmin ? ' · n 새 공지' : ''} · Esc 복귀
              </Text>
            </Box>
          </>
        )}

        {mode === 'detail' && selectedNotice && (
          <>
            <Text color={palette.accent} bold>
              [{selectedNotice.publicationState === 'published' ? '게시 중' : '종료'}] {selectedNotice.title}
            </Text>
            <Text color={palette.muted}>
              작성자: {selectedNotice.authorNickname} · 작성: {selectedNotice.createdAt}
            </Text>
            <Box marginTop={1}>
              <Text color={palette.text}>{selectedNotice.body}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={palette.muted}>
                {isAdmin ? 'e 수정 · x 게시 종료 · ' : ''}Esc 목록으로
              </Text>
            </Box>
          </>
        )}

        {(mode === 'create' || mode === 'edit') && (
          <>
            <Text color={palette.accent} bold>
              {mode === 'create' ? '새 공지 작성' : '공지 수정'}
            </Text>
            <Text color={formField === 'title' ? palette.accent : palette.text}>
              제목: {draftTitle}{formField === 'title' ? '_' : ''}
            </Text>
            <Text color={formField === 'body' ? palette.accent : palette.text}>
              본문: {draftBody}{formField === 'body' ? '_' : ''}
            </Text>
            <Text color={palette.muted}>Tab 필드 전환 · Ctrl+S 저장 · Esc 취소</Text>
          </>
        )}
      </Box>

      {statusMessage ? <Text color={palette.success}>{statusMessage}</Text> : null}
      {errorMessage ? <Text color={palette.error}>{errorMessage}</Text> : null}
    </Box>
  );
}
