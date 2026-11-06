import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, open, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LIMITS } from '../src/catalog.js';
import { appendChat, appendGuestbook, createProfile, updateProfile, type StateV1 } from '../src/model.js';
import { openStore, StorageError, type StorageTestHooks } from '../src/storage.js';

const now = '2026-10-23T06:29:00.000Z';
const initial = () => createProfile('로컬', { now });
async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'terminal-world-test-'));
  t.after(async () => { await rm(path, { recursive: true, force: true }); });
  return path;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const edits = { introduction: '새 소개', status: '저장됨', asciiPresetId: 'ascii:plant' as const, themeId: 'theme:teal' as const };

test('actual disk restart restores normalized profile and target-separated local histories', async t => {
  const dir = await directory(t);
  let store = await openStore(dir);
  try {
    assert.equal(store.state, null);
    await store.commit(createProfile('가', { now }));
    await store.commit(updateProfile(store.state!, edits, { now }));
    await store.commit(appendChat(store.state!, 'é hello', { now }));
    await store.commit(appendGuestbook(store.state!, 'terminal:example:mina', 'Mina only', { now }));
    await store.commit(appendGuestbook(store.state!, 'terminal:example:jun', 'Jun only', { now }));
    const expected = store.state;
    assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'state.lock'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'state.lock', 'owner.json'))).mode & 0o777, 0o600);
    await store.close();
    store = await openStore(dir);
    assert.deepEqual(store.state, expected);
    assert.equal(store.state!.profile.nickname, '가');
    assert.equal(store.state!.chatMessages[0]!.text, 'é hello');
    assert.deepEqual(store.state!.guestbookEntries.filter(entry => entry.targetTerminalId === 'terminal:example:mina').map(entry => entry.text), ['Mina only']);
    assert.deepEqual(store.state!.guestbookEntries.filter(entry => entry.targetTerminalId === 'terminal:example:sol'), []);
    assert.ok(!JSON.stringify(store.state).includes('seed:'));
    assert.throws(() => { store.state!.profile.status = 'mutable'; }, TypeError);
  } finally { await store.close(); }
});

test('second store conflicts and stale lock is never stolen', async t => {
  const dir = await directory(t);
  const first = await openStore(dir);
  try {
    const owner = await readFile(join(dir, 'state.lock', 'owner.json'));
    await assert.rejects(openStore(dir), error => error instanceof StorageError && error.message.includes('별도 이름으로') && error.message.includes('state.json'));
    assert.deepEqual(await readFile(join(dir, 'state.lock', 'owner.json')), owner);
  } finally { await first.close(); }
  const stale = await openStore(dir);
  const ownerPath = join(dir, 'state.lock', 'owner.json');
  await writeFile(ownerPath, JSON.stringify({ pid: 99999999, token: 'stale', startedAt: '1900-01-01T00:00:00.000Z' }));
  await assert.rejects(openStore(dir), StorageError);
  await assert.rejects(stale.close(), /소유자/);
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).token, 'stale');
});

test('another process cannot open the active store and can restore it after shutdown', async t => {
  const dir = await directory(t);
  const store = await openStore(dir);
  const moduleUrl = new URL('../src/storage.js', import.meta.url).href;
  const invoke = (code: string) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
  let expected: StateV1 | null = null;
  try {
    expected = await store.commit(initial());
    const result = invoke(`
      import { openStore, StorageError } from ${JSON.stringify(moduleUrl)};
      try { const store = await openStore(${JSON.stringify(dir)}); await store.close(); process.exitCode = 1; }
      catch (error) { if (!(error instanceof StorageError) || !error.message.includes('잠금')) throw error; console.log('locked'); }
    `);
    assert.equal(result.trim(), 'locked');
  } finally { await store.close(); }
  const restored = invoke(`
    import { openStore } from ${JSON.stringify(moduleUrl)};
    const store = await openStore(${JSON.stringify(dir)});
    try { console.log(JSON.stringify(store.state)); } finally { await store.close(); }
  `);
  assert.deepEqual(JSON.parse(restored), expected);
});

