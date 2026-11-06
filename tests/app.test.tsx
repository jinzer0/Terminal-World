import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { useState } from 'react';
import { Box, Text, render, useInput, usePaste } from 'ink';
import { App } from '../src/App.js';
import { runApplication } from '../src/cli.js';
import { createProfile, validateState, type StateV1 } from '../src/model.js';
import { StorageError } from '../src/storage.js';
import { MouseRoot, PointerBox } from '../src/ui/mouse.js';
import { createTerminalInput } from '../src/ui/terminal-input.js';

function terminal() {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(enabled: boolean) { raw.push(enabled); return this; },
    ref() { return this; },
    unref() { return this; },
  });
  let output = '';
  let frame = '';
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
  stdout.on('data', chunk => {
    output += String(chunk);
    const text = String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (text.trim()) frame = text;
  });
  const stderr = new PassThrough();
  stderr.resume();
  return { stdin, stdout, stderr, raw, output: () => output, frame: () => frame };
}

function framedInput(streams: ReturnType<typeof terminal>, mouse = true) {
  return createTerminalInput(streams.stdin, {
    mouse,
    onEnd: () => { assert.fail('unexpected fixture input end'); },
    onError: error => { assert.fail(String(error)); },
  });
}

test('actual Ink input and mouse providers preserve graphemes and isolate SGR events', async () => {
  const streams = terminal();
  const input = framedInput(streams);
  let value = '';
  let clicks = 0;
  let scroll = 0;
  let pasted = '';
  function Surface() {
    const [text, setText] = useState('');
    useInput(input => { setText(current => { value = current + input; return value; }); });
    usePaste(text => { pasted = text; });
    return <MouseRoot input={input.mouse}><Box flexDirection="column">
      <Text>{text || ' '}</Text>
      <PointerBox width={10} height={1} onClick={() => { clicks++; }}><Text>button</Text></PointerBox>
      <PointerBox width={10} height={1} onWheel={direction => { scroll += direction; }}><Text>wheel</Text></PointerBox>
    </Box></MouseRoot>;
  }
  const instance = render(<Surface />, { ...streams, stdin: input.stdin, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const send = async (data: string) => {
    streams.stdin.write(data);
    await delay(30);
    await instance.waitUntilRenderFlush();
  };
  try {
    await instance.waitUntilRenderFlush();
    await delay(30);
    await send('한글é👩‍💻');
    assert.equal(value, '한글é👩‍💻');
    for (let i = 0; i < 20; i++) {
      await send('\x1b[<0;5;2M\x1b[<0;5;2m');
      await send('\x1b[<65;5;3M');
    }
    assert.equal(clicks, 20, 'one physical press/release maps to one action');
    assert.equal(scroll, 20, 'wheel events retain their direction');
    assert.equal(value, '한글é👩‍💻', 'mouse protocol never enters the input text');
    await send('\x1b[<0;11;2M\x1b[<0;11;2m');
    assert.equal(clicks, 20, 'the right boundary is exclusive');
    await send('\x1b[200~안녕\n다음\x1b[201~');
    assert.equal(value, '한글é👩‍💻', 'paste never leaks into keyboard input');
    assert.equal(pasted, '안녕\n다음');
    streams.stdout.columns = 80;
    streams.stdout.rows = 24;
    streams.stdout.emit('resize');
    await delay(30);
    await send('\x1b[<0;5;2M\x1b[<0;5;2m');
    assert.equal(clicks, 21);
    assert.equal(value, '한글é👩‍💻');
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    input.dispose();
    streams.stdin.destroy();
    streams.stdout.destroy();
    streams.stderr.destroy();
  }
  assert.equal(streams.raw.at(-1), false, 'terminal raw mode is restored');
});

test('explicit mouse-off mode does not enable terminal mouse tracking', async () => {
  const streams = terminal();
  const input = framedInput(streams, false);
  const instance = render(<MouseRoot input={input.mouse} enabled={false}><Text>keyboard only</Text></MouseRoot>, { ...streams, stdin: input.stdin, interactive: true, patchConsole: false });
  try {
    await instance.waitUntilRenderFlush();
    await delay(20);
    assert.doesNotMatch(streams.output(), /\x1b\[\?(?:1000|1002|1003|1006)h/);
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    input.dispose();
    streams.stdin.destroy();
    streams.stdout.destroy();
    streams.stderr.destroy();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function application(initial: StateV1 | null, commit: (candidate: StateV1) => Promise<StateV1>) {
  const streams = terminal();
  const input = framedInput(streams);
  let shutdowns = 0;
  const instance = render(<MouseRoot input={input.mouse}><App initial={initial} commit={commit} requestShutdown={async () => { shutdowns++; }} isStopping={() => false} /></MouseRoot>, { ...streams, stdin: input.stdin, interactive: true, exitOnCtrlC: false, patchConsole: false });
  const flush = async () => { await delay(35); await instance.waitUntilRenderFlush(); };
  await flush();
  const send = async (data: string) => { streams.stdin.write(data); if (data.endsWith('\x1b')) await delay(100); await flush(); };
  return {
    ...streams, flush, send, shutdowns: () => shutdowns,
    async navigate(index: number) {
      await send('\t');
      await send('\x1b[A'.repeat(5) + '\x1b[B'.repeat(index) + '\r\t');
    },
    async close() {
      instance.unmount();
      await instance.waitUntilExit();
      input.dispose();
      streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy();
    },
  };
}

test('onboarding and profile changes publish only after commit, retry identical candidates, and preserve coalesced input', async () => {
  const operations: { candidate: StateV1; outcome: ReturnType<typeof deferred<StateV1>> }[] = [];
  const ui = await application(null, candidate => {
    const outcome = deferred<StateV1>();
    operations.push({ candidate, outcome });
    return outcome.promise;
  });
  try {
    await ui.send('\x1b[200~잘못\n붙여넣기\x1b[201~');
    assert.equal(operations.length, 0);
    assert.match(ui.frame(), /제어문자|줄바꿈/);
    await ui.send('가재é👩‍💻');
    await ui.send('\x7f');
    await ui.send('\x7f\r');
    assert.equal(operations.length, 1);
    assert.equal(operations[0]!.candidate.profile.nickname, '가재', 'the real application removes whole combining/ZWJ graphemes');
    assert.match(ui.frame(), /처음 입장/);
    assert.doesNotMatch(ui.frame(), /내 터미널 \/ 로컬/);
    await ui.send('\r\r');
    assert.equal(operations.length, 1, 'pending Enter repeats cannot duplicate writes');
    operations[0]!.outcome.reject(new Error('disk full'));
    await ui.flush();
    assert.match(ui.frame(), /disk full/);
    assert.match(ui.frame(), /가재/);
    await ui.send('\r');
    assert.equal(operations.length, 2);
    assert.equal(operations[1]!.candidate, operations[0]!.candidate);
    operations[1]!.outcome.resolve(operations[1]!.candidate);
    await ui.flush();
    assert.match(ui.frame(), /내 터미널 \/ 로컬/);
    assert.match(ui.frame(), /로컬 저장 완료/);
    await ui.send('\r');
    await ui.send('소개추가\t상태추가');
    assert.match(ui.frame(), /form:status/);
    await ui.send('\t\x1b[B\t\x1b[B');
    await ui.send('\x13');
    assert.equal(operations.length, 3);
    const edited = operations[2]!.candidate;
    assert.ok(edited.profile.introduction.endsWith('소개추가'));
    assert.ok(edited.profile.status.endsWith('상태추가'), 'text after a coalesced Tab reaches the new field');
    assert.equal(edited.profile.asciiPresetId, 'ascii:mountain');
    assert.equal(edited.profile.themeId, 'theme:violet');
    operations[2]!.outcome.resolve(edited);
    await ui.flush();
    assert.match(ui.frame(), /상태추가/);
    await ui.send('\r');
    await ui.send('취소될본문');
    await ui.send('\x1b[<0;5;5M\x1b[<0;5;5m');
    assert.match(ui.frame(), /먼저 저장\/전송하거나 Esc로 취소하세요/);
    assert.match(ui.frame(), /취소될본문/);
    assert.equal(operations.length, 3);
    await ui.send('\x1b');
    assert.doesNotMatch(ui.frame(), /취소될본문/);
  } finally { await ui.close(); }
});

test('six routes, example-only chat seeds and target guestbooks survive resize without cross-target leakage', async () => {
  let saved = createProfile('검증사용자');
  const ui = await application(saved, async candidate => { saved = candidate; return candidate; });
  try {
    await ui.navigate(0);
    assert.match(ui.frame(), /로비 · 로컬 프로토타입/);
    assert.match(ui.frame(), /Mina · 예시 사용자 방문/);
    await ui.navigate(1);
    assert.match(ui.frame(), /RoofTop에 오신 것을 환영해요/);
    assert.match(ui.frame(), /Mina · 예시/);
    await ui.send('\r');
    await ui.send('나의 채팅');
    await ui.send('\x13');
    assert.equal(saved.chatMessages.length, 0);
    assert.match(ui.frame(), /Ctrl\+S는 전송하지 않아요/);
    ui.stdout.columns = 70; ui.stdout.rows = 20; ui.stdout.emit('resize');
    await ui.flush();
    assert.match(ui.frame(), /80×24 이상/);
    await ui.send('사라져야할입력\r');
    assert.equal(saved.chatMessages.length, 0);
    ui.stdout.columns = 100; ui.stdout.rows = 30; ui.stdout.emit('resize');
    await ui.flush();
    assert.match(ui.frame(), /나의 채팅/);
    assert.doesNotMatch(ui.frame(), /사라져야할입력/);
    await ui.send('\r');
    assert.equal(saved.chatMessages.length, 1);
    assert.equal(saved.chatMessages[0]!.text, '나의 채팅');
    assert.match(ui.frame(), /검증사용자 · 로컬/);
    const names = ['Mina', 'Jun', 'Sol'];
    for (let index = 0; index < names.length; index++) {
      await ui.navigate(index + 3);
      assert.match(ui.frame(), new RegExp(names[index]! + ' · 예시 사용자'));
      for (const other of names.filter(name => name !== names[index])) assert.doesNotMatch(ui.frame(), new RegExp(other + '에게만'));
      await ui.send('\r');
      await ui.send(names[index]! + '에게만\r');
      assert.equal(saved.guestbookEntries.length, index + 1);
      assert.equal(saved.guestbookEntries[index]!.targetTerminalId, `terminal:example:${names[index]!.toLowerCase()}`);
    }
    await ui.navigate(2);
    assert.match(ui.frame(), /내 프로필 편집/);
    assert.doesNotMatch(ui.frame(), /로컬 방명록 작성/);
    assert.equal(saved.chatMessages.length, 1);
    assert.equal(saved.guestbookEntries.length, 3);
  } finally { await ui.close(); }
});

test('wheel over blank sidebar space moves its cursor without opening a different route', async () => {
  const ui = await application(createProfile('휠 검증'), async () => { assert.fail('sidebar wheel must not commit'); });
  try {
    await ui.send('\x1b[<65;5;18M');
    assert.match(ui.frame(), /› Mina · 예시/);
    assert.match(ui.frame().split('\n')[0]!, /TERMINAL WORLD \/ 내 터미널/);
    assert.match(ui.frame(), /포커스: sidebar/);
    await ui.send('\x1b[<64;5;18M');
    assert.match(ui.frame(), /› 내 터미널/);
    assert.match(ui.frame().split('\n')[0]!, /TERMINAL WORLD \/ 내 터미널/);
  } finally { await ui.close(); }
});

test('fragmented pointer reports and pasted Cancel/Ctrl+C never discard a dirty composer', async () => {
  const commits: StateV1[] = [];
  const ui = await application(createProfile('입력 경계'), async candidate => { commits.push(candidate); return candidate; });
  const draft = 'keep한é👩‍💻';
  try {
    await ui.navigate(1); await ui.send('\r'); await ui.send(draft);
    for (const milliseconds of [2, 20]) {
      await ui.send('z'); await ui.send('\x7f');
      const data = Buffer.from('\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<65;40;10M');
      const sizes = [1, 2, 3, 1, 5, 2, 7];
      for (let offset = 0, index = 0; offset < data.length; index++) {
        const size = sizes[index % sizes.length]!;
        ui.stdin.write(data.subarray(offset, offset + size)); offset += size;
        await delay(milliseconds);
      }
      await ui.flush();
      assert.ok(ui.frame().includes(draft));
      assert.match(ui.frame(), /먼저 저장\/전송/);
      assert.match(ui.frame(), /포커스: composer:space:rooftop/);
      assert.equal(commits.length, 0);
    }
    await ui.send('\x1b[200~prefix\x1b[<0;48;26M\x1b[<0;48;26m\x03suffix\x1b[201~');
    assert.ok(ui.frame().includes(draft));
    assert.match(ui.frame(), /제어문자/);
    assert.match(ui.frame(), /포커스: composer:space:rooftop/);
    assert.equal(ui.shutdowns(), 0);
    assert.equal(commits.length, 0);
    await ui.send('\x1b');
    assert.ok(!ui.frame().includes(draft));
    assert.match(ui.frame(), /로컬 채팅 작성/);
  } finally { await ui.close(); }
});

test('maximum legal history supports viewport navigation, draft resize and quit without new history conversion', { timeout: 30000 }, async () => {
  const base = createProfile('최대 기록');
  const state = validateState({ ...base, revision: 10001, chatMessages: Array.from({ length: 10000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, origin: 'local', authorId: 'user:local', roomId: 'space:rooftop',
    text: index === 9999 ? '마지막' + '가'.repeat(397) : '가'.repeat(400), createdAt: base.profile.createdAt,
  })) });
  const ui = await application(state, async () => { assert.fail('navigation and draft must not commit'); });
  const original = Date.prototype.toLocaleString;
  try {
    await ui.navigate(1); await ui.send('\x1b[F');
    assert.match(ui.frame(), /마지막/);
    await ui.send('\r'); await ui.send('보존 초안');
    for (const [columns, rows] of [[80, 24], [100, 30]]) {
      ui.stdout.columns = columns!; ui.stdout.rows = rows!; ui.stdout.emit('resize'); await ui.flush();
      assert.match(ui.frame(), /보존 초안/);
    }
    let conversions = 0;
    Date.prototype.toLocaleString = function (...args: Parameters<typeof original>) { conversions++; return original.apply(this, args); };
    await ui.send('z'); await ui.send('\x7f');
    assert.equal(conversions, 0, 'draft keys reuse layout');
    await ui.send('\x03');
    assert.equal(ui.shutdowns(), 1);
    assert.equal(conversions, 0, 'quit does not walk/convert history');
    assert.equal(state.chatMessages.length, 10000);
  } finally { Date.prototype.toLocaleString = original; await ui.close(); }
});

test('uncertain chat keeps committed history unchanged and retries the exact operation once', async () => {
  const initial = createProfile('작성자');
  const calls: StateV1[] = [];
  let current = deferred<StateV1>();
  const ui = await application(initial, candidate => { calls.push(candidate); return current.promise; });
  try {
    await ui.navigate(1);
    await ui.send('\r');
    await ui.send('실패한 메시지\r');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(ui.frame(), /작성자 · 로컬 ·/);
    assert.match(ui.frame(), /실패한 메시지/);
    current.reject(new StorageError('저장 결과 불확실', true));
    await ui.flush();
    await ui.send('추가하면안됨\x1b');
    assert.doesNotMatch(ui.frame(), /작성자 · 로컬 ·/);
    assert.doesNotMatch(ui.frame(), /추가하면안됨/);
    current = deferred<StateV1>();
    await ui.send('\r\r');
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
    current.resolve(calls[1]!);
    await ui.flush();
    assert.match(ui.frame(), /작성자 · 로컬 ·/);
    assert.match(ui.frame(), /로컬 저장 완료/);
    assert.equal(calls[1]!.chatMessages.length, 1);
  } finally { await ui.close(); }
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`actual CLI render defers Ctrl+C cleanup until commit ${outcome}`, async () => {
    const streams = terminal();
    const events: string[] = [];
    const pending = deferred<StateV1>();
    let candidate: StateV1 | undefined;
    let finished = false;
    let failure: unknown;
    const rawMode = streams.stdin.setRawMode.bind(streams.stdin);
    streams.stdin.setRawMode = enabled => { rawMode(enabled); if (!enabled) events.push('terminal-restored'); return streams.stdin; };
    const completion = runApplication({
      state: null,
      commit(value) { candidate = value; events.push('commit-started'); return pending.promise; },
      async close() { events.push('lock-close'); },
    }, { ...streams, interactive: true, patchConsole: false }, false).then(() => { finished = true; }, error => { failure = error; finished = true; });
    try {
      await delay(40);
      streams.stdin.write('종료검증\r');
      await delay(40);
      assert.ok(candidate);
      streams.stdin.write('\x03\x03');
      await delay(40);
      assert.equal(finished, false);
      assert.deepEqual(events, ['commit-started']);
      events.push('commit-settled');
      if (outcome === 'resolve') pending.resolve(candidate);
      else pending.reject(new Error('deferred disk error'));
      await completion;
      assert.deepEqual(events, ['commit-started', 'commit-settled', 'terminal-restored', 'lock-close']);
      if (outcome === 'resolve') assert.equal(failure, undefined);
      else assert.match(String(failure), /deferred disk error/);
    } finally {
      pending.resolve(candidate ?? createProfile('後片付け'));
      streams.stdin.write('\x03');
      await completion;
      streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy();
    }
  });

  test(`isolated child SIGTERM waits for commit ${outcome} and cleans exactly once`, { timeout: 10000 }, async () => {
    const script = `
      import {PassThrough} from 'node:stream';
      import {runApplication} from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
      let candidate,finish;
      const pending=new Promise((resolve,reject)=>{finish=value=>{process.send('commit-settled');value==='resolve'?resolve(candidate):reject(new Error('deferred disk error'));};});
      process.on('message',value=>finish(value));
      const stdin=Object.assign(new PassThrough(),{isTTY:true,setRawMode(enabled){if(!enabled)process.send('terminal-restored');return this;},ref(){return this;},unref(){return this;}});
      const stdout=Object.assign(new PassThrough(),{isTTY:true,columns:100,rows:30});stdout.resume();
      const stderr=new PassThrough();stderr.resume();
      const store={state:null,commit(value){candidate=value;process.send('commit-started');return pending;},async close(){process.send('lock-close');}};
      setTimeout(()=>stdin.write('신호검증\\r'),40);
      try {await runApplication(store,{stdin,stdout,stderr,interactive:true,patchConsole:false},false);process.send('done');}
      catch(error){process.send('failure:'+error.message);}
      stdin.destroy();stdout.destroy();stderr.destroy();process.disconnect();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    const exited = once(child, 'exit');
    const events: string[] = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const started = new Promise<void>((resolve, reject) => {
      child.on('message', message => { events.push(String(message)); if (message === 'commit-started') resolve(); });
      child.on('exit', () => { if (!events.includes('commit-started')) reject(new Error(stderr || 'child exited before commit')); });
      child.on('error', reject);
    });
    try {
      await started;
      child.kill('SIGTERM');
      await delay(30);
      child.kill('SIGTERM');
      await delay(30);
      assert.deepEqual(events, ['commit-started']);
      child.send(outcome);
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.deepEqual(events, ['commit-started', 'commit-settled', 'terminal-restored', 'lock-close', outcome === 'resolve' ? 'done' : 'failure:deferred disk error']);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy();
    }
  });
}

for (const kind of ['end', 'error'] as const) test(`actual CLI input ${kind} restores terminal and closes once`, async () => {
  const streams = terminal();
  let closes = 0;
  const running = runApplication({
    state: createProfile('입력 종료'),
    commit: async () => { assert.fail('stream termination must not commit'); },
    close: async () => { assert.equal(streams.raw.at(-1), false); closes++; },
  }, { ...streams, interactive: true, patchConsole: false });
  try {
    await delay(60);
    if (kind === 'end') { streams.stdin.end(); await running; }
    else {
      const expected = new Error('input stream broke');
      streams.stdin.emit('error', expected);
      await assert.rejects(running, error => error === expected);
    }
    assert.equal(closes, 1);
    assert.equal(streams.stdin.listenerCount('data'), 0);
    assert.equal(streams.raw.at(-1), false);
  } finally { streams.stdin.destroy(); streams.stdout.destroy(); streams.stderr.destroy(); }
});
