import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { toServiceError } from '../../core/errors.js';
import type {
  LobbyOverview,
  MemberPresenceSummary,
  PresenceService,
} from '../../core/presence-service.js';
import { DEFAULT_SPACE_ID } from '../../core/presence-service.js';
import type { RealtimeHub } from '../../core/realtime-hub.js';

export interface LivingRoomActor {
  memberId: string | null;
  nickname: string | null;
  isGuest: boolean;
  sessionId: string | null;
}

export interface LivingRoomScreenProps {
  presenceService: PresenceService;
  hub?: RealtimeHub;
  actor: LivingRoomActor;
  width?: number;
  height?: number;
  active?: boolean;
  onReturnToLobby?: () => void;
  onBack?: () => void;
}

function presenceLabel(status: MemberPresenceSummary['status']): string {
  switch (status) {
    case 'online':
      return '온라인';
    case 'away':
      return '자리 비움';
    case 'offline':
      return '오프라인';
  }
}

export function LivingRoomScreen({
  presenceService,
  hub,
  actor,
  width = 80,
  height = 22,
  active = true,
  onReturnToLobby,
  onBack,
}: LivingRoomScreenProps) {
  const [myPresence, setMyPresence] = useState<MemberPresenceSummary | null>(() =>
    actor.memberId && !actor.isGuest ? presenceService.getMemberPresence(actor.memberId) : null,
  );
  const [overview, setOverview] = useState<LobbyOverview>(() =>
    presenceService.getLobbyOverview(),
  );
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    try {
      setOverview(presenceService.getLobbyOverview());
      if (actor.memberId && !actor.isGuest) {
        setMyPresence(presenceService.getMemberPresence(actor.memberId));
      } else {
        setMyPresence(null);
      }
    } catch (error) {
      setNotice(toServiceError(error).message);
    }
  }, [actor.isGuest, actor.memberId, presenceService]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hub) return;
    return hub.subscribeMany(['presence.changed', 'session.ended'], () => {
      refresh();
    });
  }, [hub, refresh]);

  const leaveLivingRoom = useCallback(() => {
    if (onReturnToLobby) {
      onReturnToLobby();
      return;
    }
    if (actor.sessionId) {
      try {
        presenceService.moveSpace(actor.sessionId, DEFAULT_SPACE_ID);
      } catch (error) {
        setNotice(toServiceError(error).message);
        return;
      }
    }
    onBack?.();
  }, [actor.sessionId, onBack, onReturnToLobby, presenceService]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack?.();
        return;
      }
      if (key.return || input === 'l') {
        leaveLivingRoom();
      }
    },
    { isActive: active },
  );

  const listHeight = Math.max(3, height - 11);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Living Room · 자리 비움 공간</Text>
        <Text dimColor>{actor.nickname ? `@${actor.nickname}` : '게스트'}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text>
          현재 세션이 Living Room에 머무르면 자리 비움으로 표시돼요.
        </Text>
        <Text dimColor>
          다중 세션 사용 시 모든 활성 세션이 Living Room에 있을 때만 자리 비움, 하나라도 밖이면 온라인이에요.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {myPresence ? (
          <Text>
            내 통합 상태: <Text bold color={myPresence.status === 'away' ? 'yellow' : 'green'}>{presenceLabel(myPresence.status)}</Text> (활성 세션 {myPresence.activeSessionCount}개)
          </Text>
        ) : (
          <Text dimColor>게스트로 둘러보는 중이에요.</Text>
        )}
        <Text>
          전체 접속 현황: 온라인 {overview.onlineCount}명 · 자리 비움 {overview.awayCount}명 · 게스트 {overview.guestCount}명
        </Text>
      </Box>

      <Box flexDirection="column" height={listHeight} marginY={1} overflow="hidden">
        {overview.members.length === 0 ? (
          <Text dimColor>현재 접속 중인 회원이 없어요.</Text>
        ) : (
          overview.members.slice(0, listHeight).map((member) => (
            <Text key={member.memberId} wrap="truncate-end">
              @{member.nickname} — {presenceLabel(member.status)} (세션 {member.activeSessionCount})
            </Text>
          ))
        )}
      </Box>

      <Text dimColor>Enter/l Lobby로 이동(자리 비움 해제) · Esc 복귀</Text>
      {notice ? <Text color="yellow" wrap="truncate-end">{notice}</Text> : null}
    </Box>
  );
}
