import { useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { inputActions } from '../../ui/Input.js';
import { getThemePalette, type ThemePalette } from './Themes.js';

export interface SecretInputProps {
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  disabled?: boolean;
  placeholder?: string;
  width?: number;
  maskChar?: string;
  maxLength?: number;
  theme?: ThemePalette;
  onSubmit?: () => void;
  onEscape?: () => void;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function sanitizeSecret(raw: string): string {
  return raw.replace(CONTROL_CHARS, '');
}

export function SecretInput({
  value,
  onChange,
  focused,
  disabled = false,
  placeholder = '비밀 입력',
  width = 36,
  maskChar = '*',
  maxLength = 64,
  theme = getThemePalette('dark'),
  onSubmit,
  onEscape,
}: SecretInputProps) {
  const [cursor, setCursor] = useState(() => Array.from(value).length);
  const points = Array.from(value);
  const clampedCursor = Math.max(0, Math.min(cursor, points.length));

  useEffect(() => {
    setCursor(prev => Math.max(0, Math.min(prev, Array.from(value).length)));
  }, [value]);

  const applySecret = (nextRaw: string, nextCursor: number) => {
    const cleaned = sanitizeSecret(nextRaw);
    if (Array.from(cleaned).length > maxLength) return;
    onChange(cleaned);
    setCursor(Math.max(0, Math.min(nextCursor, Array.from(cleaned).length)));
  };

  usePaste(
    pasted => {
      if (!focused || disabled) return;
      const cleaned = sanitizeSecret(pasted);
      if (!cleaned) return;
      const before = points.slice(0, clampedCursor).join('');
      const after = points.slice(clampedCursor).join('');
      applySecret(`${before}${cleaned}${after}`, clampedCursor + Array.from(cleaned).length);
    },
    { isActive: focused && !disabled },
  );

  useInput(
    (input, key) => {
      if (!focused || disabled) return;
      const actions = inputActions(input, key);
      for (const action of actions) {
        if (action.kind === 'submit') {
          onSubmit?.();
          return;
        }
        if (action.kind === 'escape') {
          onEscape?.();
          return;
        }
        if (action.kind === 'backspace') {
          if (clampedCursor > 0) {
            const next = [...points.slice(0, clampedCursor - 1), ...points.slice(clampedCursor)].join('');
            applySecret(next, clampedCursor - 1);
          }
          return;
        }
        if (action.kind === 'delete') {
          if (clampedCursor < points.length) {
            const next = [...points.slice(0, clampedCursor), ...points.slice(clampedCursor + 1)].join('');
            applySecret(next, clampedCursor);
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
          setCursor(0);
          return;
        }
        if (action.kind === 'end') {
          setCursor(points.length);
          return;
        }
        if (action.kind === 'text') {
          const clean = sanitizeSecret(action.text);
          if (!clean) continue;
          const before = points.slice(0, clampedCursor).join('');
          const after = points.slice(clampedCursor).join('');
          applySecret(`${before}${clean}${after}`, clampedCursor + Array.from(clean).length);
        }
      }
    },
    { isActive: focused && !disabled },
  );

  const visibleCols = Math.max(4, width - 4);
  const masked = maskChar.repeat(points.length);
  const windowStart = Math.max(0, clampedCursor - visibleCols + 1);
  const shownMask = masked.slice(windowStart, windowStart + visibleCols);
  const relCursor = clampedCursor - windowStart;
  const before = shownMask.slice(0, relCursor);
  const current = shownMask[relCursor] ?? ' ';
  const after = shownMask.slice(relCursor + 1);

  return (
    <Box
      width={width}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
    >
      {points.length === 0 && !focused ? (
        <Text color={theme.muted}>{placeholder}</Text>
      ) : (
        <Box>
          <Text color={theme.text}>{before}</Text>
          {focused ? (
            <Text inverse color={theme.accent}>
              {current}
            </Text>
          ) : null}
          <Text color={theme.text}>{after}</Text>
        </Box>
      )}
    </Box>
  );
}
