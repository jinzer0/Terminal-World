import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ChatMessageRecord, ChatService } from '../../core/chat-service.js';
import { KST_OFFSET_MS } from '../../core/clock.js';
import { generateId } from '../../core/crypto.js';
import { toServiceError } from '../../core/errors.js';
import type { RealtimeHub } from '../../core/realtime-hub.js';

export interface RoofTopActor {
  memberId: string | null;
  nickname: string | null;
  role: 'member' | 'admin' | 'guest';
}

export interface RoofTopScreenProps {
  chatService: ChatService;
  hub?: RealtimeHub;
  actor: RoofTopActor;
  width?: number;
  height?: number;
  active?: boolean;
  onBack?: () => void;
  onReportMessage?: (messageId: string, authorNickname: string) => void;
}

function formatKstHm(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function RoofTopScreen({
  chatService,
  hub,
  actor,
  width = 80,
  height = 22,
  active = true,
  onBack,
  onReportMessage,
}: RoofTopScreenProps) {
  const [messages, setMessages] = useState<ChatMessageRecord[]>(() =>
    chatService.listRecentMessages(),
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(() =>
    Math.max(0, chatService.listRecentMessages().length - 1),
  );
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');
  const pendingKeyRef = useRef<string | null>(null);

  const isGuest = actor.role === 'guest' || !actor.memberId;
  const isAdmin = actor.role === 'admin' && Boolean(actor.memberId);

  const reloadMessages = useCallback(() => {
    const next = chatService.listRecentMessages();
    setMessages(next);
    setSelectedIndex((prev) => Math.max(0, Math.min(prev, Math.max(0, next.length - 1))));
  }, [chatService]);

  useEffect(() => {
    reloadMessages();
  }, [reloadMessages]);

  useEffect(() => {
    if (!hub) return;
    const unsubMsg = hub.subscribe('chat.message', (event) => {
      const p = event.payload;
      setMessages((prev) => {
        if (prev.some((m) => m.id === p.id)) return prev;
        const next: ChatMessageRecord[] = [
          ...prev,
          {
            id: p.id,
            roomId: p.roomId,
            authorMemberId: p.authorMemberId,
            authorNickname: p.authorNickname,
            body: p.body,
            sentAt: p.sentAt,
            expiresAt: p.expiresAt,
            deletedAt: null,
          },
        ].slice(-100);
        setSelectedIndex(Math.max(0, next.length - 1));
        return next;
      });
    });

    const unsubDel = hub.subscribe('chat.deleted', (event) => {
      const deletedId = event.payload.id;
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== deletedId);
        setSelectedIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, next.length - 1))));
        return next;
      });
    });

    return () => {
      unsubMsg();
      unsubDel();
    };
  }, [hub]);

  const submitMessage = useCallback(() => {
    if (isGuest || !actor.memberId) {
      setNotice('게스트는 RoofTop 채팅을 보낼 수 없어요.');
      return;
    }
    const idempotencyKey = pendingKeyRef.current ?? generateId();
    pendingKeyRef.current = idempotencyKey;
    try {
      const sent = chatService.sendMessage({
        memberId: actor.memberId,
        body: draft,
        idempotencyKey,
      });
      pendingKeyRef.current = null;
      setDraft('');
      setComposing(false);
      setNotice(sent.deduplicated ? '중복 전송이 방지되었어요.' : '');
      reloadMessages();
    } catch (error) {
      const err = toServiceError(error);
      setNotice(`${err.message} (재전송 시 동일 키로 중복 방지)`);
    }
  }, [actor.memberId, chatService, draft, isGuest, reloadMessages]);

  useInput(
    (input, key) => {
      if (confirmDeleteId) {
        if (key.return || input === 'y' || input === 'Y') {
          if (actor.memberId && isAdmin) {
            try {
              chatService.deleteMessage(actor.memberId, confirmDeleteId, '관리자 화면 삭제');
              setNotice('메시지를 삭제했어요.');
            } catch (error) {
              setNotice(toServiceError(error).message);
            }
          }
          setConfirmDeleteId(null);
          return;
        }
        if (key.escape || input === 'n' || input === 'N') {
          setConfirmDeleteId(null);
          setNotice('삭제를 취소했어요.');
        }
        return;
      }

      if (composing) {
        if (key.escape) {
          pendingKeyRef.current = null;
          setComposing(false);
          setDraft('');
          setNotice('');
          return;
        }
        if (key.return) {
          submitMessage();
          return;
        }
        if (key.backspace || key.delete) {
          setDraft((prev) => {
            const parts = Array.from(prev);
            parts.pop();
            return parts.join('');
          });
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab) {
          setDraft((prev) => prev + input);
          setNotice('');
        }
        return;
      }

      if (key.escape) {
        onBack?.();
        return;
      }
      if (key.upArrow || input === 'k') {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setSelectedIndex((prev) => Math.min(Math.max(0, messages.length - 1), prev + 1));
        return;
      }
      if (key.pageUp) {
        setSelectedIndex((prev) => Math.max(0, prev - 10));
        return;
      }
      if (key.pageDown) {
        setSelectedIndex((prev) => Math.min(Math.max(0, messages.length - 1), prev + 10));
        return;
      }
      if (input === 'c' || input === 'i' || key.return) {
        if (isGuest) {
          setNotice('게스트는 읽기 전용이에요. 로그인 후 채팅할 수 있어요.');
          return;
        }
        setComposing(true);
        setNotice('');
        return;
      }
      if (input === 'd' && isAdmin) {
        const target = messages[selectedIndex];
        if (target) {
          setConfirmDeleteId(target.id);
        }
        return;
      }
      if (input === 'r' && !isGuest && onReportMessage) {
        const target = messages[selectedIndex];
        if (target) {
          onReportMessage(target.id, target.authorNickname);
        }
      }
    },
    { isActive: active },
  );

  const listHeight = Math.max(4, height - 6);
  const startOffset = Math.max(0, Math.min(selectedIndex - Math.floor(listHeight / 2), Math.max(0, messages.length - listHeight)));
  const visible = messages.slice(startOffset, startOffset + listHeight);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">RoofTop 실시간 채팅 (최근 100건 · 14일 보관)</Text>
        <Text dimColor>{actor.nickname ? `@${actor.nickname}` : '게스트(읽기 전용)'}</Text>
      </Box>

      <Box flexDirection="column" height={listHeight} marginY={1} overflow="hidden">
        {visible.length === 0 ? (
          <Text dimColor>아직 RoofTop 메시지가 없어요. 첫 인사를 남겨보세요.</Text>
        ) : (
          visible.map((msg, idx) => {
            const actualIndex = startOffset + idx;
            const selected = actualIndex === selectedIndex;
            return (
              <Text key={msg.id} color={selected ? 'yellow' : undefined} wrap="truncate-end">
                {selected ? '› ' : '  '}[{formatKstHm(msg.sentAt)}] @{msg.authorNickname}: {msg.body}
              </Text>
            );
          })
        )}
      </Box>

      {confirmDeleteId ? (
        <Text color="red">선택한 메시지를 삭제할까요? [Enter/y] 확인 · [Esc/n] 취소</Text>
      ) : composing ? (
        <Box flexDirection="column">
          <Text color="green">입력 중 (Enter 전송 · Esc 취소): {draft}█</Text>
        </Box>
      ) : (
        <Text dimColor>
          {isGuest
            ? '↑↓ 스크롤 · Esc 복귀 · 게스트는 읽기 전용'
            : `↑↓ 선택 · Enter/c 작성${isAdmin ? ' · d 삭제' : ''}${onReportMessage ? ' · r 신고' : ''} · Esc 복귀`}
        </Text>
      )}

      {notice ? <Text color="yellow" wrap="truncate-end">{notice}</Text> : null}
    </Box>
  );
}