test('corrupt, unsupported, unknown-field and invalid target files are preserved byte for byte', async t => {
  const dir = await directory(t);
  const path = join(dir, 'state.json');
  const target = appendGuestbook(initial(), 'terminal:example:mina', 'hello', { now });
  const inputs = ['{broken', 'null', JSON.stringify({ ...initial(), schemaVersion: 2 }), JSON.stringify({ ...initial(), extra: 'unknown' }), JSON.stringify({ ...target, guestbookEntries: [{ ...target.guestbookEntries[0], targetTerminalId: 'terminal:unknown' }] })];
  for (const input of inputs) {
    await writeFile(path, input);
    await assert.rejects(openStore(dir), /초기화하지 않았습니다/);
    assert.equal(await readFile(path, 'utf8'), input);
    assert.ok(!(await readdir(dir)).includes('state.lock'));
  }
  await writeFile(path, Buffer.from([0xff, 0xfe]));
  await assert.rejects(openStore(dir));
  assert.deepEqual(await readFile(path), Buffer.from([0xff, 0xfe]));
});

test('oversize sparse disk file is rejected without truncation', async t => {
  const dir = await directory(t);
  const file = await open(join(dir, 'state.json'), 'wx', 0o600);
  try { await file.truncate(LIMITS.fileBytes + 1); } finally { await file.close(); }
  await assert.rejects(openStore(dir));
  assert.equal((await stat(join(dir, 'state.json'))).size, LIMITS.fileBytes + 1);
});

for (const failure of ['beforeTempOpen', 'afterTempWrite', 'beforeRename'] as const) {
  test(`failure at ${failure} preserves existing bytes and unrelated user tmp`, async t => {
    const dir = await directory(t);
    let fail = false;
    const store = await openStore(dir, { at(stage) { if (fail && stage === failure) throw new Error('injected ENOSPC/EIO'); } });
    try {
      await store.commit(initial());
      const bytes = await readFile(join(dir, 'state.json'));
      const userTemp = join(dir, 'state.user-owned.tmp');
      await writeFile(userTemp, 'do not remove');
      const candidate = appendChat(store.state!, 'pending', { now });
      fail = true;
      await assert.rejects(store.commit(candidate), error => error instanceof StorageError && !error.uncertain);
      assert.equal(store.state!.revision, 1);
      assert.deepEqual(await readFile(join(dir, 'state.json')), bytes);
      assert.equal(await readFile(userTemp, 'utf8'), 'do not remove');
      assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), ['state.user-owned.tmp']);
      fail = false;
      await store.commit(candidate);
      assert.equal(store.state!.chatMessages.length, 1);
      await store.commit(candidate);
      assert.equal(store.state!.chatMessages.length, 1);
    } finally { await store.close(); }
  });
}

for (const failure of ['afterRename', 'beforeDirectorySync'] as const) {
  test(`failure at ${failure} leaves confirmed state old and recovers only identical candidate`, async t => {
    const dir = await directory(t);
    let fail = false;
    const store = await openStore(dir, { at(stage) { if (fail && stage === failure) throw new Error('injected sync failure'); } });
    try {
      await store.commit(initial());
      const candidate = appendChat(store.state!, 'once only', { now });
      fail = true;
      await assert.rejects(store.commit(candidate), error => error instanceof StorageError && error.uncertain);
      assert.equal(store.state!.chatMessages.length, 0);
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), candidate);
      const wrong = appendChat(store.state!, 'new UUID must not overwrite', { now });
      await assert.rejects(store.commit(wrong), error => error instanceof StorageError && error.uncertain);
      fail = false;
      assert.deepEqual(await store.commit(candidate), candidate);
      await store.commit(candidate);
      assert.equal(store.state!.chatMessages.length, 1);
      assert.equal(store.state!.chatMessages[0]!.id, candidate.chatMessages[0]!.id);
    } finally { await store.close(); }
  });
}

