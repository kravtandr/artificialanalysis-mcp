export type AAErrorKind =
  | 'auth'
  | 'forbidden'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'not_found'
  | 'catalog_truncated';

export class AAApiError extends Error {
  readonly kind: AAErrorKind;
  readonly resetAt?: Date;

  constructor(kind: AAErrorKind, message: string, opts?: { resetAt?: Date; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AAApiError';
    this.kind = kind;
    if (opts?.resetAt !== undefined) this.resetAt = opts.resetAt;
  }
}

// При этих ошибках допустимо отдать stale-копию каталога (SPEC.md §3.3):
// API недоступен или снимок неполон, но старые данные лучше отказа.
export function isStaleEligible(error: unknown): boolean {
  return (
    error instanceof AAApiError &&
    (error.kind === 'rate_limited' ||
      error.kind === 'server_error' ||
      error.kind === 'network' ||
      error.kind === 'catalog_truncated')
  );
}
