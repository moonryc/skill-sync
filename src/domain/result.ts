export const EXIT_CODES = {
  success: 0,
  internal: 1,
  usage: 2,
  validation: 3,
  repository: 4,
  conflict: 5,
  partial: 6,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export interface StructuredError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly data: T; readonly exitCode: typeof EXIT_CODES.success }
  | {
      readonly ok: false;
      readonly errors: readonly StructuredError[];
      readonly exitCode: ExitCode;
    };

export class SkillSyncError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    exitCode: ExitCode,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'SkillSyncError';
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) this.details = details;
  }
}

export function success<T>(data: T): CommandResult<T> {
  return { ok: true, data, exitCode: EXIT_CODES.success };
}

export function failure(
  error: StructuredError | readonly StructuredError[],
  exitCode: ExitCode,
): CommandResult<never> {
  return { ok: false, errors: Array.isArray(error) ? error : [error], exitCode };
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(gh[opsu]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /\b((?:token|password|passwd|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
];

export function redactSecrets(value: string): string {
  let redacted = value.replace(/\b(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, '$1[REDACTED]@');
  redacted = redacted.replace(/([?&](?:token|access_token|key|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
  for (const pattern of CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix: string | undefined) =>
      prefix && /[=:]|Bearer/i.test(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  return redacted;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeUnknown(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeUnknown(entry)]),
    );
  }
  return value;
}

export function sanitizeError(error: StructuredError): StructuredError {
  const details = error.details === undefined ? undefined : sanitizeUnknown(error.details);
  return {
    code: error.code,
    message: redactSecrets(error.message),
    ...(details === undefined ? {} : { details: details as Readonly<Record<string, unknown>> }),
  };
}

export function resultFromUnknown(error: unknown): CommandResult<never> {
  if (error instanceof SkillSyncError) {
    return failure(
      sanitizeError({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
      error.exitCode,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return failure(
    { code: 'INTERNAL_ERROR', message: redactSecrets(message || 'Unexpected internal failure') },
    EXIT_CODES.internal,
  );
}
