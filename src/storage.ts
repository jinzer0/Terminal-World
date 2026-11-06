import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LIMITS } from './catalog.js';
import { validateState, validateTransition, type StateV1 } from './model.js';

export interface Store {
  readonly state: StateV1 | null;
  commit(candidate: StateV1): Promise<StateV1>;
  close(): Promise<void>;
}
/** Only for deterministic fault tests; not a runtime configuration surface. */
export type StorageTestHooks = { at?: (stage: 'beforeTempOpen' | 'afterTempWrite' | 'beforeRename' | 'afterRename' | 'beforeDirectorySync') => void | Promise<void> };
export class StorageError extends Error {
  constructor(message: string, readonly uncertain = false, options?: ErrorOptions) { super(message, options); this.name = 'StorageError'; }
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
function same(a: StateV1 | null, b: StateV1 | null): boolean { return JSON.stringify(a) === JSON.stringify(b); }

async function load(path: string): Promise<StateV1 | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > LIMITS.fileBytes) throw new Error('일반 파일과 최대 16 MiB만 허용합니다.');
    // One extra byte detects a file growing after stat, with bounded allocation.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, LIMITS.fileBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size || length > LIMITS.fileBytes) throw new Error('읽는 중 파일 크기가 변경되었습니다.');
    const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return validateState(JSON.parse(source) as unknown);
  } finally { await file.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function openStore(directory = join(homedir(), 'Library', 'Application Support', 'Terminal World'), testHooks: StorageTestHooks = {}): Promise<Store> {
  const path = join(directory, 'state.json');
  const lock = join(directory, 'state.lock');
  const ownerPath = join(lock, 'owner.json');
  const token = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    let owner = '(소유자 정보 읽기 불가)';
    try {
      const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const bytes = Buffer.alloc(4096); const result = await handle.read(bytes, 0, bytes.length, 0); owner = bytes.subarray(0, result.bytesRead).toString('utf8'); } finally { await handle.close(); }
    } catch { /* The lock itself is authoritative even when owner metadata is unavailable. */ }
    throw new StorageError(`잠금 충돌 또는 잠금 생성 실패: ${lock}. 다른 실행 또는 이전 비정상 종료 잠금입니다. 소유자: ${owner}. 모든 Terminal World 실행 종료를 확인한 뒤 이 잠금 디렉터리만 별도 이름으로 옮기고 재실행하세요. state.json과 tmp는 삭제하지 마세요.`, false, { cause: error });
  }
  let ownerCreated = false;
  let ownerReady = false;
  let ownerIdentity: { dev: number; ino: number } | undefined;
  async function release(): Promise<void> {
    let owner: unknown;
    try { owner = JSON.parse(await readFile(ownerPath, 'utf8')) as unknown; }
    catch (error) { throw new StorageError(`잠금 소유권 확인 실패: ${ownerPath}. 잠금과 데이터는 보존됩니다.`, false, { cause: error }); }
    if (typeof owner !== 'object' || owner === null || (owner as { token?: unknown }).token !== token) throw new StorageError(`잠금 소유자가 변경되어 해제하지 않습니다: ${lock}`);
    await unlink(ownerPath);
    await rmdir(lock);
  }
  let confirmed: StateV1 | null;
  try {
    const owner = await open(ownerPath, 'wx', 0o600);
    ownerCreated = true;
    try { ownerIdentity = await owner.stat(); await owner.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })); await owner.sync(); }
    finally { await owner.close(); }
    ownerReady = true;
    confirmed = await load(path);
  } catch (error) {
    // Only an owner file created by this attempt may be removed. Never clean user tmp files.
    try {
      if (ownerReady) {
        await release();
      } else if (ownerCreated) {
        // Metadata may be incomplete after a write failure, but this file was opened wx by us.
        const actual = await lstat(ownerPath);
        if (!ownerIdentity || actual.dev !== ownerIdentity.dev || actual.ino !== ownerIdentity.ino) throw new Error('잠금 소유 파일이 변경되었습니다.');
        await unlink(ownerPath);
        await rmdir(lock);
      } else {
        await rmdir(lock);
      }
    } catch (cleanupError) {
      throw new StorageError(`저장소 열기 실패: ${path}. 잠금 정리 실패: ${lock}. 원본 파일을 보존하고 앱 종료 후 사본을 확보해 유효한 사용자 사본을 복원하세요.`, false, { cause: new AggregateError([error, cleanupError]) });
    }
    throw new StorageError(`저장소 열기 실패: ${path}: ${reason(error)}. 파일은 초기화하지 않았습니다. 앱 종료 후 사본을 확보하고 유효한 사용자 사본을 복원하세요.`, false, { cause: error });
  }
  let tail: Promise<void> = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let uncertain: StateV1 | undefined;
  async function checkOwner(): Promise<void> {
    const value = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
    if (value?.token !== token) throw new Error(`잠금 소유권 충돌: ${lock}`);
  }
  async function perform(candidate: StateV1): Promise<StateV1> {
    let temp: string | undefined;
    let ownedTemp = false;
    let renamed = false;
    try {
      await checkOwner();
      if (uncertain) {
        if (!same(uncertain, candidate)) throw new StorageError(`저장 결과 불확실: ${path}. 동일 candidate/UUID 재확인 외 새 변경은 차단됩니다.`, true);
        const disk = await load(path);
        if (!same(disk, candidate)) throw new StorageError(`저장 결과 불확실: ${path}. 디스크가 동일하지 않아 덮어쓰지 않습니다. 앱 종료 후 파일 사본을 확보해 수동 복구하세요.`, true);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
        await testHooks.at?.('beforeDirectorySync');
        await syncDirectory(directory);
        confirmed = candidate;
        uncertain = undefined;
        return confirmed;
      }
      const disk = await load(path);
      if (!same(disk, confirmed)) throw new Error(`디스크 revision/내용 충돌: ${path}. 덮어쓰지 않습니다.`);
      if (same(candidate, confirmed)) return confirmed!;
      validateTransition(confirmed, candidate);
      const bytes = Buffer.from(JSON.stringify(candidate));
      if (bytes.length > LIMITS.fileBytes) throw new Error('16 MiB 제한');
      // Each attempt owns a distinct operation UUID; an existing temp is never removed or reused.
      temp = join(directory, `state.${randomUUID()}.tmp`);
      await testHooks.at?.('beforeTempOpen');
      const handle = await open(temp, 'wx', 0o600);
      ownedTemp = true;
      try {
        await handle.writeFile(bytes);
        await testHooks.at?.('afterTempWrite');
        await handle.sync();
      } finally { await handle.close(); }
      await testHooks.at?.('beforeRename');
      await checkOwner();
      if (!same(await load(path), confirmed)) throw new Error(`쓰기 중 디스크 revision/내용 충돌: ${path}`);
      await rename(temp, path);
      renamed = true;
      uncertain = candidate;
      await testHooks.at?.('afterRename');
      await testHooks.at?.('beforeDirectorySync');
      await syncDirectory(directory);
      confirmed = candidate;
      uncertain = undefined;
      return confirmed;
    } catch (error) {
      if (ownedTemp && !renamed && temp) {
        try { await unlink(temp); }
        catch (cleanupError) { throw new StorageError(`저장 실패: ${path}. 기존 데이터 보존; 임시 파일 정리 실패: ${temp}.`, false, { cause: new AggregateError([error, cleanupError]) }); }
      }
      if (renamed || uncertain) throw new StorageError(`저장 결과 불확실: ${path}. 디스크에 반영됐을 수 있습니다. 동일 candidate/UUID 재확인만 가능하며 새 변경은 차단됩니다. 파일을 삭제하지 마세요.`, true, { cause: error });
      throw new StorageError(`저장 실패: ${path}: ${reason(error)}. 기존 데이터와 초안을 보존하세요.`, false, { cause: error });
    }
  }
  return {
    get state() { return confirmed; },
    commit(candidate) {
      if (closing) return Promise.reject(new StorageError('저장소가 종료 중이거나 종료되었습니다.'));
      let snapshot: StateV1;
      try { snapshot = validateState(candidate); }
      catch (error) { return Promise.reject(error); }
      const result = tail.then(() => perform(snapshot));
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = tail.then(release);
      }
      return closePromise;
    },
  };
}
