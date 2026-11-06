import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ASCII_PRESETS, EXAMPLE_USERS, LIMITS, SEED_CHAT_MESSAGES, THEMES } from '../src/catalog.js';
import { appendChat, appendGuestbook, createProfile, graphemes, inputError, textWidth, updateProfile, validateState, validateTransition, type StateV1 } from '../src/model.js';

const now = '2026-10-23T06:29:00.000Z';
const profile = () => createProfile('한글', { now });
const clone = (state: StateV1): StateV1 => JSON.parse(JSON.stringify(state)) as StateV1;

test('graphemes, CJK cell width, combining characters and emoji clusters', () => {
  assert.deepEqual(graphemes('가é👩‍👩‍👧‍👦'), ['가', 'é', '👩‍👩‍👧‍👦']);
  assert.equal(textWidth('가é👩‍👩‍👧‍👦'), 5);
  assert.equal(inputError('한'.repeat(12), 16, 24), undefined);
  assert.ok(inputError('한'.repeat(13), 16, 24));
  assert.equal(inputError('👩‍💻'.repeat(16), 16), undefined);
  assert.ok(inputError('a'.repeat(17), 16));
  for (const value of ['\n', '\r', '\t', '\x1b[31m', '\x7f', '\x85', '\u061c', '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069']) {
    assert.ok(inputError(value, 400), JSON.stringify(value));
    assert.throws(() => createProfile(`${value}name${value}`, { now }));
  }
});

test('NFC normalization and exact field boundaries without truncation', () => {
  const state = createProfile('  가é  ', { now });
  assert.equal(state.profile.nickname, '가é');
  assert.throws(() => createProfile('   ', { now }));
  assert.throws(() => createProfile('한'.repeat(13), { now }));
  assert.throws(() => createProfile('x'.repeat(17), { now }));
  const edited = updateProfile(state, { introduction: 'é'.repeat(160), status: 's'.repeat(40), asciiPresetId: 'ascii:planet', themeId: 'theme:teal' }, { now });
  assert.equal(edited.profile.introduction, 'é'.repeat(160));
  assert.equal(edited.profile.status.length, 40);
  assert.throws(() => updateProfile(state, { introduction: 'x'.repeat(161), status: '', asciiPresetId: 'ascii:cat', themeId: 'theme:slate' }));
  assert.throws(() => updateProfile(state, { introduction: '', status: 'x'.repeat(41), asciiPresetId: 'ascii:cat', themeId: 'theme:slate' }));
  assert.equal(appendChat(state, '  ' + 'x'.repeat(400) + '  ', { now }).chatMessages[0]?.text.length, 400);
  assert.throws(() => appendChat(state, 'x'.repeat(401)));
  assert.throws(() => appendChat(state, '   '));
  assert.throws(() => appendChat(state, 'hello\n'));
  assert.equal(appendGuestbook(state, 'terminal:example:mina', 'x'.repeat(200), { now }).guestbookEntries[0]?.text.length, 200);
  assert.throws(() => appendGuestbook(state, 'terminal:example:mina', 'x'.repeat(201)));
});

test('immutable candidates, stable UUID retries, insertion order and target isolation', () => {
  const start = profile();
  const id = randomUUID();
  const chat = appendChat(start, '첫 글', { id, now });
  assert.equal(start.revision, 1);
  assert.equal(start.chatMessages.length, 0);
  assert.equal(chat.revision, 2);
  assert.throws(() => { chat.profile.status = 'mutated'; }, TypeError);
  assert.throws(() => { chat.chatMessages.push(chat.chatMessages[0]!); }, TypeError);
  assert.deepEqual(appendChat(chat, '첫 글', { id, now }), chat);
  assert.throws(() => appendChat(chat, '다른 글', { id, now }));
  assert.throws(() => appendGuestbook(chat, 'terminal:example:mina', '첫 글', { id, now }));
  const mina = appendGuestbook(chat, 'terminal:example:mina', 'Mina에게', { now });
  const jun = appendGuestbook(mina, 'terminal:example:jun', 'Jun에게', { now: '2020-01-01T00:00:00.000Z' });
  assert.deepEqual(jun.guestbookEntries.map(entry => entry.targetTerminalId), ['terminal:example:mina', 'terminal:example:jun']);
  assert.deepEqual(jun.guestbookEntries.filter(entry => entry.targetTerminalId === 'terminal:example:sol'), []);
  assert.deepEqual(jun.guestbookEntries.filter(entry => entry.targetTerminalId === 'terminal:example:mina').map(entry => entry.text), ['Mina에게']);
  assert.throws(() => appendGuestbook(start, 'terminal:local' as never, 'no'));
});

