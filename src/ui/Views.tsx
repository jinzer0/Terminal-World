import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { ASCII_PRESETS, EXAMPLE_USERS, PALETTE, THEMES, type ThemeId } from '../catalog.js';
import { graphemes, type ProfileEdits, type StateV1 } from '../model.js';
import { TextInput } from './Input.js';
import { PointerBox } from './mouse.js';

export type ViewProps = {
  state: StateV1;
  lines: readonly string[];
  width: number;
  height: number;
  scroll: number;
  focus: string;
  action: number;
  disabled: boolean;
  draft: string;
  cursor: number;
  edits: ProfileEdits | null;
  notice: string;
  onFocus: (focus: string) => void;
  onAction: (index: number) => void;
  onVisit: (index: number) => void;
  onChoose: (field: 'asciiPresetId' | 'themeId', value: string) => void;
};

export function Action({ label, focused, disabled, onClick, width }: { label: string; focused: boolean; disabled: boolean; onClick: () => void; width?: number }) {
  return <PointerBox enabled={!disabled} onClick={onClick} width={width} height={1}>
    <Text color={focused ? PALETTE.accent : PALETTE.text} wrap="truncate-end">{focused ? '› ' : '  '}{label}</Text>
  </PointerBox>;
}

function Body({ lines, height, props, theme }: { lines: readonly string[]; height: number; props: ViewProps; theme?: ThemeId }) {
  const offset = Math.max(0, Math.min(props.scroll, Math.max(0, lines.length - height)));
  const colors = theme ? THEMES[theme] : PALETTE;
  return <PointerBox width={props.width} height={height} enabled={!props.disabled} onClick={() => props.onFocus('content')}>
    <Box height={height} width={props.width} flexDirection="column" overflow="hidden">
      {lines.slice(offset, offset + height).map((line, index) => <Text key={index} color={colors.text} wrap="truncate-end">{line || ' '}</Text>)}
    </Box>
  </PointerBox>;
}

function InputRow({ props, field, value }: { props: ViewProps; field: string; value: string }) {
  return <TextInput cursor={props.focus === field ? props.cursor : graphemes(value).length} value={value} focused={props.focus === field} disabled={props.disabled} width={props.width} onFocus={() => props.onFocus(field)} />;
}

function Composer({ props, target }: { props: ViewProps; target: string }) {
  return <Box flexDirection="column" height={4} flexShrink={0}>
    <Text color={PALETTE.muted}>로컬 작성 · Enter 전송 · Esc 취소</Text>
    <InputRow props={props} field={`composer:${target}`} value={props.draft} />
    <Box><Action width={16} label="전송 / 재시도" focused={props.focus === 'composer:send'} disabled={props.disabled} onClick={() => props.onAction(0)} /><Action width={12} label="취소" focused={props.focus === 'composer:cancel'} disabled={props.disabled} onClick={() => props.onAction(1)} /></Box>
    <Text color={PALETTE.error} wrap="truncate-end">{props.notice || '내 기기에만 저장 · 실제 전달 없음'}</Text>
  </Box>;
}

export function Lobby(props: ViewProps) {
  return <Box flexDirection="column" height={props.height}>
    <Body props={props} lines={props.lines} height={props.height - 3} />
    {EXAMPLE_USERS.map((user, index) => <Action key={user.id} width={props.width} label={`${user.nickname} · 예시 사용자 방문`} focused={props.focus === 'content' && props.action === index} disabled={props.disabled} onClick={() => props.onVisit(index + 3)} />)}
  </Box>;
}
export function RoofTop(props: ViewProps) {
  const composing = props.focus.startsWith('composer:');
  return <Box flexDirection="column" height={props.height}>
    <Body props={props} lines={props.lines} height={props.height - (composing ? 4 : 1)} />
    {composing ? <Composer props={props} target="space:rooftop" /> : <Action width={props.width} label="로컬 채팅 작성" focused={props.focus === 'content'} disabled={props.disabled} onClick={() => props.onAction(0)} />}
  </Box>;
}
function EditForm({ props }: { props: ViewProps }) {
  const edits = props.edits!;
  const fields = ['introduction', 'status'] as const;
  const catalogs = { asciiPresetId: Object.keys(ASCII_PRESETS), themeId: Object.keys(THEMES) } as const;
  const rows: ReactNode[] = fields.map(field => <Box key={field} flexDirection="column" height={2}><Text color={PALETTE.muted}>{field === 'introduction' ? '소개' : '상태'}</Text><InputRow props={props} field={`form:${field}`} value={edits[field]} /></Box>);
  for (const field of ['asciiPresetId', 'themeId'] as const) {
    rows.push(<Box key={field} flexDirection="column" height={2}>
      <Text color={PALETTE.muted}>{field === 'asciiPresetId' ? 'ASCII' : '테마'} · ↑↓ 선택</Text>
      <Box>{catalogs[field].map(value => <Action key={value} width={Math.floor(props.width / catalogs[field].length)} label={`${edits[field] === value ? '●' : '○'} ${field === 'asciiPresetId' ? ASCII_PRESETS[value as keyof typeof ASCII_PRESETS].label : value.slice(6)}`} focused={props.focus === `form:${field}` && edits[field] === value} disabled={props.disabled} onClick={() => props.onChoose(field, value)} />)}</Box>
    </Box>);
  }
  return <Box flexDirection="column" height={10} flexShrink={0}>{rows}<Box><Action width={18} label="저장 / 재시도" focused={props.focus === 'form:save'} disabled={props.disabled} onClick={() => props.onAction(0)} /><Action width={12} label="취소" focused={props.focus === 'form:cancel'} disabled={props.disabled} onClick={() => props.onAction(1)} /></Box><Text color={PALETTE.error} wrap="truncate-end">{props.notice || 'Ctrl+S 저장 · Esc 복원 · 닉네임 변경 불가'}</Text></Box>;
}
export function PersonalTerminal(props: ViewProps & { index: number }) {
  const owner = props.index === 2 ? { ...props.state.profile, ...props.edits } : EXAMPLE_USERS[props.index - 3]!;
  const composing = props.focus.startsWith('composer:');
  const controls = props.edits ? 10 : composing ? 4 : 1;
  return <Box flexDirection="column" width={props.width} height={props.height} backgroundColor={THEMES[owner.themeId].background}>
    <Body props={props} theme={owner.themeId} lines={props.lines} height={props.height - controls} />
    {props.edits ? <EditForm props={props} /> : composing ? <Composer props={props} target={EXAMPLE_USERS[props.index - 3]!.terminalId} /> : <Action width={props.width} label={props.index === 2 ? '내 프로필 편집' : '로컬 방명록 작성'} focused={props.focus === 'content'} disabled={props.disabled} onClick={() => props.onAction(0)} />}
  </Box>;
}
