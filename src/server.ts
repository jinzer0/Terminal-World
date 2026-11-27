import { join } from 'node:path';
import {
  startHttpBridgeServer,
  type AccountLifecycleHooks,
  type DiscoveryHooks,
  type ModerationHooks,
  type RetentionHooks,
  type RunningHttpBridge,
} from './bridge/http-bridge.js';
import { AccountLifecycleService } from './core/account-lifecycle-service.js';
import { AuthService } from './core/auth-service.js';
import { BoardService } from './core/board-service.js';
import { ChatService } from './core/chat-service.js';
import { SystemClock, type Clock } from './core/clock.js';
import { DiscoveryService } from './core/discovery-service.js';
import { FocusService } from './core/focus-service.js';
import { GuestbookService } from './core/guestbook-service.js';
import { IntegrationAuthService } from './core/integration-auth-service.js';
import { ModerationService, type ReportReviewState } from './core/moderation-service.js';
import { NoticeService } from './core/notice-service.js';
import { PresenceService } from './core/presence-service.js';
import { ProfileService } from './core/profile-service.js';
import { RealtimeHub } from './core/realtime-hub.js';
import { RecruitmentService } from './core/recruitment-service.js';
import { RetentionService } from './core/retention-service.js';
import { startMcpHttpServer, type RunningMcpHttpServer } from './mcp/http-server.js';
import { startSshServer, type RunningSshServer, type SshServerOptions } from './ssh/ssh-server.js';
import { WorldDatabase } from './store/sqlite/database.js';

export interface WorldServerServices {
  worldDb: WorldDatabase;
  clock: Clock;
  realtimeHub: RealtimeHub;
  authService: AuthService;
  integrationAuthService: IntegrationAuthService;
  profileService: ProfileService;
  guestbookService: GuestbookService;
  boardService: BoardService;
  recruitmentService: RecruitmentService;
  noticeService: NoticeService;
  presenceService: PresenceService;
  chatService: ChatService;
  focusService: FocusService;
  accountLifecycle?: AccountLifecycleHooks;
  moderation?: ModerationHooks;
  retention?: RetentionHooks;
  discovery?: DiscoveryHooks;
}

export interface WorldServerOptions {
  dataDir?: string;
  dbPath?: string;
  tombstoneLogPath?: string;
  clock?: Clock;
  enableSsh?: boolean;
  sshHost?: string;
  sshPort?: number;
  mouse?: boolean;
  enableBridge?: boolean;
  bridgeHost?: string;
  bridgePort?: number;
  enableMcpHttp?: boolean;
  mcpHost?: string;
  mcpPort?: number;
  mcpPath?: string;
  worldAppProps?: SshServerOptions['worldAppProps'];
  renderSshSession?: SshServerOptions['renderSession'];
  accountLifecycle?: AccountLifecycleHooks;
  moderation?: ModerationHooks;
  retention?: RetentionHooks;
  discovery?: DiscoveryHooks;
  createHooks?: (services: WorldServerServices) => {
    accountLifecycle?: AccountLifecycleHooks;
    moderation?: ModerationHooks;
    retention?: RetentionHooks;
    discovery?: DiscoveryHooks;
  };
  installSignalHandlers?: boolean;
  onError?: (error: unknown) => void;
  onSessionError?: (sessionId: string, error: unknown) => void;
}

export class WorldServer {
  readonly dataDir: string;
  readonly clock: Clock;
  readonly worldDb: WorldDatabase;
  readonly realtimeHub: RealtimeHub;
  readonly authService: AuthService;
  readonly integrationAuthService: IntegrationAuthService;
  readonly profileService: ProfileService;
  readonly guestbookService: GuestbookService;
  readonly boardService: BoardService;
  readonly recruitmentService: RecruitmentService;
  readonly noticeService: NoticeService;
  readonly focusService: FocusService;
  readonly presenceService: PresenceService;
  readonly chatService: ChatService;
  readonly accountLifecycleService: AccountLifecycleService;
  readonly moderationService: ModerationService;
  readonly retentionService: RetentionService;
  readonly discoveryService: DiscoveryService;
  readonly accountLifecycle?: AccountLifecycleHooks;
  readonly moderation?: ModerationHooks;
  readonly retention?: RetentionHooks;
  readonly discovery?: DiscoveryHooks;

  private sshServer: RunningSshServer | null = null;
  private bridgeServer: RunningHttpBridge | null = null;
  private mcpHttpServer: RunningMcpHttpServer | null = null;
  private started = false;
  private stopPromise: Promise<void> | null = null;
  private signalCleanup: (() => void) | null = null;

