import { ASCII_PRESETS, EXAMPLE_USERS, SEED_CHAT_MESSAGES } from '../catalog.js';
import { graphemes, textWidth, type ChatMessage, type GuestbookEntry, type ProfileEdits, type StateV1 } from '../model.js';

/** Each grapheme is measured once; explicit newlines (including ASCII art) survive. */
export function wrapLines(values: readonly string[], width: number): string[] {
  return wrapMeasuredLines(values, width, textWidth);
}

function wrapMeasuredLines(values: readonly string[], width: number, measure: (part: string) => number): string[] {
  const lines: string[] = [];
  const cells = Math.max(1, width);
  for (const value of values) {
    for (const paragraph of value.split('\n')) {
      let line = '';
      let used = 0;
      for (const part of graphemes(paragraph)) {
        const size = measure(part);
        if (used + size > cells && line) { lines.push(line); line = ''; used = 0; }
        line += part;
        used += size;
      }
      lines.push(line);
    }
  }
  return lines;
}

function lobbyLines(): string[] {
  return ['로비 · 로컬 프로토타입', '예시 사용자 · 실제 접속 아님', 'RoofTop에서 내 기기에만 남는 채팅을 작성하세요.', '내 터미널에서 소개와 상태, ASCII와 테마를 꾸미세요.'];
}
function localHeader(state: StateV1, entry: ChatMessage | GuestbookEntry): string {
  return `${state.profile.nickname} · 로컬 · ${new Date(entry.createdAt).toLocaleString()}`;
}
function profileLines(state: StateV1, route: number, edits: ProfileEdits | null): string[] {
  const owner = route === 2 ? { ...state.profile, ...edits } : EXAMPLE_USERS[route - 3]!;
  return [`${owner.nickname} · ${route === 2 ? '내 터미널 / 로컬' : '예시 사용자 · 실제 접속 아님'}`, owner.introduction, `상태: ${owner.status}`, ASCII_PRESETS[owner.asciiPresetId].art];
}
type EntryRows = { text: string; date: string; nickname: string; rows: readonly string[] };
type RouteRows = { state: StateV1; preview: string; rows: readonly string[] };
type WidthCache = { routes: Map<number, RouteRows>; entries: Map<string, EntryRows>; texts: Map<string, readonly string[]> };

/** Per-App LRU: two widths, six latest route snapshots per width, at most 20,000
 * entry layouts and 512 shared text layouts per width. No process-global history.
 * Entry IDs plus content survive model validation's immutable object recreation.
 * Width-independent measurements use one scalar table (width + 1; zero means
 * unmeasured) and a 512-entry complex-grapheme LRU shared across both widths.
 */
export function createViewLayout(): (state: StateV1, route: number, edits: ProfileEdits | null, width: number) => readonly string[] {
  const widths = new Map<number, WidthCache>();
  const scalarWidths = new Uint8Array(0x110000);
  const complexWidths = new Map<string, number>();
  const measure = (part: string): number => {
    const scalar = part.codePointAt(0);
    if (scalar !== undefined && part.length === (scalar > 0xffff ? 2 : 1)) {
      const cached = scalarWidths[scalar]!;
      if (cached !== 0) return cached - 1;
      const size = textWidth(part);
      scalarWidths[scalar] = size + 1;
      return size;
    }
    const cached = complexWidths.get(part);
    if (cached !== undefined) {
      complexWidths.delete(part);
      complexWidths.set(part, cached);
      return cached;
    }
    const size = textWidth(part);
    complexWidths.set(part, size);
    if (complexWidths.size > 512) complexWidths.delete(complexWidths.keys().next().value!);
    return size;
  };
  return (state, route, edits, width) => {
    let selected = widths.get(width);
    if (!selected) {
      selected = { routes: new Map(), entries: new Map(), texts: new Map() };
      widths.set(width, selected);
      if (widths.size > 2) widths.delete(widths.keys().next().value!);
    } else {
      widths.delete(width);
      widths.set(width, selected);
    }
    const cache = selected;
    const preview = route === 2 ? JSON.stringify(edits) : '';
    const previous = cache.routes.get(route);
    if (previous?.state === state && previous.preview === preview) return previous.rows;
    const textRows = (text: string): readonly string[] => {
      const existing = cache.texts.get(text);
      if (existing) {
        cache.texts.delete(text);
        cache.texts.set(text, existing);
        return existing;
      }
      const rows = wrapMeasuredLines([text], width, measure);
      cache.texts.set(text, rows);
      if (cache.texts.size > 512) cache.texts.delete(cache.texts.keys().next().value!);
      return rows;
    };
    const entryRows = (entry: ChatMessage | GuestbookEntry): readonly string[] => {
      const existing = cache.entries.get(entry.id);
      if (existing && existing.text === entry.text && existing.date === entry.createdAt && existing.nickname === state.profile.nickname) return existing.rows;
      const rows = [...textRows(localHeader(state, entry)), ...textRows(entry.text)];
      cache.entries.delete(entry.id);
      cache.entries.set(entry.id, { text: entry.text, date: entry.createdAt, nickname: state.profile.nickname, rows });
      if (cache.entries.size > 20_000) cache.entries.delete(cache.entries.keys().next().value!);
      return rows;
    };
    let rows: string[];
    if (route === 0) rows = wrapMeasuredLines(lobbyLines(), width, measure);
    else if (route === 1) {
      rows = wrapMeasuredLines(SEED_CHAT_MESSAGES.map(entry => `${EXAMPLE_USERS.find(user => user.id === entry.authorId)!.nickname} · 예시\n${entry.text}`), width, measure);
      for (const entry of state.chatMessages) for (const line of entryRows(entry)) rows.push(line);
    } else {
      rows = wrapMeasuredLines(profileLines(state, route, edits), width, measure);
      if (route !== 2) {
        rows.push(...wrapMeasuredLines(['방명록 · 내 기기에만 저장 / 원격 전달 없음'], width, measure));
        const target = EXAMPLE_USERS[route - 3]!.terminalId;
        for (const entry of state.guestbookEntries) if (entry.targetTerminalId === target) for (const line of entryRows(entry)) rows.push(line);
      }
    }
    cache.routes.set(route, { state, preview, rows });
    return rows;
  };
}
