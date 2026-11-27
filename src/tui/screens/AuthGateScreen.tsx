import { useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import type { AuthService, MemberRecord, SignupResult } from '../../core/auth-service.js';
import { toServiceError } from '../../core/errors.js';
import { inputActions } from '../../ui/Input.js';
import { SecretInput } from '../components/SecretInput.js';
import { getThemePalette, type ThemePalette } from '../components/Themes.js';

export type AuthGateMode = 'guest' | 'login' | 'signup' | 'recover';

export interface AccountRecoveryInput {
  loginId: string;
  recoveryCode: string;
  newPassword: string;
}

export interface AuthGateScreenProps {
  authService: AuthService;
  width: number;
  height: number;
  theme?: ThemePalette;
  onAuthenticated: (member: MemberRecord) => void;
  onGuestEnter: () => void;
  onRecover?: (input: AccountRecoveryInput) => void;
  onExit?: () => void;
}

const MODES: readonly { id: AuthGateMode; label: string }[] = [
  { id: 'guest', label: '게스트 둘러보기' },
  { id: 'login', label: '로그인' },
  { id: 'signup', label: '회원가입' },
  { id: 'recover', label: '계정 복구' },
];

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;

function SingleLineField({
  label,
  value,
  onChange,
  focused,
  placeholder,
  width = 36,
  theme,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  focused: boolean;
  placeholder: string;
  width?: number;
  theme: ThemePalette;
  onSubmit?: () => void;
}) {
  usePaste(
    pasted => {
      if (!focused) return;
      const clean = pasted.replace(CONTROL_CHARS, '').normalize('NFC');
      if (clean) onChange(value + clean);
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
          const pts = Array.from(value);
          if (pts.length > 0) {
            onChange(pts.slice(0, -1).join(''));
          }
          return;
        }
        if (action.kind === 'text') {
          const clean = action.text.replace(CONTROL_CHARS, '').normalize('NFC');
          if (clean) onChange(value + clean);
        }
      }
    },
    { isActive: focused },
  );

  return (
    <Box flexDirection="column">
      <Text color={focused ? theme.accent : theme.muted}>{label}</Text>
      <Box
        width={width}
        borderStyle="single"
        borderColor={focused ? theme.accent : theme.border}
        paddingX={1}
      >
        <Text color={value ? theme.text : theme.muted}>
          {value || placeholder}
          {focused ? '_' : ''}
        </Text>
      </Box>
    </Box>
  );
}