  constructor(private readonly options: WorldServerOptions = {}) {
    this.dataDir = options.dataDir ?? join(process.cwd(), '.terminal-world-data');
    this.clock = options.clock ?? new SystemClock();
    this.worldDb = new WorldDatabase({
      dbPath: options.dbPath,
      dataDir: this.dataDir,
      tombstoneLogPath: options.tombstoneLogPath,
    });

    this.realtimeHub = new RealtimeHub(this.clock);
    this.authService = new AuthService(this.worldDb, this.clock);
    this.integrationAuthService = new IntegrationAuthService(this.worldDb, this.clock, this.authService);
    this.profileService = new ProfileService(this.worldDb, this.clock);
    this.guestbookService = new GuestbookService(this.worldDb, this.clock);
    this.boardService = new BoardService(this.worldDb, this.clock);
    this.recruitmentService = new RecruitmentService(this.worldDb, this.clock);
    this.noticeService = new NoticeService(this.worldDb, this.clock);
    this.focusService = new FocusService(this.worldDb, this.clock, this.realtimeHub);
    this.presenceService = new PresenceService(this.worldDb, this.clock, this.realtimeHub, {
      onSessionEnded: info => {
        this.focusService.handleSessionEnded(info.sessionId, info.mode);
      },
    });
    this.chatService = new ChatService(this.worldDb, this.clock, this.realtimeHub);
    this.accountLifecycleService = new AccountLifecycleService(this.worldDb, this.clock, {
      hub: this.realtimeHub,
    });
    this.moderationService = new ModerationService(this.worldDb, this.clock, {
      hub: this.realtimeHub,
    });
    this.retentionService = new RetentionService(this.worldDb, this.clock);
    this.discoveryService = new DiscoveryService(this.worldDb, {
      clock: this.clock,
      autoSeed: true,
    });

    const defaultAccountLifecycle: AccountLifecycleHooks = {
      recoverAccount: input => this.accountLifecycleService.recoverAccount(input),
      changePassword: input => this.accountLifecycleService.changePassword(input),
      reissueRecoveryCode: input => this.accountLifecycleService.reissueRecoveryCode(input),
      withdrawAccount: input => this.accountLifecycleService.withdrawAccount(input),
    };
    const defaultModeration: ModerationHooks = {
      createReport: input => this.moderationService.createReport(input),
      listMyReports: memberId => this.moderationService.listMyReports(memberId),
      listReportsForAdmin: (adminMemberId, state) =>
        this.moderationService.listReportsForAdmin(
          adminMemberId,
          state === 'received' || state === 'reviewed' ? (state as ReportReviewState) : undefined,
        ),
      reviewReport: input => this.moderationService.reviewReport(input),
      adminDeleteContent: input => this.moderationService.adminDeleteContent(input),
      listDeletionHistory: adminMemberId => this.moderationService.listDeletionHistory(adminMemberId),
    };
    const defaultRetention: RetentionHooks = {
      createDailyBackup: backupDir =>
        this.retentionService.createDailyBackup(backupDir ?? join(this.dataDir, 'backups')),
      restoreFromBackup: (backupPath, targetDataDir) =>
        this.retentionService.restoreFromBackup(backupPath, targetDataDir ?? this.dataDir),
    };
    const defaultDiscovery: DiscoveryHooks = {
      listPopularRepos: filter =>
        this.discoveryService.listPopularRepos({
          language: filter?.language,
          topic: filter?.topic,
          query: filter?.q,
          limit: filter?.limit,
        }),
      searchContributionIssues: filter =>
        this.discoveryService.searchContributionIssues({
          language: filter?.language,
          topic: filter?.topic,
          query: filter?.q,
          limit: filter?.limit,
        }),
      getIssueDetail: issueId => this.discoveryService.getIssueDetail(issueId),
      explainIssue: issueId => this.discoveryService.explainIssue(issueId),
    };

    const baseServices: WorldServerServices = {
      worldDb: this.worldDb,
      clock: this.clock,
      realtimeHub: this.realtimeHub,
      authService: this.authService,
      integrationAuthService: this.integrationAuthService,
      profileService: this.profileService,
      guestbookService: this.guestbookService,
      boardService: this.boardService,
      recruitmentService: this.recruitmentService,
      noticeService: this.noticeService,
      presenceService: this.presenceService,
      chatService: this.chatService,
      focusService: this.focusService,
      accountLifecycle: defaultAccountLifecycle,
      moderation: defaultModeration,
      retention: defaultRetention,
      discovery: defaultDiscovery,
    };
    const factoryHooks = options.createHooks?.(baseServices);
    this.accountLifecycle = options.accountLifecycle ?? factoryHooks?.accountLifecycle ?? defaultAccountLifecycle;
    this.moderation = options.moderation ?? factoryHooks?.moderation ?? defaultModeration;
    this.retention = options.retention ?? factoryHooks?.retention ?? defaultRetention;
    this.discovery = options.discovery ?? factoryHooks?.discovery ?? defaultDiscovery;
  }

