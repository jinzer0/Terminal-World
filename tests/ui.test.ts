import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { appendChat, appendGuestbook, createProfile, textWidth, updateProfile, validateState } from '../src/model.js';
import { createViewLayout, wrapLines } from '../src/ui/layout.js';
import { createTerminalInput } from '../src/ui/terminal-input.js';

const now = '2026-10-23T06:29:00.000Z';
const edits = { introduction: '편집 미리보기', status: '다른 상태', asciiPresetId: 'ascii:plant' as const, themeId: 'theme:teal' as const };

test('linear wrapping preserves CJK, combining and ZWJ graphemes and explicit empty lines', () => {
  const rows = wrapLines(['가é👩‍💻', 'ab\n\n c'], 4);
  assert.deepEqual(rows, ['가é', '👩‍💻', 'ab', '', ' c']);
  assert.ok(rows.every(row => textWidth(row) <= 4));
  assert.deepEqual(wrapLines(['  /\\\n /  \\'], 8), ['  /\\', ' /  \\']);
});

test('cached scalar and complex widths match canonical zero-width and emoji layout', () => {
  const state = appendChat(createProfile('폭 정확성', { now }), 'A\u200b\u115f\u1160é👩‍💻🌱B', { now });
  const entry = state.chatMessages[0]!;
  const source = `${state.profile.nickname} · 로컬 · ${new Date(entry.createdAt).toLocaleString()}\n${entry.text}`;
  const layout = createViewLayout();
  for (const width of [4, 5, 4, 6, 5]) {
    const expected = wrapLines([source], width);
    assert.deepEqual(layout(state, 1, null, width).slice(-expected.length), expected);
  }
});

test('shared layout keeps immutable row identity across focus/draft previews and route revisits', () => {
  const initial = appendChat(createProfile('작성자', { now }), '저장한 메시지', { now });
  const state = appendGuestbook(appendGuestbook(initial, 'terminal:example:mina', 'Mina only', { now }), 'terminal:example:jun', 'Jun only', { now });
  const layout = createViewLayout();
  const chat = layout(state, 1, null, 71);
  assert.ok(chat.includes('저장한 메시지'));
  assert.equal(chat.filter(line => line.endsWith(' · 예시')).length, 2);
  assert.equal(chat.filter(line => line.includes('작성자 · 로컬 ·')).length, 1);
  const mina = layout(state, 3, null, 71);
  assert.ok(mina.includes('Mina only'));
  assert.ok(!mina.includes('Jun only'));
  const jun = layout(state, 4, null, 71);
  assert.ok(jun.includes('Jun only'));
  assert.ok(!jun.includes('Mina only'));
  assert.equal(layout(state, 1, edits, 71), chat);
  const own = layout(state, 2, null, 71);
  assert.ok(layout(state, 2, edits, 71).includes('편집 미리보기'));
  assert.deepEqual(layout(state, 2, null, 71), own);
  assert.equal(layout(state, 1, null, 71), chat);
});

test('appended validated snapshots reuse old entry metadata rather than relayout all history', () => {
  const state = appendChat(createProfile('작성자', { now }), '첫 항목', { now });
  const layout = createViewLayout();
  const original = Date.prototype.toLocaleString;
  let conversions = 0;
  Date.prototype.toLocaleString = function (...args: Parameters<typeof original>) { conversions++; return original.apply(this, args); };
  try {
    const first = layout(state, 1, null, 71);
    assert.equal(conversions, 1);
    assert.equal(layout(state, 1, null, 71), first);
    const profile = updateProfile(state, edits, { now });
    assert.deepEqual(layout(profile, 1, null, 71), first);
    assert.equal(conversions, 1, 'profile cloning does not reconvert immutable history');
    const appended = appendChat(profile, '두 번째', { now });
    const next = layout(appended, 1, null, 71);
    assert.equal(conversions, 2, 'only the appended entry receives metadata layout');
    assert.ok(next.includes('첫 항목') && next.includes('두 번째'));
  } finally { Date.prototype.toLocaleString = original; }
});

