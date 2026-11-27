import { Box, Text } from 'ink';
import type { ProfilePreviewResult } from '../../core/profile-service.js';
import { getThemePalette, THEME_LABELS } from './Themes.js';

export interface PreviewPaneProps {
  preview: ProfilePreviewResult;
  width?: number;
}

export function PreviewPane({ preview, width = 76 }: PreviewPaneProps) {
  const palette = getThemePalette(preview.personalSpace.colorTheme);
  const artLines = preview.personalSpace.asciiArt
    ? preview.personalSpace.asciiArt.split('\n').slice(0, 12)
    : ['(ASCII 아트 없음)'];

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={palette.accent}
      backgroundColor={palette.background}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={palette.accent}>
          미리보기 · @{preview.nickname} ({THEME_LABELS[palette.id]})
        </Text>
        <Text color={palette.warning}>저장 전 · 공개 상태 미변경</Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={palette.border}
        paddingX={1}
        marginTop={1}
      >
        {artLines.map((line, index) => (
          <Text key={index} color={palette.text}>
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={palette.text}>
          상태: {preview.profile.currentStatus || '(없음)'}
        </Text>
        <Text color={palette.text}>
          소개: {preview.profile.introduction || '(없음)'}
        </Text>
        <Text color={palette.muted}>
          기술 스택: {preview.profile.technologyStack.length > 0 ? preview.profile.technologyStack.join(', ') : '(없음)'}
        </Text>
        <Text color={palette.accent}>
          프로젝트 URL: {preview.profile.projectUrl || '(없음)'}
        </Text>
        <Text color={palette.muted}>
          변경 항목: {preview.changedFields.length > 0 ? preview.changedFields.join(', ') : '변경 없음'}
        </Text>
      </Box>
    </Box>
  );
}