test('uncertain mismatching disk cannot be overwritten even by the original candidate', async t => {
  const dir = await directory(t);
  let fail = false;
  const store = await openStore(dir, { at(stage) { if (fail && stage === 'afterRename') throw new Error('sync failed'); } });
  try {
    await store.commit(initial());
    const candidate = appendChat(store.state!, 'uncertain', { now });
    fail = true;
    await assert.rejects(store.commit(candidate));
    await writeFile(join(dir, 'state.json'), '{external corruption');
    fail = false;
    await assert.rejects(store.commit(candidate), error => error instanceof StorageError && error.uncertain);
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), '{external corruption');
    assert.equal(store.state!.revision, 1);
  } finally { await store.close(); }
});

test('external same-revision changes, deletion and stale candidates never overwrite disk', async t => {
  const dir = await directory(t);
  const store = await openStore(dir);
  try {
    await store.commit(initial());
    const candidate = appendChat(store.state!, 'hello', { now });
    const external: StateV1 = { ...store.state!, profile: { ...store.state!.profile, status: 'external same revision' } };
    const bytes = JSON.stringify(external);
    await writeFile(join(dir, 'state.json'), bytes);
    await assert.rejects(store.commit(candidate));
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), bytes);
    await rm(join(dir, 'state.json'));
    await assert.rejects(store.commit(candidate));
    await assert.rejects(stat(join(dir, 'state.json')), { code: 'ENOENT' });
    await writeFile(join(dir, 'state.json'), JSON.stringify(store.state));
    await store.commit(candidate);
    await assert.rejects(store.commit(updateProfile(initial(), edits, { now })));
    assert.equal(store.state!.chatMessages.length, 1);
  } finally { await store.close(); }
});

test('external change during temp write is detected again before rename', async t => {
  const dir = await directory(t);
  let alter = false;
  const external = JSON.stringify({ ...initial(), profile: { ...initial().profile, status: 'external' } });
  const hooks: StorageTestHooks = { async at(stage) { if (alter && stage === 'beforeRename') await writeFile(join(dir, 'state.json'), external); } };
  const store = await openStore(dir, hooks);
  try {
    await store.commit(initial());
    alter = true;
    await assert.rejects(store.commit(appendChat(store.state!, 'hello', { now })));
    assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), external);
  } finally { await store.close(); }
});

test('queued commits are serialized, snapshots immutable, close waits and is idempotent', async t => {
  const dir = await directory(t);
  const entered = deferred();
  const resume = deferred();
  let block = false;
  const store = await openStore(dir, { async at(stage) { if (block && stage === 'afterTempWrite') { entered.resolve(); await resume.promise; } } });
  await store.commit(initial());
  const candidate = appendChat(store.state!, 'queued', { now });
  const mutable = JSON.parse(JSON.stringify(candidate)) as StateV1;
  block = true;
  const first = store.commit(mutable);
  const duplicate = store.commit(candidate);
  mutable.chatMessages[0]!.text = 'caller mutation';
  await entered.promise;
  assert.equal(store.state!.chatMessages.length, 0);
  const close = store.close();
  assert.equal(store.close(), close);
  await assert.rejects(store.commit(candidate), /종료/);
  assert.ok((await readdir(dir)).includes('state.lock'));
  resume.resolve();
  await Promise.all([first, duplicate, close]);
  assert.equal(store.state!.chatMessages[0]!.text, 'queued');
  assert.equal(store.state!.chatMessages.length, 1);
  assert.ok(!(await readdir(dir)).includes('state.lock'));
});

test('close waits for a rejected commit before releasing its lock', async t => {
  const dir = await directory(t);
  const entered = deferred();
  const resume = deferred();
  const store = await openStore(dir, { async at(stage) { if (stage === 'afterTempWrite') { entered.resolve(); await resume.promise; throw new Error('disk full'); } } });
  const commit = store.commit(initial());
  const rejected = assert.rejects(commit);
  await entered.promise;
  const close = store.close();
  assert.ok((await readdir(dir)).includes('state.lock'));
  resume.resolve();
  await Promise.all([rejected, close]);
  assert.equal(store.state, null);
  await assert.rejects(stat(join(dir, 'state.json')), { code: 'ENOENT' });
  assert.ok(!(await readdir(dir)).includes('state.lock'));
});