  get services(): WorldServerServices {
    return {
      worldDb: this.worldDb,
      clock: this.clock,
      realtimeHub: this.realtimeHub,
      authService: this.authService,
      integrationAuthService: this.integrationAuthService,
      profileService: this.profileService,
      guestbookService: this.guestbookService,
      boardService: this.boardService,
      recruitmentService: this.recruitmentService,
      noticeService: this.noticeService,
      presenceService: this.presenceService,
      chatService: this.chatService,
      focusService: this.focusService,
      accountLifecycle: this.accountLifecycle,
      moderation: this.moderation,
      retention: this.retention,
      discovery: this.discovery,
    };
  }

  get ssh(): RunningSshServer | null {
    return this.sshServer;
  }

  get bridge(): RunningHttpBridge | null {
    return this.bridgeServer;
  }

  get mcpHttp(): RunningMcpHttpServer | null {
    return this.mcpHttpServer;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      if (this.options.enableSsh !== false) {
        this.sshServer = await startSshServer({
          dataDir: this.dataDir,
          host: this.options.sshHost,
          port: this.options.sshPort,
          mouse: this.options.mouse,
          authService: this.authService,
          profileService: this.profileService,
          guestbookService: this.guestbookService,
          worldAppProps: {
            boardService: this.boardService,
            recruitmentService: this.recruitmentService,
            noticeService: this.noticeService,
            presenceService: this.presenceService,
            chatService: this.chatService,
            focusService: this.focusService,
            accountLifecycleService: this.accountLifecycleService,
            moderationService: this.moderationService,
            integrationAuthService: this.integrationAuthService,
            discoveryService: this.discoveryService,
            realtimeHub: this.realtimeHub,
            ...this.options.worldAppProps,
          },
          renderSession: this.options.renderSshSession,
          onSessionError: this.options.onSessionError,
        });
      }

      if (this.options.enableBridge !== false) {
        this.bridgeServer = await startHttpBridgeServer({
          host: this.options.bridgeHost,
          port: this.options.bridgePort,
          worldDb: this.worldDb,
          clock: this.clock,
          authService: this.authService,
          integrationAuthService: this.integrationAuthService,
          profileService: this.profileService,
          guestbookService: this.guestbookService,
          boardService: this.boardService,
          recruitmentService: this.recruitmentService,
          noticeService: this.noticeService,
          presenceService: this.presenceService,
          chatService: this.chatService,
          focusService: this.focusService,
          realtimeHub: this.realtimeHub,
          accountLifecycle: this.accountLifecycle,
          moderation: this.moderation,
          retention: this.retention,
          discovery: this.discovery,
          onError: this.options.onError,
        });
      }

      if (this.options.enableMcpHttp) {
        this.mcpHttpServer = await startMcpHttpServer({
          host: this.options.mcpHost,
          port: this.options.mcpPort,
          path: this.options.mcpPath,
          deps: {
            services: this.services,
            serverUrl: this.bridgeServer?.baseUrl ?? 'in-process',
          },
          onError: this.options.onError,
        });
      }

      if (this.options.installSignalHandlers) {
        const onSignal = () => {
          void this.stop();
        };
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        this.signalCleanup = () => {
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
        };
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.signalCleanup?.();
      this.signalCleanup = null;

      try {
        this.focusService.closeAllActiveFocusForShutdown();
      } catch (error) {
        this.options.onError?.(error);
      }

      if (this.mcpHttpServer) {
        try {
          await this.mcpHttpServer.close();
        } catch (error) {
          this.options.onError?.(error);
        }
        this.mcpHttpServer = null;
      }

      if (this.bridgeServer) {
        try {
          await this.bridgeServer.close();
        } catch (error) {
          this.options.onError?.(error);
        }
        this.bridgeServer = null;
      }

      if (this.sshServer) {
        try {
          await this.sshServer.close();
        } catch (error) {
          this.options.onError?.(error);
        }
        this.sshServer = null;
      }

      this.realtimeHub.clear();
      this.worldDb.close();
    })();

    return this.stopPromise;
  }
}

export async function startWorldServer(options: WorldServerOptions = {}): Promise<WorldServer> {
  const server = new WorldServer(options);
  await server.start();
  return server;
}
