import { ServiceError } from './errors.js';

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  private currentMs: number;

  constructor(initial: Date | string | number = '2026-11-28T00:00:00.000Z') {
    this.currentMs = typeof initial === 'number' ? initial : new Date(initial).getTime();
    if (Number.isNaN(this.currentMs)) {
      throw new Error(`Invalid FakeClock initial time: ${String(initial)}`);
    }
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  set(next: Date | string | number): void {
    const ms = typeof next === 'number' ? next : new Date(next).getTime();
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid FakeClock time: ${String(next)}`);
    }
    this.currentMs = ms;
  }

  advanceMs(ms: number): Date {
    this.currentMs += ms;
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advanceMs(seconds * 1000);
  }

  advanceMinutes(minutes: number): Date {
    return this.advanceMs(minutes * 60 * 1000);
  }

  advanceHours(hours: number): Date {
    return this.advanceMs(hours * 60 * 60 * 1000);
  }

  advanceDays(days: number): Date {
    return this.advanceMs(days * DAY_MS);
  }
}

export function toIso(date: Date | string | number): string {
  return new Date(date).toISOString();
}

export function addMs(date: Date | string, ms: number): string {
  return new Date(new Date(date).getTime() + ms).toISOString();
}

export function addSeconds(date: Date | string, seconds: number): string {
  return addMs(date, seconds * 1000);
}

export function addMinutes(date: Date | string, minutes: number): string {
  return addMs(date, minutes * 60 * 1000);
}

export function addHours(date: Date | string, hours: number): string {
  return addMs(date, hours * 60 * 60 * 1000);
}

export function addDays(date: Date | string, days: number): string {
  return addMs(date, days * DAY_MS);
}

/**
 * Formats a UTC instant as an Asia/Seoul (UTC+09:00) calendar date string (YYYY-MM-DD).
 */
export function toKstDateString(date: Date | string | number): string {
  const ms = typeof date === 'number' ? date : new Date(date).getTime();
  const kst = new Date(ms + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the UTC epoch ms for the next Asia/Seoul midnight strictly after `utcMs`.
 */
export function nextKstMidnightUtcMs(utcMs: number): number {
  const kstMs = utcMs + KST_OFFSET_MS;
  const kstDayIndex = Math.floor(kstMs / DAY_MS);
  const nextKstMidnightMs = (kstDayIndex + 1) * DAY_MS;
  return nextKstMidnightMs - KST_OFFSET_MS;
}

export interface KstDailySlice {
  kstDate: string;
  seconds: number;
}

/**
 * Splits a [startedAt, endedAt] focus interval across Asia/Seoul (UTC+09:00) midnight boundaries.
 * The sum of returned integer seconds always equals Math.max(0, Math.floor((endMs - startMs) / 1000)).
 */
export function splitByKstMidnight(
  startedAt: Date | string | number,
  endedAt: Date | string | number,
): KstDailySlice[] {
  const startMs = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
  const endMs = typeof endedAt === 'number' ? endedAt : new Date(endedAt).getTime();
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (totalSeconds === 0) return [];

  const effectiveEndMs = startMs + totalSeconds * 1000;
  const slices: KstDailySlice[] = [];
  let cursorMs = startMs;
  let remainingSeconds = totalSeconds;

  while (cursorMs < effectiveEndMs && remainingSeconds > 0) {
    const kstDate = toKstDateString(cursorMs);
    const boundaryUtcMs = nextKstMidnightUtcMs(cursorMs);
    const sliceEndMs = Math.min(effectiveEndMs, boundaryUtcMs);
    const exactSec = Math.floor((sliceEndMs - cursorMs) / 1000);
    const seconds = sliceEndMs === effectiveEndMs
      ? remainingSeconds
      : Math.min(remainingSeconds, exactSec);

    if (seconds > 0) {
      slices.push({ kstDate, seconds });
      remainingSeconds -= seconds;
    }

    if (sliceEndMs === effectiveEndMs) {
      break;
    }
    cursorMs = boundaryUtcMs;
  }

  return slices;
}

/**
 * Parses a recruitment deadline input using Asia/Seoul (UTC+09:00) semantics when no offset is given.
 * - "YYYY-MM-DD" => end of that KST day (23:59:59.999+09:00)
 * - "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD HH:mm(:ss)?" => interpreted as +09:00
 * - ISO string with Z or +/-HH:MM => parsed as given and normalized to UTC ISO
 */
export function parseKstDeadline(input: string, field = 'deadlineAt'): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ServiceError('INVALID_INPUT', '마감 시각을 입력해 주세요.', field);
  }

  let candidate: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    candidate = `${trimmed}T23:59:59.999+09:00`;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(trimmed)) {
    const normalized = trimmed.replace(' ', 'T');
    candidate = `${normalized}+09:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    candidate = trimmed;
  } else {
    throw new ServiceError(
      'INVALID_INPUT',
      '마감 시각은 YYYY-MM-DD 또는 ISO-8601 형식으로 입력해 주세요.',
      field,
    );
  }

  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new ServiceError('INVALID_INPUT', '올바른 마감 시각을 입력해 주세요.', field);
  }
  return parsed.toISOString();
}