test('strict schema rejects unknown fields, versions, IDs, dates, types and duplicate UUIDs', () => {
  const good = appendChat(profile(), 'hello', { now });
  const invalid: unknown[] = [null, {}, [], { ...good, schemaVersion: 2 }, { ...good, revision: 0 }, { ...good, revision: 1.5 }, { ...good, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...good, extra: true }, { ...good, profile: null }, { ...good, chatMessages: null }, { ...good, chatMessages: Array(1) }];
  for (const [key, value] of Object.entries({ id: 'example:mina', nickname: 'é', introduction: 5, status: '\u202e', asciiPresetId: 'ascii:unknown', themeId: 'theme:unknown', createdAt: '2026-02-30T00:00:00.000Z', updatedAt: '2026-10-23' })) {
    invalid.push({ ...good, profile: { ...good.profile, [key]: value } });
  }
  for (const [key, value] of Object.entries({ id: 'not-uuid', origin: 'example', authorId: 'example:mina', roomId: 'space:lobby', text: '', createdAt: 'not-date', extra: true })) {
    invalid.push({ ...good, chatMessages: [{ ...good.chatMessages[0], [key]: value }] });
  }
  invalid.push({ ...good, guestbookEntries: [{ id: randomUUID(), origin: 'local', authorId: 'user:local', targetTerminalId: 'terminal:unknown', text: 'no', createdAt: now }] });
  invalid.push({ ...good, chatMessages: [...good.chatMessages, ...good.chatMessages] });
  invalid.push({ ...good, guestbookEntries: [{ ...good.chatMessages[0], roomId: undefined, targetTerminalId: 'terminal:example:mina' }] });
  const duplicate = appendGuestbook(good, 'terminal:example:mina', 'hi', { now });
  const changed = clone(duplicate);
  changed.guestbookEntries[0]!.id = changed.chatMessages[0]!.id.toUpperCase();
  invalid.push(changed);
  for (const value of invalid) assert.throws(() => validateState(value));
  assert.deepEqual(validateState(good), good);
});

test('counts enforce hard limits without rolling or truncating histories', () => {
  const base = profile();
  const chats = Array.from({ length: LIMITS.messages }, () => ({ id: randomUUID(), origin: 'local' as const, authorId: 'user:local' as const, roomId: 'space:rooftop' as const, text: 'x', createdAt: now }));
  const full = validateState({ ...base, chatMessages: chats });
  assert.throws(() => appendChat(full, 'one too many'));
  assert.equal(full.chatMessages.length, LIMITS.messages);
  const entries = Array.from({ length: LIMITS.guestbooks }, () => ({ id: randomUUID(), origin: 'local' as const, authorId: 'user:local' as const, targetTerminalId: 'terminal:example:sol' as const, text: 'x', createdAt: now }));
  const guestFull = validateState({ ...base, guestbookEntries: entries });
  assert.throws(() => appendGuestbook(guestFull, 'terminal:example:mina', 'one too many'));
  assert.equal(guestFull.guestbookEntries.length, LIMITS.guestbooks);
});

test('save transitions reject stale revisions, edits to history and nickname changes', () => {
  const initial = profile();
  validateTransition(null, initial);
  const chat = appendChat(initial, 'hello', { now });
  validateTransition(initial, chat);
  assert.throws(() => validateTransition(initial, initial));
  assert.throws(() => validateTransition(null, chat));
  const changed = clone(chat);
  changed.revision += 1;
  changed.chatMessages[0]!.text = 'rewritten';
  assert.throws(() => validateTransition(chat, changed));
  const renamed = clone(initial);
  renamed.revision += 1;
  renamed.profile.nickname = 'different';
  assert.throws(() => validateTransition(initial, renamed));
  const multi = appendChat(chat, 'second', { now });
  assert.throws(() => validateTransition(initial, multi));
});

test('catalog contains immutable example-only seeds and exact preset art', () => {
  assert.deepEqual(EXAMPLE_USERS.map(user => user.terminalId), ['terminal:example:mina', 'terminal:example:jun', 'terminal:example:sol']);
  assert.deepEqual(SEED_CHAT_MESSAGES.map(message => message.id), ['seed:rooftop:welcome', 'seed:rooftop:local-only']);
  assert.ok(SEED_CHAT_MESSAGES.every(message => message.origin === 'example' && !('createdAt' in message)));
  assert.equal(ASCII_PRESETS['ascii:cat'].art, ' /\\_/\\\n( o.o )\n > ^ <');
  for (const preset of Object.values(ASCII_PRESETS)) {
    assert.equal(preset.art.split('\n').length, 3);
    assert.ok(preset.art.split('\n').every(line => textWidth(line) <= 11));
    assert.ok(Object.isFrozen(preset));
  }
  assert.equal(Object.keys(THEMES).length, 3);
  assert.equal(profile().chatMessages.length, 0);
  assert.equal(profile().guestbookEntries.length, 0);
});
