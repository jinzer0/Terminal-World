import type { ReactNode } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { PALETTE } from '../catalog.js';
import { PointerBox } from './mouse.js';

export type NavigationItem = { id: string; label: string };
export type ShellProps = {
  items: NavigationItem[];
  cursor: number;
  activeId: string;
  focus: string;
  onNavigate: (index: number, open: boolean) => void;
  onContentFocus: () => void;
  onScroll: (direction: -1 | 1) => void;
  title: string;
  status: string;
  help: string;
  disabled?: boolean;
  children: ReactNode;
};

export function Shell({ items, cursor, activeId, focus, onNavigate, onContentFocus, onScroll, title, status, help, disabled = false, children }: ShellProps) {
  const { columns, rows } = useWindowSize();
  if (columns < 80 || rows < 24) return <Box flexDirection="column" width={columns} height={rows}>
    <Text color={PALETTE.error}>80×24 이상으로 늘려 주세요</Text>
    <Text>{columns}×{rows} · Ctrl+C 종료 · 작성 중인 내용은 유지돼요</Text>
  </Box>;
  const height = rows - 4;
  return <Box flexDirection="column" width={columns} height={rows} backgroundColor={PALETTE.background}>
    <Text color={PALETTE.text} bold> TERMINAL WORLD / {title}</Text>
    <Text color={PALETTE.muted}> 로컬 프로토타입 · 원격 전달 없음</Text>
    <Box height={height} flexShrink={0}>
      <Box width={24} height={height} borderStyle="round" borderColor={focus === 'sidebar' ? PALETTE.accent : PALETTE.border} paddingX={1} flexDirection="column">
        <PointerBox width={20} height={height - 2} enabled={!disabled} onWheel={direction => onNavigate(Math.max(0, Math.min(items.length - 1, cursor + direction)), false)}>
          <Text color={PALETTE.muted}>공간과 예시 사용자</Text>
          {items.map((item, index) => <PointerBox key={item.id} width={20} height={1} enabled={!disabled} onClick={() => onNavigate(index, true)}>
            <Text color={index === cursor ? PALETTE.accent : PALETTE.text} backgroundColor={index === cursor ? PALETTE.selected : undefined}>
              {index === cursor ? '› ' : '  '}{item.label}{activeId === item.id ? ' *' : ''}
            </Text>
          </PointerBox>)}
          <Box marginTop={1}><Text color={PALETTE.muted} wrap="wrap">예시 사용자 · 실제 접속 아님</Text></Box>
        </PointerBox>
      </Box>
      <Box width={1} />
      <Box width={columns - 25} height={height} borderStyle="round" borderColor={focus === 'sidebar' ? PALETTE.border : PALETTE.accent} paddingX={1} flexDirection="column">
        <PointerBox width={columns - 29} height={1} enabled={!disabled} onClick={onContentFocus}>
          <Text color={PALETTE.text} bold>{title}</Text>
        </PointerBox>
        <PointerBox width={columns - 29} height={height - 3} enabled={!disabled} onWheel={onScroll}>
          {children}
        </PointerBox>
      </Box>
    </Box>
    <Text color={PALETTE.muted} wrap="truncate-end"> 포커스: {focus} · {help}</Text>
    <Text color={PALETTE.text} wrap="truncate-end"> {status}</Text>
  </Box>;
}
