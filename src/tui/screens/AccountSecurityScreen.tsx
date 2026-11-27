import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { AccountLifecycleService } from '../../core/account-lifecycle-service.js';
import { toServiceError } from '../../core/errors.js';
import type { ContentReportRecord, ModerationService } from '../../core/moderation-service.js';
import type { ServiceTheme } from '../../service/validation.js';
import { inputActions } from '../../ui/Input.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { SecretInput } from '../components/SecretInput.js';
import { getThemePalette, type ThemePalette } from '../components/Themes.js';

export interface IntegrationGrantView {
  id: string;
  channel: 'cli' | 'mcp';
  label: string;
  scopes: string[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface AccountSecurityScreenProps {
  lifecycleService: AccountLifecycleService;
  moderationService?: ModerationService;
  memberId: string;
  nickname: string;
  sessionId?: string | null;
  width?: number;
  height?: number;
  theme?: ThemePalette | ServiceTheme;
  grants?: readonly IntegrationGrantView[];
  onListGrants?: () => IntegrationGrantView[];
  onApproveCode?: (code: string, password: string) => { label: string; scopes: string[]; expiresAt: string } | void;
  onRevokeGrant?: (grantId: string) => void;
  onWithdrawn?: () => void;
  onBack: () => void;
}

type AccountTab = 'password' | 'recovery' | 'integrations' | 'reports' | 'withdraw';

const TABS: readonly { id: AccountTab; label: string }[] = [
  { id: 'password', label: '1:비번 변경' },
  { id: 'recovery', label: '2:복구 코드' },
  { id: 'integrations', label: '3:CLI/MCP 연동' },
  { id: 'reports', label: '4:내 신고' },
  { id: 'withdraw', label: '5:회원 탈퇴' },
];

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function resolvePalette(theme?: ThemePalette | ServiceTheme): ThemePalette {
  if (!theme || typeof theme === 'string') {
    return getThemePalette(theme ?? 'dark');
  }
  return theme;
}

function ApprovalCodeInput({
  value,
  onChange,
  focused,
  theme,
  onSubmit,
}: {
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  theme: ThemePalette;
  onSubmit?: () => void;
}) {
  usePaste(
    pasted => {
      if (!focused) return;
      const clean = pasted.replace(CONTROL_CHARS, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (clean) onChange(clean);
    },
    { isActive: focused },
  );

  useInput(
    (input, key) => {
      if (!focused) return;
      for (const action of inputActions(input, key)) {
        if (action.kind === 'submit') {
          onSubmit?.();
          return;
        }
        if (action.kind === 'backspace' || action.kind === 'delete') {
          onChange(value.slice(0, -1));
          return;
        }
        if (action.kind === 'text') {
          const clean = action.text.replace(CONTROL_CHARS, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (clean) onChange((value + clean).slice(0, 6));
        }
      }
    },
    { isActive: focused },
  );

  return (
    <Box
      width={24}
      borderStyle="single"
      borderColor={focused ? theme.accent : theme.border}
      paddingX={1}
    >
      <Text color={value ? theme.text : theme.muted}>
        {value || '6자리 코드'}
        {focused ? '_' : ''}
      </Text>
    </Box>
  );
}

export function AccountSecurityScreen({
  lifecycleService,
  moderationService,
  memberId,
  nickname,
  sessionId = null,
  width = 100,
  height = 28,
  theme,
  grants: externalGrants,
  onListGrants,
  onApproveCode,
  onRevokeGrant,
  onWithdrawn,
  onBack,
}: AccountSecurityScreenProps) {
  const palette = resolvePalette(theme);

  const [tab, setTab] = useState<AccountTab>('password');
  const [focusIdx, setFocusIdx] = useState(0); // 0 = tabs
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');

  // Recovery code reissue state
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null);

  // Integrations state
  const [approvalCode, setApprovalCode] = useState('');
  const [approvalPassword, setApprovalPassword] = useState('');
  const [grants, setGrants] = useState<IntegrationGrantView[]>(() => [...(externalGrants ?? [])]);
  const [grantIndex, setGrantIndex] = useState(0);

  // My reports state
  const [reports, setReports] = useState<ContentReportRecord[]>([]);
  const [reportIndex, setReportIndex] = useState(0);

  // Withdraw state
  const [withdrawPassword, setWithdrawPassword] = useState('');
  const [withdrawConfirmOpen, setWithdrawConfirmOpen] = useState(false);

  const refreshGrants = useCallback(() => {
    if (onListGrants) {
      try {
        const list = onListGrants();
        setGrants(list);
        setGrantIndex(prev => Math.max(0, Math.min(prev, Math.max(0, list.length - 1))));
      } catch (err) {
        setErrorMessage(toServiceError(err).message);
      }
    } else if (externalGrants) {
      setGrants([...externalGrants]);
    }
  }, [onListGrants, externalGrants]);

  const refreshReports = useCallback(() => {
    if (!moderationService) return;
    try {
      const list = moderationService.listMyReports(memberId);
      setReports(list);
      setReportIndex(prev => Math.max(0, Math.min(prev, Math.max(0, list.length - 1))));
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  }, [moderationService, memberId]);

  useEffect(() => {
    if (tab === 'integrations') refreshGrants();
    if (tab === 'reports') refreshReports();
  }, [tab, refreshGrants, refreshReports]);

  const fieldsForTab = (): string[] => {
    switch (tab) {
      case 'password':
        return ['tabs', 'currentPassword', 'newPassword', 'newPasswordConfirm', 'submit'];
      case 'recovery':
        return ['tabs', 'recoveryPassword', 'submit'];
      case 'integrations':
        return ['tabs', 'approvalCode', 'approvalPassword', 'approveSubmit', 'grantsList'];
      case 'reports':
        return ['tabs', 'reportsList'];
      case 'withdraw':
        return ['tabs', 'withdrawPassword', 'withdrawSubmit'];
    }
  };

  const fields = fieldsForTab();
  const activeField = fields[Math.min(focusIdx, fields.length - 1)] ?? 'tabs';

  const switchTab = (next: AccountTab) => {
    setTab(next);
    setFocusIdx(1);
    setErrorMessage('');
    setStatusMessage('');
  };

  const submitPasswordChange = () => {
    setErrorMessage('');
    setStatusMessage('');
    if (newPassword !== newPasswordConfirm) {
      setErrorMessage('새 비밀번호 확인이 일치하지 않아요.');
      return;
    }
    try {
      const res = lifecycleService.changePassword({
        memberId,
        currentPassword,
        newPassword,
        currentSessionId: sessionId,
      });
      setCurrentPassword('');
      setNewPassword('');
      setNewPasswordConfirm('');
      setStatusMessage(
        `비밀번호를 변경했어요. 다른 세션 ${res.closedSessionCount}개와 연동 자격 ${res.revokedGrantCount}개를 무효화했어요.`,
      );
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  const submitRecoveryReissue = () => {
    setErrorMessage('');
    setStatusMessage('');
    try {
      const res = lifecycleService.reissueRecoveryCode({
        memberId,
        currentPassword: recoveryPassword,
      });
      setRecoveryPassword('');
      setIssuedRecoveryCode(res.recoveryCode);
      setStatusMessage('새 32자리 복구 코드를 발급했어요. 아래 코드를 안전한 곳에 보관하세요.');
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  const submitApproveCode = () => {
    setErrorMessage('');
    setStatusMessage('');
    if (!onApproveCode) {
      setErrorMessage('연동 승인 어댑터가 아직 연결되지 않았어요.');
      return;
    }
    try {
      const approved = onApproveCode(approvalCode, approvalPassword);
      setApprovalCode('');
      setApprovalPassword('');
      setStatusMessage(
        approved
          ? `연동을 승인했어요 (${approved.label} · 범위: ${approved.scopes.join(', ')}).`
          : '6자리 승인 코드를 승인했어요.',
      );
      refreshGrants();
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  const confirmWithdraw = () => {
    setWithdrawConfirmOpen(false);
    setErrorMessage('');
    setStatusMessage('');
    try {
      lifecycleService.withdrawAccount({
        memberId,
        password: withdrawPassword,
        confirm: true,
      });
      setWithdrawPassword('');
      setStatusMessage('회원 탈퇴가 완료되었어요.');
      if (onWithdrawn) {
        onWithdrawn();
      } else {
        onBack();
      }
    } catch (err) {
      setErrorMessage(toServiceError(err).message);
    }
  };

  useInput(
    (input, key) => {
      if (withdrawConfirmOpen) return;

      if (key.escape) {
        if (focusIdx > 0) {
          setFocusIdx(0);
        } else {
          onBack();
        }
        return;
      }

      if (key.tab) {
        const delta = key.shift ? -1 : 1;
        setFocusIdx(prev => (prev + delta + fields.length) % fields.length);
        return;
      }

      if (activeField === 'tabs') {
        if (key.leftArrow || key.rightArrow) {
          const idx = TABS.findIndex(t => t.id === tab);
          const delta = key.leftArrow ? -1 : 1;
          const next = TABS[(idx + delta + TABS.length) % TABS.length]!;
          setTab(next.id);
          setErrorMessage('');
          setStatusMessage('');
          return;
        }
        if (input === '1') { switchTab('password'); return; }
        if (input === '2') { switchTab('recovery'); return; }
        if (input === '3') { switchTab('integrations'); return; }
        if (input === '4') { switchTab('reports'); return; }
        if (input === '5') { switchTab('withdraw'); return; }
        if (key.return) {
          setFocusIdx(1);
          return;
        }
      }

      if (activeField === 'grantsList') {
        if (key.upArrow || input === 'k') {
          setGrantIndex(prev => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setGrantIndex(prev => Math.min(Math.max(0, grants.length - 1), prev + 1));
          return;
        }
        if ((input === 'x' || input === 'r') && grants[grantIndex] && onRevokeGrant) {
          try {
            onRevokeGrant(grants[grantIndex]!.id);
            setStatusMessage('연동 자격을 회수했어요.');
            refreshGrants();
          } catch (err) {
            setErrorMessage(toServiceError(err).message);
          }
          return;
        }
      }

      if (activeField === 'reportsList') {
        if (key.upArrow || input === 'k') {
          setReportIndex(prev => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow || input === 'j') {
          setReportIndex(prev => Math.min(Math.max(0, reports.length - 1), prev + 1));
          return;
        }
        if (input === 'r') {
          refreshReports();
          setStatusMessage('신고 처리 내역을 새로고침했어요.');
          return;
        }
      }

      if (key.return) {
        if (activeField === 'submit' && tab === 'password') submitPasswordChange();
        else if (activeField === 'submit' && tab === 'recovery') submitRecoveryReissue();
        else if (activeField === 'approveSubmit' && tab === 'integrations') submitApproveCode();
        else if (activeField === 'withdrawSubmit' && tab === 'withdraw') {
          if (!withdrawPassword) {
            setErrorMessage('현재 비밀번호를 입력해 주세요.');
          } else {
            setWithdrawConfirmOpen(true);
          }
        }
      }
    },
    { isActive: !withdrawConfirmOpen },
  );

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
        계정 · 보안 · 연동 관리 (@{nickname})
      </Text>

      <Box gap={2} marginTop={1} marginBottom={1}>
        {TABS.map(item => {
          const selected = item.id === tab;
          return (
            <Text
              key={item.id}
              bold={selected}
              color={selected ? palette.accent : palette.muted}
              inverse={selected && activeField === 'tabs'}
            >
              {` [${item.label}] `}
            </Text>
          );
        })}
      </Box>

      {withdrawConfirmOpen ? (
        <ConfirmDialog
          title="회원 탈퇴 최종 확인"
          message="탈퇴 시 프로필·개인 공간·북마크가 삭제되고 작성물은 '탈퇴한 사용자'로 익명화되며, 아이디·닉네임은 90일간 재사용이 제한됩니다. 계속할까요?"
          confirmLabel="탈퇴 실행"
          cancelLabel="취소"
          destructive
          theme={palette}
          onConfirm={confirmWithdraw}
          onCancel={() => setWithdrawConfirmOpen(false)}
        />
      ) : (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.border}
          paddingX={2}
          paddingY={1}
          flexGrow={1}
        >
          {tab === 'password' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>비밀번호 변경</Text>
              <Text color={palette.muted}>
                현재 세션은 유지되고 다른 세션과 모든 CLI/MCP 연동 자격은 즉시 무효화됩니다. (복구 코드는 유지)
              </Text>
              <Box flexDirection="column">
                <Text color={activeField === 'currentPassword' ? palette.accent : palette.muted}>현재 비밀번호</Text>
                <SecretInput
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  focused={activeField === 'currentPassword'}
                  theme={palette}
                  onSubmit={() => setFocusIdx(2)}
                />
              </Box>
              <Box flexDirection="column">
                <Text color={activeField === 'newPassword' ? palette.accent : palette.muted}>새 비밀번호 (10~24자, 3종 이상)</Text>
                <SecretInput
                  value={newPassword}
                  onChange={setNewPassword}
                  focused={activeField === 'newPassword'}
                  theme={palette}
                  onSubmit={() => setFocusIdx(3)}
                />
              </Box>
              <Box flexDirection="column">
                <Text color={activeField === 'newPasswordConfirm' ? palette.accent : palette.muted}>새 비밀번호 확인</Text>
                <SecretInput
                  value={newPasswordConfirm}
                  onChange={setNewPasswordConfirm}
                  focused={activeField === 'newPasswordConfirm'}
                  theme={palette}
                  onSubmit={submitPasswordChange}
                />
              </Box>
              <Text
                bold={activeField === 'submit'}
                color={activeField === 'submit' ? palette.accent : palette.text}
                inverse={activeField === 'submit'}
              >
                {' [비밀번호 변경 실행] '}
              </Text>
            </Box>
          )}

          {tab === 'recovery' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>복구 코드 재발급</Text>
              <Text color={palette.muted}>
                현재 비밀번호 확인 후 기존 복구 코드를 폐기하고 새 32자리 코드를 1회 표시합니다.
              </Text>
              <Box flexDirection="column">
                <Text color={activeField === 'recoveryPassword' ? palette.accent : palette.muted}>현재 비밀번호</Text>
                <SecretInput
                  value={recoveryPassword}
                  onChange={setRecoveryPassword}
                  focused={activeField === 'recoveryPassword'}
                  theme={palette}
                  onSubmit={submitRecoveryReissue}
                />
              </Box>
              <Text
                bold={activeField === 'submit'}
                color={activeField === 'submit' ? palette.accent : palette.text}
                inverse={activeField === 'submit'}
              >
                {' [복구 코드 재발급] '}
              </Text>
              {issuedRecoveryCode && (
                <Box borderStyle="double" borderColor={palette.success} paddingX={2} paddingY={1} marginTop={1}>
                  <Text bold color={palette.success}>
                    새 복구 코드 (1회 표시): {issuedRecoveryCode}
                  </Text>
                </Box>
              )}
            </Box>
          )}

          {tab === 'integrations' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>CLI / MCP 6자리 승인 코드 입력 및 내 연동 자격</Text>
              <Box gap={2}>
                <Box flexDirection="column">
                  <Text color={activeField === 'approvalCode' ? palette.accent : palette.muted}>6자리 승인 코드</Text>
                  <ApprovalCodeInput
                    value={approvalCode}
                    onChange={setApprovalCode}
                    focused={activeField === 'approvalCode'}
                    theme={palette}
                    onSubmit={() => setFocusIdx(2)}
                  />
                </Box>
                <Box flexDirection="column">
                  <Text color={activeField === 'approvalPassword' ? palette.accent : palette.muted}>비밀번호 재확인</Text>
                  <SecretInput
                    value={approvalPassword}
                    onChange={setApprovalPassword}
                    focused={activeField === 'approvalPassword'}
                    theme={palette}
                    onSubmit={submitApproveCode}
                  />
                </Box>
              </Box>
              <Text
                bold={activeField === 'approveSubmit'}
                color={activeField === 'approveSubmit' ? palette.accent : palette.text}
                inverse={activeField === 'approveSubmit'}
              >
                {' [연동 코드 승인] '}
              </Text>
              <Text color={activeField === 'grantsList' ? palette.accent : palette.muted}>
                내 연동 자격 목록 ({grants.length}건 · ↑/↓ 선택 · x 회수)
              </Text>
              {grants.length === 0 ? (
                <Text color={palette.muted}>활성 연동 자격이 없어요.</Text>
              ) : (
                grants.slice(0, 6).map((g, idx) => {
                  const selected = activeField === 'grantsList' && idx === grantIndex;
                  const stateLabel = g.revokedAt ? '회수됨' : `만료 ${g.expiresAt.slice(0, 16)}`;
                  return (
                    <Text
                      key={g.id}
                      color={selected ? palette.accent : palette.text}
                      backgroundColor={selected ? palette.selected : undefined}
                    >
                      {selected ? '› ' : '  '}
                      [{g.channel.toUpperCase()}] {g.label} · 범위({g.scopes.join(',')}) · {stateLabel}
                    </Text>
                  );
                })
              )}
            </Box>
          )}

          {tab === 'reports' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.text} bold>
                내 신고 처리 결과 ({reports.length}건 · r 새로고침)
              </Text>
              {!moderationService ? (
                <Text color={palette.muted}>신고 서비스가 연결되지 않았어요.</Text>
              ) : reports.length === 0 ? (
                <Text color={palette.muted}>접수한 신고 내역이 없어요.</Text>
              ) : (
                reports.slice(0, 8).map((r, idx) => {
                  const selected = activeField === 'reportsList' && idx === reportIndex;
                  const stateText = r.reviewState === 'received'
                    ? '접수됨'
                    : r.outcome === 'deleted'
                      ? '검토 완료 · 삭제됨'
                      : '검토 완료 · 조치 없음';
                  return (
                    <Box key={r.id} flexDirection="column">
                      <Text
                        color={selected ? palette.accent : palette.text}
                        backgroundColor={selected ? palette.selected : undefined}
                      >
                        {selected ? '› ' : '  '}
                        [{r.targetKind}] {r.targetId} · {stateText} · {r.createdAt.slice(0, 10)}
                      </Text>
                      {selected && r.resolutionReason && (
                        <Text color={palette.muted}>    처리 사유: {r.resolutionReason}</Text>
                      )}
                    </Box>
                  );
                })
              )}
            </Box>
          )}

          {tab === 'withdraw' && (
            <Box flexDirection="column" gap={1}>
              <Text color={palette.error} bold>회원 탈퇴</Text>
              <Text color={palette.text}>
                • 탈퇴 시 아이디와 닉네임은 90일간 재사용이 제한되며, 90일 경과 후 개인정보가 영구 파기됩니다.
              </Text>
              <Text color={palette.text}>
                • 프로필·개인 공간·관심 모집 목록은 삭제되며, 기존 글·댓글·방명록·채팅은 &apos;탈퇴한 사용자&apos;로 남습니다.
              </Text>
              <Box flexDirection="column">
                <Text color={activeField === 'withdrawPassword' ? palette.accent : palette.muted}>현재 비밀번호 입력</Text>
                <SecretInput
                  value={withdrawPassword}
                  onChange={setWithdrawPassword}
                  focused={activeField === 'withdrawPassword'}
                  theme={palette}
                  onSubmit={() => {
                    if (!withdrawPassword) setErrorMessage('현재 비밀번호를 입력해 주세요.');
                    else setWithdrawConfirmOpen(true);
                  }}
                />
              </Box>
              <Text
                bold={activeField === 'withdrawSubmit'}
                color={activeField === 'withdrawSubmit' ? palette.error : palette.text}
                inverse={activeField === 'withdrawSubmit'}
              >
                {' [회원 탈퇴 진행...] '}
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
          Tab: 항목 이동 · 1~5/←/→: 탭 전환 · Esc: 탭 바/월드 복귀
        </Text>
      </Box>
    </Box>
  );
}