test('layout width LRU retains two widths and recomputes an evicted viewport correctly', () => {
  const state = appendChat(createProfile('폭 검증', { now }), '한글'.repeat(40), { now });
  const layout = createViewLayout();
  const narrow = layout(state, 1, null, 51);
  const medium = layout(state, 1, null, 71);
  assert.equal(layout(state, 1, null, 51), narrow);
  layout(state, 1, null, 80);
  const recomputed = layout(state, 1, null, 71);
  assert.notEqual(recomputed, medium);
  assert.deepEqual(recomputed, medium);
  assert.ok(recomputed.every(line => textWidth(line) <= 71));
});

test('maximum legal 10000 by 400-CJK history builds once and supports cached route/width reuse', { timeout: 30000 }, () => {
  const base = createProfile('대용량', { now });
  const state = validateState({ ...base, revision: 10001, chatMessages: Array.from({ length: 10000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, origin: 'local', authorId: 'user:local', roomId: 'space:rooftop', text: '가'.repeat(400), createdAt: now,
  })) });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 16 * 1024 * 1024);
  const layout = createViewLayout();
  const rows = layout(state, 1, null, 51);
  assert.equal(rows.length, 170004);
  assert.equal(rows.at(-1), '가'.repeat(25));
  for (let index = 0; index < 20; index++) assert.equal(layout(state, 1, edits, 51), rows);
  layout(state, 2, null, 51);
  assert.equal(layout(state, 1, null, 51), rows);
  const wider = layout(state, 1, null, 71);
  assert.equal(wider.length, 130004);
  assert.equal(wider.at(-1), '가'.repeat(15));
  assert.equal(layout(state, 1, null, 51), rows);
});

test('distinct maximum-size history measures repeated Unicode scalars once across widths', { timeout: 30000 }, () => {
  const base = createProfile('고유한 최대 기록', { now });
  const state = validateState({ ...base, revision: 10001, chatMessages: Array.from({ length: 10000 }, (_, index) => {
    let seed = index + 1;
    let text = '';
    for (let part = 0; part < 400; part++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += String.fromCharCode(0x4e00 + seed % 20000); }
    return { id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, origin: 'local', authorId: 'user:local', roomId: 'space:rooftop', text, createdAt: now };
  }) });
  assert.equal(new Set(state.chatMessages.map(entry => entry.text)).size, 10000);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 16 * 1024 * 1024);
  const original = Intl.Segmenter.prototype.segment;
  let segmentations = 0;
  Intl.Segmenter.prototype.segment = function (input: string) { segmentations++; return original.call(this, input); };
  try {
    const layout = createViewLayout();
    const rows = layout(state, 1, null, 51);
    assert.equal(rows.length, 170004);
    assert.equal(rows[5], state.chatMessages[0]!.text.slice(0, 25));
    assert.equal(rows.at(-1), state.chatMessages.at(-1)!.text.slice(-25));
    assert.ok(segmentations < 100000, `repeated per-scalar segmentation: ${segmentations}`);
    const beforeResize = segmentations;
    assert.equal(layout(state, 1, null, 71).length, 130004);
    assert.ok(segmentations - beforeResize < 20000, 'width change reuses Unicode measurements');
    assert.equal(layout(state, 1, null, 51), rows);
  } finally { Intl.Segmenter.prototype.segment = original; }
});

function ingress(mouse = true) {
  const source = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(enabled: boolean) { this.isRaw = enabled; return this; },
    ref() { return this; }, unref() { return this; },
  });
  let ended = 0;
  const input = createTerminalInput(source, { mouse, onEnd: () => { ended++; }, onError: error => { assert.fail(String(error)); } });
  const keyboard: string[] = [];
  const pointer: string[] = [];
  input.stdin.setEncoding('utf8'); input.mouse.setEncoding('utf8');
  input.stdin.on('data', chunk => { keyboard.push(String(chunk)); });
  input.mouse.on('data', chunk => { pointer.push(String(chunk)); });
  return { source, input, keyboard, pointer, ended: () => ended, close() { input.dispose(); source.destroy(); } };
}

