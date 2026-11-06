import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Box, useStdin, useStdout, type DOMElement } from 'ink';
import { getBoundingClientRect } from '@ink-tools/ink-mouse';
import { Mouse, type MouseEvent, type ReadableStreamWithEncoding } from 'xterm-mouse';
import type { TerminalStream } from './terminal-input.js';

type PointerHandler = {
  ref: RefObject<DOMElement | null>;
  enabled: boolean;
  onClick?: () => void;
  onWheel?: (direction: -1 | 1) => void;
};
const PointerRegistry = createContext<Set<PointerHandler> | null>(null);

export function MouseRoot({ children, input, enabled = true }: { children: ReactNode; input: TerminalStream; enabled?: boolean }) {
  const registry = useRef<Set<PointerHandler> | null>(null);
  registry.current ??= new Set();
  const handlers = registry.current;
  const { setRawMode } = useStdin();
  const { stdout } = useStdout();
  useEffect(() => {
    if (!enabled) return;
    const mouse = new Mouse({ inputStream: input as unknown as ReadableStreamWithEncoding, outputStream: stdout as NodeJS.WriteStream, setRawMode });
    const deliver = (event: MouseEvent, kind: 'click' | 'wheel') => {
      if (kind === 'click' && event.button !== 'left') return;
      const direction = event.button === 'wheel-up' ? -1 : event.button === 'wheel-down' ? 1 : undefined;
      if (kind === 'wheel' && direction === undefined) return;
      for (const handler of handlers) {
        if (!handler.enabled || !(kind === 'click' ? handler.onClick : handler.onWheel)) continue;
        const bounds = getBoundingClientRect(handler.ref.current);
        if (!bounds || event.x < bounds.left || event.x >= bounds.right || event.y < bounds.top || event.y >= bounds.bottom) continue;
        if (kind === 'click') handler.onClick?.();
        else handler.onWheel?.(direction!);
        break;
      }
    };
    mouse.on('click', event => deliver(event, 'click'));
    mouse.on('wheel', event => deliver(event, 'wheel'));
    try { mouse.enable(); }
    catch (error) {
      try { mouse.destroy(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Mouse initialization and cleanup failed.'); }
      throw error;
    }
    return () => { mouse.destroy(); };
  }, [enabled, handlers, input, setRawMode, stdout]);
  return <PointerRegistry.Provider value={handlers}>{children}</PointerRegistry.Provider>;
}

export function PointerBox({ children, enabled = true, onClick, onWheel, width, height }: {
  children: ReactNode;
  enabled?: boolean;
  onClick?: () => void;
  onWheel?: (direction: -1 | 1) => void;
  width?: number;
  height?: number;
}) {
  const registry = useContext(PointerRegistry);
  if (!registry) throw new Error('PointerBox requires MouseRoot.');
  const ref = useRef<DOMElement | null>(null);
  const handler = useRef<PointerHandler | null>(null);
  handler.current ??= { ref, enabled, onClick, onWheel };
  const current = handler.current;
  current.enabled = enabled;
  current.onClick = onClick;
  current.onWheel = onWheel;
  useEffect(() => {
    registry.add(current);
    return () => { registry.delete(current); };
  }, [current, registry]);
  return <Box ref={ref} width={width} height={height} flexDirection="column">{children}</Box>;
}
