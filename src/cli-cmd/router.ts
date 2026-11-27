import { readFileSync } from 'node:fs';
import type { BridgeResponseMeta } from '../bridge/http-bridge.js';
import { ServiceError, toServiceError } from '../core/errors.js';
import type { IntegrationScope } from '../core/integration-auth-service.js';
import { BridgeClient } from './client.js';

export interface CliTextWritable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface CliIoOptions {
  stdout?: CliTextWritable;
  stderr?: CliTextWritable;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  readFd?: (fd: number) => string;
  promptSecret?: (prompt: string) => Promise<string>;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  heartbeatIntervalMs?: number;
  retentionRestore?: (backupPath: string, targetDataDir?: string) => unknown;
}

export const CLI_SUBCOMMANDS = new Set([
  'serve',
  'tui',
  'mcp',
  'auth',
  'world',
  'profile',
  'guestbook',
  'board',
  'recruit',
  'notice',
  'chat',
  'focus',
  'report',
  'admin',
  'oss',
]);

const FORBIDDEN_SECRET_FLAGS = new Set([
  'password',
  'new-password',
  'current-password',
  'recovery-code',
]);

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'h',
  'version',
  'v',
  'preview',
  'ack-public',
  'no-skill-required',
  'include-ended',
  'attach',
  'confirm',
  'saved',
]);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseCliArgv(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') {
      for (let j = i + 1; j < argv.length; j += 1) {
        positionals.push(argv[j]!);
      }
      break;
    }

    if (token === '-h') {
      flags.set('help', true);
      continue;
    }
    if (token === '-v') {
      flags.set('version', true);
      continue;
    }

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      const rawName = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const inlineValue = eqIdx === -1 ? undefined : token.slice(eqIdx + 1);

      if (FORBIDDEN_SECRET_FLAGS.has(rawName)) {
        throw new ServiceError(
          'INVALID_INPUT',
          `--${rawName} 옵션은 셸 히스토리 노출 방지를 위해 금지되어 있어요. TTY 프롬프트 또는 --${rawName}-fd를 사용해 주세요.`,
          rawName,
        );
      }

      if (BOOLEAN_FLAGS.has(rawName)) {
        if (inlineValue !== undefined) {
          flags.set(rawName, inlineValue === 'true' || inlineValue === '1');
        } else {
          flags.set(rawName, true);
        }
        continue;
      }

      if (inlineValue !== undefined) {
        flags.set(rawName, inlineValue);
        continue;
      }

      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ServiceError('INVALID_INPUT', `--${rawName} 옵션 값이 필요해요.`, rawName);
      }
      flags.set(rawName, next);
      i += 1;
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  const val = flags.get(name);
  if (typeof val === 'string') return val;
  return undefined;
}

function getBoolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function getIntFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = getStringFlag(flags, name);
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new ServiceError('INVALID_INPUT', `--${name} 값은 정수여야 해요.`, name);
  }
  return num;
}

function requirePositional(positionals: readonly string[], index: number, label: string): string {
  const val = positionals[index];
  if (!val || !val.trim()) {
    throw new ServiceError('INVALID_INPUT', `${label} 인수가 필요해요.`, label);
  }
  return val;
}

function requireStringOpt(flags: Map<string, string | boolean>, name: string): string {
  const val = getStringFlag(flags, name);
  if (val === undefined || !val.trim()) {
    throw new ServiceError('INVALID_INPUT', `--${name} 옵션이 필요해요.`, name);
  }
  return val;
}

function readTextOptOrFile(
  flags: Map<string, string | boolean>,
  textFlag: string,
  fileFlag: string,
  required: boolean,
): string | undefined {
  const direct = getStringFlag(flags, textFlag);
  const filePath = getStringFlag(flags, fileFlag);
  if (direct !== undefined && filePath !== undefined) {
    throw new ServiceError('INVALID_INPUT', `--${textFlag}와 --${fileFlag}를 동시에 지정할 수 없어요.`);
  }
  if (filePath !== undefined) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new ServiceError(
        'INVALID_INPUT',
        `파일(${filePath})을 읽을 수 없어요: ${error instanceof Error ? error.message : String(error)}`,
        fileFlag,
      );
    }
  }
  if (direct !== undefined) return direct;
  if (required) {
    throw new ServiceError('INVALID_INPUT', `--${textFlag} 또는 --${fileFlag}를 지정해 주세요.`, textFlag);
  }
  return undefined;
}

function defaultReadFd(fd: number): string {
  return readFileSync(fd, 'utf8');
}

