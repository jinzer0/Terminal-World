#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { render, type RenderOptions } from 'ink';
import { App } from './App.js';
import { CLI_SUBCOMMANDS, runCli } from './cli-cmd/router.js';
import { SystemClock } from './core/clock.js';
import { RetentionService } from './core/retention-service.js';
import { startMcpStdioServer } from './mcp/stdio-server.js';
import type { StateV1 } from './model.js';
import { startWorldServer } from './server.js';
import { openStore, type Store } from './storage.js';
import { WorldDatabase } from './store/sqlite/database.js';
import { MouseRoot } from './ui/mouse.js';
import { createTerminalInput, type TerminalInput } from './ui/terminal-input.js';

export async function runApplication(store: Store, options: RenderOptions = {}, mouse = true): Promise<void> {
  let instance: ReturnType<typeof render> | undefined;
  let input: TerminalInput | undefined;
  let pending: Promise<StateV1> | undefined;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  let failure: unknown;
  const rememberFailure = (error: unknown) => { failure ??= error; };
  const requestShutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      try { await pending; } catch (error) { rememberFailure(error); }
      try {
        instance?.unmount();
        if (instance) await instance.waitUntilExit();
      } catch (error) { rememberFailure(error); }
      try { input?.dispose(); } catch (error) { rememberFailure(error); }
      try { await store.close(); } catch (error) { rememberFailure(error); }
      process.removeListener('SIGTERM', onSignal);
    })();
    return shutdownPromise;
  };
  const onSignal = () => { void requestShutdown(); };
  const commit = (candidate: StateV1): Promise<StateV1> => {
    if (stopping) return Promise.reject(new Error('종료 중에는 새 저장을 시작할 수 없어요.'));
    const operation = store.commit(candidate);
    pending = operation;
    const settled = () => { if (pending === operation) pending = undefined; };
    void operation.then(settled, settled);
    return operation;
  };
  process.on('SIGTERM', onSignal);
  try {
    input = createTerminalInput(options.stdin ?? process.stdin, {
      mouse,
      onEnd: () => { void requestShutdown(); },
      onError: error => { rememberFailure(error); void requestShutdown(); },
    });
    instance = render(<MouseRoot input={input.mouse} enabled={mouse}>
      <App initial={store.state} commit={commit} requestShutdown={requestShutdown} isStopping={() => stopping} />
    </MouseRoot>, { ...options, stdin: input.stdin, exitOnCtrlC: false, alternateScreen: true });
    await instance.waitUntilExit();
  } catch (error) { rememberFailure(error); }
  finally { await requestShutdown(); }
  if (failure !== undefined) throw failure;
}

function findSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--server' || token === '--cursor' || token === '--limit' || token === '--idempotency-key' || token === '--data-dir') {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return CLI_SUBCOMMANDS.has(token) ? token : null;
  }
  return null;
}

function getFlagValue(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token.startsWith(prefix)) return token.slice(prefix.length);
    if (token === `--${name}` && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const subcommand = findSubcommand(args);

  if (subcommand === 'serve') {
    const sshPort = Number(getFlagValue(args, 'ssh-port') ?? '2222');
    const bridgePort = Number(getFlagValue(args, 'bridge-port') ?? '4310');
    const mcpPort = Number(getFlagValue(args, 'mcp-port') ?? '4311');
    const dataDir = getFlagValue(args, 'data-dir');
    const enableMcpHttp = args.includes('--mcp-http');
    const enableSsh = !args.includes('--no-ssh');
    const mouse = !args.includes('--no-mouse');

    const server = await startWorldServer({
      dataDir,
      sshPort,
      bridgePort,
      mcpPort,
      enableSsh,
      enableMcpHttp,
      mouse,
      installSignalHandlers: true,
    });
    const lines = [
      `Terminal-World 서버 기동 완료 (dataDir: ${server.dataDir})`,
      server.ssh ? `  SSH TUI : ssh -p ${server.ssh.port} localhost` : '  SSH TUI : 비활성',
      server.bridge ? `  Bridge  : ${server.bridge.baseUrl}` : '  Bridge  : 비활성',
      server.mcpHttp ? `  MCP HTTP: ${server.mcpHttp.url}` : '  MCP HTTP: 비활성 (기본 stdio: terminal-world mcp)',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    await new Promise<void>(resolve => {
      const done = () => {
        void server.stop().finally(resolve);
      };
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    return;
  }

  if (subcommand === 'mcp') {
    const serverUrl = getFlagValue(args, 'server');
    const running = await startMcpStdioServer({ serverUrl });
    await new Promise<void>(resolve => {
      const done = () => {
        void running.close().finally(resolve);
      };
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
      process.stdin.once('end', done);
    });
    return;
  }

  if (subcommand && subcommand !== 'tui') {
    const exitCode = await runCli(args, {
      retentionRestore: (backupPath, targetDataDir) => {
        const dir = targetDataDir ?? getFlagValue(args, 'data-dir') ?? './.terminal-world-data';
        const db = new WorldDatabase({ dataDir: dir });
        try {
          const retention = new RetentionService(db, new SystemClock());
          return retention.restoreFromBackup(backupPath, dir);
        } finally {
          db.close();
        }
      },
    });
    process.exitCode = exitCode;
    return;
  }

  const localArgs = subcommand === 'tui' ? args.filter(a => a !== 'tui') : args;

  if (localArgs.includes('--help')) {
    process.stdout.write([
      'Terminal World — macOS 로컬 TUI & 다중 사용자 서버/CLI/MCP',
      '사용법: terminal-world [--no-mouse] [--help] [--version]',
      '서브커맨드: serve | mcp | auth | world | profile | guestbook | board | recruit | notice | chat | focus | report | admin | oss',
      'Node.js 22 이상 필요. bunx도 기본적으로 Node shebang을 사용합니다.',
      '로비 / RoofTop / 내 터미널 / Mina·Jun·Sol 예시 터미널',
      '↑↓ 선택 · Enter 열기/전송 · Tab/Shift+Tab 포커스 · Esc 취소/뒤로 · Ctrl+C 종료',
      '프로필: 소개/상태/ASCII/개인 테마 · Ctrl+S 또는 저장 버튼',
      '데이터: ~/Library/Application Support/Terminal World/state.json',
      '실제 접속·원격 전달·자동 답장 없음. 예시 사용자는 고정 로컬 예시입니다.',
      '저장 실패 시 초안 유지. 같은 동작으로 재시도하며 파일을 자동 삭제/초기화하지 않습니다.',
      '마우스가 불편한 터미널은 --no-mouse 사용. 권장 100×30, 최소 80×24.',
      'npm/Bun 설치 및 npx/bunx 배포는 사전 컴파일 JS/Node 실행 경로입니다.',
      'Bun-native --bun, 실제 SSH/네트워크/다중 사용자 통신은 지원 약속이 아닙니다.',
      '',
    ].join('\n'));
    return;
  }
  if (localArgs.includes('--version')) {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(metadata.version + '\n');
    return;
  }
  if (localArgs.some(argument => argument !== '--no-mouse')) throw new Error('알 수 없는 옵션입니다. --help를 확인하세요.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('대화형 TTY에서 실행해 주세요. --help와 --version은 파이프에서도 사용할 수 있어요.');
  const store = await openStore();
  await runApplication(store, {}, !localArgs.includes('--no-mouse'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
