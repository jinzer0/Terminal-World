import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { toServiceError } from '../../core/errors.js';
import type {
  ContentReportRecord,
  ModerationDeletionRecord,
  ModerationService,
  ReportOutcome,
  ReportReviewState,
  ReportTargetKind,
} from '../../core/moderation-service.js';
import type { ServiceTheme } from '../../service/validation.js';
import { inputActions } from '../../ui/Input.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { MultilineInput } from '../components/MultilineInput.js';
import { getThemePalette, type ThemePalette } from '../components/Themes.js';

export interface AdminPanelScreenProps {
  moderationService: ModerationService;
  adminMemberId: string;
  adminNickname: string;
  width?: number;
  height?: number;
  theme?: ThemePalette | ServiceTheme;
  onBack: () => void;
}

type AdminTab = 'reports' | 'deletions' | 'direct-delete';
type ReportFilter = 'received' | 'all' | 'reviewed';

const ADMIN_TABS: readonly { id: AdminTab; label: string }[] = [
  { id: 'reports', label: '1:신고 검토' },
  { id: 'deletions', label: '2:삭제 이력 (90일)' },
  { id: 'direct-delete', label: '3:직접 삭제' },
];

const TARGET_KINDS: readonly ReportTargetKind[] = ['post', 'comment', 'guestbook', 'chat'];
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function resolvePalette(theme?: ThemePalette | ServiceTheme): ThemePalette {
  if (!theme || typeof theme === 'string') {
    return getThemePalette(theme ?? 'dark');
  }
  return theme;
}

function TargetIdInput({
  value,
  onChange,
  focused,
  theme,
}: {
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  theme: ThemePalette;
}) {
  usePaste(
    pasted => {
      if (!focused) return;
      const clean = pasted.replace(CONTROL_CHARS, '').trim();
      if (clean) onChange(value + clean);
    },
    { isActive: focused },
  );

  useInput(
    (input, key) => {
      if (!focused) return;
      for (const action of inputActions(input, key)) {
        if (action.kind === 'backspace' || action.kind === 'delete') {
          onChange(value.slice(0, -1));
          return;
        }
        if (action.kind === 'text') {
          const clean = action.text.replace(CONTROL_CHARS, '');
          if (clean) onChange(value + clean);
        }
      }
    },
    { isActive: focused },
  );

  return (
    <Box
      width={44}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
    >
      <Text color={value ? theme.text : theme.muted}>
        {value || '대상 콘텐츠 ID 입력'}
        {focused ? '_' : ''}
      </Text>
    </Box>
  );
}