async function promptSecretTty(
  prompt: string,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown },
  stderr: CliTextWritable,
): Promise<string> {
  stderr.write(prompt);
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const wasRaw = (stdin as { isRaw?: boolean }).isRaw;
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(Boolean(wasRaw));
      }
      stdin.pause();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onData = (buf: Buffer | string) => {
      const str = typeof buf === 'string' ? buf : buf.toString('utf8');
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          stderr.write('\n');
          cleanup();
          resolve(chunks.join(''));
          return;
        }
        if (ch === '\u0003') {
          stderr.write('\n');
          cleanup();
          reject(new ServiceError('INVALID_INPUT', '입력이 취소되었어요.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (chunks.length > 0) {
            chunks.pop();
            stderr.write('\b \b');
          }
          continue;
        }
        chunks.push(ch);
        stderr.write('*');
      }
    };

    stdin.on('data', onData);
    stdin.on('error', onError);
  });
}

async function readSecret(
  flags: Map<string, string | boolean>,
  fdFlag: string,
  promptLabel: string,
  io: Required<Pick<CliIoOptions, 'stderr' | 'stdin'>> & Pick<CliIoOptions, 'readFd' | 'promptSecret'>,
): Promise<string> {
  const fd = getIntFlag(flags, fdFlag);
  if (fd !== undefined) {
    if (fd < 0) {
      throw new ServiceError('INVALID_INPUT', `--${fdFlag}는 0 이상의 파일 디스크립터여야 해요.`, fdFlag);
    }
    try {
      const raw = (io.readFd ?? defaultReadFd)(fd);
      return raw.replace(/\r?\n$/, '');
    } catch (error) {
      throw new ServiceError(
        'INVALID_INPUT',
        `--${fdFlag}에서 비밀 입력을 읽지 못했어요: ${error instanceof Error ? error.message : String(error)}`,
        fdFlag,
      );
    }
  }

  if (io.promptSecret) {
    return await io.promptSecret(promptLabel);
  }
  if (io.stdin.isTTY && io.stderr.isTTY) {
    return await promptSecretTty(promptLabel, io.stdin, io.stderr);
  }

  throw new ServiceError(
    'INVALID_INPUT',
    `민감한 입력을 받으려면 대화형 TTY 또는 --${fdFlag}가 필요해요.`,
    fdFlag,
  );
}

function parseScopesFlag(raw: string | undefined): IntegrationScope[] {
  if (!raw) return ['read', 'write'];
  const items = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (items.length === 0) {
    throw new ServiceError('INVALID_INPUT', '--scopes 값을 입력해 주세요.', 'scopes');
  }
  for (const item of items) {
    if (item !== 'read' && item !== 'write' && item !== 'admin') {
      throw new ServiceError('INVALID_INPUT', 'scopes는 read, write, admin 중 하나여야 해요.', 'scopes');
    }
  }
  return items as IntegrationScope[];
}

