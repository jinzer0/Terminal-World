import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { ASCII_PRESETS, EXAMPLE_USERS, LIMITS, PALETTE, THEMES } from './catalog.js';
import { appendChat, appendGuestbook, createProfile, graphemes, inputError, updateProfile, type ProfileEdits, type StateV1 } from './model.js';
import { StorageError } from './storage.js';
import { inputActions, TextInput, type InputAction } from './ui/Input.js';
import { Shell } from './ui/Shell.js';
import { Action, Lobby, PersonalTerminal, RoofTop, type ViewProps } from './ui/Views.js';
import { createViewLayout } from './ui/layout.js';

export type AppProps = { initial: StateV1 | null; commit: (candidate: StateV1) => Promise<StateV1>; requestShutdown: () => Promise<void>; isStopping: () => boolean };
type Operation = { candidate: StateV1; kind: 'onboard' | 'profile' | 'message' };
type UIState = {
  committed: StateV1 | null;
  route: number;
  nav: number;
  focus: string;
  action: number;
  scroll: number;
  nickname: string;
  edits: ProfileEdits | null;
  draft: string;
  cursors: Record<string, number>;
  notice: string;
  pending: boolean;
  failed: Operation | null;
  uncertain: boolean;
  request: 'save' | 'quit' | null;
};
type Event =
  | { type: 'key'; action: InputAction }
  | { type: 'paste'; text: string }
  | { type: 'focus'; focus: string }
  | { type: 'navigate'; index: number; open: boolean }
  | { type: 'activate'; index: number }
  | { type: 'choose'; field: 'asciiPresetId' | 'themeId'; value: string }
  | { type: 'scroll'; amount: number }
  | { type: 'clamp'; max: number }
  | { type: 'begin'; operation: Operation }
  | { type: 'success'; state: StateV1; operation: Operation }
  | { type: 'failure'; message: string; uncertain: boolean }
  | { type: 'notice'; message: string };