export function AuthGateScreen({
  authService,
  width,
  height,
  theme = getThemePalette('dark'),
  onAuthenticated,
  onGuestEnter,
  onRecover,
  onExit,
}: AuthGateScreenProps) {
  const [mode, setMode] = useState<AuthGateMode>('guest');
  const [focusIdx, setFocusIdx] = useState(0); // 0 = tab bar
  const [loginId, setLoginId] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState('');
  const [signupReceipt, setSignupReceipt] = useState<SignupResult | null>(null);

  const fieldsForMode = (): string[] => {
    switch (mode) {
      case 'guest':
        return ['tabs', 'enter'];
      case 'login':
        return ['tabs', 'loginId', 'password', 'submit'];
      case 'signup':
        return ['tabs', 'loginId', 'nickname', 'password', 'passwordConfirm', 'submit'];
      case 'recover':
        return ['tabs', 'loginId', 'recoveryCode', 'password', 'submit'];
    }
  };

  const fields = fieldsForMode();
  const activeField = fields[Math.min(focusIdx, fields.length - 1)] ?? 'tabs';

  const switchMode = (nextMode: AuthGateMode) => {
    setMode(nextMode);
    setFocusIdx(nextMode === 'guest' ? 1 : 1);
    setError('');
  };

  const handleSubmit = () => {
    setError('');
    try {
      if (mode === 'guest') {
        onGuestEnter();
        return;
      }
      if (mode === 'login') {
        const result = authService.login({ loginId, password });
        onAuthenticated(result.member);
        return;
      }
      if (mode === 'signup') {
        if (password !== passwordConfirm) {
          setError('비밀번호 확인이 일치하지 않아요.');
          return;
        }
        const created = authService.signup({ loginId, nickname, password });
        setSignupReceipt(created);
        return;
      }
      if (mode === 'recover') {
        if (!onRecover) {
          setError('계정 복구 서비스가 아직 연결되지 않았어요.');
          return;
        }
        onRecover({ loginId, recoveryCode, newPassword: password });
      }
    } catch (err) {
      setError(toServiceError(err).message);
    }
  };

  useInput(
    (input, key) => {
      if (signupReceipt) {
        if (key.return || input === ' ') {
          onAuthenticated(signupReceipt.member);
        }
        return;
      }

      if (key.ctrl && input === 'c') {
        onExit?.();
        return;
      }

      if (key.tab) {
        const delta = key.shift ? -1 : 1;
        setFocusIdx(prev => (prev + delta + fields.length) % fields.length);
        return;
      }

      if (key.upArrow && activeField !== 'tabs') {
        setFocusIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow && activeField !== 'tabs') {
        setFocusIdx(prev => Math.min(fields.length - 1, prev + 1));
        return;
      }

      if (activeField === 'tabs') {
        if (key.leftArrow || key.rightArrow) {
          const idx = MODES.findIndex(m => m.id === mode);
          const delta = key.leftArrow ? -1 : 1;
          const next = MODES[(idx + delta + MODES.length) % MODES.length]!;
          setMode(next.id);
          setError('');
          return;
        }
        if (key.return) {
          if (mode === 'guest') onGuestEnter();
          else setFocusIdx(1);
          return;
        }
        if (input === '1') { switchMode('guest'); return; }
        if (input === '2') { switchMode('login'); return; }
        if (input === '3') { switchMode('signup'); return; }
        if (input === '4') { switchMode('recover'); return; }
        if (input === 'q') { onExit?.(); return; }
      }

      if ((activeField === 'submit' || activeField === 'enter') && key.return) {
        handleSubmit();
      }
    },
    { isActive: true },
  );

  if (signupReceipt) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={height}
        backgroundColor={theme.background}
        padding={2}
      >
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor={theme.warning}
          paddingX={2}
          paddingY={1}
        >
          <Text bold color={theme.success}>
            회원가입 완료 · @{signupReceipt.member.nickname} 님 환영합니다!
          </Text>
          <Box marginTop={1}>
            <Text color={theme.warning} bold>
              1회성 32자리 계정 복구 코드 (이번 한 번만 표시됩니다 — 반드시 안전하게 보관하세요):
            </Text>
          </Box>
          <Box marginTop={1} marginBottom={1} borderStyle="single" borderColor={theme.accent} paddingX={2}>
            <Text bold color={theme.accent}>
              {signupReceipt.recoveryCode}
            </Text>
          </Box>
          <Text color={theme.muted}>
            개인 공간 슬롯 #{signupReceipt.personalSpace.gridSlot + 1}이 자동 생성되었습니다.
          </Text>
          <Box marginTop={1}>
            <Text inverse color={theme.success}>
              {' [복구 코드를 안전하게 보관했습니다 · Enter로 월드 입장] '}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={theme.background}
      paddingX={2}
      paddingY={1}
    >
      <Text bold color={theme.accent}>
        TERMINAL WORLD · 접속 게이트
      </Text>
      <Text color={theme.muted}>
        Tab/↑↓ 이동 · 탭 바에서 ←/→ 또는 1~4 전환 · Ctrl+C 종료
      </Text>

      <Box marginTop={1} marginBottom={1} gap={2}>
        {MODES.map((item, idx) => {
          const selected = item.id === mode;
          const isTabFocus = activeField === 'tabs' && selected;
          return (
            <Text
              key={item.id}
              bold={selected}
              color={selected ? theme.accent : theme.muted}
              inverse={isTabFocus}
            >
              {` [${idx + 1}] ${item.label} `}
            </Text>
          );
        })}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={1}
        flexGrow={1}
      >
        {mode === 'guest' && (
          <Box flexDirection="column" gap={1}>
            <Text color={theme.text}>
              게스트 모드로 공용 공간(Lobby, Cafe, 오픈소스 탐색, 공개 개인 공간)을 둘러볼 수 있습니다.
            </Text>
            <Text color={theme.muted}>
              글쓰기·방명록·채팅·집중 시간 기록에는 회원가입 또는 로그인이 필요합니다.
            </Text>
            <Box marginTop={1}>
              <Text inverse={activeField === 'enter'} color={theme.accent}>
                {' [게스트로 월드 둘러보기 (Enter)] '}
              </Text>
            </Box>
          </Box>
        )}

        {mode === 'login' && (
          <Box flexDirection="column" gap={1}>
            <SingleLineField
              label="아이디 (영문·숫자·_- 4~20자, 대소문자 무관)"
              value={loginId}
              onChange={setLoginId}
              focused={activeField === 'loginId'}
              placeholder="login_id"
              theme={theme}
              onSubmit={() => setFocusIdx(2)}
            />
            <Box flexDirection="column">
              <Text color={activeField === 'password' ? theme.accent : theme.muted}>비밀번호</Text>
              <SecretInput
                value={password}
                onChange={setPassword}
                focused={activeField === 'password'}
                theme={theme}
                onSubmit={handleSubmit}
              />
            </Box>
            <Box marginTop={1}>
              <Text inverse={activeField === 'submit'} color={theme.accent}>
                {' [로그인 (Enter)] '}
              </Text>
            </Box>
          </Box>
        )}

        {mode === 'signup' && (
          <Box flexDirection="column">
            <SingleLineField
              label="아이디 (영문·숫자·_- 4~20자)"
              value={loginId}
              onChange={setLoginId}
              focused={activeField === 'loginId'}
              placeholder="login_id"
              theme={theme}
              onSubmit={() => setFocusIdx(2)}
            />
            <SingleLineField
              label="닉네임 (한글·영문·숫자·_- 2~12자)"
              value={nickname}
              onChange={setNickname}
              focused={activeField === 'nickname'}
              placeholder="닉네임"
              theme={theme}
              onSubmit={() => setFocusIdx(3)}
            />
            <Box flexDirection="column">
              <Text color={activeField === 'password' ? theme.accent : theme.muted}>
                비밀번호 (ASCII 10~24자, 영문 대/소문자·숫자·특수문자 중 3종 이상)
              </Text>
              <SecretInput
                value={password}
                onChange={setPassword}
                focused={activeField === 'password'}
                theme={theme}
                onSubmit={() => setFocusIdx(4)}
              />
            </Box>
            <Box flexDirection="column">
              <Text color={activeField === 'passwordConfirm' ? theme.accent : theme.muted}>
                비밀번호 확인
              </Text>
              <SecretInput
                value={passwordConfirm}
                onChange={setPasswordConfirm}
                focused={activeField === 'passwordConfirm'}
                theme={theme}
                onSubmit={handleSubmit}
              />
            </Box>
            <Box marginTop={1}>
              <Text inverse={activeField === 'submit'} color={theme.accent}>
                {' [회원가입 및 자동 로그인 (Enter)] '}
              </Text>
            </Box>
          </Box>
        )}

        {mode === 'recover' && (
          <Box flexDirection="column" gap={1}>
            <SingleLineField
              label="아이디"
              value={loginId}
              onChange={setLoginId}
              focused={activeField === 'loginId'}
              placeholder="login_id"
              theme={theme}
              onSubmit={() => setFocusIdx(2)}
            />
            <Box flexDirection="column">
              <Text color={activeField === 'recoveryCode' ? theme.accent : theme.muted}>
                32자리 복구 코드
              </Text>
              <SecretInput
                value={recoveryCode}
                onChange={setRecoveryCode}
                focused={activeField === 'recoveryCode'}
                theme={theme}
                onSubmit={() => setFocusIdx(3)}
              />
            </Box>
            <Box flexDirection="column">
              <Text color={activeField === 'password' ? theme.accent : theme.muted}>
                새 비밀번호
              </Text>
              <SecretInput
                value={password}
                onChange={setPassword}
                focused={activeField === 'password'}
                theme={theme}
                onSubmit={handleSubmit}
              />
            </Box>
            <Box marginTop={1}>
              <Text inverse={activeField === 'submit'} color={theme.accent}>
                {' [계정 복구 실행 (Enter)] '}
              </Text>
            </Box>
          </Box>
        )}

        {error ? (
          <Box marginTop={1}>
            <Text color={theme.error} bold>
              오류: {error}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
