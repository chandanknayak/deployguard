export interface RepoPolicy {
  orgId: string;
  repo: string;
  blockThreshold: number;
  warnThreshold: number;
  requiredApprovers: number;
  criticalPathPatterns: string[];
  blockOnBreakingApi: boolean;
  blockOnP0Impact: boolean;
  updatedAt: string;
}

export function createDefaultRepoPolicy(orgId: string, repo: string): RepoPolicy {
  return {
    orgId,
    repo,
    blockThreshold: Number(process.env.RISK_THRESHOLD_BLOCK || 70),
    warnThreshold: Number(process.env.RISK_THRESHOLD_WARN || 40),
    requiredApprovers: 2,
    criticalPathPatterns: [
      "services/payment_*",
      "services/order_*",
      "services/auth_*",
      "services/subscription_*",
    ],
    blockOnBreakingApi: true,
    blockOnP0Impact: false,
    updatedAt: new Date().toISOString(),
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchCriticalFilePatterns(filePath: string, patterns: string[]): string[] {
  const normalized = filePath.replace(/^\/+/, "");
  const matched: string[] = [];
  for (const pat of patterns) {
    if (!pat.trim()) continue;
    try {
      const rx = globToRegExp(pat);
      if (rx.test(normalized) || normalized.toLowerCase().includes(pat.replace(/\*/g, "").toLowerCase())) {
        matched.push(pat);
      }
    } catch {
      // Ignore malformed patterns safely
    }
  }
  return matched;
}

export function validatePolicyUpdate(input: Partial<RepoPolicy>): {
  valid: boolean;
  error?: string;
} {
  const blockThreshold = Number(input.blockThreshold);
  const warnThreshold = Number(input.warnThreshold);
  const requiredApprovers = Number(input.requiredApprovers ?? 1);

  if (
    !Number.isFinite(blockThreshold) ||
    !Number.isFinite(warnThreshold) ||
    warnThreshold < 10 ||
    blockThreshold <= warnThreshold ||
    blockThreshold > 99
  ) {
    return {
      valid: false,
      error: "Ensure 10 <= warnThreshold < blockThreshold <= 99.",
    };
  }
  if (!Number.isInteger(requiredApprovers) || requiredApprovers < 0 || requiredApprovers > 10) {
    return {
      valid: false,
      error: "requiredApprovers must be an integer between 0 and 10.",
    };
  }
  return { valid: true };
}