const formFields = ['form:introduction', 'form:status', 'form:asciiPresetId', 'form:themeId', 'form:save', 'form:cancel'];
const guardedNotice = '먼저 저장/전송하거나 Esc로 취소하세요';
const isComposer = (s: UIState) => s.focus.startsWith('composer:');
const composerTarget = (s: UIState) => s.route === 1 ? 'space:rooftop' : EXAMPLE_USERS[s.route - 3]!.terminalId;
function profileEdits(state: StateV1): ProfileEdits {
  const { introduction, status, asciiPresetId, themeId } = state.profile;
  return { introduction, status, asciiPresetId, themeId };
}
function dirty(s: UIState): boolean {
  return s.committed === null ? s.nickname.length > 0 : s.draft.length > 0 || (s.edits !== null && JSON.stringify(s.edits) !== JSON.stringify(profileEdits(s.committed)));
}
function textField(s: UIState): { value: string; limit: number; maxCells?: number } | null {
  if (!s.committed && s.focus === 'onboard:nickname') return { value: s.nickname, limit: LIMITS.nickname, maxCells: LIMITS.nicknameCells };
  if (s.edits && s.focus === 'form:introduction') return { value: s.edits.introduction, limit: LIMITS.introduction };
  if (s.edits && s.focus === 'form:status') return { value: s.edits.status, limit: LIMITS.status };
  if (isComposer(s) && s.focus === `composer:${composerTarget(s)}`) return { value: s.draft, limit: s.route === 1 ? LIMITS.chat : LIMITS.guestbook };
  return null;
}
function replaceText(s: UIState, value: string, cursor: number): UIState {
  const next = { ...s, cursors: { ...s.cursors, [s.focus]: cursor }, notice: '', failed: null };
  if (!s.committed) return { ...next, nickname: value };
  if (s.edits && (s.focus === 'form:introduction' || s.focus === 'form:status')) return { ...next, edits: { ...s.edits, [s.focus.slice(5)]: value } };
  return { ...next, draft: value };
}
function focus(s: UIState, value: string): UIState {
  if ((s.edits || isComposer(s)) && value === 'content') return s;
  return { ...s, focus: value };
}
function cancel(s: UIState): UIState {
  if (s.uncertain) return { ...s, notice: '저장 결과 불확실 · 동일 작업 재시도로 확인하세요. 초안을 취소할 수 없어요.' };
  return { ...s, edits: null, draft: '', focus: 'content', failed: null, notice: '미저장 초안을 취소했어요.', action: 0 };
}
function navigate(s: UIState, index: number, open: boolean): UIState {
  if (s.edits || isComposer(s)) {
    if (dirty(s) || s.failed) return { ...s, notice: guardedNotice };
    s = cancel(s);
  }
  return { ...s, nav: index, focus: 'sidebar', ...(open ? { route: index, action: 0, scroll: 0 } : {}) };
}
function activate(s: UIState, index: number): UIState {
  if (!s.committed) return index === 1 ? { ...s, request: 'quit' } : { ...s, request: 'save' };
  if (s.edits || isComposer(s)) return index === 1 ? cancel(s) : { ...s, request: 'save' };
  if (s.route === 0) return { ...navigate(s, index + 3, true), focus: 'content' };
  if (s.route === 2) return { ...s, edits: profileEdits(s.committed), focus: formFields[0]!, notice: '', failed: null };
  const next = { ...s, draft: '', notice: '', failed: null };
  return { ...next, focus: `composer:${composerTarget(next)}` };
}
function cycle(s: UIState, reverse: boolean): UIState {
  let fields: string[];
  if (!s.committed) fields = ['onboard:nickname', 'onboard:save', 'onboard:cancel'];
  else if (s.edits) fields = formFields;
  else if (isComposer(s)) fields = [`composer:${composerTarget(s)}`, 'composer:send', 'composer:cancel'];
  else fields = ['sidebar', 'content'];
  const index = Math.max(0, fields.indexOf(s.focus));
  return { ...s, focus: fields[(index + (reverse ? fields.length - 1 : 1)) % fields.length]! };
}
/** Pure UI transition. IDs, timestamps, persistence and shutdown belong to dispatch. */
function reduce(s: UIState, event: Event): UIState {
  if (event.type === 'success') {
    const onboard = event.operation.kind === 'onboard';
    return { ...s, committed: event.state, pending: false, failed: null, uncertain: false, edits: null, draft: '', nickname: '', focus: 'content', route: onboard ? 2 : s.route, nav: onboard ? 2 : s.nav, action: 0, scroll: event.operation.kind === 'message' ? Number.MAX_SAFE_INTEGER : s.scroll, notice: '로컬 저장 완료 · 원격 전달 없음' };
  }
  if (event.type === 'failure') return { ...s, pending: false, uncertain: event.uncertain, notice: `${event.message} · 동일 작업: 저장/전송 버튼으로 재시도` };
  if (event.type === 'begin') return { ...s, pending: true, failed: event.operation, request: null, notice: '로컬 저장 중 · 초안 보존 중' };
  if (event.type === 'notice') return { ...s, notice: event.message, request: null };
  if (event.type === 'clamp') return s.scroll > event.max ? { ...s, scroll: event.max } : s;
  if (event.type === 'key' && (event.action.kind === 'quit' || event.action.kind === 'escape' && !s.committed)) return { ...s, request: 'quit', notice: dirty(s) ? '미저장 초안은 저장되지 않아요. 종료 중…' : '종료 중…' };
  if (s.pending) return s;
  if (s.uncertain) {
    if (event.type === 'key' && event.action.kind === 'save' && isComposer(s)) return { ...s, notice: '전송은 Enter를 사용하세요. Ctrl+S는 전송하지 않아요.' };
    const retry = event.type === 'activate' && event.index === 0 || event.type === 'key' && (event.action.kind === 'save' || event.action.kind === 'submit');
    return retry ? { ...s, request: 'save' } : { ...s, notice: '저장 결과 불확실 · 동일 candidate/UUID 재시도만 가능해요. Enter로 확인 · Ctrl+C 종료' };
  }
  if (event.type === 'focus') return focus(s, event.focus);
  if (event.type === 'navigate') return navigate(s, event.index, event.open);
  if (event.type === 'activate') return activate(s, event.index);
  if (event.type === 'scroll') return { ...s, scroll: Math.max(0, s.scroll + event.amount) };
  if (event.type === 'choose') return s.edits ? { ...s, edits: { ...s.edits, [event.field]: event.value }, focus: `form:${event.field}`, notice: '', failed: null } : s;
  if (event.type === 'paste' || event.type === 'key' && event.action.kind === 'text') {
    const field = textField(s);
    if (!field) return s;
    const text = event.type === 'paste' ? event.text : event.action.kind === 'text' ? event.action.text : '';
    const parts = graphemes(field.value);
    const cursor = Math.min(s.cursors[s.focus] ?? parts.length, parts.length);
    const value = parts.slice(0, cursor).join('') + text + parts.slice(cursor).join('');
    const error = inputError(value, field.limit, field.maxCells);
    return error ? { ...s, notice: error } : replaceText(s, value, graphemes(parts.slice(0, cursor).join('') + text).length);
  }
  if (event.type !== 'key') return s;
  const action = event.action;
  if (action.kind === 'tab') return cycle(s, action.reverse);
  if (action.kind === 'escape') {
    if (!s.committed) return { ...s, request: 'quit' };
    if (s.edits || isComposer(s)) return cancel(s);
    if (s.focus === 'content' && s.route === 0) return { ...s, focus: 'sidebar' };
    return { ...s, route: 0, nav: 0, scroll: 0, action: 0, focus: s.focus === 'sidebar' ? 'sidebar' : 'content' };
  }
  if (action.kind === 'save') {
    if (isComposer(s)) return { ...s, notice: '전송은 Enter를 사용하세요. Ctrl+S는 전송하지 않아요.' };
    return !s.committed || s.edits ? { ...s, request: 'save' } : s;
  }
  if (action.kind === 'submit') {
    if (!s.committed) return activate(s, s.focus === 'onboard:cancel' ? 1 : 0);
    if (s.edits) {
      const index = formFields.indexOf(s.focus);
      if (index < 4) return cycle(s, false);
      return activate(s, index === 5 ? 1 : 0);
    }
    if (isComposer(s)) return activate(s, s.focus === 'composer:cancel' ? 1 : 0);
    return s.focus === 'sidebar' ? navigate(s, s.nav, true) : activate(s, s.action);
  }
  const field = textField(s);
  if (field) {
    const parts = graphemes(field.value);
    const cursor = Math.min(s.cursors[s.focus] ?? parts.length, parts.length);
    if (action.kind === 'left' || action.kind === 'right' || action.kind === 'home' || action.kind === 'end') {
      const next = action.kind === 'home' ? 0 : action.kind === 'end' ? parts.length : Math.max(0, Math.min(parts.length, cursor + (action.kind === 'left' ? -1 : 1)));
      return { ...s, cursors: { ...s.cursors, [s.focus]: next } };
    }
    if (action.kind === 'backspace' && cursor > 0) return replaceText(s, [...parts.slice(0, cursor - 1), ...parts.slice(cursor)].join(''), cursor - 1);
    if (action.kind === 'delete') return replaceText(s, [...parts.slice(0, cursor), ...parts.slice(cursor + 1)].join(''), cursor);
    return s;
  }
  if (action.kind === 'up' || action.kind === 'down') {
    const delta = action.kind === 'up' ? -1 : 1;
    if (s.edits && (s.focus === 'form:asciiPresetId' || s.focus === 'form:themeId')) {
      const field = s.focus === 'form:asciiPresetId' ? 'asciiPresetId' : 'themeId';
      const keys = Object.keys(field === 'asciiPresetId' ? ASCII_PRESETS : THEMES);
      const index = keys.indexOf(s.edits[field]);
      return reduce(s, { type: 'choose', field, value: keys[(index + delta + keys.length) % keys.length]! });
    }
    if (s.focus === 'sidebar') return { ...s, nav: Math.max(0, Math.min(5, s.nav + delta)) };
    if (s.focus === 'content') return { ...s, action: Math.max(0, Math.min(s.route === 0 ? 2 : 0, s.action + delta)) };
  }
  if (s.focus === 'content' && (action.kind === 'home' || action.kind === 'end')) return { ...s, scroll: action.kind === 'home' ? 0 : Number.MAX_SAFE_INTEGER };
  return s;
}