for (const milliseconds of [2, 20]) test(`split SGR at ${milliseconds}ms is decoded only on the mouse channel`, async () => {
  const io = ingress();
  const packets = '\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<65;40;10M';
  try {
    const sizes = [1, 2, 3, 1, 5, 2, 7];
    for (let offset = 0, index = 0; offset < packets.length; index++) {
      const size = sizes[index % sizes.length]!;
      io.source.write(packets.slice(offset, offset + size)); offset += size;
      await delay(milliseconds);
    }
    await delay(5);
    assert.equal(io.pointer.join(''), packets);
    assert.equal(io.keyboard.join(''), '');
    assert.equal(io.pointer.length, 3, 'press, release and wheel are independently complete frames');
  } finally { io.close(); }
});

test('fragmented legacy mouse frames remain isolated from keyboard commands', async () => {
  const io = ingress();
  const packets = '\x1b[M %%\x1b[M#%%';
  try {
    for (const byte of Buffer.from(packets)) { io.source.write(Buffer.from([byte])); await delay(20); }
    assert.equal(io.pointer.join(''), packets);
    assert.equal(io.pointer.length, 2);
    assert.equal(io.keyboard.join(''), '');
  } finally { io.close(); }
});

test('UTF8 byte fragments and complete keyboard controls preserve exact input', async () => {
  const io = ingress();
  const text = '한é👩‍💻\x1b[A\x1b[Z\x1b[1;5C\x1bOA';
  try {
    for (const byte of Buffer.from(text)) io.source.write(Buffer.from([byte]));
    await delay(10);
    assert.equal(io.keyboard.join(''), text);
    assert.deepEqual(io.pointer, []);
  } finally { io.close(); }
});

test('bracketed paste keeps literal mouse/control bytes exclusively on the paste/key channel', async () => {
  const io = ingress();
  const paste = '\x1b[200~가\n\x1b[<0;48;26M\x1b[<0;48;26m\x03\u202e\x1b[201~';
  try {
    for (const byte of Buffer.from(paste)) { io.source.write(Buffer.from([byte])); await delay(1); }
    await delay(10);
    assert.equal(io.keyboard.join(''), paste);
    assert.deepEqual(io.pointer, [], 'pasted Cancel reports never reach the mouse decoder');
    io.source.write('\x1b[<0;5;5M'); await delay(5);
    assert.equal(io.pointer.join(''), '\x1b[<0;5;5M', 'a real packet after paste still works');
  } finally { io.close(); }
});

test('bounded malformed mouse input cannot spill numeric noise or delay Ctrl+C', async () => {
  const io = ingress();
  try {
    io.source.write('\x1b[<' + '1'.repeat(1024) + 'M안전');
    io.source.write('\x1b[<0;\x03');
    await delay(10);
    assert.equal(io.keyboard.join(''), '안전\x03');
    assert.deepEqual(io.pointer, []);
  } finally { io.close(); }
});

test('genuine Esc is delivered once and disposal removes listeners and pending timers', async () => {
  const io = ingress();
  try {
    io.source.write('\x1b'); await delay(110);
    assert.equal(io.keyboard.join(''), '\x1b');
    io.source.write('\x1b'); await delay(5);
    io.input.dispose(); io.input.dispose();
    io.source.write('ignored'); await delay(100);
    assert.equal(io.keyboard.join(''), '\x1b');
    assert.equal(io.source.listenerCount('data'), 0);
    assert.equal(io.source.listenerCount('end'), 0);
    assert.equal(io.source.listenerCount('error'), 0);
  } finally { io.close(); }
});

test('mouse-off drops mouse frames but preserves keys and forwards input end once', async () => {
  const io = ingress(false);
  try {
    io.source.end('입력\x1b[<0;5;5M'); await delay(10);
    assert.equal(io.keyboard.join(''), '입력');
    assert.deepEqual(io.pointer, []);
    assert.equal(io.ended(), 1);
  } finally { io.close(); }
});
