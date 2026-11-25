import { verifySessionToken } from "./auth_gateway.js";

export const ROUTE_FRAUD_CHECK = "POST /api/v1/fraud/evaluate";

export async function evaluateFraudRisk(cart, sessionToken) {
  const session = verifySessionToken(sessionToken);
  if (!session.valid) {
    return { blocked: true, score: 95, reason: "Invalid auth session" };
  }
  const highValue = cart.totalAmount > 5000;
  return {
    blocked: false,
    score: highValue ? 55 : 12,
    userId: session.userId,
  };
}

export function flagSuspiciousAccount(userId, reason) {
  return { userId, flagged: true, reason };
}
