import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MemberRecord } from '../../core/auth-service.js';
import type {
  BoardRecord,
  BoardService,
  PostDetail,
  PostRecord,
} from '../../core/board-service.js';
import { ServiceError } from '../../core/errors.js';
import type { ServiceTheme } from '../../service/validation.js';

export interface CafeScreenProps {
  boardService: BoardService;
  currentMember: MemberRecord | null;
  initialBoardId?: string;
  theme?: ServiceTheme;
  onBack: () => void;
  onOpenRecruitment?: () => void;
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

type CafeMode = 'boards' | 'posts' | 'detail' | 'createPost' | 'editPost' | 'createComment';

function formatError(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  if (err instanceof Error) return err.message;
  return '요청을 처리하지 못했어요.';
}

export function CafeScreen({
  boardService,
  currentMember,
  initialBoardId,
  theme = 'dark',
  onBack,
  onOpenRecruitment,
}: CafeScreenProps) {
  const palette = THEME_COLORS[theme] ?? THEME_COLORS.dark;
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [boardIndex, setBoardIndex] = useState(0);
  const [mode, setMode] = useState<CafeMode>(initialBoardId ? 'posts' : 'boards');
  const [posts, setPosts] = useState<PostRecord[]>([]);
  const [postIndex, setPostIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [commentIndex, setCommentIndex] = useState(0);
  const [formField, setFormField] = useState<'title' | 'body'>('title');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const loadedBoards = boardService.listBoards();
    setBoards(loadedBoards);
    if (initialBoardId) {
      const idx = loadedBoards.findIndex(b => b.id === initialBoardId);
      if (idx >= 0) setBoardIndex(idx);
    }
  }, [boardService, initialBoardId]);

  const activeBoard = boards[boardIndex] ?? null;

  const loadPosts = useCallback(
    (boardId: string, cursor: string | null = null) => {
      try {
        const page = boardService.listPosts({ boardId, cursor, limit: 15 });
        setPosts(page.items);
        setNextCursor(page.cursor);
        setHasMore(page.hasMore);
        setPostIndex(0);
        setErrorMessage('');
      } catch (err) {
        setErrorMessage(formatError(err));
      }
    },
    [boardService],
  );

  useEffect(() => {
    if (mode === 'posts' && activeBoard) {
      loadPosts(activeBoard.id, null);
    }
  }, [mode, activeBoard, loadPosts]);

  const reloadDetail = useCallback(
    (postId: string) => {
      try {
        const loaded = boardService.getPost(postId);
        setDetail(loaded);
        setCommentIndex(prev => Math.max(0, Math.min(prev, Math.max(0, loaded.comments.length - 1))));
        setErrorMessage('');
      } catch (err) {
        setErrorMessage(formatError(err));
      }
    },
    [boardService],
  );

