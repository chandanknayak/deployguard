export interface HistoricalIncident {
  id: string;
  title: string;
  severity: "P0" | "P1" | "P2";
  durationMinutes: number;
  affectedService: string;
  rootCauseTags: string[];
  summary: string;
}

export interface MatchedIncident {
  id: string;
  title: string;
  severity: "P0" | "P1" | "P2";
  durationMinutes: number;
  similarity: number;
  rootCauseTags: string[];
}

export const HISTORICAL_INCIDENTS: HistoricalIncident[] = [
  {
    id: "INC-2024-0317",
    title: "Payment retry storm caused 40-minute checkout outage",
    severity: "P0",
    durationMinutes: 40,
    affectedService: "payment-service",
    rootCauseTags: ["retry", "backoff", "jitter", "payment", "chargecard", "computebackoff", "thundering-herd"],
    summary:
      "Uncoordinated exponential retry backoff and jitter changes in payment_service chargeCard and computeBackoff saturated downstream order_service and subscription_billing pools.",
  },
  {
    id: "INC-2024-0209",
    title: "Redis distributed lock contention during peak settlement",
    severity: "P0",
    durationMinutes: 28,
    affectedService: "session-cache",
    rootCauseTags: ["lock", "acquiredistributedlock", "settlement", "redis", "cache", "ttl", "contention", "payment"],
    summary:
      "Modifying distributed lock acquisition or TTL in session_cache or payment_service caused settlement lock contention and checkout stalls.",
  },
  {
    id: "INC-2024-0174",
    title: "Duplicate ledger debit on missing idempotency key guard",
    severity: "P0",
    durationMinutes: 55,
    affectedService: "payment-service",
    rootCauseTags: ["idempotency", "idempotencykey", "chargecard", "debit", "duplicate", "signature", "payment"],
    summary:
      "Removing or altering idempotencyKey parameter validation in chargeCard caused duplicate ledger debits during network retry timeouts.",
  },
  {
    id: "INC-2024-0142",
    title: "Thundering herd on OAuth JWT token refresh rotation",
    severity: "P1",
    durationMinutes: 19,
    affectedService: "auth-gateway",
    rootCauseTags: ["oauth", "jwt", "token", "refresh", "refreshoauthtoken", "jitter", "verifysessiontoken", "auth"],
    summary:
      "Tightening OAuth refresh jitterWindowMs or altering verifySessionToken triggered synchronized 401/429 spikes across auth_gateway and session_cache.",
  },
  {
    id: "INC-2023-1105",
    title: "Subscription renewal batch double-charge during peak load",
    severity: "P0",
    durationMinutes: 35,
    affectedService: "subscription-billing",
    rootCauseTags: ["subscription", "renewal", "runrenewalbatch", "retryfailedinvoice", "batch", "billing", "chargecard"],
    summary:
      "Changes to runRenewalBatch and retryFailedInvoice bypassed per-cycle charge guards and overwhelmed payment_service.",
  },
  {
    id: "INC-2023-0918",
    title: "Fraud evaluation bypass allowed high-value checkout abuse",
    severity: "P1",
    durationMinutes: 24,
    affectedService: "fraud-detection",
    rootCauseTags: ["fraud", "evaluatefraudrisk", "placeorder", "order", "session", "bypass", "checkout"],
    summary:
      "Disabling or loosening evaluateFraudRisk in fraud_detection or order_service allowed unchecked high-value orders through checkout.",
  },
  {
    id: "INC-2023-0744",
    title: "Breaking API contract on order placement halted checkout",
    severity: "P0",
    durationMinutes: 31,
    affectedService: "order-service",
    rootCauseTags: ["order", "placeorder", "cancelorder", "refund", "refundtransaction", "route", "signature", "contract"],
    summary:
      "Breaking parameter signature or route path change on placeOrder or refundTransaction caused 500 errors across commerce clients.",
  },
];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

export function matchHistoricalIncidents(params: {
  originService: string;
  affectedServices: string[];
  prTitle: string;
  modifiedSymbols: string[];
  riskyPatterns: string[];
  diffSnippet: string;
}): MatchedIncident[] {
  const queryTokens = new Set<string>([
    ...tokenize(params.originService),
    ...params.affectedServices.flatMap(tokenize),
    ...tokenize(params.prTitle),
    ...params.modifiedSymbols.flatMap(tokenize),
    ...params.riskyPatterns.flatMap(tokenize),
    ...tokenize(params.diffSnippet.slice(0, 1200)),
  ]);

  const scored: MatchedIncident[] = [];

  for (const inc of HISTORICAL_INCIDENTS) {
    const tagTokens = new Set(inc.rootCauseTags.flatMap(tokenize));
    const summaryTokens = new Set([
      ...tokenize(inc.title),
      ...tokenize(inc.summary),
      ...tokenize(inc.affectedService),
    ]);

    let tagHits = 0;
    for (const t of tagTokens) {
      if (queryTokens.has(t)) tagHits++;
    }

    let summaryHits = 0;
    for (const t of summaryTokens) {
      if (queryTokens.has(t)) summaryHits++;
    }

    const serviceExactBonus = inc.affectedService === params.originService ? 0.34 : 0;
    const serviceBlastBonus =
      !serviceExactBonus && params.affectedServices.includes(inc.affectedService) ? 0.16 : 0;

    const tagScore = tagTokens.size > 0 ? (tagHits / Math.min(tagTokens.size, 4)) * 0.48 : 0;
    const summaryScore =
      summaryTokens.size > 0 ? (summaryHits / Math.min(summaryTokens.size, 8)) * 0.24 : 0;

    const similarity = Math.min(
      0.97,
      Number((serviceExactBonus + serviceBlastBonus + Math.min(0.48, tagScore) + Math.min(0.24, summaryScore)).toFixed(2))
    );

    if (similarity >= 0.45 && (tagHits >= 1 || serviceExactBonus > 0)) {
      scored.push({
        id: inc.id,
        title: inc.title,
        severity: inc.severity,
        durationMinutes: inc.durationMinutes,
        similarity,
        rootCauseTags: inc.rootCauseTags.slice(0, 4),
      });
    }
  }

  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}
