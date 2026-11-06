import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export type TerminalStream = PassThrough & {
  readonly isTTY: boolean;
  readonly isRaw: boolean;
  setRawMode?: (enabled: boolean) => TerminalStream;
  ref?: () => TerminalStream;
  unref?: () => TerminalStream;
};
export type TerminalInput = { stdin: TerminalStream; mouse: TerminalStream; dispose: () => void };
type Options = { mouse: boolean; onEnd: () => void; onError: (error: unknown) => void };
const ESC = '\x1b';
const pasteStart = '\x1b[200~';
const pasteEnd = '\x1b[201~';
const maxControlLength = 128;

/** Frame once: Ink decodes keys/paste, xterm-mouse decodes only mouse packets. */
export function createTerminalInput(source: NodeJS.ReadableStream, options: Options): TerminalInput {
  const original = source as NodeJS.ReadStream;
  const wasFlowing = original.readableFlowing;
  const stdin = new PassThrough() as TerminalStream;
  const mouse = new PassThrough() as TerminalStream;
  for (const stream of [stdin, mouse]) {
    Object.defineProperty(stream, 'isTTY', { value: original.isTTY === true });
    Object.defineProperty(stream, 'isRaw', { get: () => original.isRaw === true });
  }
  if (typeof original.setRawMode === 'function') stdin.setRawMode = enabled => { original.setRawMode(enabled); return stdin; };
  if (typeof original.ref === 'function') stdin.ref = () => { original.ref(); return stdin; };
  if (typeof original.unref === 'function') stdin.unref = () => { original.unref(); return stdin; };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let pasting = false;
  let discardingMouse = false;
  let disposed = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  const keyboard = (value: string) => { if (value) stdin.write(value); };
  const pointer = (value: string) => { if (options.mouse) mouse.write(value); };
  function clearTimer() { if (escapeTimer) clearTimeout(escapeTimer); escapeTimer = undefined; }
  function consume(value: string) {
    if (disposed) return;
    clearTimer();
    buffer += value;
    while (buffer) {
      if (pasting) {
        const end = buffer.indexOf(pasteEnd);
        if (end >= 0) {
          keyboard(buffer.slice(0, end + pasteEnd.length));
          buffer = buffer.slice(end + pasteEnd.length);
          pasting = false;
          continue;
        }
        let keep = Math.min(pasteEnd.length - 1, buffer.length);
        while (keep > 0 && !pasteEnd.startsWith(buffer.slice(-keep))) keep--;
        keyboard(buffer.slice(0, buffer.length - keep));
        buffer = buffer.slice(buffer.length - keep);
        break;
      }
      if (discardingMouse) {
        const end = buffer.search(/[^\d;]/u);
        if (end < 0) { buffer = ''; break; }
        const final = buffer[end]!;
        buffer = buffer.slice(end + (final === 'M' || final === 'm' ? 1 : 0));
        discardingMouse = false;
        continue;
      }
      if (buffer[0] !== ESC) {
        const next = buffer.indexOf(ESC);
        keyboard(next < 0 ? buffer : buffer.slice(0, next));
        buffer = next < 0 ? '' : buffer.slice(next);
        continue;
      }
      if (buffer.length === 1) break;
      if (buffer[1] !== '[' && buffer[1] !== 'O') {
        const length = buffer.codePointAt(1)! > 0xffff ? 3 : 2;
        keyboard(buffer.slice(0, length));
        buffer = buffer.slice(length);
        continue;
      }
      if (buffer.startsWith('\x1b[M')) {
        const interrupt = buffer.slice(3, 6).indexOf('\x03');
        if (interrupt >= 0) { buffer = buffer.slice(3 + interrupt); continue; }
        if (buffer.length < 6) break;
        pointer(buffer.slice(0, 6));
        buffer = buffer.slice(6);
        continue;
      }
      const isMouse = buffer.startsWith('\x1b[<');
      let end = 2;
      while (end < buffer.length && end < maxControlLength) {
        const code = buffer.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        if (isMouse && end > 2 && !/[\d;]/u.test(buffer[end]!)) break;
        if (code < 0x20 || code > 0x3f) break;
        end++;
      }
      if (end === maxControlLength) {
        if (isMouse) discardingMouse = true;
        else keyboard(buffer.slice(0, end));
        buffer = buffer.slice(end);
        continue;
      }
      if (end === buffer.length) break;
      const code = buffer.charCodeAt(end);
      if (code < 0x40 || code > 0x7e) {
        if (!isMouse) keyboard(buffer.slice(0, end));
        buffer = buffer.slice(end);
        continue;
      }
      const sequence = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      if (isMouse) pointer(sequence);
      else {
        keyboard(sequence);
        if (sequence === pasteStart) pasting = true;
      }
    }
    // Only a lone Esc is ambiguous. Known partial CSI/SS3 packets never become keys.
    if (!pasting && buffer === ESC) {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        if (!disposed && buffer === ESC) { buffer = ''; keyboard(ESC); }
      }, 80);
      escapeTimer.unref();
    }
  }
  const onData = (chunk: Buffer | string) => consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  const onEnd = () => {
    consume(decoder.end());
    clearTimer();
    if (pasting || buffer === ESC) keyboard(buffer);
    buffer = '';
    stdin.end();
    mouse.end();
    options.onEnd();
  };
  const onError = (error: unknown) => { options.onError(error); };
  source.on('data', onData);
  source.once('end', onEnd);
  source.once('error', onError);
  return { stdin, mouse, dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    buffer = '';
    source.removeListener('data', onData);
    source.removeListener('end', onEnd);
    source.removeListener('error', onError);
    stdin.destroy();
    mouse.destroy();
    if (wasFlowing !== true) source.pause();
  } };
}
