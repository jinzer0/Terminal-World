import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';
import { Box, render, Text, type Instance as InkInstance } from 'ink';
import ssh2, { type Connection, type PseudoTtyInfo, type Server, type ServerChannel, type Session } from 'ssh2';
import type { AuthService } from '../core/auth-service.js';
import type { GuestbookService } from '../core/guestbook-service.js';
import type { ProfileService } from '../core/profile-service.js';
import { WorldApp, type WorldAppProps } from '../tui/WorldApp.js';
import { createTerminalInput, type TerminalStream } from '../ui/terminal-input.js';

const { Server: Ssh2Server, utils: ssh2Utils } = ssh2;

export const SSH_HOST_KEY_FILENAME = 'ssh_host_ed25519.key';

export interface SshPtyStdout extends Writable {
  isTTY: boolean;
  columns: number;
  rows: number;
}

export interface SshSessionRenderContext {
  sessionId: string;
  remoteIp: string;
  onExit: () => void;
  stdout: SshPtyStdout;
}

export interface SshServerOptions {
  dataDir: string;
  host?: string;
  port?: number;
  mouse?: boolean;
  authService: AuthService;
  profileService: ProfileService;
  guestbookService: GuestbookService;
  worldAppProps?: Partial<Omit<WorldAppProps, 'authService' | 'profileService' | 'guestbookService' | 'onExit'>>;
  renderSession?: (context: SshSessionRenderContext) => ReactNode;
  onSessionError?: (sessionId: string, error: unknown) => void;
}

export interface RunningSshServer {
  server: Server;
  host: string;
  port: number;
  hostKeyPath: string;
  activeSessions: () => number;
  close: () => Promise<void>;
}

/**
 * Ensures `<dataDir>/ssh_host_ed25519.key` exists with strict 0o600 permissions and returns its PEM.
 */
export function ensureSshHostKey(dataDir: string): { keyPath: string; privateKeyPem: string } {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, SSH_HOST_KEY_FILENAME);

  if (existsSync(keyPath)) {
    chmodSync(keyPath, 0o600);
    const existing = readFileSync(keyPath, 'utf8');
    const parsed = ssh2Utils.parseKey(existing);
    if (!(parsed instanceof Error)) {
      return { keyPath, privateKeyPem: existing };
    }
  }

  const generated = ssh2Utils.generateKeyPairSync('ed25519');
  writeFileSync(keyPath, generated.private, { encoding: 'utf8', mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return { keyPath, privateKeyPem: generated.private };
}

export interface SessionErrorBoundaryProps {
  sessionId: string;
  onError?: (error: unknown) => void;
  onExit: () => void;
  children: ReactNode;
}

interface SessionErrorBoundaryState {
  error: Error | null;
}

/**
 * Isolates a single SSH PTY React tree so a render crash never tears down the server or other clients.
 */
export class SessionErrorBoundary extends Component<SessionErrorBoundaryProps, SessionErrorBoundaryState> {
  override state: SessionErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): SessionErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return createElement(
        Box,
        { flexDirection: 'column', padding: 1, borderStyle: 'round', borderColor: 'red' },
        createElement(
          Text,
          { bold: true, color: 'red' },
          '세션 화면 오류가 발생했습니다 (다른 접속에는 영향을 주지 않습니다)',
        ),
        createElement(Text, null, this.state.error.message),
        createElement(Text, { color: 'gray' }, '세션을 다시 연결하거나 Ctrl+C로 종료해 주세요.'),
      );
    }
    return this.props.children;
  }
}

function createPtyStdout(channel: ServerChannel, initialCols: number, initialRows: number): SshPtyStdout {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      if (channel.writable) {
        channel.write(chunk);
      }
      callback();
    },
  }) as SshPtyStdout;
  stream.isTTY = true;
  stream.columns = initialCols;
  stream.rows = initialRows;
  return stream;
}

function createPtyInputSource(): TerminalStream {
  const source = new PassThrough() as TerminalStream;
  Object.defineProperty(source, 'isTTY', { value: true });
  Object.defineProperty(source, 'isRaw', { value: true });
  source.setRawMode = () => source;
  source.ref = () => source;
  source.unref = () => source;
  return source;
}

