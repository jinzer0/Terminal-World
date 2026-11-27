import { ValidationError } from '../service/validation.js';

export type ServiceErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'AUTH_FAILED'
  | 'AUTH_LOCKED'
  | 'AUTH_EXPIRED'
  | 'AUTH_REVOKED'
  | 'TOKEN_REUSE_DETECTED'
  | 'RECOVERY_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EXTERNAL_UNAVAILABLE'
  | 'UNCERTAIN_DELIVERY'
  | 'HANDOFF_REQUIRED'
  | 'INTERNAL_ERROR';

export function errorToExitCode(code: ServiceErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 2;
    case 'UNAUTHORIZED':
    case 'AUTH_FAILED':
    case 'AUTH_LOCKED':
    case 'AUTH_EXPIRED':
    case 'AUTH_REVOKED':
    case 'TOKEN_REUSE_DETECTED':
    case 'RECOVERY_FAILED':
    case 'FORBIDDEN':
    case 'HANDOFF_REQUIRED':
      return 3;
    case 'NOT_FOUND':
    case 'CONFLICT':
    case 'RATE_LIMITED':
      return 4;
    case 'EXTERNAL_UNAVAILABLE':
    case 'INTERNAL_ERROR':
      return 5;
    case 'UNCERTAIN_DELIVERY':
      return 6;
  }
}

export function errorToHttpStatus(code: ServiceErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'UNAUTHORIZED':
    case 'AUTH_FAILED':
    case 'AUTH_EXPIRED':
    case 'AUTH_REVOKED':
    case 'TOKEN_REUSE_DETECTED':
    case 'RECOVERY_FAILED':
      return 401;
    case 'AUTH_LOCKED':
      return 423;
    case 'FORBIDDEN':
    case 'HANDOFF_REQUIRED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'EXTERNAL_UNAVAILABLE':
      return 503;
    case 'UNCERTAIN_DELIVERY':
      return 504;
    case 'INTERNAL_ERROR':
      return 500;
  }
}

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly field?: string;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;
  readonly exitCode: number;

  constructor(
    code: ServiceErrorCode,
    message: string,
    field?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.field = field;
    this.details = details;
    this.httpStatus = errorToHttpStatus(code);
    this.exitCode = errorToExitCode(code);
  }

  toJSON(): {
    code: ServiceErrorCode;
    field?: string;
    message: string;
    details?: Record<string, unknown>;
  } {
    const payload: {
      code: ServiceErrorCode;
      field?: string;
      message: string;
      details?: Record<string, unknown>;
    } = {
      code: this.code,
      message: this.message,
    };
    if (this.field !== undefined) payload.field = this.field;
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ValidationError) {
    return new ServiceError('INVALID_INPUT', error.message, error.field);
  }
  if (error instanceof Error) {
    return new ServiceError('INTERNAL_ERROR', error.message);
  }
  return new ServiceError('INTERNAL_ERROR', '알 수 없는 오류가 발생했어요.');
}
