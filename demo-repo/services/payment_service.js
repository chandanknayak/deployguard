import { acquireDistributedLock } from "./session_cache.js";

export const ROUTE_CHARGE = "POST /api/v1/payments/charge";
export const ROUTE_REFUND = "POST /api/v1/payments/refund";

export function computeBackoff(attempt, baseMs = 200, jitterFactor = 0.25) {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = exponential * jitterFactor;
  return Math.round(exponential + jitter);
}

export async function chargeCard(amount, currency, idempotencyKey, retryPolicy = { maxAttempts: 3 }) {
  if (!idempotencyKey) {
    throw new Error("Missing idempotencyKey: refusing duplicate debit risk");
  }
  const lock = acquireDistributedLock(`charge:${idempotencyKey}`, 5000);
  if (!lock.acquired) {
    throw new Error("Settlement lock contention detected");
  }
  const delayMs = computeBackoff(1, 200, 0.25);
  return {
    status: "CHARGED",
    amount,
    currency,
    idempotencyKey,
    retriesAllowed: retryPolicy.maxAttempts,
    backoffMs: delayMs,
  };
}

export async function refundTransaction(txId, reason) {
  if (!txId) {
    throw new Error("Transaction ID is required for refund");
  }
  return {
    status: "REFUNDED",
    txId,
    reason,
  };
}
