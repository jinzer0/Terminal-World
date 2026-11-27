import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  FocusHistoryResult,
  FocusRankingEntry,
  FocusService,
  FocusStatusSummary,
} from '../../core/focus-service.js';
import { toServiceError } from '../../core/errors.js';
import type { RealtimeHub } from '../../core/realtime-hub.js';

export type FocusTab = 'status' | 'history' | 'ranking';

export interface FocusActor {
  memberId: string | null;
  nickname: string | null;
  isGuest: boolean;
  sessionId: string | null;
}

export interface FocusScreenProps {
  focusService: FocusService;
  hub?: RealtimeHub;
  actor: FocusActor;
  width?: number;
  height?: number;
  active?: boolean;
  onBack?: () => void;
}

export function formatDurationHms(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

export function FocusScreen({
  focusService,
  hub,
  actor,
  width = 80,
  height = 22,
  active = true,
  onBack,
}: FocusScreenProps) {
  const [tab, setTab] = useState<FocusTab>('status');
  const [status, setStatus] = useState<FocusStatusSummary | null>(() =>
    actor.memberId && !actor.isGuest ? focusService.getFocusStatus(actor.memberId) : null,
  );
  const [history, setHistory] = useState<FocusHistoryResult | null>(() =>
    actor.memberId && !actor.isGuest ? focusService.getFocusHistory(actor.memberId, actor.memberId) : null,
  );
  const [ranking, setRanking] = useState<FocusRankingEntry[]>(() =>
    focusService.getDailyRanking(),
  );
  const [notice, setNotice] = useState('');

  const isGuest = actor.isGuest || !actor.memberId;

  const refresh = useCallback(() => {
    try {
      setRanking(focusService.getDailyRanking());
      if (actor.memberId && !actor.isGuest) {
        setStatus(focusService.getFocusStatus(actor.memberId));
        setHistory(focusService.getFocusHistory(actor.memberId, actor.memberId));
      } else {
        setStatus(null);
        setHistory(null);
      }
    } catch (error) {
      setNotice(toServiceError(error).message);
    }
  }, [actor.isGuest, actor.memberId, focusService]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!hub) return;
    return hub.subscribe('focus.changed', () => {
      refresh();
    });
  }, [hub, refresh]);

  // Update elapsed HH:MM:SS display every second while an active focus session is running.
  useEffect(() => {
    if (!status?.activeSession) return;
    const timer = setInterval(() => {
      refresh();
    }, 1000);
    return () => clearInterval(timer);
  }, [refresh, status?.activeSession]);

  const toggleFocus = useCallback(() => {
    if (isGuest || !actor.memberId) {
      setNotice('게스트는 집중 추적을 시작할 수 없어요. 일별 랭킹을 확인해 보세요.');
      return;
    }
    try {
      if (status?.activeSession) {
        const stopped = focusService.stopFocus(actor.memberId);
        setNotice(`집중 추적을 중단했어요 (${formatDurationHms(stopped.countedSeconds ?? 0)} 기록).`);
      } else {
        if (!actor.sessionId) {
          setNotice('지속 연결 세션이 없어 집중 추적을 시작할 수 없어요.');
          return;
        }
        focusService.startFocus(actor.memberId, actor.sessionId);
        setNotice('집중 추적을 시작했어요 (목표 시간 없음).');
      }
      refresh();
    } catch (error) {
      setNotice(toServiceError(error).message);
    }
  }, [actor.memberId, actor.sessionId, focusService, isGuest, refresh, status?.activeSession]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onBack?.();
        return;
      }
      if (key.tab) {
        const order: FocusTab[] = ['status', 'history', 'ranking'];
        const nextIndex = (order.indexOf(tab) + (key.shift ? order.length - 1 : 1)) % order.length;
        setTab(order[nextIndex]!);
        return;
      }
      if (input === '1') {
        setTab('status');
        return;
      }
      if (input === '2') {
        setTab('history');
        return;
      }
      if (input === '3') {
        setTab('ranking');
        return;
      }
      if (tab === 'status' && (input === 's' || key.return)) {
        toggleFocus();
      }
    },
    { isActive: active },
  );

  const bodyHeight = Math.max(4, height - 7);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">Focus Room · 집중 시간 & 일별 랭킹 (KST)</Text>
        <Text dimColor>{actor.nickname ? `@${actor.nickname}` : '게스트'}</Text>
      </Box>

      <Box gap={2} marginTop={1}>
        <Text bold={tab === 'status'} color={tab === 'status' ? 'yellow' : 'gray'}>[1] 상태/타이머</Text>
        <Text bold={tab === 'history'} color={tab === 'history' ? 'yellow' : 'gray'}>[2] 내 집중 기록</Text>
        <Text bold={tab === 'ranking'} color={tab === 'ranking' ? 'yellow' : 'gray'}>[3] 일별 랭킹</Text>
      </Box>

      <Box flexDirection="column" height={bodyHeight} marginY={1} overflow="hidden">
        {tab === 'status' ? (
          isGuest || !status ? (
            <Box flexDirection="column">
              <Text>게스트는 집중 추적을 사용할 수 없어요.</Text>
              <Text dimColor>[3] 일별 랭킹 탭에서 공개 랭킹을 확인할 수 있어요.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text>
                상태: {status.activeSession ? <Text color="green" bold>집중 중</Text> : <Text dimColor>대기 중</Text>}
              </Text>
              <Text>현재 구간 경과: {formatDurationHms(status.currentElapsedSeconds)}</Text>
              <Text>오늘 누적 ({status.todayKstDate}): {formatDurationHms(status.todayTotalSeconds)}</Text>
              <Text dimColor>목표 시간 없음 · 시작 세션이 끊기면 마지막 확인 시각까지 자동 저장</Text>
            </Box>
          )
        ) : null}

        {tab === 'history' ? (
          isGuest || !history ? (
            <Text>본인 로그인 계정만 상세 집중 기록을 조회할 수 있어요.</Text>
          ) : history.sessions.length === 0 ? (
            <Text dimColor>기록된 집중 구간이 아직 없어요.</Text>
          ) : (
            <Box flexDirection="column">
              {history.sessions.slice(0, bodyHeight).map((item) => (
                <Text key={item.id} wrap="truncate-end">
                  {item.startedAt} ~ {item.endedAt ?? '진행 중'} ({item.countedSeconds !== null ? formatDurationHms(item.countedSeconds) : '측정 중'})
                </Text>
              ))}
            </Box>
          )
        ) : null}

        {tab === 'ranking' ? (
          ranking.length === 0 ? (
            <Text dimColor>오늘 등록된 집중 랭킹이 아직 없어요.</Text>
          ) : (
            <Box flexDirection="column">
              {ranking.slice(0, bodyHeight).map((entry, index) => (
                <Text key={`${entry.rank}-${entry.nickname}-${index}`} wrap="truncate-end">
                  #{entry.rank} @{entry.nickname} — {formatDurationHms(entry.totalSeconds)}
                </Text>
              ))}
            </Box>
          )
        ) : null}
      </Box>

      <Text dimColor>
        {tab === 'status' && !isGuest
          ? 's/Enter 시작·중단 · Tab/1-3 탭 이동 · Esc 복귀'
          : 'Tab/1-3 탭 이동 · Esc 복귀'}
      </Text>
      {notice ? <Text color="yellow" wrap="truncate-end">{notice}</Text> : null}
    </Box>
  );
}
