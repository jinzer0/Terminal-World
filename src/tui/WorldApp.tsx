import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { AccountLifecycleService } from '../core/account-lifecycle-service.js';
import type { AuthService, MemberRecord } from '../core/auth-service.js';
import type { BoardService } from '../core/board-service.js';
import type { ChatService } from '../core/chat-service.js';
import type { DiscoveryService } from '../core/discovery-service.js';
import type { FocusService } from '../core/focus-service.js';
import type { GuestbookService } from '../core/guestbook-service.js';
import type { IntegrationAuthService } from '../core/integration-auth-service.js';
import type { ModerationService } from '../core/moderation-service.js';
import type { NoticeService } from '../core/notice-service.js';
import type { PresenceService } from '../core/presence-service.js';
import type { ProfileService } from '../core/profile-service.js';
import type { RealtimeHub } from '../core/realtime-hub.js';
import type { RecruitmentService } from '../core/recruitment-service.js';
import type { ServiceTheme } from '../service/validation.js';
import { getThemePalette } from './components/Themes.js';
import { AccountSecurityScreen } from './screens/AccountSecurityScreen.js';
import { AdminPanelScreen } from './screens/AdminPanelScreen.js';
import {
  AuthGateScreen,
  type AccountRecoveryInput,
} from './screens/AuthGateScreen.js';
import { CafeScreen } from './screens/CafeScreen.js';
import { FocusScreen } from './screens/FocusScreen.js';
import { LivingRoomScreen } from './screens/LivingRoomScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { OssDiscoveryScreen } from './screens/OssDiscoveryScreen.js';
import { PersonalSpaceScreen, type SpaceViewer } from './screens/PersonalSpaceScreen.js';
import { RecruitmentScreen } from './screens/RecruitmentScreen.js';
import { RoofTopScreen } from './screens/RoofTopScreen.js';
import {
  buildWorldMap,
  computeCameraViewport,
  getAdjacentSpace,
  moveAvatar,
  PUBLIC_SPACES,
  renderWorldMapLines,
  type CameraViewport,
  type RemoteAvatar,
  type WorldCounts,
} from './world-map.js';

export type WorldViewMode = 'map' | 'list';

export type ActiveWorldScreen =
  | { kind: 'world' }
  | { kind: 'space'; spaceId: string }
  | { kind: 'archived-guestbook' }
  | { kind: 'account' }
  | { kind: 'admin' };

export interface WorldScreenContext {
  screen: Exclude<ActiveWorldScreen, { kind: 'world' }>;
  viewer: SpaceViewer;
  width: number;
  height: number;
  onBack: () => void;
}

export interface ListEntryItem {
  id: string;
  label: string;
  description: string;
  target: ActiveWorldScreen;
}

export interface WorldAppProps {
  authService: AuthService;
  profileService: ProfileService;
  guestbookService: GuestbookService;
  boardService?: BoardService;
  recruitmentService?: RecruitmentService;
  noticeService?: NoticeService;
  presenceService?: PresenceService;
  chatService?: ChatService;
  focusService?: FocusService;
  accountLifecycleService?: AccountLifecycleService;
  moderationService?: ModerationService;
  integrationAuthService?: IntegrationAuthService;
  discoveryService?: DiscoveryService;
  realtimeHub?: RealtimeHub;
  sessionId?: string | null;
  initialViewer?: SpaceViewer | null;
  theme?: ServiceTheme;
  onlineAvatars?: readonly RemoteAvatar[];
  worldCounts?: WorldCounts;
  onlineSummary?: { onlineCount: number; awayCount: number; guestCount: number };
  /**
   * Optional custom screen slot so Coordinator can plug in Wave 1/2 screens
   * (`space:lobby`, `space:focus`, `space:cafe`, `space:rooftop`, `space:living`,
   * `space:oss`, `account`, `admin`). Return `null`/`undefined` to use built-in fallback.
   */
  renderScreen?: (context: WorldScreenContext) => ReactNode;
  onAuthenticated?: (member: MemberRecord) => void;
  onGuestEnter?: () => void;
  onRecover?: (input: AccountRecoveryInput) => void;
  onEnterSpace?: (spaceId: string) => void;
  onMoveAvatar?: (x: number, y: number) => void;
  onSessionOpened?: (sessionId: string | null) => void;
  onExit?: () => void;
}

