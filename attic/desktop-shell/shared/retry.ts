export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 8, baseDelayMs: 500, maxDelayMs: 30_000 }

export function retryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exponential * (0.8 + Math.random() * 0.4))
}

