import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getThemePalette, type ThemePalette } from './Themes.js';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  theme?: ThemePalette;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '확인',
  cancelLabel = '취소',
  destructive = false,
  theme = getThemePalette('dark'),
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [selected, setSelected] = useState<'confirm' | 'cancel'>('cancel');

  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onCancel();
      return;
    }
    if (key.leftArrow || key.rightArrow || key.tab) {
      setSelected(prev => (prev === 'confirm' ? 'cancel' : 'confirm'));
      return;
    }
    if (key.return) {
      if (selected === 'confirm') onConfirm();
      else onCancel();
    }
  });

  const accentColor = destructive ? theme.error : theme.accent;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={accentColor}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={accentColor}>
        {title}
      </Text>
      <Box marginTop={1} marginBottom={1}>
        <Text color={theme.text}>{message}</Text>
      </Box>
      <Box gap={3}>
        <Text
          bold={selected === 'confirm'}
          color={selected === 'confirm' ? accentColor : theme.muted}
          inverse={selected === 'confirm'}
        >
          {` [${confirmLabel}] `}
        </Text>
        <Text
          bold={selected === 'cancel'}
          color={selected === 'cancel' ? theme.accent : theme.muted}
          inverse={selected === 'cancel'}
        >
          {` [${cancelLabel}] `}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>←/→ 또는 Tab으로 선택 · Enter 실행 · Esc 취소</Text>
      </Box>
    </Box>
  );
}
