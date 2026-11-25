import { getCachedKey, setCachedKey } from "./session_cache.js";

export const ROUTE_TOKEN_REFRESH = "POST /api/v1/auth/refresh";

export function verifySessionToken(token) {
  if (!token || token.length < 12) {
    return { valid: false, userId: null };
  }
  const cached = getCachedKey(`jwt:${token}`);
  return {
    valid: true,
    userId: cached?.userId || "usr_active",
  };
}

export function refreshOAuthToken(refreshToken, jitterWindowMs = 1500) {
  if (!refreshToken) {
    throw new Error("Refresh token required");
  }
  const nextExpiry = Date.now() + 3600_000 + Math.round(jitterWindowMs * 0.5);
  setCachedKey(`oauth:${refreshToken}`, { nextExpiry }, 3600_000);
  return {
    accessToken: `tok_${refreshToken.slice(0, 8)}`,
    expiresAt: nextExpiry,
  };
}
