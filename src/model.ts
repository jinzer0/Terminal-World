import { randomUUID } from 'node:crypto';
import stringWidth from 'string-width';
import { ASCII_PRESETS, DEFAULT_PROFILE, EXAMPLE_USERS, LIMITS, THEMES, type AsciiPresetId, type ExampleTerminalId, type ThemeId } from './catalog.js';

export type Profile = { id: 'user:local'; nickname: string; introduction: string; status: string; asciiPresetId: AsciiPresetId; themeId: ThemeId; createdAt: string; updatedAt: string };
export type ChatMessage = { id: string; origin: 'local'; authorId: 'user:local'; roomId: 'space:rooftop'; text: string; createdAt: string };
export type GuestbookEntry = { id: string; origin: 'local'; authorId: 'user:local'; targetTerminalId: ExampleTerminalId; text: string; createdAt: string };
export type StateV1 = { schemaVersion: 1; revision: number; profile: Profile; chatMessages: ChatMessage[]; guestbookEntries: GuestbookEntry[] };
export type ProfileEdits = Pick<Profile, 'introduction' | 'status' | 'asciiPresetId' | 'themeId'>;
export type OperationOptions = { now?: string; id?: string };
const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function graphemes(value: string): string[] { return Array.from(segmenter.segment(value), part => part.segment); }
export function textWidth(value: string): number { return stringWidth(value); }
export function inputError(value: string, limit: number, maxCells?: number): string | undefined {
  if (unsafeText.test(value)) return '제어문자와 줄바꿈은 입력할 수 없어요.';
  if (graphemes(value).length > limit) return `${limit}글자까지 입력할 수 있어요.`;
  if (maxCells !== undefined && textWidth(value) > maxCells) return `표시 폭은 ${maxCells}칸까지 가능해요.`;
  return undefined;
}
function fail(message: string): never { throw new Error(`데이터 검증 실패: ${message}`); }
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) fail(`${label}: 알 수 없거나 누락된 필드`);
  return object;
}
function text(value: unknown, limit: number, required = false, cells?: number): string {
  if (typeof value !== 'string') fail('문자열 필요');
  const error = inputError(value, limit, cells);
  if (error) fail(error);
  if (value !== value.normalize('NFC')) fail('NFC 문자열 필요');
  if (required && (!value.trim() || value !== value.trim())) fail('빈 값 또는 앞뒤 공백');
  return value;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('UTC ISO 날짜 필요');
  return value;
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail('알 수 없는 ID');
  return value as T;
}
export function validateState(value: unknown): StateV1 {
  const state = record(value, ['schemaVersion', 'revision', 'profile', 'chatMessages', 'guestbookEntries'], 'state');
  if (state.schemaVersion !== 1) fail('지원하지 않는 버전');
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 1) fail('revision');
  const p = record(state.profile, ['id', 'nickname', 'introduction', 'status', 'asciiPresetId', 'themeId', 'createdAt', 'updatedAt'], 'profile');
  const profile: Profile = { id: member(p.id, ['user:local']), nickname: text(p.nickname, LIMITS.nickname, true, LIMITS.nicknameCells), introduction: text(p.introduction, LIMITS.introduction), status: text(p.status, LIMITS.status), asciiPresetId: member(p.asciiPresetId, Object.keys(ASCII_PRESETS) as AsciiPresetId[]), themeId: member(p.themeId, Object.keys(THEMES) as ThemeId[]), createdAt: date(p.createdAt), updatedAt: date(p.updatedAt) };
  if (!Array.isArray(state.chatMessages) || state.chatMessages.length > LIMITS.messages || !Array.isArray(state.guestbookEntries) || state.guestbookEntries.length > LIMITS.guestbooks) fail('기록 개수 제한');
  const ids = new Set<string>();
  function common(entry: Record<string, unknown>, limit: number) {
    if (typeof entry.id !== 'string' || !uuid.test(entry.id) || ids.has(entry.id.toLowerCase())) fail('중복 또는 잘못된 UUID');
    ids.add(entry.id.toLowerCase());
    return { id: entry.id, origin: member(entry.origin, ['local']), authorId: member(entry.authorId, ['user:local']), text: text(entry.text, limit, true), createdAt: date(entry.createdAt) };
  }
  const chatMessages = Array.from(state.chatMessages, value => { const e = record(value, ['id', 'origin', 'authorId', 'roomId', 'text', 'createdAt'], 'chat'); return { ...common(e, LIMITS.chat), roomId: member(e.roomId, ['space:rooftop']) }; });
  const guestbookEntries = Array.from(state.guestbookEntries, value => { const e = record(value, ['id', 'origin', 'authorId', 'targetTerminalId', 'text', 'createdAt'], 'guestbook'); return { ...common(e, LIMITS.guestbook), targetTerminalId: member(e.targetTerminalId, EXAMPLE_USERS.map(user => user.terminalId)) }; });
  const result: StateV1 = { schemaVersion: 1, revision: state.revision as number, profile, chatMessages, guestbookEntries };
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.fileBytes) fail('16 MiB 제한');
  Object.freeze(result.profile);
  result.chatMessages.forEach(Object.freeze);
  result.guestbookEntries.forEach(Object.freeze);
  Object.freeze(result.chatMessages);
  Object.freeze(result.guestbookEntries);
  return Object.freeze(result);
}
function normalized(value: string, trim = false): string {
  // Validate controls before trim so pasted newlines cannot silently disappear.
  if (unsafeText.test(value)) fail('제어문자와 줄바꿈');
  const result = value.normalize('NFC');
  return trim ? result.trim() : result;
}
export function createProfile(nickname: string, options: Pick<OperationOptions, 'now'> = {}): StateV1 {
  const now = options.now ?? new Date().toISOString();
  return validateState({ schemaVersion: 1, revision: 1, profile: { id: 'user:local', nickname: normalized(nickname, true), ...DEFAULT_PROFILE, createdAt: now, updatedAt: now }, chatMessages: [], guestbookEntries: [] });
}
export function updateProfile(state: StateV1, edits: ProfileEdits, options: Pick<OperationOptions, 'now'> = {}): StateV1 {
  const current = validateState(state);
  record(edits, ['introduction', 'status', 'asciiPresetId', 'themeId'], 'profile edits');
  return validateState({ ...current, revision: current.revision + 1, profile: { ...current.profile, ...edits, introduction: normalized(edits.introduction), status: normalized(edits.status), updatedAt: options.now ?? new Date().toISOString() } });
}
function append(state: StateV1, value: string, target: ExampleTerminalId | undefined, options: OperationOptions): StateV1 {
  const current = validateState(state);
  const id = options.id ?? randomUUID();
  const body = normalized(value, true);
  const existing = [...current.chatMessages, ...current.guestbookEntries].find(entry => entry.id.toLowerCase() === id.toLowerCase());
  if (existing) {
    if (existing.text !== body || ('targetTerminalId' in existing ? existing.targetTerminalId !== target : target !== undefined) || (options.now !== undefined && existing.createdAt !== options.now)) fail('동일 UUID의 다른 작업');
    return current;
  }
  const entry = { id, origin: 'local', authorId: 'user:local', text: body, createdAt: options.now ?? new Date().toISOString() };
  return validateState(target === undefined ? { ...current, revision: current.revision + 1, chatMessages: [...current.chatMessages, { ...entry, roomId: 'space:rooftop' }] } : { ...current, revision: current.revision + 1, guestbookEntries: [...current.guestbookEntries, { ...entry, targetTerminalId: target }] });
}
export function appendChat(state: StateV1, value: string, options: OperationOptions = {}): StateV1 { return append(state, value, undefined, options); }
export function appendGuestbook(state: StateV1, target: ExampleTerminalId, value: string, options: OperationOptions = {}): StateV1 { member(target, EXAMPLE_USERS.map(user => user.terminalId)); return append(state, value, target, options); }

/** Enforce append-only local history and the one-profile contract at the save boundary. */
export function validateTransition(previous: StateV1 | null, next: StateV1): void {
  if (next.revision !== (previous?.revision ?? 0) + 1) fail('revision 충돌');
  if (!previous) { if (next.chatMessages.length || next.guestbookEntries.length) fail('최초 프로필에 기록 불가'); return; }
  if (next.profile.nickname !== previous.profile.nickname || next.profile.createdAt !== previous.profile.createdAt) fail('프로필 소유권 변경');
  for (const key of ['chatMessages', 'guestbookEntries'] as const) {
    if (next[key].length < previous[key].length || previous[key].some((entry, i) => JSON.stringify(entry) !== JSON.stringify(next[key][i]))) fail('기존 기록 변경');
  }
  const added = next.chatMessages.length - previous.chatMessages.length + next.guestbookEntries.length - previous.guestbookEntries.length;
  if (added > 1 || (added === 1 && JSON.stringify(next.profile) !== JSON.stringify(previous.profile))) fail('한 번에 한 작업만 저장');
}