  useInput((input, key) => {
    if (mode === 'createPost' || mode === 'editPost') {
      if (key.escape) {
        setMode(mode === 'editPost' ? 'detail' : 'posts');
        setErrorMessage('');
        return;
      }
      if (key.tab) {
        setFormField(prev => (prev === 'title' ? 'body' : 'title'));
        return;
      }
      if (key.ctrl && input === 's') {
        if (!currentMember || !activeBoard) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          if (mode === 'createPost') {
            const created = boardService.createPost(currentMember.id, {
              boardId: activeBoard.id,
              title: draftTitle,
              body: draftBody,
            });
            setStatusMessage('게시글을 등록했어요.');
            reloadDetail(created.id);
            setMode('detail');
          } else if (detail) {
            boardService.updatePost(currentMember.id, detail.id, {
              title: draftTitle,
              body: draftBody,
            });
            setStatusMessage('게시글을 수정했어요.');
            reloadDetail(detail.id);
            setMode('detail');
          }
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (formField === 'title') setDraftTitle(prev => prev.slice(0, -1));
        else setDraftBody(prev => prev.slice(0, -1));
        return;
      }
      if (key.return) {
        if (formField === 'title') setFormField('body');
        else setDraftBody(prev => `${prev}\n`);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (formField === 'title') setDraftTitle(prev => prev + input);
        else setDraftBody(prev => prev + input);
      }
      return;
    }

    if (mode === 'createComment') {
      if (key.escape) {
        setMode('detail');
        setErrorMessage('');
        return;
      }
      if (key.ctrl && input === 's') {
        if (!currentMember || !detail) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          boardService.createComment(currentMember.id, {
            postId: detail.id,
            body: draftComment,
          });
          setDraftComment('');
          setStatusMessage('댓글을 등록했어요.');
          reloadDetail(detail.id);
          setMode('detail');
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (key.backspace || key.delete) {
        setDraftComment(prev => prev.slice(0, -1));
        return;
      }
      if (key.return) {
        setDraftComment(prev => `${prev}\n`);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraftComment(prev => prev + input);
      }
      return;
    }

    if (mode === 'detail' && detail) {
      if (key.escape) {
        setMode('posts');
        if (activeBoard) loadPosts(activeBoard.id, null);
        return;
      }
      if (key.upArrow || input === 'k') {
        setCommentIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCommentIndex(prev => Math.min(Math.max(0, detail.comments.length - 1), prev + 1));
        return;
      }
      if (input === 'c') {
        if (!currentMember) {
          setErrorMessage('로그인한 회원만 댓글을 작성할 수 있어요.');
          return;
        }
        setDraftComment('');
        setMode('createComment');
        return;
      }
      if (input === 'e') {
        if (!currentMember || detail.authorMemberId !== currentMember.id) {
          setErrorMessage('본인이 작성한 글만 수정할 수 있어요.');
          return;
        }
        setDraftTitle(detail.title);
        setDraftBody(detail.body);
        setFormField('title');
        setMode('editPost');
        return;
      }
      if (input === 'd') {
        if (!currentMember) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          boardService.deletePost(currentMember.id, detail.id);
          setDetail(null);
          setStatusMessage('게시글을 삭제했어요.');
          setMode('posts');
          if (activeBoard) loadPosts(activeBoard.id, null);
        } catch (err) {
          setErrorMessage(formatError(err));
        }
        return;
      }
      if (input === 'x') {
        const comment = detail.comments[commentIndex];
        if (!comment) return;
        if (!currentMember) {
          setErrorMessage('로그인이 필요해요.');
          return;
        }
        try {
          boardService.deleteComment(currentMember.id, comment.id);
          setStatusMessage('댓글을 삭제했어요.');
          reloadDetail(detail.id);
        } catch (err) {
          setErrorMessage(formatError(err));
        }
      }
      return;
    }

    if (mode === 'posts') {
      if (key.escape) {
        setMode('boards');
        setErrorMessage('');
        return;
      }
      if (key.upArrow || input === 'k') {
        setPostIndex(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setPostIndex(prev => Math.min(Math.max(0, posts.length - 1), prev + 1));
        return;
      }
      if (key.return) {
        const target = posts[postIndex];
        if (!target) return;
        reloadDetail(target.id);
        setMode('detail');
        return;
      }
      if (input === 'n' && hasMore && activeBoard) {
        loadPosts(activeBoard.id, nextCursor);
        return;
      }
      if (input === 'p' && activeBoard) {
        loadPosts(activeBoard.id, null);
        return;
      }
      if (input === 'w') {
        if (!currentMember) {
          setErrorMessage('로그인한 회원만 글을 작성할 수 있어요.');
          return;
        }
        setDraftTitle('');
        setDraftBody('');
        setFormField('title');
        setMode('createPost');
        return;
      }
      if (input === 'r' && onOpenRecruitment && activeBoard?.id === 'recruitment') {
        onOpenRecruitment();
      }
      return;
    }

    // mode === 'boards'
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow || input === 'k') {
      setBoardIndex(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setBoardIndex(prev => Math.min(Math.max(0, boards.length - 1), prev + 1));
      return;
    }
    if (key.return && activeBoard) {
      if (activeBoard.id === 'recruitment' && onOpenRecruitment) {
        onOpenRecruitment();
        return;
      }
      setMode('posts');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1}>
      <Text color={palette.accent} bold>
        CAFE · 7개 게시판 {activeBoard ? `> ${activeBoard.name}` : ''}
      </Text>

      {mode === 'boards' && (
        <Box marginTop={1} flexDirection="column">
          {boards.map((board, idx) => (
            <Text key={board.id} color={idx === boardIndex ? palette.accent : palette.text}>
              {idx === boardIndex ? '› ' : '  '}
              [{board.id}] {board.name} — {board.description}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={palette.muted}>↑↓ 게시판 선택 · Enter 입장 · Esc 월드 복귀</Text>
          </Box>
        </Box>
      )}

      {mode === 'posts' && activeBoard && (
        <Box marginTop={1} flexDirection="column">
          {posts.length === 0 ? (
            <Text color={palette.muted}>게시글이 없어요.</Text>
          ) : (
            posts.map((post, idx) => (
              <Text key={post.id} color={idx === postIndex ? palette.accent : palette.text}>
                {idx === postIndex ? '› ' : '  '}
                {post.title} · {post.authorNickname} · 댓글 {post.commentCount}
              </Text>
            ))
          )}
          <Box marginTop={1}>
            <Text color={palette.muted}>
              ↑↓ 선택 · Enter 보기 · w 글쓰기{hasMore ? ' · n 다음 페이지' : ''} · p 첫 페이지
              {activeBoard.id === 'recruitment' && onOpenRecruitment ? ' · r 모집 필터' : ''} · Esc 게시판 목록
            </Text>
          </Box>
        </Box>
      )}

      {mode === 'detail' && detail && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.accent} bold>{detail.title}</Text>
          <Text color={palette.muted}>
            작성자: {detail.authorNickname} · 작성: {detail.createdAt}
          </Text>
          <Box marginTop={1}>
            <Text color={palette.text}>{detail.body}</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={palette.accent} bold>댓글 ({detail.comments.length})</Text>
            {detail.comments.length === 0 ? (
              <Text color={palette.muted}>등록된 댓글이 없어요.</Text>
            ) : (
              detail.comments.map((comment, idx) => (
                <Text key={comment.id} color={idx === commentIndex ? palette.accent : palette.text}>
                  {idx === commentIndex ? '› ' : '  '}
                  {comment.authorNickname}: {comment.body}
                </Text>
              ))
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={palette.muted}>
              c 댓글 · e 글 수정 · d 글 삭제 · x 선택 댓글 삭제 · Esc 목록으로
            </Text>
          </Box>
        </Box>
      )}

      {(mode === 'createPost' || mode === 'editPost') && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.accent} bold>{mode === 'createPost' ? '새 게시글 작성' : '게시글 수정'}</Text>
          <Text color={formField === 'title' ? palette.accent : palette.text}>
            제목: {draftTitle}{formField === 'title' ? '_' : ''}
          </Text>
          <Text color={formField === 'body' ? palette.accent : palette.text}>
            본문: {draftBody}{formField === 'body' ? '_' : ''}
          </Text>
          <Text color={palette.muted}>Tab 필드 전환 · Ctrl+S 저장 · Esc 취소</Text>
        </Box>
      )}

      {mode === 'createComment' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={palette.accent} bold>댓글 작성</Text>
          <Text color={palette.text}>내용: {draftComment}_</Text>
          <Text color={palette.muted}>Ctrl+S 저장 · Esc 취소</Text>
        </Box>
      )}

      {statusMessage ? <Text color={palette.success}>{statusMessage}</Text> : null}
      {errorMessage ? <Text color={palette.error}>{errorMessage}</Text> : null}
    </Box>
  );
}