export function App({ initial, commit, requestShutdown, isStopping }: AppProps) {
  const { columns, rows } = useWindowSize();
  const [state, setState] = useState<UIState>(() => ({ committed: initial, route: 2, nav: 2, focus: initial ? 'content' : 'onboard:nickname', action: 0, scroll: 0, nickname: '', edits: null, draft: '', cursors: {}, notice: '권장 100×30 · Ctrl+C 종료', pending: false, failed: null, uncertain: false, request: null }));
  const stateRef = useRef(state);
  const layoutRef = useRef<ReturnType<typeof createViewLayout> | null>(null);
  if (layoutRef.current === null) layoutRef.current = createViewLayout();
  const sizeRef = useRef({ columns, rows });
  sizeRef.current = { columns, rows };
  const width = Math.max(2, columns - 29);
  const height = Math.max(1, rows - 7);
  function maxScroll(s: UIState): number {
    if (!s.committed) return 0;
    const lines = layoutRef.current!(s.committed, s.route, s.edits, Math.max(2, sizeRef.current.columns - 29));
    const controls = s.route === 0 ? 3 : s.edits ? 10 : isComposer(s) ? 4 : 1;
    return Math.max(0, lines.length - Math.max(1, sizeRef.current.rows - 7 - controls));
  }
  function apply(next: UIState) { stateRef.current = next; setState(next); }
  function dispatch(event: Event) {
    const settling = event.type === 'success' || event.type === 'failure';
    if (!settling && isStopping()) return;
    const quit = event.type === 'key' && event.action.kind === 'quit' || event.type === 'key' && event.action.kind === 'escape' && stateRef.current.committed === null;
    if (!settling && event.type !== 'clamp' && !quit && (sizeRef.current.columns < 80 || sizeRef.current.rows < 24)) return;
    let next = reduce(stateRef.current, event);
    const request = next.request;
    next = { ...next, request: null };
    if (request === 'quit') {
      apply(next);
      void requestShutdown().catch(error => apply(reduce(stateRef.current, { type: 'notice', message: error instanceof Error ? error.message : String(error) })));
      return;
    }
    next = { ...next, scroll: Math.min(next.scroll, maxScroll(next)) };
    apply(next);
    if (request !== 'save') return;
    let operation = next.failed;
    try {
      if (!operation) {
        if (!next.committed) operation = { kind: 'onboard', candidate: createProfile(next.nickname) };
        else if (next.edits) operation = { kind: 'profile', candidate: updateProfile(next.committed, next.edits) };
        else if (isComposer(next)) operation = { kind: 'message', candidate: next.route === 1 ? appendChat(next.committed, next.draft) : appendGuestbook(next.committed, EXAMPLE_USERS[next.route - 3]!.terminalId, next.draft) };
        else return;
      }
      apply(reduce(stateRef.current, { type: 'begin', operation }));
      // Invoke synchronously: CLI must register pending before any following signal.
      const pending = commit(operation.candidate);
      const requested = operation;
      void pending.then(saved => dispatch({ type: 'success', state: saved, operation: requested }), error => dispatch({ type: 'failure', message: error instanceof Error ? error.message : String(error), uncertain: error instanceof StorageError && error.uncertain }));
    } catch (error) {
      apply(reduce(stateRef.current, { type: 'failure', message: error instanceof Error ? error.message : String(error), uncertain: error instanceof StorageError && error.uncertain }));
    }
  }
  useEffect(() => { dispatch({ type: 'clamp', max: maxScroll(stateRef.current) }); }, [columns, rows]);
  useInput((input, key) => {
    for (const action of inputActions(input, key)) {
      if (action.kind === 'pageUp' || action.kind === 'pageDown') {
        const current = stateRef.current;
        if (current.focus === 'content') {
          const controls = current.route === 0 ? 3 : 1;
          dispatch({ type: 'scroll', amount: (action.kind === 'pageUp' ? -1 : 1) * Math.max(1, sizeRef.current.rows - 7 - controls - 1) });
        }
      } else dispatch({ type: 'key', action });
    }
  });
  usePaste(text => dispatch({ type: 'paste', text }));
  const disabled = state.pending || isStopping() || columns < 80 || rows < 24;
  const cursor = state.cursors[state.focus] ?? graphemes(textField(state)?.value ?? '').length;
  if (!state.committed) {
    if (columns < 80 || rows < 24) return <Box width={columns} height={rows} flexDirection="column"><Text color={PALETTE.error}>80×24 이상으로 늘려 주세요</Text><Text>{columns}×{rows} · Ctrl+C 종료 · 작성 중인 내용은 유지돼요</Text></Box>;
    return <Box width={columns} height={rows} flexDirection="column" backgroundColor={PALETTE.background}>
      <Text color={PALETTE.text} bold>TERMINAL WORLD · 처음 입장</Text>
      <Text color={PALETTE.muted}>로컬 프로토타입 · 원격 전달 없음 · 권장 100×30</Text>
      <Text color={PALETTE.text}>닉네임 (1–16글자 / 24셀, 저장 후 변경 불가)</Text>
      <TextInput cursor={cursor} value={state.nickname} focused={state.focus === 'onboard:nickname'} disabled={disabled} width={Math.min(40, columns)} onFocus={() => dispatch({ type: 'focus', focus: 'onboard:nickname' })} />
      <Box><Action width={22} label="저장 후 입장 / 재시도" focused={state.focus === 'onboard:save'} disabled={disabled} onClick={() => dispatch({ type: 'activate', index: 0 })} /><Action width={12} label="취소 / 종료" focused={state.focus === 'onboard:cancel'} disabled={false} onClick={() => dispatch({ type: 'key', action: { kind: 'quit' } })} /></Box>
      <Text color={PALETTE.error} wrap="truncate-end">{state.notice}</Text>
      <Text color={PALETTE.muted}>포커스: {state.focus} · Tab/Shift+Tab 이동 · Enter 입장 · Esc/Ctrl+C 종료</Text>
    </Box>;
  }
  const items = [{ id: 'space:lobby', label: '로비' }, { id: 'space:rooftop', label: 'RoofTop' }, { id: 'terminal:local', label: '내 터미널' }, ...EXAMPLE_USERS.map(user => ({ id: user.terminalId, label: `${user.nickname} · 예시` }))];
  const lines = layoutRef.current(state.committed, state.route, state.edits, width);
  const props: ViewProps = { state: state.committed, lines, width, height, scroll: state.scroll, focus: state.focus, action: state.action, disabled, draft: state.draft, cursor, edits: state.edits, notice: state.notice, onFocus: focus => dispatch({ type: 'focus', focus }), onAction: index => dispatch({ type: 'activate', index }), onVisit: index => dispatch({ type: 'navigate', index, open: true }), onChoose: (field, value) => dispatch({ type: 'choose', field, value }) };
  const help = state.edits ? 'Tab 필드 · ↑↓ 선택 · Ctrl+S 저장 · Esc 취소' : isComposer(state) ? 'Enter 전송 · Tab 전송/취소 · Esc 취소' : state.focus === 'sidebar' ? '↑↓ 선택 · Enter 열기 · Tab 본문 · Esc 로비 · Ctrl+C 종료' : '↑↓ 행동 · Enter 실행 · PgUp/Dn 스크롤 · Home/End · Tab 목록 · Esc 로비';
  return <Shell items={items} cursor={state.nav} activeId={items[state.route]!.id} focus={state.focus} disabled={disabled} title={items[state.route]!.label} status={state.notice} help={help} onNavigate={(index, open) => dispatch({ type: 'navigate', index, open })} onContentFocus={() => dispatch({ type: 'focus', focus: 'content' })} onScroll={direction => dispatch({ type: 'scroll', amount: direction * 3 })}>
    {state.route === 0 ? <Lobby {...props} /> : state.route === 1 ? <RoofTop {...props} /> : <PersonalTerminal {...props} index={state.route} />}
  </Shell>;
}
