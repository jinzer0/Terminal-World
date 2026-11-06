import { Box, Text, type Key } from 'ink';
import { graphemes, textWidth } from '../model.js';
import { PointerBox } from './mouse.js';

export type InputAction =
  | { kind: 'text'; text: string }
  | { kind: 'tab'; reverse: boolean }
  | { kind: 'quit' | 'save' | 'submit' | 'escape' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'backspace' | 'delete' };

export function inputActions(input: string, key: Key): InputAction[] {
  if (key.eventType === 'release' || key.meta || key.super || key.hyper) return [];
  if (key.ctrl) return input === 'c' ? [{ kind: 'quit' }] : input === 's' ? [{ kind: 'save' }] : [];
  if (key.tab) return [{ kind: 'tab', reverse: key.shift }];
  const named = [
    ['return', 'submit'], ['escape', 'escape'], ['upArrow', 'up'], ['downArrow', 'down'],
    ['leftArrow', 'left'], ['rightArrow', 'right'], ['home', 'home'], ['end', 'end'],
    ['pageUp', 'pageUp'], ['pageDown', 'pageDown'], ['backspace', 'backspace'], ['delete', 'delete'],
  ] as const;
  for (const [flag, kind] of named) if (key[flag]) return [{ kind }];
  // Ink may deliver a tab and subsequent text together as one ordinary chunk.
  // Split decoded keyboard controls, never bracketed paste or mouse protocols.
  const actions: InputAction[] = [];
  for (const chunk of input.split(/([\t\r\n\u007f\b\u0003])/u)) {
    if (!chunk) continue;
    if (chunk === '\t') actions.push({ kind: 'tab', reverse: false });
    else if (chunk === '\r' || chunk === '\n') actions.push({ kind: 'submit' });
    else if (chunk === '\u007f' || chunk === '\b') actions.push({ kind: 'backspace' });
    else if (chunk === '\u0003') actions.push({ kind: 'quit' });
    else actions.push({ kind: 'text', text: chunk });
  }
  return actions;
}

export type TextInputProps = {
  value: string;
  focused: boolean;
  disabled?: boolean;
  cursor: number;
  width: number;
  onFocus?: () => void;
};

export function TextInput({ value, focused, disabled = false, cursor: requestedCursor, width, onFocus }: TextInputProps) {
  const parts = graphemes(value);
  const cursor = Math.max(0, Math.min(requestedCursor, parts.length));
  const active = focused && !disabled;
  const cells = Math.max(2, width);
  let start = 0;
  const cursorSize = textWidth(parts[cursor] ?? ' ');
  while (start < cursor && textWidth(parts.slice(start, cursor).join('')) + cursorSize > cells) start++;
  const before = parts.slice(start, cursor).join('');
  const current = parts[cursor] ?? ' ';
  let after = '';
  for (const part of parts.slice(cursor + 1)) {
    if (textWidth(before + current + after + part) > cells) break;
    after += part;
  }
  return <PointerBox width={cells} height={1} enabled={!disabled} onClick={onFocus}>
    <Box width={cells}>
      <Text>{before}</Text>
      <Text inverse={active}>{current}</Text>
      <Text>{after}</Text>
    </Box>
  </PointerBox>;
}