function formatHumanSummary(resource: string, action: string, data: unknown): string {
  if (data === null || data === undefined) {
    return `[${resource} ${action}] 완료\n`;
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

function buildCliHelpText(): string {
  return [
    'Terminal-World 업무 CLI',
    '사용법: terminal-world [전역 옵션] <resource> <action> [옵션]',
    '',
    '전역 옵션:',
    '  --server <url>            브릿지 서버 주소 (기본 http://127.0.0.1:4310)',
    '  --json                    JSON 봉투 출력 (stdout 순수 JSON, stderr 진단 분리)',
    '  --cursor <token>          페이지 커서',
    '  --limit <n>               조회 개수',
    '  --idempotency-key <key>   쓰기 중복 방지 키',
    '',
    '리소스:',
    '  serve | tui | mcp | auth | world | profile | guestbook | board | recruit | notice | chat | focus | report | admin | oss',
    '',
    '민감 입력 주의:',
    '  --password 등 평문 비밀번호 플래그는 금지되며 TTY 프롬프트 또는 --password-fd 를 사용합니다.',
    '',
  ].join('\n');
}

export async function runCli(
  argv: readonly string[],
  ioOpts: CliIoOptions = {},
): Promise<number> {
  const stdout = ioOpts.stdout ?? process.stdout;
  const stderr = ioOpts.stderr ?? process.stderr;
  const stdin = ioOpts.stdin ?? process.stdin;
  const jsonMode = argv.includes('--json');

  const emitSuccess = (resource: string, action: string, data: unknown, meta: BridgeResponseMeta = {}) => {
    if (jsonMode) {
      stdout.write(`${JSON.stringify({ ok: true, data, meta })}\n`);
    } else {
      stdout.write(formatHumanSummary(resource, action, data));
    }
  };

  try {
    const { positionals, flags } = parseCliArgv(argv);

    if (getBoolFlag(flags, 'help') && positionals.length === 0) {
      stdout.write(buildCliHelpText());
      return 0;
    }

    const resource = positionals[0];
    const action = positionals[1] ?? '';
    if (!resource) {
      stdout.write(buildCliHelpText());
      return 0;
    }

    if (getBoolFlag(flags, 'help')) {
      stdout.write(buildCliHelpText());
      return 0;
    }

    const client = new BridgeClient({
      baseUrl: getStringFlag(flags, 'server'),
      credentialsPath: ioOpts.credentialsPath,
      fetchImpl: ioOpts.fetchImpl,
    });

    const cursor = getStringFlag(flags, 'cursor');
    const limit = getIntFlag(flags, 'limit');
    const idempotencyKey = getStringFlag(flags, 'idempotency-key');
    const secretCtx = {
      stderr,
      stdin,
      readFd: ioOpts.readFd,
      promptSecret: ioOpts.promptSecret,
    };

    switch (resource) {
      case 'auth': {
        if (action === 'signup') {
          const loginId = requireStringOpt(flags, 'login-id');
          const nickname = requireStringOpt(flags, 'nickname');
          const password = await readSecret(flags, 'password-fd', '비밀번호: ', secretCtx);
          const res = await client.request('POST', '/auth/signup', {
            body: { loginId, nickname, password },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        if (action === 'login') {
          const loginId = requireStringOpt(flags, 'login-id');
          const password = await readSecret(flags, 'password-fd', '비밀번호: ', secretCtx);
          const scopes = parseScopesFlag(getStringFlag(flags, 'scopes'));
          const ttlSec = getIntFlag(flags, 'ttl');
          const clientLabel = getStringFlag(flags, 'label') ?? 'terminal-world-cli';

          const started = await client.request<{ code: string }>('POST', '/auth/device-code', {
            body: {
              channel: 'cli',
              scopes,
              requestedTtlSec: ttlSec,
              clientLabel,
            },
          });

          await client.request('POST', '/auth/approve', {
            body: {
              code: started.data.code,
              loginId,
              password,
              ttlSec,
            },
          });

          const exchanged = await client.request<{
            accessToken: string;
            accessTokenExpiresAt: string;
            refreshToken: string;
            refreshTokenExpiresAt: string;
            grant: {
              id: string;
              channel: 'cli' | 'mcp';
              scopes: IntegrationScope[];
              expiresAt: string;
            };
            member: {
              id: string;
              loginId: string;
              nickname: string;
              role: 'member' | 'admin';
            };
            effectiveScopes: IntegrationScope[];
          }>('POST', '/auth/token', {
            body: { code: started.data.code },
          });

          const savedPath = client.storeCredentials({
            serverUrl: client.baseUrl,
            accessToken: exchanged.data.accessToken,
            accessTokenExpiresAt: exchanged.data.accessTokenExpiresAt,
            refreshToken: exchanged.data.refreshToken,
            refreshTokenExpiresAt: exchanged.data.refreshTokenExpiresAt,
            grantId: exchanged.data.grant.id,
            grantExpiresAt: exchanged.data.grant.expiresAt,
            channel: exchanged.data.grant.channel,
            scopes: exchanged.data.effectiveScopes,
            memberId: exchanged.data.member.id,
            loginId: exchanged.data.member.loginId,
            nickname: exchanged.data.member.nickname,
            role: exchanged.data.member.role,
          });

          emitSuccess(resource, action, {
            authenticated: true,
            member: exchanged.data.member,
            grant: exchanged.data.grant,
            effectiveScopes: exchanged.data.effectiveScopes,
            credentialsPath: savedPath,
          }, exchanged.meta);
          return 0;
        }

        if (action === 'logout') {
          const creds = client.getCredentials();
          if (creds) {
            try {
              await client.request('DELETE', `/auth/grants/${encodeURIComponent(creds.grantId)}`, {
                auth: true,
              });
            } catch {
              // Still remove local credentials even if server grant already expired/revoked.
            }
          }
          const removed = client.removeCredentials();
          emitSuccess(resource, action, { loggedOut: true, removed });
          return 0;
        }

        if (action === 'approve') {
          const code = requirePositional(positionals, 2, 'approval-code');
          const loginId = requireStringOpt(flags, 'login-id');
          const password = await readSecret(flags, 'password-fd', '비밀번호: ', secretCtx);
          const ttlSec = getIntFlag(flags, 'ttl');
          const res = await client.request('POST', '/auth/approve', {
            body: { code, loginId, password, ttlSec },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        if (action === 'deny') {
          const code = requirePositional(positionals, 2, 'approval-code');
          const res = await client.request('POST', '/auth/deny', {
            body: { code },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        if (action === 'grants') {
          const subAction = positionals[2];
          if (subAction === 'list') {
            const res = await client.request('GET', '/auth/grants', { auth: true });
            emitSuccess(resource, 'grants list', res.data, res.meta);
            return 0;
          }
          if (subAction === 'revoke') {
            const grantId = requirePositional(positionals, 3, 'grantId');
            const reason = getStringFlag(flags, 'reason');
            const res = await client.request('POST', `/auth/grants/${encodeURIComponent(grantId)}/revoke`, {
              auth: true,
              body: reason ? { reason } : {},
            });
            emitSuccess(resource, 'grants revoke', res.data, res.meta);
            return 0;
          }
          throw new ServiceError('INVALID_INPUT', 'auth grants 하위 명령은 list 또는 revoke여야 해요.');
        }

        if (action === 'refresh') {
          const updated = await client.refreshStoredCredentials();
          emitSuccess(resource, action, {
            refreshed: true,
            grantId: updated.grantId,
            grantExpiresAt: updated.grantExpiresAt,
            accessTokenExpiresAt: updated.accessTokenExpiresAt,
            refreshTokenExpiresAt: updated.refreshTokenExpiresAt,
            scopes: updated.scopes,
          });
          return 0;
        }

        if (action === 'change-password') {
          const currentPassword = await readSecret(flags, 'password-fd', '현재 비밀번호: ', secretCtx);
          const newPassword = await readSecret(flags, 'new-password-fd', '새 비밀번호: ', secretCtx);
          const res = await client.request('POST', '/auth/change-password', {
            auth: true,
            body: { currentPassword, newPassword },
          });
          client.removeCredentials();
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        if (action === 'recover') {
          const loginId = requireStringOpt(flags, 'login-id');
          const recoveryCode = await readSecret(flags, 'recovery-code-fd', '32자리 복구 코드: ', secretCtx);
          const newPassword = await readSecret(flags, 'new-password-fd', '새 비밀번호: ', secretCtx);
          const res = await client.request('POST', '/auth/recover', {
            body: { loginId, recoveryCode, newPassword },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        if (action === 'recovery-code' && positionals[2] === 'reissue') {
          const currentPassword = await readSecret(flags, 'password-fd', '현재 비밀번호: ', secretCtx);
          const res = await client.request('POST', '/auth/recovery-code/reissue', {
            auth: true,
            body: { currentPassword },
          });
          emitSuccess(resource, 'recovery-code reissue', res.data, res.meta);
          return 0;
        }

        if (action === 'withdraw') {
          if (!getBoolFlag(flags, 'confirm')) {
            throw new ServiceError('INVALID_INPUT', '회원 탈퇴에는 --confirm 확인이 필요해요.', 'confirm');
          }
          const password = await readSecret(flags, 'password-fd', '비밀번호: ', secretCtx);
          const res = await client.request('POST', '/auth/withdraw', {
            auth: true,
            body: { password, confirm: true },
          });
          client.removeCredentials();
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }

        throw new ServiceError('INVALID_INPUT', `알 수 없는 auth 명령이에요: ${action}`);
      }

      case 'world': {
        if (action === 'spaces') {
          const res = await client.request('GET', '/world/spaces');
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'lobby') {
          const res = await client.request('GET', '/world/lobby');
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'presence') {
          const res = await client.request('GET', '/world/presence');
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'enter') {
          const spaceId = requirePositional(positionals, 2, 'spaceId');
          let sessionId = getStringFlag(flags, 'session-id');
          if (!sessionId) {
            const opened = await client.request<{ id: string }>('POST', '/sessions', {
              auth: 'optional',
              body: { channel: 'cli', spaceId },
            });
            emitSuccess(resource, action, opened.data, opened.meta);
            return 0;
          }
          const res = await client.request('POST', `/sessions/${encodeURIComponent(sessionId)}/enter`, {
            auth: 'optional',
            body: { spaceId },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 world 명령이에요: ${action}`);
      }

      case 'profile': {
        if (action === 'get') {
          const identifier = requirePositional(positionals, 2, 'nickname');
          const res = await client.request('GET', `/profiles/${encodeURIComponent(identifier)}`);
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'edit') {
          const introduction = readTextOptOrFile(flags, 'intro', 'intro-file', false);
          const rawStack = getStringFlag(flags, 'stack');
          const technologyStack = rawStack !== undefined
            ? (rawStack.trim() === '' ? [] : rawStack.split(',').map(s => s.trim()))
            : undefined;
          const currentStatus = getStringFlag(flags, 'status');
          const projectUrl = getStringFlag(flags, 'url');
          const asciiArt = readTextOptOrFile(flags, 'ascii', 'ascii-file', false);
          const colorTheme = getStringFlag(flags, 'theme');
          const preview = getBoolFlag(flags, 'preview');

          const body: Record<string, unknown> = {};
          if (introduction !== undefined) body.introduction = introduction;
          if (technologyStack !== undefined) body.technologyStack = technologyStack;
          if (currentStatus !== undefined) body.currentStatus = currentStatus;
          if (projectUrl !== undefined) body.projectUrl = projectUrl;
          if (asciiArt !== undefined) body.asciiArt = asciiArt;
          if (colorTheme !== undefined) body.colorTheme = colorTheme;

          if (preview) {
            const res = await client.request('POST', '/profiles/me/preview', { auth: true, body });
            emitSuccess(resource, 'preview', res.data, res.meta);
            return 0;
          }
          const res = await client.request('PATCH', '/profiles/me', {
            auth: true,
            idempotencyKey,
            body,
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 profile 명령이에요: ${action}`);
      }

      case 'guestbook': {
        if (action === 'archived') {
          const res = await client.request('GET', '/guestbook/archived');
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'list') {
          const identifier = requirePositional(positionals, 2, 'nickname');
          const res = await client.request('GET', `/guestbook/${encodeURIComponent(identifier)}`);
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'create') {
          const identifier = requirePositional(positionals, 2, 'nickname');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
          const res = await client.request('POST', `/guestbook/${encodeURIComponent(identifier)}`, {
            auth: true,
            idempotencyKey,
            body: { body: bodyText },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'update') {
          const entryId = requirePositional(positionals, 2, 'entryId');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
          const res = await client.request('PATCH', `/guestbook/entries/${encodeURIComponent(entryId)}`, {
            auth: true,
            idempotencyKey,
            body: { body: bodyText },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'delete') {
          const entryId = requirePositional(positionals, 2, 'entryId');
          const reason = getStringFlag(flags, 'reason');
          const res = await client.request('DELETE', `/guestbook/entries/${encodeURIComponent(entryId)}`, {
            auth: true,
            idempotencyKey,
            body: reason ? { reason } : {},
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 guestbook 명령이에요: ${action}`);
      }

      case 'board': {
        if (action === 'list') {
          const res = await client.request('GET', '/boards');
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'posts') {
          const boardId = requirePositional(positionals, 2, 'boardId');
          const res = await client.request('GET', `/boards/${encodeURIComponent(boardId)}/posts`, {
            query: { cursor, limit },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'post') {
          const sub = positionals[2];
          if (sub === 'get') {
            const postId = requirePositional(positionals, 3, 'postId');
            const res = await client.request('GET', `/posts/${encodeURIComponent(postId)}`);
            emitSuccess(resource, 'post get', res.data, res.meta);
            return 0;
          }
          if (sub === 'create') {
            const boardId = requirePositional(positionals, 3, 'boardId');
            const title = requireStringOpt(flags, 'title');
            const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
            const res = await client.request('POST', `/boards/${encodeURIComponent(boardId)}/posts`, {
              auth: true,
              idempotencyKey,
              body: { title, body: bodyText },
            });
            emitSuccess(resource, 'post create', res.data, res.meta);
            return 0;
          }
          if (sub === 'update') {
            const postId = requirePositional(positionals, 3, 'postId');
            const title = getStringFlag(flags, 'title');
            const bodyText = readTextOptOrFile(flags, 'body', 'body-file', false);
            const res = await client.request('PATCH', `/posts/${encodeURIComponent(postId)}`, {
              auth: true,
              idempotencyKey,
              body: {
                ...(title !== undefined ? { title } : {}),
                ...(bodyText !== undefined ? { body: bodyText } : {}),
              },
            });
            emitSuccess(resource, 'post update', res.data, res.meta);
            return 0;
          }
          if (sub === 'delete') {
            const postId = requirePositional(positionals, 3, 'postId');
            const reason = getStringFlag(flags, 'reason');
            const res = await client.request('DELETE', `/posts/${encodeURIComponent(postId)}`, {
              auth: true,
              idempotencyKey,
              body: reason ? { reason } : {},
            });
            emitSuccess(resource, 'post delete', res.data, res.meta);
            return 0;
          }
        }
        if (action === 'comment') {
          const sub = positionals[2];
          if (sub === 'create') {
            const postId = requirePositional(positionals, 3, 'postId');
            const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
            const res = await client.request('POST', `/posts/${encodeURIComponent(postId)}/comments`, {
              auth: true,
              idempotencyKey,
              body: { body: bodyText },
            });
            emitSuccess(resource, 'comment create', res.data, res.meta);
            return 0;
          }
          if (sub === 'update') {
            const commentId = requirePositional(positionals, 3, 'commentId');
            const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
            const res = await client.request('PATCH', `/comments/${encodeURIComponent(commentId)}`, {
              auth: true,
              idempotencyKey,
              body: { body: bodyText },
            });
            emitSuccess(resource, 'comment update', res.data, res.meta);
            return 0;
          }
          if (sub === 'delete') {
            const commentId = requirePositional(positionals, 3, 'commentId');
            const reason = getStringFlag(flags, 'reason');
            const res = await client.request('DELETE', `/comments/${encodeURIComponent(commentId)}`, {
              auth: true,
              idempotencyKey,
              body: reason ? { reason } : {},
            });
            emitSuccess(resource, 'comment delete', res.data, res.meta);
            return 0;
          }
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 board 명령이에요: ${action}`);
      }

      case 'recruit': {
        if (action === 'list') {
          const res = await client.request('GET', '/recruitments', {
            auth: 'optional',
            query: {
              type: getStringFlag(flags, 'type'),
              role: getStringFlag(flags, 'role'),
              skill: getStringFlag(flags, 'skill'),
              mode: getStringFlag(flags, 'mode'),
              state: getStringFlag(flags, 'state'),
              cursor,
              limit,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'get') {
          const postId = requirePositional(positionals, 2, 'postId');
          const res = await client.request('GET', `/recruitments/${encodeURIComponent(postId)}`, {
            auth: 'optional',
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'create') {
          const title = requireStringOpt(flags, 'title');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
          const recruitmentType = requireStringOpt(flags, 'type');
          const progressNote = requireStringOpt(flags, 'progress');
          const rolesRaw = requireStringOpt(flags, 'roles');
          const roles = rolesRaw.split(',').map(s => s.trim()).filter(Boolean);
          const skillsRaw = getStringFlag(flags, 'skills');
          const requiredSkills = skillsRaw !== undefined
            ? skillsRaw.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;
          const noSkillRequired = getBoolFlag(flags, 'no-skill-required');
          const participationPeriod = requireStringOpt(flags, 'period');
          const weeklyTime = requireStringOpt(flags, 'weekly-time');
          const participationMode = requireStringOpt(flags, 'mode');
          const region = getStringFlag(flags, 'region');
          const contactMethod = requireStringOpt(flags, 'contact');
          const deadlineAt = requireStringOpt(flags, 'deadline');
          const ackPublic = getBoolFlag(flags, 'ack-public');

          const res = await client.request('POST', '/recruitments', {
            auth: true,
            idempotencyKey,
            body: {
              title,
              body: bodyText,
              recruitmentType,
              progressNote,
              roles,
              requiredSkills,
              noSkillRequired,
              participationPeriod,
              weeklyTime,
              participationMode,
              region,
              contactMethod,
              deadlineAt,
              ackPublic,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'update') {
          const postId = requirePositional(positionals, 2, 'postId');
          const body: Record<string, unknown> = {};
          const title = getStringFlag(flags, 'title');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', false);
          if (title !== undefined) body.title = title;
          if (bodyText !== undefined) body.body = bodyText;
          if (getStringFlag(flags, 'type') !== undefined) body.recruitmentType = getStringFlag(flags, 'type');
          if (getStringFlag(flags, 'progress') !== undefined) body.progressNote = getStringFlag(flags, 'progress');
          if (getStringFlag(flags, 'roles') !== undefined) {
            body.roles = getStringFlag(flags, 'roles')!.split(',').map(s => s.trim()).filter(Boolean);
          }
          if (getStringFlag(flags, 'skills') !== undefined) {
            body.requiredSkills = getStringFlag(flags, 'skills')!.split(',').map(s => s.trim()).filter(Boolean);
          }
          if (flags.has('no-skill-required')) body.noSkillRequired = getBoolFlag(flags, 'no-skill-required');
          if (getStringFlag(flags, 'period') !== undefined) body.participationPeriod = getStringFlag(flags, 'period');
          if (getStringFlag(flags, 'weekly-time') !== undefined) body.weeklyTime = getStringFlag(flags, 'weekly-time');
          if (getStringFlag(flags, 'mode') !== undefined) body.participationMode = getStringFlag(flags, 'mode');
          if (getStringFlag(flags, 'region') !== undefined) body.region = getStringFlag(flags, 'region');
          if (getStringFlag(flags, 'contact') !== undefined) body.contactMethod = getStringFlag(flags, 'contact');
          if (getStringFlag(flags, 'deadline') !== undefined) body.deadlineAt = getStringFlag(flags, 'deadline');

          const res = await client.request('PATCH', `/recruitments/${encodeURIComponent(postId)}`, {
            auth: true,
            idempotencyKey,
            body,
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'close') {
          const postId = requirePositional(positionals, 2, 'postId');
          const res = await client.request('POST', `/recruitments/${encodeURIComponent(postId)}/close`, {
            auth: true,
            idempotencyKey,
            body: {},
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'bookmark') {
          const sub = positionals[2];
          if (sub === 'list') {
            const res = await client.request('GET', '/recruitments/bookmarks', { auth: true });
            emitSuccess(resource, 'bookmark list', res.data, res.meta);
            return 0;
          }
          if (sub === 'add' || sub === 'remove') {
            const postId = requirePositional(positionals, 3, 'postId');
            const res = await client.request('POST', `/recruitments/${encodeURIComponent(postId)}/bookmark`, {
              auth: true,
              idempotencyKey,
              body: { saved: sub === 'add' },
            });
            emitSuccess(resource, `bookmark ${sub}`, res.data, res.meta);
            return 0;
          }
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 recruit 명령이에요: ${action}`);
      }

      case 'notice': {
        if (action === 'list') {
          const res = await client.request('GET', '/notices', {
            query: {
              includeEnded: getBoolFlag(flags, 'include-ended') ? 'true' : undefined,
              state: getStringFlag(flags, 'state'),
              cursor,
              limit,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'get') {
          const noticeId = requirePositional(positionals, 2, 'noticeId');
          const res = await client.request('GET', `/notices/${encodeURIComponent(noticeId)}`);
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'create') {
          const title = requireStringOpt(flags, 'title');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', true)!;
          const res = await client.request('POST', '/notices', {
            auth: true,
            idempotencyKey,
            body: { title, body: bodyText },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'update') {
          const noticeId = requirePositional(positionals, 2, 'noticeId');
          const title = getStringFlag(flags, 'title');
          const bodyText = readTextOptOrFile(flags, 'body', 'body-file', false);
          const res = await client.request('PATCH', `/notices/${encodeURIComponent(noticeId)}`, {
            auth: true,
            idempotencyKey,
            body: {
              ...(title !== undefined ? { title } : {}),
              ...(bodyText !== undefined ? { body: bodyText } : {}),
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'end') {
          const noticeId = requirePositional(positionals, 2, 'noticeId');
          const res = await client.request('POST', `/notices/${encodeURIComponent(noticeId)}/end`, {
            auth: true,
            idempotencyKey,
            body: {},
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 notice 명령이에요: ${action}`);
      }

      case 'chat': {
        if (action === 'history') {
          const res = await client.request('GET', '/chat/messages', {
            query: { limit },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'send') {
          const text = getStringFlag(flags, 'text') ?? readTextOptOrFile(flags, 'body', 'body-file', true)!;
          const res = await client.request('POST', '/chat/messages', {
            auth: true,
            idempotencyKey,
            body: { body: text },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'watch') {
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          ioOpts.signal?.addEventListener('abort', onAbort, { once: true });
          const onSigint = () => controller.abort();
          process.once('SIGINT', onSigint);
          process.once('SIGTERM', onSigint);
          try {
            await client.streamSse(
              '/chat/stream',
              frame => {
                if (jsonMode) {
                  stdout.write(`${JSON.stringify(frame)}\n`);
                } else {
                  const data = frame.data as { payload?: { authorNickname?: string; body?: string; sentAt?: string } } | undefined;
                  const payload = data?.payload;
                  if (frame.event === 'chat.message' && payload) {
                    stdout.write(`[${payload.sentAt ?? ''}] @${payload.authorNickname ?? 'unknown'}: ${payload.body ?? ''}\n`);
                  } else {
                    stdout.write(`[${frame.event}] ${JSON.stringify(frame.data)}\n`);
                  }
                }
              },
              { signal: controller.signal },
            );
          } finally {
            ioOpts.signal?.removeEventListener('abort', onAbort);
            process.removeListener('SIGINT', onSigint);
            process.removeListener('SIGTERM', onSigint);
          }
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 chat 명령이에요: ${action}`);
      }

      case 'focus': {
        if (action === 'status') {
          const res = await client.request('GET', '/focus/status', { auth: true });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'stop') {
          const res = await client.request('POST', '/focus/stop', {
            auth: true,
            idempotencyKey,
            body: {},
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'history') {
          const res = await client.request('GET', '/focus/history', {
            auth: true,
            query: {
              memberId: getStringFlag(flags, 'member-id'),
              limit,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'ranking') {
          const res = await client.request('GET', '/focus/ranking', {
            query: { date: getStringFlag(flags, 'date') },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'start') {
          const attach = getBoolFlag(flags, 'attach');
          const explicitSessionId = getStringFlag(flags, 'session-id');

          if (!attach) {
            if (!explicitSessionId) {
              throw new ServiceError(
                'INVALID_INPUT',
                'focus start는 지속 세션 소유가 필요해요. --attach 또는 --session-id를 지정해 주세요.',
              );
            }
            const res = await client.request('POST', '/focus/start', {
              auth: true,
              idempotencyKey,
              body: { sessionId: explicitSessionId },
            });
            emitSuccess(resource, action, res.data, res.meta);
            return 0;
          }

          const opened = await client.request<{ id: string }>('POST', '/sessions', {
            auth: true,
            body: { channel: 'cli', spaceId: 'space:focus' },
          });
          const sessionId = opened.data.id;

          try {
            const started = await client.request('POST', '/focus/start', {
              auth: true,
              idempotencyKey,
              body: { sessionId },
            });
            emitSuccess(resource, 'start --attach', started.data, started.meta);

            await new Promise<void>(resolve => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                clearInterval(timer);
                ioOpts.signal?.removeEventListener('abort', finish);
                process.removeListener('SIGINT', finish);
                process.removeListener('SIGTERM', finish);
                resolve();
              };

              const intervalMs = ioOpts.heartbeatIntervalMs ?? 30_000;
              const timer = setInterval(() => {
                void client.request('POST', `/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
                  auth: true,
                  body: {},
                }).catch(err => {
                  stderr.write(`heartbeat warning: ${err instanceof Error ? err.message : String(err)}\n`);
                });
              }, intervalMs);
              timer.unref();

              if (ioOpts.signal?.aborted) {
                finish();
                return;
              }
              ioOpts.signal?.addEventListener('abort', finish, { once: true });
              process.once('SIGINT', finish);
              process.once('SIGTERM', finish);
            });
          } finally {
            await client.request('POST', `/sessions/${encodeURIComponent(sessionId)}/close`, {
              auth: true,
              body: { mode: 'normal', reason: 'cli_attach_ended' },
            }).catch(() => {});
          }
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 focus 명령이에요: ${action}`);
      }

      case 'report': {
        if (action === 'create') {
          const targetKind = requirePositional(positionals, 2, 'targetKind');
          const targetId = requirePositional(positionals, 3, 'targetId');
          const reason = requireStringOpt(flags, 'reason');
          const res = await client.request('POST', '/reports', {
            auth: true,
            idempotencyKey,
            body: { targetKind, targetId, reason },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'mine') {
          const res = await client.request('GET', '/reports/mine', { auth: true });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 report 명령이에요: ${action}`);
      }

      case 'admin': {
        if (action === 'reports') {
          const sub = positionals[2];
          if (sub === 'list') {
            const res = await client.request('GET', '/admin/reports', {
              auth: true,
              query: { state: getStringFlag(flags, 'state') },
            });
            emitSuccess(resource, 'reports list', res.data, res.meta);
            return 0;
          }
          if (sub === 'review') {
            const reportId = requirePositional(positionals, 3, 'reportId');
            const outcome = requireStringOpt(flags, 'outcome');
            const resolutionReason = requireStringOpt(flags, 'reason');
            const res = await client.request('POST', `/admin/reports/${encodeURIComponent(reportId)}/review`, {
              auth: true,
              idempotencyKey,
              body: { outcome, resolutionReason },
            });
            emitSuccess(resource, 'reports review', res.data, res.meta);
            return 0;
          }
        }
        if (action === 'deletions' && positionals[2] === 'list') {
          const res = await client.request('GET', '/admin/deletions', { auth: true });
          emitSuccess(resource, 'deletions list', res.data, res.meta);
          return 0;
        }
        if (action === 'delete') {
          const targetKind = requirePositional(positionals, 2, 'targetKind');
          const targetId = requirePositional(positionals, 3, 'targetId');
          const reason = requireStringOpt(flags, 'reason');
          const res = await client.request('POST', '/admin/delete', {
            auth: true,
            idempotencyKey,
            body: { targetKind, targetId, reason },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'backup') {
          const backupDir = getStringFlag(flags, 'dir');
          const res = await client.request('POST', '/admin/backup', {
            auth: true,
            body: backupDir ? { backupDir } : {},
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'restore') {
          const backupFile = requirePositional(positionals, 2, 'backupFile');
          const targetDataDir = getStringFlag(flags, 'data-dir');
          if (!ioOpts.retentionRestore) {
            throw new ServiceError('EXTERNAL_UNAVAILABLE', '복구 모듈이 연결되지 않았어요.');
          }
          const result = await ioOpts.retentionRestore(backupFile, targetDataDir);
          emitSuccess(resource, action, result);
          return 0;
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 admin 명령이에요: ${action}`);
      }

      case 'oss': {
        if (action === 'popular') {
          const res = await client.request('GET', '/oss/popular', {
            query: {
              language: getStringFlag(flags, 'lang') ?? getStringFlag(flags, 'language'),
              topic: getStringFlag(flags, 'topic'),
              q: getStringFlag(flags, 'q'),
              cursor,
              limit,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'issues') {
          const res = await client.request('GET', '/oss/issues', {
            query: {
              language: getStringFlag(flags, 'lang') ?? getStringFlag(flags, 'language'),
              topic: getStringFlag(flags, 'topic'),
              q: getStringFlag(flags, 'q'),
              cursor,
              limit,
            },
          });
          emitSuccess(resource, action, res.data, res.meta);
          return 0;
        }
        if (action === 'issue') {
          const sub = positionals[2];
          const issueId = requirePositional(positionals, 3, 'issueId');
          if (sub === 'get') {
            const res = await client.request('GET', '/oss/issue', {
              query: { id: issueId },
            });
            emitSuccess(resource, 'issue get', res.data, res.meta);
            return 0;
          }
          if (sub === 'explain') {
            const res = await client.request('GET', '/oss/issue/explain', {
              query: { id: issueId },
            });
            emitSuccess(resource, 'issue explain', res.data, res.meta);
            return 0;
          }
        }
        throw new ServiceError('INVALID_INPUT', `알 수 없는 oss 명령이에요: ${action}`);
      }

      default:
        throw new ServiceError('INVALID_INPUT', `알 수 없는 명령 리소스예요: ${resource}`);
    }
  } catch (error) {
    const err = toServiceError(error);
    if (jsonMode) {
      stdout.write(`${JSON.stringify({ ok: false, error: err.toJSON() })}\n`);
    } else {
      stderr.write(`[${err.code}] ${err.message}\n`);
    }
    return err.exitCode;
  }
}