test('close never removes a replacement lock owned by someone else', async t => {
  const dir = await directory(t);
  const store = await openStore(dir);
  await rename(join(dir, 'state.lock'), join(dir, 'original.lock'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'state.lock'));
  await writeFile(join(dir, 'state.lock', 'owner.json'), JSON.stringify({ token: 'replacement' }));
  await assert.rejects(store.commit(initial()));
  const closing = store.close();
  await assert.rejects(closing, /소유자/);
  assert.equal(store.close(), closing);
  assert.equal(JSON.parse(await readFile(join(dir, 'state.lock', 'owner.json'), 'utf8')).token, 'replacement');
  assert.ok((await readdir(dir)).includes('original.lock'));
});

test('actual EACCES preserves committed bytes and permits the same candidate after access is restored', async t => {
  const dir = await directory(t);
  const store = await openStore(dir);
  try {
    await store.commit(initial());
    const bytes = await readFile(join(dir, 'state.json'));
    const candidate = appendChat(store.state!, '권한 복구 후 재시도', { now });
    await chmod(dir, 0o500);
    try {
      await assert.rejects(store.commit(candidate), error => error instanceof StorageError && !error.uncertain && (error.cause as NodeJS.ErrnoException)?.code === 'EACCES');
    } finally { await chmod(dir, 0o700); }
    assert.deepEqual(await readFile(join(dir, 'state.json')), bytes);
    assert.equal(store.state!.chatMessages.length, 0);
    await store.commit(candidate);
    assert.equal(store.state!.chatMessages[0]!.text, '권한 복구 후 재시도');
  } finally { await chmod(dir, 0o700); await store.close(); }
});

test('an ENOSPC cause is retained without publishing or truncating state', async t => {
  const dir = await directory(t);
  let fail = false;
  const store = await openStore(dir, { at(stage) {
    if (fail && stage === 'beforeTempOpen') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } });
  try {
    await store.commit(initial());
    const bytes = await readFile(join(dir, 'state.json'));
    fail = true;
    await assert.rejects(store.commit(appendChat(store.state!, '보존', { now })), error => error instanceof StorageError && !error.uncertain && (error.cause as NodeJS.ErrnoException)?.code === 'ENOSPC');
    assert.deepEqual(await readFile(join(dir, 'state.json')), bytes);
    assert.equal(store.state!.chatMessages.length, 0);
  } finally { await store.close(); }
});

test('partial temp bytes plus a write failure never replace or acknowledge committed data', async t => {
  const dir = await directory(t);
  let fail = false;
  const store = await openStore(dir, { async at(stage) {
    if (!fail || stage !== 'afterTempWrite') return;
    const temporary = (await readdir(dir)).filter(name => /^state\.[0-9a-f-]+\.tmp$/u.test(name));
    assert.equal(temporary.length, 1);
    await writeFile(join(dir, temporary[0]!), '{"partial":');
    throw Object.assign(new Error('partial write then no space'), { code: 'ENOSPC' });
  } });
  try {
    await store.commit(initial());
    await writeFile(join(dir, 'user.tmp'), 'unrelated');
    const bytes = await readFile(join(dir, 'state.json'));
    const candidate = appendChat(store.state!, '부분 쓰기 복구', { now });
    fail = true;
    await assert.rejects(store.commit(candidate), error => error instanceof StorageError && !error.uncertain && (error.cause as NodeJS.ErrnoException)?.code === 'ENOSPC');
    assert.deepEqual(await readFile(join(dir, 'state.json')), bytes);
    assert.equal(store.state!.chatMessages.length, 0);
    assert.equal(await readFile(join(dir, 'user.tmp'), 'utf8'), 'unrelated');
    assert.equal((await readdir(dir)).filter(name => /^state\.[0-9a-f-]+\.tmp$/u.test(name)).length, 0);
    fail = false;
    await store.commit(candidate);
    assert.equal(store.state!.chatMessages[0]!.id, candidate.chatMessages[0]!.id);
  } finally { await store.close(); }
});