export function resolveResponsiveDefaultMode(columns: number, rows: number): WorldViewMode {
  return columns >= 120 && rows >= 30 ? 'map' : 'list';
}

export function WorldApp({
  authService,
  profileService,
  guestbookService,
  boardService,
  recruitmentService,
  noticeService,
  presenceService,
  chatService,
  focusService,
  accountLifecycleService,
  moderationService,
  integrationAuthService,
  discoveryService,
  realtimeHub,
  sessionId = null,
  initialViewer = null,
  theme = 'dark',
  onlineAvatars = [],
  worldCounts,
  onlineSummary,
  renderScreen,
  onAuthenticated,
  onGuestEnter,
  onRecover,
  onEnterSpace,
  onMoveAvatar,
  onSessionOpened,
  onExit,
}: WorldAppProps) {
  const { columns, rows } = useWindowSize();
  const palette = getThemePalette(theme);

  const [viewer, setViewer] = useState<SpaceViewer | null>(initialViewer);
  const [screen, setScreen] = useState<ActiveWorldScreen>({ kind: 'world' });
  const [presenceTick, setPresenceTick] = useState(0);
  const [managedSessionId, setManagedSessionId] = useState<string | null>(null);
  const effectiveSessionId = sessionId ?? managedSessionId;

  // Open, heartbeat, and cleanly close a persistent SSH user_session when presenceService is wired
  useEffect(() => {
    if (!presenceService || sessionId || !viewer) return;
    const opened = presenceService.openSession({
      memberId: viewer.isGuest ? null : viewer.memberId,
      isGuest: viewer.isGuest,
      channel: 'ssh',
    });
    setManagedSessionId(opened.id);
    onSessionOpened?.(opened.id);

    const timer = setInterval(() => {
      try {
        presenceService.heartbeat(opened.id);
      } catch {
        // Ignore if session already closed
      }
    }, 15_000);
    timer.unref?.();

    return () => {
      clearInterval(timer);
      try {
        presenceService.closeSession(opened.id, {
          mode: 'disconnect',
          reason: 'ssh_disconnect',
        });
      } catch {
        // Already closed
      }
      setManagedSessionId(null);
      onSessionOpened?.(null);
    };
  }, [presenceService, sessionId, viewer?.isGuest, viewer?.memberId]);

  useEffect(() => {
    if (!realtimeHub) return;
    return realtimeHub.subscribeMany(['presence.changed', 'avatar.moved', 'session.ended'], () => {
      setPresenceTick(t => t + 1);
    });
  }, [realtimeHub]);

  const liveOverview = useMemo(() => {
    if (!presenceService) return null;
    void presenceTick;
    return presenceService.getLobbyOverview();
  }, [presenceService, presenceTick]);

  const effectiveOnlineAvatars: readonly RemoteAvatar[] = useMemo(() => {
    if (onlineAvatars.length > 0 || !liveOverview) return onlineAvatars;
    return liveOverview.activeAvatars
      .filter(a => a.memberId !== null && a.nickname !== null && a.memberId !== viewer?.memberId)
      .map(a => ({
        sessionId: a.sessionId,
        memberId: a.memberId,
        nickname: a.nickname!,
        x: a.worldX,
        y: a.worldY,
        spaceId: a.spaceId,
        away: a.status === 'away',
      }));
  }, [onlineAvatars, liveOverview, viewer?.memberId]);

  const effectiveOnlineSummary = useMemo(() => {
    if (onlineSummary) return onlineSummary;
    if (!liveOverview) return undefined;
    return {
      onlineCount: liveOverview.onlineMembers.length,
      awayCount: liveOverview.awayMembers.length,
      guestCount: liveOverview.guestCount,
    };
  }, [onlineSummary, liveOverview]);

  const currentMemberRecord = useMemo(
    () => (viewer && !viewer.isGuest && viewer.memberId ? authService.getMemberById(viewer.memberId) : null),
    [authService, viewer],
  );
  const [viewMode, setViewMode] = useState<WorldViewMode>(() =>
    resolveResponsiveDefaultMode(columns, rows),
  );
  const prevTerminalBucketRef = useRef<'wide' | 'compact'>(
    columns >= 120 && rows >= 30 ? 'wide' : 'compact',
  );
  const [listCursor, setListCursor] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  const [statusNotice, setStatusNotice] = useState('');

  // Auto-fallback to list mode when terminal shrinks below 120x30, and restore map when grown back
  useEffect(() => {
    if (columns < 80 || rows < 24) return;
    const bucket: 'wide' | 'compact' = columns >= 120 && rows >= 30 ? 'wide' : 'compact';
    if (bucket !== prevTerminalBucketRef.current) {
      prevTerminalBucketRef.current = bucket;
      setViewMode(bucket === 'wide' ? 'map' : 'list');
    }
  }, [columns, rows]);

  const personalSpaces = useMemo(() => profileService.listPublicPersonalSpaces(), [
    profileService,
    viewer,
    screen,
  ]);
  const worldMap = useMemo(() => buildWorldMap(personalSpaces), [personalSpaces]);

  const [playerPos, setPlayerPos] = useState<{ x: number; y: number }>(() => worldMap.defaultSpawn);
  const viewportWidth = Math.max(20, columns - 4);
  const viewportHeight = Math.max(10, rows - 8);
  const [camera, setCamera] = useState<CameraViewport>(() =>
    computeCameraViewport(worldMap, worldMap.defaultSpawn, viewportWidth, viewportHeight),
  );

  useEffect(() => {
    setCamera(prev =>
      computeCameraViewport(worldMap, playerPos, viewportWidth, viewportHeight, prev),
    );
  }, [worldMap, playerPos, viewportWidth, viewportHeight]);

  const adjacent = useMemo(
    () => getAdjacentSpace(worldMap, playerPos.x, playerPos.y),
    [worldMap, playerPos],
  );

  const listItems: ListEntryItem[] = useMemo(() => {
    const items: ListEntryItem[] = PUBLIC_SPACES.map(pub => ({
      id: pub.id,
      label: `[공용] ${pub.title} (${pub.shortLabel})`,
      description: pub.description,
      target: { kind: 'space', spaceId: pub.id },
    }));

    if (viewer && !viewer.isGuest && viewer.memberId) {
      const mine = personalSpaces.find(ps => ps.memberId === viewer.memberId);
      if (mine) {
        items.push({
          id: `my:${mine.spaceId}`,
          label: `[내 터미널] @${mine.nickname} (${mine.colorTheme})`,
          description: mine.currentStatus || mine.introduction || '내 프로필 및 방명록 관리',
          target: { kind: 'space', spaceId: mine.spaceId },
        });
      }
    }

    for (const ps of personalSpaces) {
      if (viewer?.memberId && ps.memberId === viewer.memberId) continue;
      items.push({
        id: ps.spaceId,
        label: `[개인] @${ps.nickname} (${ps.colorTheme})`,
        description: ps.currentStatus || ps.introduction || '개인 터미널 공간',
        target: { kind: 'space', spaceId: ps.spaceId },
      });
    }

    items.push({
      id: 'archived-guestbook',
      label: '[보관] 탈퇴한 사용자의 공간',
      description: '탈퇴 회원의 공간에 남겨진 방명록 보관 목록 (읽기 전용)',
      target: { kind: 'archived-guestbook' },
    });

    return items;
  }, [personalSpaces, viewer]);

  useEffect(() => {
    setListCursor(c => Math.max(0, Math.min(c, Math.max(0, listItems.length - 1))));
  }, [listItems.length]);

  const enterTarget = (target: ActiveWorldScreen) => {
    setStatusNotice('');
    setScreen(target);
    if (target.kind === 'space') {
      if (presenceService && effectiveSessionId) {
        try {
          presenceService.moveSpace(effectiveSessionId, target.spaceId);
        } catch {
          // Ignore stale session during local transitions
        }
      }
      onEnterSpace?.(target.spaceId);
    }
  };

  const handleBackToWorld = () => {
    setScreen({ kind: 'world' });
    setStatusNotice('');
    if (presenceService && effectiveSessionId) {
      try {
        presenceService.moveSpace(effectiveSessionId, 'space:lobby');
      } catch {
        // Ignore stale session during local transitions
      }
    }
    onEnterSpace?.('space:lobby');
  };

  const isTooSmall = columns < 80 || rows < 24;

  // World-level keyboard navigation (active only on world screen when terminal >= 80x24 and authenticated)
  useInput(
    (input, key) => {
      if (isTooSmall || !viewer || screen.kind !== 'world') return;

      if (key.ctrl && input === 'c') {
        onExit?.();
        return;
      }

      if (input === 'm' || input === 'M') {
        setViewMode(prev => (prev === 'map' ? 'list' : 'map'));
        return;
      }

      if (input === '?') {
        setHelpVisible(prev => !prev);
        return;
      }

      if (input === 'a' || input === 'A') {
        if (viewer.isGuest) {
          setStatusNotice('계정/연동 관리는 로그인한 회원만 사용할 수 있습니다.');
          return;
        }
        enterTarget({ kind: 'account' });
        return;
      }

      if (input === 'g' || input === 'G') {
        if (viewer.role !== 'admin') {
          setStatusNotice('관리자 패널은 관리자 권한이 필요합니다.');
          return;
        }
        enterTarget({ kind: 'admin' });
        return;
      }

      if (viewMode === 'map') {
        let dx = 0;
        let dy = 0;
        if (key.upArrow || input === 'k') dy = -1;
        else if (key.downArrow || input === 'j') dy = 1;
        else if (key.leftArrow || input === 'h') dx = -1;
        else if (key.rightArrow || input === 'l') dx = 1;

        if (dx !== 0 || dy !== 0) {
          const moved = moveAvatar(worldMap, playerPos, dx, dy);
          if (moved.moved) {
            const nextPos = { x: moved.x, y: moved.y };
            setPlayerPos(nextPos);
            setCamera(prev =>
              computeCameraViewport(worldMap, nextPos, viewportWidth, viewportHeight, prev),
            );
            if (presenceService && effectiveSessionId) {
              try {
                presenceService.moveAvatar(effectiveSessionId, moved.x, moved.y);
              } catch {
                // Ignore stale session during local transitions
              }
            }
            onMoveAvatar?.(moved.x, moved.y);
          }
          return;
        }

        if (key.return && adjacent) {
          enterTarget({ kind: 'space', spaceId: adjacent.space.id });
          return;
        }
      } else {
        if (key.upArrow || input === 'k') {
          setListCursor(c => Math.max(0, c - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setListCursor(c => Math.min(Math.max(0, listItems.length - 1), c + 1));
          return;
        }
        if (key.return) {
          const item = listItems[listCursor];
          if (item) enterTarget(item.target);
          return;
        }
      }
    },
    { isActive: !isTooSmall && viewer !== null && screen.kind === 'world' },
  );

  // Fallback Escape/Ctrl+C handler for built-in placeholder public screens
  const hasCustomScreen = useMemo(() => {
    if (!viewer || screen.kind === 'world' || !renderScreen) return false;
    return renderScreen({
      screen,
      viewer,
      width: columns,
      height: rows,
      onBack: handleBackToWorld,
    });
  }, [viewer, screen, renderScreen, columns, rows]);

  const hasBuiltInWiredScreen = Boolean(
    (screen.kind === 'account' && accountLifecycleService && viewer && !viewer.isGuest && viewer.memberId) ||
      (screen.kind === 'admin' && moderationService && viewer && !viewer.isGuest && viewer.memberId) ||
      (screen.kind === 'space' &&
        ((screen.spaceId === 'space:lobby' && noticeService) ||
          (screen.spaceId === 'space:cafe' && boardService) ||
          (screen.spaceId === 'space:recruitment' && recruitmentService) ||
          (screen.spaceId === 'space:rooftop' && chatService) ||
          (screen.spaceId === 'space:focus' && focusService) ||
          (screen.spaceId === 'space:living' && presenceService) ||
          (screen.spaceId === 'space:oss' && discoveryService))),
  );

  const isFallbackPublicPlaceholder = Boolean(
    viewer &&
      !isTooSmall &&
      screen.kind !== 'world' &&
      !hasCustomScreen &&
      !hasBuiltInWiredScreen &&
      screen.kind !== 'archived-guestbook' &&
      !(screen.kind === 'space' && screen.spaceId.startsWith('space:member:')),
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        onExit?.();
        return;
      }
      if (key.escape) {
        handleBackToWorld();
      }
    },
    { isActive: isFallbackPublicPlaceholder },
  );

  // Preserve state hooks above; render resize overlay when < 80x24 without unmounting state!
  if (isTooSmall) {
    return (
      <Box
        flexDirection="column"
        width={columns}
        height={rows}
        backgroundColor={palette.background}
        padding={1}
      >
        <Text bold color={palette.error}>
          터미널 창을 80×24 이상으로 확대해 주세요
        </Text>
        <Text color={palette.text}>
          현재 크기: {columns}×{rows} (권장 120×30 · 최소 80×24)
        </Text>
        <Text color={palette.muted}>
          작성 중인 초안과 현재 화면 상태는 유지됩니다 · Ctrl+C 종료
        </Text>
      </Box>
    );
  }

  if (!viewer) {
    return (
      <AuthGateScreen
        authService={authService}
        width={columns}
        height={rows}
        theme={palette}
        onAuthenticated={member => {
          const nextViewer: SpaceViewer = {
            isGuest: false,
            memberId: member.id,
            nickname: member.nickname,
            role: member.role,
          };
          setViewer(nextViewer);
          onAuthenticated?.(member);
        }}
        onGuestEnter={() => {
          setViewer({
            isGuest: true,
            memberId: null,
            nickname: '게스트',
            role: 'guest',
          });
          onGuestEnter?.();
        }}
        onRecover={
          onRecover ??
          (accountLifecycleService
            ? input => {
                accountLifecycleService.recoverAccount({
                  loginId: input.loginId,
                  recoveryCode: input.recoveryCode,
                  newPassword: input.newPassword,
                });
              }
            : undefined)
        }
        onExit={onExit}
      />
    );
  }

  if (screen.kind !== 'world') {
    if (hasCustomScreen) {
      return <>{hasCustomScreen}</>;
    }

    if (screen.kind === 'archived-guestbook') {
      return (
        <PersonalSpaceScreen
          profileService={profileService}
          guestbookService={guestbookService}
          viewer={viewer}
          mode="archived"
          width={columns}
          height={rows}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId.startsWith('space:member:')) {
      return (
        <PersonalSpaceScreen
          profileService={profileService}
          guestbookService={guestbookService}
          viewer={viewer}
          spaceIdentifier={screen.spaceId}
          mode="space"
          width={columns}
          height={rows}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:lobby' && noticeService) {
      return (
        <LobbyScreen
          noticeService={noticeService}
          currentMember={currentMemberRecord}
          presence={
            liveOverview
              ? {
                  onlineMembers: liveOverview.onlineMembers.map(m => ({
                    memberId: m.memberId,
                    nickname: m.nickname,
                  })),
                  awayMembers: liveOverview.awayMembers.map(m => ({
                    memberId: m.memberId,
                    nickname: m.nickname,
                  })),
                  guestCount: liveOverview.guestCount,
                }
              : undefined
          }
          theme={theme}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:cafe' && boardService) {
      return (
        <CafeScreen
          boardService={boardService}
          currentMember={currentMemberRecord}
          theme={theme}
          onBack={handleBackToWorld}
          onOpenRecruitment={
            recruitmentService
              ? () => enterTarget({ kind: 'space', spaceId: 'space:recruitment' })
              : undefined
          }
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:recruitment' && recruitmentService) {
      return (
        <RecruitmentScreen
          recruitmentService={recruitmentService}
          currentMember={currentMemberRecord}
          theme={theme}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:rooftop' && chatService) {
      return (
        <RoofTopScreen
          chatService={chatService}
          hub={realtimeHub}
          actor={{
            memberId: viewer.memberId,
            nickname: viewer.nickname,
            role: viewer.role,
          }}
          width={columns}
          height={rows}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:focus' && focusService) {
      return (
        <FocusScreen
          focusService={focusService}
          hub={realtimeHub}
          actor={{
            memberId: viewer.memberId,
            nickname: viewer.nickname,
            isGuest: viewer.isGuest,
            sessionId: effectiveSessionId,
          }}
          width={columns}
          height={rows}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:living' && presenceService) {
      return (
        <LivingRoomScreen
          presenceService={presenceService}
          hub={realtimeHub}
          actor={{
            memberId: viewer.memberId,
            nickname: viewer.nickname,
            isGuest: viewer.isGuest,
            sessionId: effectiveSessionId,
          }}
          width={columns}
          height={rows}
          onReturnToLobby={handleBackToWorld}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'account' && accountLifecycleService && !viewer.isGuest && viewer.memberId) {
      const memberId = viewer.memberId;
      return (
        <AccountSecurityScreen
          lifecycleService={accountLifecycleService}
          moderationService={moderationService}
          memberId={memberId}
          nickname={viewer.nickname}
          sessionId={effectiveSessionId}
          width={columns}
          height={rows}
          theme={theme}
          onListGrants={
            integrationAuthService
              ? () => integrationAuthService.listGrants(memberId)
              : undefined
          }
          onApproveCode={
            integrationAuthService && currentMemberRecord
              ? (code, password) => {
                  const res = integrationAuthService.approveCode({
                    code,
                    loginId: currentMemberRecord.loginId,
                    password,
                  });
                  return {
                    label: res.grant.label,
                    scopes: res.grant.scopes,
                    expiresAt: res.grant.expiresAt,
                  };
                }
              : undefined
          }
          onRevokeGrant={
            integrationAuthService
              ? grantId => {
                  integrationAuthService.revokeGrant(memberId, grantId, 'user_revoked_tui');
                }
              : undefined
          }
          onWithdrawn={() => {
            setViewer(null);
            setScreen({ kind: 'world' });
          }}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'admin' && moderationService && !viewer.isGuest && viewer.memberId) {
      return (
        <AdminPanelScreen
          moderationService={moderationService}
          adminMemberId={viewer.memberId}
          adminNickname={viewer.nickname}
          width={columns}
          height={rows}
          theme={theme}
          onBack={handleBackToWorld}
        />
      );
    }

    if (screen.kind === 'space' && screen.spaceId === 'space:oss' && discoveryService) {
      return (
        <OssDiscoveryScreen
          discoveryService={discoveryService}
          theme={theme}
          width={columns}
          height={rows}
          onBack={handleBackToWorld}
        />
      );
    }

    const pub = PUBLIC_SPACES.find(s => screen.kind === 'space' && s.id === screen.spaceId);
    return (
      <Box
        flexDirection="column"
        width={columns}
        height={rows}
        backgroundColor={palette.background}
        padding={2}
      >
        <Text bold color={palette.accent}>
          {screen.kind === 'account'
            ? '계정 · 보안 · 연동 관리'
            : screen.kind === 'admin'
              ? '관리자 패널'
              : `${pub?.title ?? '공간'} (${pub?.shortLabel ?? ''})`}
        </Text>
        <Box marginTop={1} marginBottom={1}>
          <Text color={palette.text}>
            {pub?.description ?? '해당 공간 어댑터가 연결되면 상세 화면이 표시됩니다.'}
          </Text>
        </Box>
        <Text color={palette.muted}>Esc를 누르면 월드로 복귀합니다.</Text>
      </Box>
    );
  }

  const mapLines =
    viewMode === 'map'
      ? renderWorldMapLines(worldMap, {
          playerX: playerPos.x,
          playerY: playerPos.y,
          playerNickname: viewer.nickname,
          remoteAvatars: effectiveOnlineAvatars,
          camera,
          counts: worldCounts,
        })
      : [];

  const summaryText = effectiveOnlineSummary
    ? `온라인(${effectiveOnlineSummary.onlineCount}) · 자리비움(${effectiveOnlineSummary.awayCount}) · 게스트(${effectiveOnlineSummary.guestCount})`
    : `접속 아바타(${effectiveOnlineAvatars.length + 1})`;

  const hudLine = adjacent
    ? `인접 공간: [${adjacent.space.label}] ${adjacent.space.title} · ${adjacent.space.description} · Enter로 입장`
    : '이동 중 · 건물 문([문]) 또는 1타일 인접 시 Enter로 입장';

  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      backgroundColor={palette.background}
    >
      <Box justifyContent="space-between" paddingX={1}>
        <Text bold color={palette.accent}>
          TERMINAL WORLD · {viewMode === 'map' ? '2.5D MAP' : '목록 탐색'} · @{viewer.nickname}
          {viewer.isGuest ? ' (게스트)' : ''}
        </Text>
        <Text color={palette.muted}>m: {viewMode === 'map' ? '목록 전환' : '2.5D 맵'} · ?: 도움말</Text>
      </Box>

      {helpVisible ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={2}
          paddingY={1}
          flexGrow={1}
        >
          <Text bold color={palette.accent}>
            조작 도움말
          </Text>
          <Text color={palette.text}>• 방향키 / hjkl: 아바타 1타일 이동 또는 목록 선택</Text>
          <Text color={palette.text}>• Enter: 인접 공간 / 선택 공간 진입 (Esc 복귀)</Text>
          <Text color={palette.text}>• m: 2.5D 아바타 맵 ↔ 목록 탐색 전환 (80×24는 목록 기본)</Text>
          <Text color={palette.text}>• a: 계정/연동 관리 · g: 관리자 패널 · Ctrl+C: 종료</Text>
          <Box marginTop={1}>
            <Text color={palette.muted}>? 를 다시 누르면 닫힙니다.</Text>
          </Box>
        </Box>
      ) : viewMode === 'map' ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.border}
          width={columns}
          height={rows - 4}
          paddingX={1}
          overflow="hidden"
        >
          {mapLines.map((line, idx) => (
            <Text key={idx} color={palette.text} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.border}
          width={columns}
          height={rows - 4}
          paddingX={1}
        >
          <Text color={palette.muted}>공간 목록 (↑/↓ 선택 · Enter 입장 · m 2.5D 맵 전환)</Text>
          {listItems
            .slice(Math.max(0, listCursor - 6), Math.max(0, listCursor - 6) + Math.max(4, rows - 8))
            .map((item, idx) => {
              const actualIdx = Math.max(0, listCursor - 6) + idx;
              const selected = actualIdx === listCursor;
              return (
                <Text
                  key={item.id}
                  color={selected ? palette.accent : palette.text}
                  backgroundColor={selected ? palette.selected : undefined}
                  wrap="truncate-end"
                >
                  {selected ? '› ' : '  '}
                  {item.label} — {item.description}
                </Text>
              );
            })}
        </Box>
      )}

      <Box flexDirection="column" paddingX={1}>
        <Text color={adjacent ? palette.accent : palette.muted} wrap="truncate-end">
          {viewMode === 'map'
            ? `${hudLine} · 좌표(${playerPos.x},${playerPos.y})`
            : listItems[listCursor]?.description ?? '공간을 선택하세요'}
        </Text>
        <Text color={statusNotice ? palette.warning : palette.text} wrap="truncate-end">
          {statusNotice || `${summaryText} │ 방향키 이동 · Enter 진입 · m 목록 · a 계정 · Ctrl+C 종료`}
        </Text>
      </Box>
    </Box>
  );
}