export async function startSshServer(options: SshServerOptions): Promise<RunningSshServer> {
  const { keyPath, privateKeyPem } = ensureSshHostKey(options.dataDir);
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 2222;
  const sessionCleanups = new Set<() => void>();
  let nextSessionSeq = 0;

  const server = new Ssh2Server({ hostKeys: [privateKeyPem] }, (client: Connection, info) => {
    const remoteIp = info.ip;
    client.on('error', err => {
      options.onSessionError?.(`conn:${remoteIp}`, err);
    });

    client.on('authentication', ctx => {
      // Terminal-World handles guest/login/signup/recovery inside the TUI AuthGateScreen.
      ctx.accept();
    });

    client.on('session', acceptSession => {
      const session: Session = acceptSession();
      const sessionId = `ssh-${++nextSessionSeq}`;
      let pty: Pick<PseudoTtyInfo, 'cols' | 'rows' | 'term'> = {
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      };
      let stdoutAdapter: SshPtyStdout | null = null;

      session.on('error', (err: unknown) => {
        options.onSessionError?.(sessionId, err);
      });

      session.on('pty', (acceptPty, _rejectPty, ptyInfo) => {
        pty = {
          cols: ptyInfo.cols > 0 ? ptyInfo.cols : 80,
          rows: ptyInfo.rows > 0 ? ptyInfo.rows : 24,
          term: ptyInfo.term || 'xterm-256color',
        };
        acceptPty?.();
      });

      session.on('window-change', (acceptWin, _rejectWin, winInfo) => {
        const nextCols = winInfo.cols > 0 ? winInfo.cols : pty.cols;
        const nextRows = winInfo.rows > 0 ? winInfo.rows : pty.rows;
        pty.cols = nextCols;
        pty.rows = nextRows;
        if (stdoutAdapter) {
          stdoutAdapter.columns = nextCols;
          stdoutAdapter.rows = nextRows;
          stdoutAdapter.emit('resize');
        }
        acceptWin?.();
      });

      session.on('shell', acceptShell => {
        const channel = acceptShell();
        const stdout = createPtyStdout(channel, pty.cols, pty.rows);
        stdoutAdapter = stdout;
        const rawSource = createPtyInputSource();

        let cleaned = false;
        let inkInstance: InkInstance | null = null;
        let terminalInput: ReturnType<typeof createTerminalInput> | null = null;
        let activePresenceSessionId: string | null = null;

        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          sessionCleanups.delete(cleanup);
          if (activePresenceSessionId && options.worldAppProps?.presenceService) {
            const sid = activePresenceSessionId;
            activePresenceSessionId = null;
            try {
              options.worldAppProps.presenceService.closeSession(sid, {
                mode: 'disconnect',
                reason: 'ssh_disconnect',
              });
            } catch {
              // ignore if already closed
            }
          }
          try {
            inkInstance?.unmount();
          } catch (err) {
            options.onSessionError?.(sessionId, err);
          }
          try {
            terminalInput?.dispose();
          } catch {
            // ignore disposal errors
          }
          try {
            rawSource.destroy();
          } catch {
            // ignore
          }
          try {
            if (!channel.destroyed) {
              channel.exit?.(0);
              channel.end();
            }
          } catch {
            // ignore
          }
          try {
            stdout.destroy();
          } catch {
            // ignore
          }
        };

        sessionCleanups.add(cleanup);

        channel.on('error', (err: unknown) => {
          options.onSessionError?.(sessionId, err);
          cleanup();
        });
        channel.once('close', cleanup);
        channel.once('end', () => {
          rawSource.end();
        });
        channel.on('data', (chunk: Buffer | string) => {
          if (!cleaned && rawSource.writable) {
            rawSource.write(chunk);
          }
        });

        terminalInput = createTerminalInput(rawSource, {
          mouse: options.mouse ?? false,
          onEnd: cleanup,
          onError: err => {
            options.onSessionError?.(sessionId, err);
            cleanup();
          },
        });

        const stderr = new PassThrough();
        stderr.resume();

        const renderTree = () => {
          const inner = options.renderSession
            ? options.renderSession({
                sessionId,
                remoteIp,
                onExit: cleanup,
                stdout,
              })
            : createElement(WorldApp, {
                authService: options.authService,
                profileService: options.profileService,
                guestbookService: options.guestbookService,
                ...options.worldAppProps,
                onSessionOpened: (sid: string | null) => {
                  activePresenceSessionId = sid;
                  options.worldAppProps?.onSessionOpened?.(sid);
                },
                onExit: cleanup,
              });

          return createElement(
            SessionErrorBoundary,
            {
              sessionId,
              onError: err => options.onSessionError?.(sessionId, err),
              onExit: cleanup,
              children: inner,
            },
          );
        };

        try {
          inkInstance = render(renderTree(), {
            stdin: terminalInput.stdin as unknown as NodeJS.ReadStream,
            stdout: stdout as unknown as NodeJS.WriteStream,
            stderr: stderr as unknown as NodeJS.WriteStream,
            interactive: true,
            exitOnCtrlC: false,
            patchConsole: false,
          });
        } catch (err) {
          options.onSessionError?.(sessionId, err);
          try {
            if (channel.writable) {
              channel.write('세션 초기화에 실패했습니다.\r\n');
            }
          } catch {
            // ignore
          }
          cleanup();
        }
      });
    });

    client.once('close', () => {
      // channel close handlers handle per-session cleanup
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;

  return {
    server,
    host,
    port: actualPort,
    hostKeyPath: keyPath,
    activeSessions: () => sessionCleanups.size,
    close: async () => {
      for (const cleanup of Array.from(sessionCleanups)) {
        cleanup();
      }
      await new Promise<void>(resolve => {
        server.close(() => resolve());
      });
    },
  };
}
