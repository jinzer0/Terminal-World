import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAccountName, parseAsciiArt, parsePassword, parseProjectUrl, parseRecoveryCode, parseTechnologyStack, parseText, parseTheme, ValidationError, type TextField } from '../src/service/validation.js';

test('service account names preserve display case and normalize uniqueness keys', () => {
  assert.deepEqual(parseAccountName('loginId', 'Demo_User-01'), { value: 'Demo_User-01', lookupKey: 'demo_user-01' });
  assert.deepEqual(parseAccountName('nickname', '가나Ab'), { value: '가나Ab', lookupKey: '가나ab' });
  assert.equal(parseAccountName('nickname', '한'.repeat(12)).value.length, 12);
  assert.equal(parseAccountName('loginId', 'a'.repeat(20)).value.length, 20);
  for (const value of ['abc', 'a'.repeat(21), 'abcd ', '한글아이디', 'abcd\n', 'ab.cd', '', null]) {
    assert.throws(() => parseAccountName('loginId', value), ValidationError);
  }
  for (const value of ['가', '한'.repeat(13), 'ㄱㄴ', '가나 ', 'éé', '가나👩‍💻', '가나\n']) {
    assert.throws(() => parseAccountName('nickname', value), ValidationError);
  }
});

test('service passwords allow every printable punctuation but enforce length and three categories', () => {
  assert.equal(parsePassword('Aa12345678'), 'Aa12345678');
  assert.equal(parsePassword('aaaaaaaa1!'), 'aaaaaaaa1!');
  const punctuation = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).filter(char => !/[A-Za-z0-9]/.test(char));
  for (const char of punctuation) assert.equal(parsePassword(`Aa1234567${char}`), `Aa1234567${char}`);
  assert.equal(parsePassword('Aa1' + 'x'.repeat(21)).length, 24);
  for (const value of ['Aa1234567', 'Aa1' + 'x'.repeat(22), 'aaaaaaaaaa', 'Aaaaaaaaaa', 'Aa1234567 ', 'Aa1234567\n', 'Aa1234567\t', 'Aa1234567가', 'Ka12345678', undefined]) {
    assert.throws(() => parsePassword(value), ValidationError);
  }
});

test('service text uses NFC code points instead of grapheme clusters and keeps original whitespace', () => {
  assert.equal(parseText('chat', 'é'.repeat(500)), 'é'.repeat(500));
  assert.equal(parseText('chat', '👩‍💻'.repeat(166)), '👩‍💻'.repeat(166));
  assert.throws(() => parseText('chat', '👩‍💻'.repeat(167)), ValidationError);
  assert.equal(parseText('body', '  본문\n다음 줄  '), '  본문\n다음 줄  ');
  assert.equal(parseText('comment', '한글 😀\n댓글'), '한글 😀\n댓글');
  assert.throws(() => parseText('chat', 'x'.repeat(501)), ValidationError);
});

test('service text limits apply at their exact specified boundaries without truncation', () => {
  const limits: [TextField, number][] = [['title', 100], ['body', 10_000], ['comment', 1_000], ['guestbook', 1_000], ['chat', 500], ['reason', 1_000], ['introduction', 500], ['status', 80], ['technology', 20]];
  for (const [field, limit] of limits) {
    assert.equal(parseText(field, '한'.repeat(limit)), '한'.repeat(limit));
    assert.throws(() => parseText(field, '한'.repeat(limit + 1)), ValidationError);
  }
  for (const field of ['title', 'body', 'comment', 'guestbook', 'chat', 'reason', 'technology'] as const) {
    for (const value of ['', '   ', '\n']) assert.throws(() => parseText(field, value), ValidationError);
  }
  assert.equal(parseText('introduction', ''), '');
  assert.equal(parseText('status', ''), '');
});

