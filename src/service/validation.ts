/** Input rules for the shared service, following requirements sections 5.3 and 5.10–5.12. */
export class ValidationError extends Error {
  readonly code = 'INVALID_INPUT';

  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const textRules = {
  title: { max: 100, multiline: false, required: true },
  body: { max: 10_000, multiline: true, required: true },
  comment: { max: 1_000, multiline: true, required: true },
  guestbook: { max: 1_000, multiline: true, required: true },
  chat: { max: 500, multiline: false, required: true },
  reason: { max: 1_000, multiline: true, required: true },
  introduction: { max: 500, multiline: true, required: false },
  status: { max: 80, multiline: false, required: false },
  technology: { max: 20, multiline: false, required: true },
  projectUrl: { max: 2_048, multiline: false, required: false },
} as const;

export type TextField = keyof typeof textRules;
export type ServiceTheme = 'dark' | 'light' | 'green' | 'amber';

// LF is checked separately because only selected fields support multiple lines.
const terminalControls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(field, '문자열을 입력해 주세요.');
  // JSON strings can contain lone surrogates, which cannot round-trip as UTF-8 text.
  if (/[\ud800-\udfff]/u.test(value)) throw new ValidationError(field, '올바른 유니코드 문자를 입력해 주세요.');
  return value;
}

export function parseAccountName(field: 'loginId' | 'nickname', value: unknown): { value: string; lookupKey: string } {
  const normalized = string(value, field).normalize('NFC');
  const valid = field === 'loginId'
    ? /^[A-Za-z0-9_-]{4,20}$/.test(normalized)
    : /^[가-힣A-Za-z0-9_-]{2,12}$/u.test(normalized);
  if (!valid) {
    throw new ValidationError(field, field === 'loginId'
      ? '아이디는 영문·숫자·밑줄·대시 4~20자로 입력해 주세요.'
      : '닉네임은 완성형 한글·영문·숫자·밑줄·대시 2~12자로 입력해 주세요.');
  }
  return { value: normalized, lookupKey: normalized.toLowerCase() };
}

export function parsePassword(value: unknown): string {
  const password = string(value, 'password');
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(password)).length;
  if (!/^[\x21-\x7e]{10,24}$/.test(password) || categories < 3) {
    throw new ValidationError('password', '비밀번호는 공백 없는 ASCII 10~24자이며 소문자·대문자·숫자·특수문자 중 세 종류 이상이 필요해요.');
  }
  return password;
}

export function parseText(field: TextField, value: unknown): string {
  const normalized = string(value, field).normalize('NFC');
  const rule = textRules[field];
  if (terminalControls.test(normalized) || (!rule.multiline && normalized.includes('\n'))) {
    throw new ValidationError(field, rule.multiline
      ? '탭과 터미널 제어문자는 입력할 수 없어요.'
      : '탭·줄바꿈·터미널 제어문자는 입력할 수 없어요.');
  }
  if (Array.from(normalized).length > rule.max) {
    throw new ValidationError(field, `${rule.max}자까지 입력할 수 있어요.`);
  }
  if (rule.required && !normalized.trim()) throw new ValidationError(field, '내용을 입력해 주세요.');
  return normalized;
}

export function parseTechnologyStack(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10) {
    throw new ValidationError('technologyStack', '기술 스택은 최대 10개까지 입력할 수 있어요.');
  }
  return Array.from(value, item => parseText('technology', item));
}

export function parseProjectUrl(value: unknown): string {
  const url = parseText('projectUrl', value);
  if (!url) return url;
  try {
    if (/\s/u.test(url) || new URL(url).protocol !== 'https:' || !/^https:\/\//i.test(url)) throw new Error('HTTPS required');
  } catch {
    throw new ValidationError('projectUrl', 'HTTPS 주소 하나를 입력해 주세요.');
  }
  return url;
}

export function parseAsciiArt(value: unknown): string {
  const art = string(value, 'asciiArt');
  if (/[^\x20-\x7e\n]/.test(art)) throw new ValidationError('asciiArt', '출력 가능한 ASCII 문자와 줄바꿈만 입력할 수 있어요.');
  const lines = art.split('\n');
  if (lines.length > 12 || lines.some(line => line.length > 40)) {
    throw new ValidationError('asciiArt', 'ASCII 아트는 최대 40열×12줄로 입력해 주세요.');
  }
  return art;
}

export function parseTheme(value: unknown = 'dark'): ServiceTheme {
  if (value !== 'dark' && value !== 'light' && value !== 'green' && value !== 'amber') {
    throw new ValidationError('theme', '다크·라이트·그린·앰버 중 하나를 선택해 주세요.');
  }
  return value;
}

export function parseRecoveryCode(value: unknown): string {
  const input = string(value, 'recoveryCode');
  if (/[^A-Za-z0-9-]/.test(input)) throw new ValidationError('recoveryCode', '32자리 복구 코드를 확인해 주세요.');
  const code = input.toUpperCase();
  const alphabet = '[ABCDEFGHJKMNPQRSTUVWXYZ23456789]';
  if (!new RegExp(`^(?:${alphabet}{32}|(?:${alphabet}{4}-){7}${alphabet}{4})$`).test(code)) {
    throw new ValidationError('recoveryCode', '32자리 복구 코드를 확인해 주세요.');
  }
  return code.replaceAll('-', '');
}