export function AdminPanelScreen({
  moderationService,
  adminMemberId,
  adminNickname,
  width = 100,
  height = 28,
  theme,
  onBack,
}: AdminPanelScreenProps) {
  const palette = resolvePalette(theme);

  const [tab, setTab] = useState<AdminTab>('reports');
  const [filter, setFilter] = useState<ReportFilter>('received');
  const [reports, setReports] = useState<ContentReportRecord[]>([]);
  const [reportIdx, setReportIdx] = useState(0);
  const [deletions, setDeletions] = useState<ModerationDeletionRecord[]>([]);
  const [deletionIdx, setDeletionIdx] = useState(0);

  // Review modal/form state
  const [reviewingReport, setReviewingReport] = useState<ContentReportRecord | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<ReportOutcome>('deleted');
  const [reviewReason, setReviewReason] = useState('');
  const [reviewFocus, setReviewFocus] = useState<'outcome' | 'reason' | 'submit'>('outcome');

  // Direct delete form state
  const [deleteKindIdx, setDeleteKindIdx] = useState(0);
  const [deleteTargetId, setDeleteTargetId] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [directFocus, setDirectFocus] = useState<'kind' | 'targetId' | 'reason' | 'submit'>('kind');

  const [confirmState, setConfirmState] = useState<{
    kind: 'review' | 'direct';
    message: string;
  } | null>(null);

  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const refreshReports = useCallback(() => {
    try {
      const stateArg: ReportReviewState | undefined = filter === 'all' ? undefined : filter;
      const list = moderationService.listReportsForAdmin(adminMemberId, stateArg);
      setReports(list);
      setReportIdx(prev => Math.max(0, Math.min(prev, Math.max(0, list.length - 1))));
      setErrorMessage('');
    } catch (err) {
      setReports([]);
      setErrorMessage(toServiceError(err).message);
    }
  }, [moderationService, adminMemberId, filter]);

  const refreshDeletions = useCallback(() => {
    try {
      const list = moderationService.listDeletionHistory(adminMemberId);
      setDeletions(list);
      setDeletionIdx(prev => Math.max(0, Math.min(prev, Math.max(0, list.length - 1))));
      setErrorMessage('');
    } catch (err) {
      setDeletions([]);
      setErrorMessage(toServiceError(err).message);
    }
  }, [moderationService, adminMemberId]);

  useEffect(() => {
    if (tab === 'reports') refreshReports();
    if (tab === 'deletions') refreshDeletions();
  }, [tab, refreshReports, refreshDeletions]);

  const executeReview = () => {
    if (!reviewingReport) return;
    setConfirmState(null);
    setErrorMessage('');
    setStatusMessage('');
    try {
      moderationService.reviewReport({
        adminMemberId,
        reportId: reviewingReport.id,
        outcome: reviewOutcome,
        resolutionReason: reviewReason,
      });
      setReviewingReport(null);
      setReviewReason('');
      setStatusMessage(
        reviewOutcome === 'deleted'
          ? '신고를 검토하고 대상 콘텐츠를 삭제 처리했어요.'
          : '신고를 검토하고 조치 없음으로 종결했어요.',
      );
      refreshReports();
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  const executeDirectDelete = () => {
    setConfirmState(null);
    setErrorMessage('');
    setStatusMessage('');
    const targetKind = TARGET_KINDS[deleteKindIdx]!;
    try {
      moderationService.adminDeleteContent({
        adminMemberId,
        targetKind,
        targetId: deleteTargetId,
        reason: deleteReason,
      });
      setDeleteTargetId('');
      setDeleteReason('');
      setStatusMessage(`[${targetKind}] 콘텐츠를 삭제하고 90일 삭제 이력에 기록했어요.`);
      refreshDeletions();
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  useInput(
    (input, key) => {
      if (confirmState) return;

      if (reviewingReport) {
        if (key.escape) {
          setReviewingReport(null);
          setErrorMessage('');
          return;
        }
        if (key.tab) {
          setReviewFocus(prev => (prev === 'outcome' ? 'reason' : prev === 'reason' ? 'submit' : 'outcome'));
          return;
        }
        if (reviewFocus === 'outcome' && (key.leftArrow || key.rightArrow || input === ' ')) {
          setReviewOutcome(prev => (prev === 'deleted' ? 'no_action' : 'deleted'));
          return;
        }
        if ((reviewFocus === 'submit' && key.return) || (key.ctrl && input === 's')) {
          if (!reviewReason.trim()) {
            setErrorMessage('처리 사유를 입력해 주세요.');
            return;
          }
          if (reviewOutcome === 'deleted') {
            setConfirmState({
              kind: 'review',
              message: `[${reviewingReport.targetKind}] ${reviewingReport.targetId} 콘텐츠를 삭제 처리할까요? (게시글 삭제 시 댓글도 함께 삭제됩니다)`,
            });
          } else {
            executeReview();
          }
        }
        return;
      }

      if (tab === 'direct-delete') {
        if (key.escape) {
          setTab('reports');
          setErrorMessage('');
          return;
        }
        if (key.tab) {
          setDirectFocus(prev => {
            if (prev === 'kind') return 'targetId';
            if (prev === 'targetId') return 'reason';
            if (prev === 'reason') return 'submit';
            return 'kind';
          });
          return;
        }
        if (directFocus === 'kind' && (key.leftArrow || key.rightArrow)) {
          const delta = key.leftArrow ? -1 : 1;
          setDeleteKindIdx(prev => (prev + delta + TARGET_KINDS.length) % TARGET_KINDS.length);
          return;
        }
        if ((directFocus === 'submit' && key.return) || (key.ctrl && input === 's')) {
          if (!deleteTargetId.trim() || !deleteReason.trim()) {
            setErrorMessage('대상 ID와 삭제 사유를 모두 입력해 주세요.');
            return;
          }
          setConfirmState({
            kind: 'direct',
            message: `[${TARGET_KINDS[deleteKindIdx]}] ${deleteTargetId} 콘텐츠를 관리자 권한으로 삭제할까요?`,
          });
          return;
        }
        if (directFocus === 'kind') {
          if (input === '1') { setTab('reports'); return; }
          if (input === '2') { setTab('deletions'); return; }
        }
        return;
      }

      if (key.escape) {
        onBack();
        return;
      }
      if (input === '1') { setTab('reports'); setErrorMessage(''); return; }
      if (input === '2') { setTab('deletions'); setErrorMessage(''); return; }
      if (input === '3') { setTab('direct-delete'); setDirectFocus('kind'); setErrorMessage(''); return; }

      if (tab === 'reports') {
        if (input === 'f') {
          setFilter(prev => (prev === 'received' ? 'all' : prev === 'all' ? 'reviewed' : 'received'));
          return;
        }
        if (input === 'r') {
          refreshReports();
          return;
        }
        if (key.upArrow || input === 'k') {
          setReportIdx(prev => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setReportIdx(prev => Math.min(Math.max(0, reports.length - 1), prev + 1));
          return;
        }
        if (key.return && reports[reportIdx]) {
          const target = reports[reportIdx]!;
          if (target.reviewState === 'reviewed') {
            setStatusMessage('이미 검토 완료된 신고입니다.');
            return;
          }
          setReviewingReport(target);
          setReviewOutcome('deleted');
          setReviewReason('');
          setReviewFocus('outcome');
          setErrorMessage('');
        }
      } else if (tab === 'deletions') {
        if (input === 'r') {
          refreshDeletions();
          return;
        }
        if (key.upArrow || input === 'k') {
          setDeletionIdx(prev => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setDeletionIdx(prev => Math.min(Math.max(0, deletions.length - 1), prev + 1));
        }
      }
    },
    { isActive: !confirmState },
  );

  const selectedReport = reports[reportIdx] ?? null;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={palette.background}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={palette.accent}>
        관리자 패널 (@{adminNickname})
      </Text>

      <Box gap={2} marginTop={1} marginBottom={1}>
        {ADMIN_TABS.map(item => {
          const selected = item.id === tab;
          return (
            <Text
              key={item.id}
              bold={selected}
              color={selected ? palette.accent : palette.muted}
              inverse={selected}
            >
              {` [${item.label}] `}
            </Text>
          );
        })}
      </Box>

      {confirmState ? (
        <ConfirmDialog
          title="관리자 삭제 확인"
          message={confirmState.message}
          confirmLabel="삭제 실행"
          cancelLabel="취소"
          destructive
          theme={palette}
          onConfirm={() => {
            if (confirmState.kind === 'review') executeReview();
            else executeDirectDelete();
          }}
          onCancel={() => setConfirmState(null)}
        />
      ) : reviewingReport ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={2}
          paddingY={1}
          gap={1}
          flexGrow={1}
        >
          <Text bold color={palette.accent}>
            신고 검토 · [{reviewingReport.targetKind}] {reviewingReport.targetId}
          </Text>
          <Text color={palette.text}>신고 사유: {reviewingReport.reason}</Text>
          <Box gap={2}>
            <Text color={reviewFocus === 'outcome' ? palette.accent : palette.muted}>결정:</Text>
            <Text
              bold={reviewOutcome === 'deleted'}
              color={reviewOutcome === 'deleted' ? palette.error : palette.muted}
              inverse={reviewFocus === 'outcome' && reviewOutcome === 'deleted'}
            >
              {' [삭제 (deleted)] '}
            </Text>
            <Text
              bold={reviewOutcome === 'no_action'}
              color={reviewOutcome === 'no_action' ? palette.success : palette.muted}
              inverse={reviewFocus === 'outcome' && reviewOutcome === 'no_action'}
            >
              {' [조치 없음 (no_action)] '}
            </Text>
          </Box>
          <Box flexDirection="column">
            <Text color={reviewFocus === 'reason' ? palette.accent : palette.muted}>처리 사유 (필수)</Text>
            <MultilineInput
              value={reviewReason}
              onChange={setReviewReason}
              focused={reviewFocus === 'reason'}
              maxLength={1000}
              visibleLines={3}
              width={64}
              placeholder="신고 검토 결과 및 사유를 입력하세요"
              theme={palette}
            />
          </Box>
          <Text
            bold={reviewFocus === 'submit'}
            color={reviewFocus === 'submit' ? palette.accent : palette.text}
            inverse={reviewFocus === 'submit'}
          >
            {' [검토 확정 (Enter / Ctrl+S)] '}
          </Text>
        </Box>
      ) : (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.border}
          paddingX={2}
          paddingY={1}
          flexGrow={1}
        >
          {tab === 'reports' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>
                접수된 신고 목록 ({filter === 'received' ? '미검토' : filter === 'reviewed' ? '검토 완료' : '전체'} · {reports.length}건 · f 필터 · r 새로고침 · Enter 검토)
              </Text>
              {reports.length === 0 ? (
                <Text color={palette.muted}>표시할 신고가 없어요.</Text>
              ) : (
                reports.slice(0, 8).map((r, idx) => {
                  const selected = idx === reportIdx;
                  const stateLabel = r.reviewState === 'received'
                    ? '미검토'
                    : r.outcome === 'deleted'
                      ? '삭제됨'
                      : '조치 없음';
                  return (
                    <Text
                      key={r.id}
                      color={selected ? palette.accent : palette.text}
                      backgroundColor={selected ? palette.selected : undefined}
                      wrap="truncate-end"
                    >
                      {selected ? '› ' : '  '}
                      [{r.targetKind}] {r.targetId} · {stateLabel} · {r.reason}
                    </Text>
                  );
                })
              )}
              {selectedReport && (
                <Box marginTop={1} flexDirection="column">
                  <Text color={palette.muted}>
                    선택 ID: {selectedReport.id} · 접수: {selectedReport.createdAt}
                  </Text>
                  {selectedReport.resolutionReason && (
                    <Text color={palette.muted}>처리 사유: {selectedReport.resolutionReason}</Text>
                  )}
                </Box>
              )}
            </Box>
          )}

          {tab === 'deletions' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>
                전체 삭제 이력 (90일 보존 · 원문 본문 미저장 · {deletions.length}건 · r 새로고침)
              </Text>
              {deletions.length === 0 ? (
                <Text color={palette.muted}>보존 기간 내 삭제 이력이 없어요.</Text>
              ) : (
                deletions.slice(0, 10).map((d, idx) => {
                  const selected = idx === deletionIdx;
                  return (
                    <Text
                      key={d.id}
                      color={selected ? palette.accent : palette.text}
                      backgroundColor={selected ? palette.selected : undefined}
                      wrap="truncate-end"
                    >
                      {selected ? '› ' : '  '}
                      [{d.targetKind}] {d.targetId} · {d.reason} · 처리자: {d.adminNickname ?? '탈퇴/미상'} · {d.deletedAt.slice(0, 10)}
                    </Text>
                  );
                })
              )}
            </Box>
          )}

          {tab === 'direct-delete' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>콘텐츠 직접 삭제</Text>
              <Box gap={2}>
                <Text color={directFocus === 'kind' ? palette.accent : palette.muted}>대상 종류 (←/→):</Text>
                {TARGET_KINDS.map((k, idx) => (
                  <Text
                    key={k}
                    bold={idx === deleteKindIdx}
                    color={idx === deleteKindIdx ? palette.accent : palette.muted}
                    inverse={directFocus === 'kind' && idx === deleteKindIdx}
                  >
                    {` [${k}] `}
                  </Text>
                ))}
              </Box>
              <Box flexDirection="column">
                <Text color={directFocus === 'targetId' ? palette.accent : palette.muted}>대상 ID</Text>
                <TargetIdInput
                  value={deleteTargetId}
                  onChange={setDeleteTargetId}
                  focused={directFocus === 'targetId'}
                  theme={palette}
                />
              </Box>
              <Box flexDirection="column">
                <Text color={directFocus === 'reason' ? palette.accent : palette.muted}>삭제 사유 (필수)</Text>
                <MultilineInput
                  value={deleteReason}
                  onChange={setDeleteReason}
                  focused={directFocus === 'reason'}
                  maxLength={1000}
                  visibleLines={3}
                  width={64}
                  placeholder="삭제 사유를 입력하세요 (삭제 본문은 저장되지 않습니다)"
                  theme={palette}
                />
              </Box>
              <Text
                bold={directFocus === 'submit'}
                color={directFocus === 'submit' ? palette.error : palette.text}
                inverse={directFocus === 'submit'}
              >
                {' [관리자 삭제 실행 (Enter / Ctrl+S)] '}
              </Text>
            </Box>
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {errorMessage ? (
          <Text color={palette.error}>{errorMessage}</Text>
        ) : statusMessage ? (
          <Text color={palette.success}>{statusMessage}</Text>
        ) : null}
        <Text color={palette.muted}>
          1~3: 탭 전환 · ↑/↓: 선택 · Enter: 검토/실행 · Esc: 뒤로/월드 복귀
        </Text>
      </Box>
    </Box>
  );
}
