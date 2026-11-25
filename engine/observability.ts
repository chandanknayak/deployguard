export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAtEpochSec: number;
}

export class SlidingWindowRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly hits = new Map<string, number[]>();

  constructor(maxRequests = 120, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string, nowMs = Date.now()): RateLimitResult {
    const cutoff = nowMs - this.windowMs;
    const prev = (this.hits.get(key) || []).filter((ts) => ts > cutoff);
    const allowed = prev.length < this.maxRequests;
    if (allowed) {
      prev.push(nowMs);
    }
    this.hits.set(key, prev);

    const oldest = prev[0] ?? nowMs;
    return {
      allowed,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - prev.length),
      resetAtEpochSec: Math.ceil((oldest + this.windowMs) / 1000),
    };
  }
}

export interface MetricsState {
  requestsTotal: number;
  rateLimitedTotal: number;
  assessmentsTotal: number;
  blockedTotal: number;
  latencySumMs: number;
  latencyCount: number;
}

export function createMetricsStore(): MetricsState {
  return {
    requestsTotal: 0,
    rateLimitedTotal: 0,
    assessmentsTotal: 0,
    blockedTotal: 0,
    latencySumMs: 0,
    latencyCount: 0,
  };
}

export function renderPrometheusMetrics(m: MetricsState): string {
  const avgLatency = m.latencyCount > 0 ? (m.latencySumMs / m.latencyCount).toFixed(2) : "0.00";
  return [
    "# HELP deployguard_requests_total Total HTTP API requests processed",
    "# TYPE deployguard_requests_total counter",
    `deployguard_requests_total ${m.requestsTotal}`,
    "# HELP deployguard_rate_limited_total Total requests rejected by rate limiter",
    "# TYPE deployguard_rate_limited_total counter",
    `deployguard_rate_limited_total ${m.rateLimitedTotal}`,
    "# HELP deployguard_assessments_total Total PR risk assessments evaluated",
    "# TYPE deployguard_assessments_total counter",
    `deployguard_assessments_total ${m.assessmentsTotal}`,
    "# HELP deployguard_blocked_releases_total Total PRs blocked by DeployGuard risk gate",
    "# TYPE deployguard_blocked_releases_total counter",
    `deployguard_blocked_releases_total ${m.blockedTotal}`,
    "# HELP deployguard_request_latency_ms_avg Average API request latency in milliseconds",
    "# TYPE deployguard_request_latency_ms_avg gauge",
    `deployguard_request_latency_ms_avg ${avgLatency}`,
    "",
  ].join("\n");
}

export function logStructuredRequest(entry: {
  request_id: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  org_id?: string;
  repo?: string;
}): void {
  const safeLine = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info",
    service: "deployguard-ai",
    ...entry,
  });
  console.log(safeLine);
}