test('service text rejects terminal escapes, controls and malformed Unicode at the shared boundary', () => {
  for (const value of ['\t', '\r', '\x00', '\x1b[31m', '\x1b]52;c;secret\x07', '\x7f', '\x85', '\u2028', '\u202e', '\ud800', '\udfff']) {
    assert.throws(() => parseText('body', '내용' + value), ValidationError);
  }
  for (const field of ['title', 'chat', 'status', 'technology', 'projectUrl'] as const) {
    assert.throws(() => parseText(field, '내용\n다음'), ValidationError);
  }
  for (const value of [null, 123, {}, [], true]) assert.throws(() => parseText('body', value), ValidationError);
});

test('service stack validates all ten items, rejects sparse arrays and returns a fresh array', () => {
  const stack = Array.from({ length: 10 }, () => 'a'.repeat(20));
  const parsed = parseTechnologyStack(stack);
  assert.deepEqual(parsed, stack);
  assert.notEqual(parsed, stack);
  assert.deepEqual(parseTechnologyStack([]), []);
  assert.deepEqual(parseTechnologyStack(['é']), ['é']);
  for (const value of [[...stack, 'extra'], ['a'.repeat(21)], [''], [' '], ['Type\nScript'], [undefined], Array(1), null, 'TypeScript']) {
    assert.throws(() => parseTechnologyStack(value), ValidationError);
  }
});

test('service project URL is optional, HTTPS-only, single-line and at most 2048 code points', () => {
  assert.equal(parseProjectUrl(''), '');
  const url = 'https://example.com/path?q=1#part';
  assert.equal(parseProjectUrl(url), url);
  const max = 'https://example.com/' + 'x'.repeat(2_048 - 'https://example.com/'.length);
  assert.equal(parseProjectUrl(max), max);
  for (const value of [max + 'x', 'http://example.com', 'javascript:alert(1)', 'https:example.com', 'https://', 'https://example.com/a b', 'https://example.com\n', 'https://a.example https://b.example']) {
    assert.throws(() => parseProjectUrl(value), ValidationError);
  }
});

test('service ASCII art allows manual printable art within 40 columns and 12 lines', () => {
  const max = Array.from({ length: 12 }, () => '~'.repeat(40)).join('\n');
  assert.equal(parseAsciiArt(max), max);
  assert.equal(parseAsciiArt(''), '');
  assert.equal(parseAsciiArt(' /\\_/\\\n( o.o )'), ' /\\_/\\\n( o.o )');
  for (const value of ['a'.repeat(41), Array.from({ length: 13 }, () => 'a').join('\n'), '가', '😀', '\t', '\r\n', '\x1b[31m', '\x7f']) {
    assert.throws(() => parseAsciiArt(value), ValidationError);
  }
});

test('service themes match the four requirements themes and default to dark', () => {
  assert.equal(parseTheme(), 'dark');
  for (const value of ['dark', 'light', 'green', 'amber'] as const) assert.equal(parseTheme(value), value);
  for (const value of ['teal', 'slate', '#00ff41', '', null]) assert.throws(() => parseTheme(value), ValidationError);
});

test('service recovery codes accept either documented representation without changing their value', () => {
  const code = 'ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2-3456-789A';
  const raw = code.replaceAll('-', '');
  assert.equal(parseRecoveryCode(code.toLowerCase()), raw);
  assert.equal(parseRecoveryCode(raw), raw);
  for (const value of [code.replace('A', 'I'), code.replace('A', 'L'), code.replace('A', 'O'), code.replace('A', '0'), code.replace('A', '1'), code.replace('S', 'ſ'), code.replace('K', 'K'), raw.slice(1), raw + 'A', raw + '\n', ' ' + raw, '-' + code, code.replace('-', '')]) {
    assert.throws(() => parseRecoveryCode(value), ValidationError);
  }
});

test('service validation errors identify fields without including secret input', () => {
  const secret = 'bad-secret';
  assert.throws(() => parsePassword(secret), error => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.field, 'password');
    assert.equal(error.code, 'INVALID_INPUT');
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});
