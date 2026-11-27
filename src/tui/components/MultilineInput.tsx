import { useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { inputActions } from '../../ui/Input.js';
import { getThemePalette, type ThemePalette } from './Themes.js';

export interface MultilineInputProps {
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  disabled?: boolean;
  maxLength?: number;
  asciiMode?: boolean;
  asciiMaxCols?: number;
  asciiMaxLines?: number;
  visibleLines?: number;
  width?: number;
  placeholder?: string;
  theme?: ThemePalette;
  onSaveShortcut?: () => void;
  onEscape?: () => void;
}

const DISALLOWED_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function sanitizeText(raw: string, asciiMode: boolean): string {
  const normalized = raw.replace(/\r\n?/g, '\n').replace(DISALLOWED_CONTROL, '').normalize('NFC');
  if (!asciiMode) return normalized;
  return normalized.replace(/[^\x20-\x7e\n]/g, '');
}

export function MultilineInput({
  value,
  onChange,
  focused,
  disabled = false,
  maxLength,
  asciiMode = false,
  asciiMaxCols = 40,
  asciiMaxLines = 12,
  visibleLines = 6,
  width = 60,
  placeholder = '내용을 입력하세요 (Enter 줄바꿈)',
  theme = getThemePalette('dark'),
  onSaveShortcut,
  onEscape,
}: MultilineInputProps) {
  const [cursor, setCursor] = useState(() => Array.from(value).length);

  const points = Array.from(value);
  const clampedCursor = Math.max(0, Math.min(cursor, points.length));

  useEffect(() => {
    setCursor(prev => Math.max(0, Math.min(prev, Array.from(value).length)));
  }, [value]);

  const applyEdit = (nextRaw: string, nextCursor: number) => {
    const cleaned = sanitizeText(nextRaw, asciiMode);
    if (maxLength !== undefined && Array.from(cleaned).length > maxLength) {
      return;
    }
    if (asciiMode) {
      const lines = cleaned.split('\n');
      if (lines.length > asciiMaxLines || lines.some(l => l.length > asciiMaxCols)) {
        return;
      }
    }
    onChange(cleaned);
    setCursor(Math.max(0, Math.min(nextCursor, Array.from(cleaned).length)));
  };

  usePaste(
    pasted => {
      if (!focused || disabled) return;
      const clean = sanitizeText(pasted, asciiMode);
      if (!clean) return;
      const before = points.slice(0, clampedCursor).join('');
      const after = points.slice(clampedCursor).join('');
      applyEdit(`${before}${clean}${after}`, clampedCursor + Array.from(clean).length);
    },
    { isActive: focused && !disabled },
  );

  useInput(
    (input, key) => {
      if (!focused || disabled) return;
      const actions = inputActions(input, key);
      for (const action of actions) {
        if (action.kind === 'save') {
          onSaveShortcut?.();
          return;
        }
        if (action.kind === 'escape') {
          onEscape?.();
          return;
        }
        if (action.kind === 'submit') {
          const before = points.slice(0, clampedCursor).join('');
          const after = points.slice(clampedCursor).join('');
          applyEdit(`${before}\n${after}`, clampedCursor + 1);
          return;
        }
        if (action.kind === 'backspace') {
          if (clampedCursor > 0) {
            const next = [...points.slice(0, clampedCursor - 1), ...points.slice(clampedCursor)].join('');
            applyEdit(next, clampedCursor - 1);
          }
          return;
        }
        if (action.kind === 'delete') {
          if (clampedCursor < points.length) {
            const next = [...points.slice(0, clampedCursor), ...points.slice(clampedCursor + 1)].join('');
            applyEdit(next, clampedCursor);
          }
          return;
        }
        if (action.kind === 'left') {
          setCursor(Math.max(0, clampedCursor - 1));
          return;
        }
        if (action.kind === 'right') {
          setCursor(Math.min(points.length, clampedCursor + 1));
          return;
        }
        if (action.kind === 'home') {
          let idx = clampedCursor;
          while (idx > 0 && points[idx - 1] !== '\n') idx -= 1;
          setCursor(idx);
          return;
        }
        if (action.kind === 'end') {
          let idx = clampedCursor;
          while (idx < points.length && points[idx] !== '\n') idx += 1;
          setCursor(idx);
          return;
        }
        if (action.kind === 'up' || action.kind === 'down') {
          const lines = value.split('\n');
          let rem = clampedCursor;
          let row = 0;
          let col = 0;
          for (let i = 0; i < lines.length; i += 1) {
            const len = Array.from(lines[i]!).length;
            if (rem <= len) {
              row = i;
              col = rem;
              break;
            }
            rem -= len + 1;
          }
          const targetRow = action.kind === 'up' ? Math.max(0, row - 1) : Math.min(lines.length - 1, row + 1);
          let nextOffset = 0;
          for (let i = 0; i < targetRow; i += 1) {
            nextOffset += Array.from(lines[i]!).length + 1;
          }
          nextOffset += Math.min(col, Array.from(lines[targetRow]!).length);
          setCursor(nextOffset);
          return;
        }
        if (action.kind === 'text') {
          const before = points.slice(0, clampedCursor).join('');
          const after = points.slice(clampedCursor).join('');
          applyEdit(`${before}${action.text}${after}`, clampedCursor + Array.from(action.text).length);
        }
      }
    },
    { isActive: focused && !disabled },
  );

  // Compute cursor line/col for viewport window
  const lines = value.split('\n');
  let rem = clampedCursor;
  let cursorRow = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineLen = Array.from(lines[i]!).length;
    if (rem <= lineLen) {
      cursorRow = i;
      cursorCol = rem;
      break;
    }
    rem -= lineLen + 1;
  }

  const startLine = Math.max(0, Math.min(cursorRow - visibleLines + 1, Math.max(0, lines.length - visibleLines)));
  const shownLines = lines.slice(startLine, startLine + visibleLines);
  const maxColsInArt = lines.reduce((m, l) => Math.max(m, l.length), 0);

  const counterText = asciiMode
    ? `${maxColsInArt}/${asciiMaxCols}열 × ${lines.length}/${asciiMaxLines}줄`
    : maxLength !== undefined
      ? `${points.length}/${maxLength}자 · ${lines.length}줄`
      : `${points.length}자 · ${lines.length}줄`;

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
    >
      {value.length === 0 && !focused ? (
        <Text color={theme.muted}>{placeholder}</Text>
      ) : (
        shownLines.map((line, idx) => {
          const absRow = startLine + idx;
          if (!focused || absRow !== cursorRow) {
            return (
              <Text key={absRow} color={theme.text} wrap="truncate-end">
                {line || ' '}
              </Text>
            );
          }
          const linePoints = Array.from(line);
          const before = linePoints.slice(0, cursorCol).join('');
          const at = linePoints[cursorCol] ?? ' ';
          const after = linePoints.slice(cursorCol + 1).join('');
          return (
            <Box key={absRow}>
              <Text color={theme.text}>{before}</Text>
              <Text inverse color={theme.accent}>
                {at}
              </Text>
              <Text color={theme.text}>{after}</Text>
            </Box>
          );
        })
      )}
      <Box justifyContent="flex-end">
        <Text color={theme.muted}>{counterText}</Text>
      </Box>
    </Box>
  );
}
