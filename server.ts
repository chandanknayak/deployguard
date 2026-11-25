import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { loadDemoRepoGraph } from "./engine/dependencyGraph.ts";
import {
  analyzeExternalGitHubPr,
  analyzeSandboxPullRequest,
  type AssessmentRecord,
} from "./engine/riskEngine.ts";
import {
  createApiKeyRecord,
  hasPermission,
  hashPassword,
  isValidRole,
  matchApiKey,
  signJwt,
  signWebhookPayload,
  verifyJwt,
  verifyPassword,
  verifyWebhookSignature,
  type Permission,
  type Role,
  type StoredApiKey,
} from "./engine/authRbac.ts";
import {
  createDefaultRepoPolicy,
  validatePolicyUpdate,
  type RepoPolicy,
} from "./engine/policyEngine.ts";
import {
  createMetricsStore,
  logStructuredRequest,
  renderPrometheusMetrics,
  SlidingWindowRateLimiter,
} from "./engine/observability.ts";

const ROOT_DIR = process.cwd();
const DEMO_REPO_DIR = path.resolve(ROOT_DIR, "demo-repo");
const FRONTEND_DIR = path.resolve(ROOT_DIR, "frontend");
const PORT = Number(process.env.PORT || 3000);
const DIST_INDEX = path.resolve(FRONTEND_DIR, "dist", "index.html");
const IS_PROD =
  process.env.NODE_ENV === "production" ||
  (!process.env.DEPLOYGUARD_DEV && fs.existsSync(DIST_INDEX));

// Ephemeral signing secret when JWT_SECRET env var is unset (never hardcoded)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const rateLimiter = new SlidingWindowRateLimiter(
  Number(process.env.RATE_LIMIT_MAX || 180),
  60_000
);
const metrics = createMetricsStore();

// Capture pristine baseline of demo-repo files for reset
const initialRepoState = loadDemoRepoGraph(DEMO_REPO_DIR);
const BASELINE_FILES: Record<string, string> = { ...initialRepoState.fileContents };

interface Organization {
  id: string;
  name: string;
  plan: "Enterprise" | "Growth";
  repositories: string[];
}

interface UserAccount {
  id: string;
  email: string;
  name: string;
  orgId: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
}

interface AuditEntry {
  id: string;
  orgId: string;
  action:
    | "PR_ANALYZED"
    | "PR_MERGED"
    | "PR_OVERRIDE_MERGED"
    | "DEPLOYMENT_TRIGGERED"
    | "POLICY_UPDATED"
    | "API_KEY_CREATED"
    | "API_KEY_REVOKED"
    | "WEBHOOK_VERIFIED"
    | "SANDBOX_RESET";
  repo: string;
  prNumber?: number;
  operator: string;
  role?: Role;
  detail: string;
  riskScore?: number;
  gateStatus?: string;
  timestamp: string;
}

interface RequestPrincipal {
  sub: string;
  email: string;
  name: string;
  orgId: string;
  role: Role;
  authMethod: "jwt" | "api_key" | "anonymous_readonly";
  apiKeyId?: string;
}

interface AuthedRequest extends Request {
  requestId?: string;
  principal?: RequestPrincipal;
}

const ORGANIZATIONS: Organization[] = [
  {
    id: "acme-corp",
    name: "Acme Payments Corp",
    plan: "Enterprise",
    repositories: ["acme/payments-platform", "acme/checkout-web"],
  },
  {
    id: "globex-fintech",
    name: "Globex FinTech Ltd",
    plan: "Enterprise",
    repositories: ["globex/treasury-ledger", "globex/fx-settlement"],
  },
];

const users: UserAccount[] = [];
const apiKeys: StoredApiKey[] = [];
const auditLogs: AuditEntry[] = [];

// Per-org, per-repo policies
const policies = new Map<string, RepoPolicy>();
function policyKey(orgId: string, repo: string): string {
  return `${orgId}::${repo}`;
}
function getRepoPolicy(orgId: string, repo: string): RepoPolicy {
  const key = policyKey(orgId, repo);
  if (!policies.has(key)) {
    policies.set(key, createDefaultRepoPolicy(orgId, repo));
  }
  return policies.get(key)!;
}

// Initialize default policies for both orgs
for (const org of ORGANIZATIONS) {
  for (const repo of org.repositories) {
    getRepoPolicy(org.id, repo);
  }
}

interface TamperScenario {
  id: string;
  label: string;
  expectedGate: "BLOCK" | "WARN" | "PASS";
  filePath: string;
  prTitle: string;
  description: string;
  apply: (baseCode: string) => string;
}

const TAMPER_SCENARIOS: TamperScenario[] = [
  {
    id: "break-payment-signature",
    label: "Break chargeCard() Signature & Lock",
    expectedGate: "BLOCK",
    filePath: "services/payment_service.js",
    prTitle: "Refactor chargeCard retry backoff & drop idempotencyKey parameter",
    description:
      "Removes idempotencyKey from exported chargeCard(), drops the guard, and cranks retry backoff — hits P0 order-service & subscription-billing.",
    apply: (code) =>
      code
        .replace(
          "export async function chargeCard(amount, currency, idempotencyKey, retryPolicy = { maxAttempts: 3 }) {",
          "export async function chargeCard(amount, currency) {"
        )
        .replace(
          `  if (!idempotencyKey) {\n    throw new Error("Missing idempotencyKey: refusing duplicate debit risk");\n  }\n`,
          ""
        )
        .replace(
          "const lock = acquireDistributedLock(`charge:${idempotencyKey}`, 5000);",
          "const lock = { acquired: true };"
        )
        .replace("computeBackoff(1, 200, 0.25)", "computeBackoff(4, 900, 0)"),
  },
  {
    id: "bypass-fraud-check",
    label: "Bypass Fraud Evaluation in Checkout",
    expectedGate: "BLOCK",
    filePath: "services/order_service.js",
    prTitle: "Fast-path checkout by skipping fraud check during peak traffic",
    description:
      "Removes evaluateFraudRisk() guard from placeOrder() — affects P0 order-service and upstream subscription-billing.",
    apply: (code) =>
      code
        .replace(
          `  const fraud = await evaluateFraudRisk(cart, sessionToken);\n  if (fraud.blocked) {\n    return { status: "REJECTED_FRAUD", score: fraud.score };\n  }\n`,
          "  // Fraud check skipped for speed\n"
        )
        .replace('import { evaluateFraudRisk } from "./fraud_detection.js";\n', ""),
  },
  {
    id: "oauth-jitter-tweak",
    label: "Tweak OAuth Token Refresh Jitter",
    expectedGate: "WARN",
    filePath: "services/auth_gateway.js",
    prTitle: "Update OAuth token refresh jitter window to 200ms",
    description:
      "Modifies refreshOAuthToken() timing without breaking its exported signature — recalls INC-2024-0142.",
    apply: (code) =>
      code.replace(
        "const nextExpiry = Date.now() + 3600_000 + Math.round(jitterWindowMs * 0.5);",
        "const nextExpiry = Date.now() + 3600_000 + Math.round(jitterWindowMs * 0.1);"
      ),
  },
  {
    id: "safe-billing-csv",
    label: "Safe Invoice CSV Header Polish",
    expectedGate: "PASS",
    filePath: "services/billing_ui.js",
    prTitle: "Improve invoice CSV export formatting & column headers",
    description:
      "Edits leaf P2 billing_ui.js with zero downstream callers and zero breaking API changes.",
    apply: (code) =>
      code.replace(
        'const headers = ["Invoice ID", "Date", "Customer", "Amount", "Status"];',
        'const headers = ["Invoice #", "Issued Date", "Customer Name", "Amount", "Status"];'
      ),
  },
];

let nextPrNumber = 428;

function resolveSafeDemoFile(relFilePath: string): string {
  if (typeof relFilePath !== "string" || !relFilePath.trim()) {
    throw new Error("Invalid filePath");
  }
  const normalized = path.posix.normalize(relFilePath).replace(/^\/+/, "");
  const resolved = path.resolve(DEMO_REPO_DIR, normalized);
  if (!resolved.startsWith(DEMO_REPO_DIR + path.sep)) {
    throw new Error("Path traversal blocked");
  }
  if (!Object.prototype.hasOwnProperty.call(BASELINE_FILES, normalized)) {
    throw new Error(`Unknown demo-repo file: ${normalized}`);
  }
  return resolved;
}

function addAudit(entry: Omit<AuditEntry, "id" | "timestamp">) {
  auditLogs.unshift({
    ...entry,
    id: `aud-${crypto.randomBytes(4).toString("hex")}`,
    timestamp: new Date().toISOString(),
  });
  if (auditLogs.length > 200) auditLogs.length = 200;
}

function seedRealAssessments(): AssessmentRecord[] {
  const { graph, fileContents } = loadDemoRepoGraph(DEMO_REPO_DIR);
  const acmePolicy = getRepoPolicy("acme-corp", "acme/payments-platform");

  const acmePr1 = analyzeSandboxPullRequest({
    id: "pr-418",
    orgId: "acme-corp",
    prNumber: 418,
    title: "Refactor ledger settlement lock & retry backoff",
    author: "r.patel",
    filePath: "services/payment_service.js",
    baseCode: fileContents["services/payment_service.js"],
    headCode: TAMPER_SCENARIOS[0].apply(fileContents["services/payment_service.js"]),
    graph,
    policy: acmePolicy,
    updatedAt: "12m ago",
  });

  const acmePr2 = analyzeSandboxPullRequest({
    id: "pr-421",
    orgId: "acme-corp",
    prNumber: 421,
    title: "Update OAuth token refresh jitter window",
    author: "s.nair",
    filePath: "services/auth_gateway.js",
    baseCode: fileContents["services/auth_gateway.js"],
    headCode: TAMPER_SCENARIOS[2].apply(fileContents["services/auth_gateway.js"]),
    graph,
    policy: acmePolicy,
    updatedAt: "38m ago",
  });

  const acmePr3 = analyzeSandboxPullRequest({
    id: "pr-425",
    orgId: "acme-corp",
    prNumber: 425,
    title: "Improve invoice CSV export formatting & headers",
    author: "a.verma",
    filePath: "services/billing_ui.js",
    baseCode: fileContents["services/billing_ui.js"],
    headCode: TAMPER_SCENARIOS[3].apply(fileContents["services/billing_ui.js"]),
    graph,
    policy: acmePolicy,
    updatedAt: "1h ago",
  });

  // Isolated second enterprise tenant (Globex FinTech) to demonstrate true multi-tenancy
  const globexPolicy = getRepoPolicy("globex-fintech", "globex/treasury-ledger");
  const globexPr1 = analyzeExternalGitHubPr({
    id: "glx-104",
    orgId: "globex-fintech",
    repo: "globex/treasury-ledger",
    prNumber: 104,
    title: "Drop distributed settlement mutex during FX wire clearing",
    author: "k.tanaka",
    rawDiff: [
      "diff --git a/settlement/wire_engine.js b/settlement/wire_engine.js",
      "--- a/settlement/wire_engine.js",
      "+++ b/settlement/wire_engine.js",
      "-export async function clearWireTransfer(txId, amount, idempotencyKey) {",
      "-  await acquireDistributedLock(idempotencyKey);",
      "+export async function clearWireTransfer(txId, amount) {",
      "+  // removed lock and retry backoff for latency",
      "+  return executeLedgerDebit(txId, amount);",
    ].join("\n"),
    policy: globexPolicy,
  });
  globexPr1.updatedAt = "22m ago";

  const globexPr2 = analyzeExternalGitHubPr({
    id: "glx-109",
    orgId: "globex-fintech",
    repo: "globex/fx-settlement",
    prNumber: 109,
    title: "Format EUR/JPY currency decimal rounding tooltip",
    author: "m.silva",
    rawDiff: [
      "diff --git a/ui/currency_format.js b/ui/currency_format.js",
      "--- a/ui/currency_format.js",
      "+++ b/ui/currency_format.js",
      "-const label = 'FX Rate';",
      "+const label = 'Indicative FX Rate';",
    ].join("\n"),
    policy: globexPolicy,
  });
  globexPr2.updatedAt = "2h ago";

  return [acmePr1, acmePr2, acmePr3, globexPr1, globexPr2];
}

let assessments: AssessmentRecord[] = seedRealAssessments();
metrics.assessmentsTotal = assessments.length;
metrics.blockedTotal = assessments.filter((a) => a.gateStatus === "BLOCK").length;

addAudit({
  orgId: "acme-corp",
  action: "PR_ANALYZED",
  repo: "acme/payments-platform",
  prNumber: 418,
  operator: "DeployGuard CI Bot",
  role: "Admin",
  detail: `Initial AST & blast radius scan blocked PR #418 (score ${assessments[0].riskScore}/100).`,
  riskScore: assessments[0].riskScore,
  gateStatus: assessments[0].gateStatus,
});
addAudit({
  orgId: "globex-fintech",
  action: "PR_ANALYZED",
  repo: "globex/treasury-ledger",
  prNumber: 104,
  operator: "DeployGuard CI Bot",
  role: "Admin",
  detail: `Initial scan blocked FX wire settlement PR #104 (score ${assessments[3].riskScore}/100).`,
  riskScore: assessments[3].riskScore,
  gateStatus: assessments[3].gateStatus,
});

// ---------------------------------------------------------------------------
// Principal & RBAC Middleware Helpers
// ---------------------------------------------------------------------------
function resolvePrincipal(req: AuthedRequest): RequestPrincipal {
  // 1. Check Bearer JWT
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const payload = verifyJwt(token, JWT_SECRET);
    if (payload) {
      return {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        orgId: payload.orgId,
        role: payload.role,
        authMethod: "jwt",
      };
    }
  }

  // 2. Check X-API-Key
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
    const matched = matchApiKey(apiKeyHeader.trim(), apiKeys);
    if (matched) {
      return {
        sub: matched.id,
        email: `${matched.name.toLowerCase().replace(/\s+/g, "-")}@api-key`,
        name: `API Key: ${matched.name}`,
        orgId: matched.orgId,
        role: matched.role,
        authMethod: "api_key",
        apiKeyId: matched.id,
      };
    }
  }

  // 3. Fallback read-only Viewer in default tenant (for legacy unauthenticated GET probes)
  return {
    sub: "anonymous-viewer",
    email: "viewer@acme.io",
    name: "Guest Viewer",
    orgId: "acme-corp",
    role: "Viewer",
    authMethod: "anonymous_readonly",
  };
}

function requirePermission(permission: Permission) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    const principal = req.principal || resolvePrincipal(req);
    if (!hasPermission(principal.role, permission)) {
      return res.status(403).json({
        error: `Forbidden: role '${principal.role}' lacks '${permission}' permission. Switch to Release Manager or Admin to perform this action.`,
      });
    }
    return next();
  };
}

async function startServer() {
  const app = express();

  // Raw body capture specifically for GitHub webhook HMAC verification before JSON parsing
  app.use((req, _res, next) => {
    if (req.path === "/api/v1/webhook/github" || req.path === "/api/webhook/github") {
      return next();
    }
    return express.json({ limit: "2mb" })(req, _res, next);
  });

  // Security headers, strict CORS, request ID tracing & structured JSON logging
  app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    const start = performance.now();
    const requestId = String(req.headers["x-request-id"] || crypto.randomUUID());
    req.requestId = requestId;
    req.principal = resolvePrincipal(req);

    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    // Strict CORS (never wildcard on authenticated routes)
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-API-Key,X-Request-ID");
      if (req.method === "OPTIONS") {
        return res.status(204).end();
      }
    }

    res.on("finish", () => {
      if (
        req.path.startsWith("/api/") ||
        req.path.startsWith("/assessments") ||
        req.path === "/healthz" ||
        req.path === "/readyz"
      ) {
        const latencyMs = Number((performance.now() - start).toFixed(1));
        metrics.requestsTotal++;
        metrics.latencySumMs += latencyMs;
        metrics.latencyCount++;
        logStructuredRequest({
          request_id: requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          latency_ms: latencyMs,
          org_id: req.principal?.orgId,
        });
      }
    });

    return next();
  });

  // Sliding-window rate limiter on /api/v1/*
  app.use("/api/v1", (req: AuthedRequest, res: Response, next: NextFunction) => {
    const key = req.principal?.apiKeyId
      ? `key:${req.principal.apiKeyId}`
      : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const result = rateLimiter.check(key);
    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(result.resetAtEpochSec));

    if (!result.allowed) {
      metrics.rateLimitedTotal++;
      return res.status(429).json({
        error: "Rate limit exceeded. Retry after window reset.",
        resetAt: result.resetAtEpochSec,
      });
    }
    return next();
  });

  // -------------------------------------------------------------------------
  // Observability Endpoints (/healthz, /readyz, /metrics)
  // -------------------------------------------------------------------------
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "DeployGuard AI",
      engine: "acorn-ast-v2",
      organizations: ORGANIZATIONS.length,
      assessmentsCount: assessments.length,
    });
  });

  app.get("/readyz", (_req, res) => {
    const graphReady = initialRepoState.graph.nodes.length > 0;
    const checks = {
      ast_engine: "healthy",
      dependency_graph: graphReady ? "healthy" : "degraded",
      storage: process.env.MONGODB_URI ? "mongodb_configured" : "in_memory_ready",
      llm_synthesis: process.env.OPENAI_API_KEY ? "configured" : "deterministic_fallback_ready",
    };
    res.status(graphReady ? 200 : 503).json({
      status: graphReady ? "ready" : "degraded",
      checks,
    });
  });

  app.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderPrometheusMetrics(metrics));
  });

  // -------------------------------------------------------------------------
  // Auth & Multi-Tenant Session Endpoints (/api/v1/auth/*)
  // -------------------------------------------------------------------------
  app.get("/api/v1/orgs", (_req, res) => {
    res.json({ organizations: ORGANIZATIONS });
  });

  app.post("/api/v1/auth/demo-session", (req, res) => {
    const orgId =
      typeof req.body?.orgId === "string" && ORGANIZATIONS.some((o) => o.id === req.body.orgId)
        ? req.body.orgId
        : "acme-corp";
    const role: Role = isValidRole(req.body?.role) ? req.body.role : "Admin";
    const org = ORGANIZATIONS.find((o) => o.id === orgId)!;

    const email =
      role === "Admin"
        ? `admin@${orgId}.io`
        : role === "Release Manager"
        ? `release-mgr@${orgId}.io`
        : `viewer@${orgId}.io`;
    const name = `${role} (${org.name})`;

    const token = signJwt(
      { sub: `demo-${orgId}-${role}`, email, name, orgId, role },
      JWT_SECRET
    );
    return res.json({
      token,
      user: { email, name, orgId, orgName: org.name, role },
      organizations: ORGANIZATIONS,
    });
  });

  app.post("/api/v1/auth/register", (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    const orgId =
      typeof req.body?.orgId === "string" && ORGANIZATIONS.some((o) => o.id === req.body.orgId)
        ? req.body.orgId
        : "acme-corp";
    const role: Role = isValidRole(req.body?.role) ? req.body.role : "Release Manager";

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid work email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (users.some((u) => u.email === email)) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const account: UserAccount = {
      id: `usr_${crypto.randomBytes(5).toString("hex")}`,
      email,
      name: name || email.split("@")[0],
      orgId,
      role,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    users.push(account);

    const org = ORGANIZATIONS.find((o) => o.id === orgId)!;
    const token = signJwt(
      { sub: account.id, email: account.email, name: account.name, orgId: account.orgId, role: account.role },
      JWT_SECRET
    );

    return res.status(201).json({
      token,
      user: {
        email: account.email,
        name: account.name,
        orgId: account.orgId,
        orgName: org.name,
        role: account.role,
      },
    });
  });

  app.post("/api/v1/auth/login", (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    const account = users.find((u) => u.email === email);
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const org = ORGANIZATIONS.find((o) => o.id === account.orgId)!;
    const token = signJwt(
      { sub: account.id, email: account.email, name: account.name, orgId: account.orgId, role: account.role },
      JWT_SECRET
    );

    return res.json({
      token,
      user: {
        email: account.email,
        name: account.name,
        orgId: account.orgId,
        orgName: org.name,
        role: account.role,
      },
    });
  });

  app.get("/api/v1/auth/me", (req: AuthedRequest, res) => {
    const p = req.principal!;
    const org = ORGANIZATIONS.find((o) => o.id === p.orgId) || ORGANIZATIONS[0];
    res.json({
      user: {
        email: p.email,
        name: p.name,
        orgId: p.orgId,
        orgName: org.name,
        role: p.role,
        authMethod: p.authMethod,
      },
      organizations: ORGANIZATIONS,
    });
  });

  // -------------------------------------------------------------------------
  // Tenant-Isolated Assessments API (v1 + backward-compatible routes)
  // -------------------------------------------------------------------------
  const listAssessmentsHandler = (req: AuthedRequest, res: Response) => {
    const orgId = req.principal!.orgId;
    const repoFilter = typeof req.query.repo === "string" ? req.query.repo.trim() : "";
    const statusFilter = typeof req.query.decision === "string" ? req.query.decision.toUpperCase() : "";

    const scoped = assessments.filter((a) => {
      if (a.orgId !== orgId) return false;
      if (repoFilter && a.repo !== repoFilter) return false;
      if (statusFilter && statusFilter !== "ALL" && a.gateStatus !== statusFilter) return false;
      return true;
    });
    res.json({ orgId, total: scoped.length, results: scoped });
  };

  app.get("/assessments", listAssessmentsHandler);
  app.get("/assessments/", listAssessmentsHandler);
  app.get("/api/v1/assessments", listAssessmentsHandler);

  const getAssessmentHandler = (req: AuthedRequest, res: Response) => {
    const found = assessments.find(
      (a) => a.id === req.params.id && a.orgId === req.principal!.orgId
    );
    if (!found) return res.status(404).json({ error: "Assessment not found in your organization." });
    return res.json(found);
  };
  app.get("/assessments/:id", getAssessmentHandler);
  app.get("/api/v1/assessments/:id", getAssessmentHandler);

  // Merge Gate Enforcer (RBAC: Release Manager or Admin)
  const mergeHandler = (req: AuthedRequest, res: Response) => {
    const principal = req.principal!;
    const item = assessments.find(
      (a) => a.id === req.params.id && a.orgId === principal.orgId
    );
    if (!item) return res.status(404).json({ error: "Assessment not found in your organization." });
    if (item.status === "MERGED") {
      return res.status(400).json({ error: "Pull request is already merged." });
    }

    const override = Boolean(req.body?.override);
    const overrideReason =
      typeof req.body?.overrideReason === "string" ? req.body.overrideReason.trim() : "";

    if (item.gateStatus === "BLOCK") {
      if (!hasPermission(principal.role, "assessments:override")) {
        return res.status(403).json({
          error: `Role '${principal.role}' cannot approve overrides on BLOCKED releases.`,
        });
      }
      if (!override || overrideReason.length < 5) {
        return res.status(403).json({
          error:
            "Merge rejected by DeployGuard Risk Gate. A BLOCKED pull request requires an explicit override justification (min 5 characters).",
        });
      }
    }

    if (item.sourceType === "sandbox" && typeof item.proposedCode === "string") {
      try {
        const absPath = resolveSafeDemoFile(item.filePath);
        fs.writeFileSync(absPath, item.proposedCode, "utf-8");
      } catch (err: any) {
        return res.status(500).json({ error: `Failed to apply merge to demo-repo: ${err.message}` });
      }
    }

    item.status = "MERGED";
    item.updatedAt = "Merged just now";

    addAudit({
      orgId: principal.orgId,
      action: override ? "PR_OVERRIDE_MERGED" : "PR_MERGED",
      repo: item.repo,
      prNumber: item.prNumber,
      operator: principal.email,
      role: principal.role,
      detail: override
        ? `Override merge on ${item.filePath}. Reason: "${overrideReason}"`
        : `Merged ${item.filePath} via DeployGuard ${item.gateStatus} gate.`,
      riskScore: item.riskScore,
      gateStatus: item.gateStatus,
    });

    const orgAudit = auditLogs.filter((l) => l.orgId === principal.orgId);
    return res.json({ status: "merged", assessment: item, auditLog: orgAudit });
  };

  app.post("/assessments/:id/merge", requirePermission("assessments:merge"), mergeHandler);
  app.post("/api/v1/assessments/:id/merge", requirePermission("assessments:merge"), mergeHandler);

  // Deploy Rollout (RBAC: Release Manager or Admin)
  const deployHandler = (req: AuthedRequest, res: Response) => {
    const principal = req.principal!;
    const item = assessments.find(
      (a) => a.id === req.params.id && a.orgId === principal.orgId
    );
    if (!item) return res.status(404).json({ error: "Assessment not found in your organization." });

    const strategy =
      req.body?.strategy === "CANARY" || req.body?.strategy === "STANDARD"
        ? req.body.strategy
        : item.deploymentStrategy === "STANDARD"
        ? "STANDARD"
        : "CANARY";
    const environment = req.body?.environment === "production" ? "production" : "staging";
    const trafficPercent = strategy === "CANARY" ? 5 : 100;

    const deployment = {
      deploymentId: `dep-${crypto.randomBytes(4).toString("hex")}`,
      repo: item.repo,
      prNumber: item.prNumber,
      environment,
      strategy,
      trafficPercent,
      status: "HEALTHY",
      timestamp: new Date().toISOString(),
    };

    addAudit({
      orgId: principal.orgId,
      action: "DEPLOYMENT_TRIGGERED",
      repo: item.repo,
      prNumber: item.prNumber,
      operator: principal.email,
      role: principal.role,
      detail: `Deployed PR #${item.prNumber} to ${environment} using ${strategy} (${trafficPercent}% traffic).`,
      riskScore: item.riskScore,
      gateStatus: item.gateStatus,
    });

    return res.json({
      deployment,
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  };

  app.post("/assessments/:id/deploy", requirePermission("assessments:deploy"), deployHandler);
  app.post("/api/v1/assessments/:id/deploy", requirePermission("assessments:deploy"), deployHandler);

  // -------------------------------------------------------------------------
  // Per-Repository Policies (RBAC: Admin writes, all roles read)
  // -------------------------------------------------------------------------
  app.get("/api/v1/policies", (req: AuthedRequest, res) => {
    const orgId = req.principal!.orgId;
    const org = ORGANIZATIONS.find((o) => o.id === orgId) || ORGANIZATIONS[0];
    const list = org.repositories.map((repo) => getRepoPolicy(orgId, repo));
    res.json({ orgId, policies: list });
  });

  app.get("/api/policy", (req: AuthedRequest, res) => {
    const orgId = req.principal!.orgId;
    const org = ORGANIZATIONS.find((o) => o.id === orgId) || ORGANIZATIONS[0];
    const repo =
      typeof req.query.repo === "string" && org.repositories.includes(req.query.repo)
        ? req.query.repo
        : org.repositories[0];
    res.json(getRepoPolicy(orgId, repo));
  });

  const updatePolicyHandler = (req: AuthedRequest, res: Response) => {
    const principal = req.principal!;
    const org = ORGANIZATIONS.find((o) => o.id === principal.orgId) || ORGANIZATIONS[0];
    const repo =
      typeof req.body?.repo === "string" && org.repositories.includes(req.body.repo)
        ? req.body.repo
        : org.repositories[0];

    const check = validatePolicyUpdate(req.body || {});
    if (!check.valid) {
      return res.status(400).json({ error: check.error });
    }

    const patterns = Array.isArray(req.body?.criticalPathPatterns)
      ? req.body.criticalPathPatterns
          .map((p: unknown) => String(p).trim())
          .filter(Boolean)
          .slice(0, 20)
      : getRepoPolicy(principal.orgId, repo).criticalPathPatterns;

    const updated: RepoPolicy = {
      orgId: principal.orgId,
      repo,
      blockThreshold: Math.round(Number(req.body.blockThreshold)),
      warnThreshold: Math.round(Number(req.body.warnThreshold)),
      requiredApprovers: Math.round(Number(req.body.requiredApprovers ?? 2)),
      criticalPathPatterns: patterns,
      blockOnBreakingApi: Boolean(req.body.blockOnBreakingApi),
      blockOnP0Impact: Boolean(req.body.blockOnP0Impact),
      updatedAt: new Date().toISOString(),
    };
    policies.set(policyKey(principal.orgId, repo), updated);

    addAudit({
      orgId: principal.orgId,
      action: "POLICY_UPDATED",
      repo,
      operator: principal.email,
      role: principal.role,
      detail: `Updated policy for ${repo}: WARN >= ${updated.warnThreshold}, BLOCK >= ${updated.blockThreshold}, Approvers: ${updated.requiredApprovers}, Critical patterns: ${updated.criticalPathPatterns.length}.`,
    });

    return res.json({
      policy: updated,
      policies: org.repositories.map((r) => getRepoPolicy(principal.orgId, r)),
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  };

  app.post("/api/policy", requirePermission("policies:write"), updatePolicyHandler);
  app.post("/api/v1/policies", requirePermission("policies:write"), updatePolicyHandler);

  // -------------------------------------------------------------------------
  // Enterprise API Key Management (RBAC: Admin only)
  // -------------------------------------------------------------------------
  app.get("/api/v1/api-keys", (req: AuthedRequest, res) => {
    const orgId = req.principal!.orgId;
    const keys = apiKeys
      .filter((k) => k.orgId === orgId)
      .map(({ keyHash: _redacted, ...safe }) => safe);
    res.json({ orgId, apiKeys: keys });
  });

  app.post("/api/v1/api-keys", requirePermission("apikeys:write"), (req: AuthedRequest, res) => {
    const principal = req.principal!;
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 60) : "";
    const role: Role = isValidRole(req.body?.role) ? req.body.role : "Release Manager";
    if (!name) {
      return res.status(400).json({ error: "Provide a descriptive name for the API key." });
    }

    const { rawKey, record } = createApiKeyRecord({
      orgId: principal.orgId,
      name,
      role,
      createdBy: principal.email,
    });
    apiKeys.unshift(record);

    addAudit({
      orgId: principal.orgId,
      action: "API_KEY_CREATED",
      repo: "*",
      operator: principal.email,
      role: principal.role,
      detail: `Provisioned scoped API key '${record.name}' (${record.prefix}) with role ${record.role}.`,
    });

    const { keyHash: _redacted, ...safeRecord } = record;
    return res.status(201).json({
      rawKey,
      apiKey: safeRecord,
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  });

  app.delete("/api/v1/api-keys/:id", requirePermission("apikeys:write"), (req: AuthedRequest, res) => {
    const principal = req.principal!;
    const found = apiKeys.find((k) => k.id === req.params.id && k.orgId === principal.orgId);
    if (!found) return res.status(404).json({ error: "API key not found." });
    found.revoked = true;

    addAudit({
      orgId: principal.orgId,
      action: "API_KEY_REVOKED",
      repo: "*",
      operator: principal.email,
      role: principal.role,
      detail: `Revoked API key '${found.name}' (${found.prefix}).`,
    });

    return res.json({
      status: "revoked",
      id: found.id,
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  });

  // -------------------------------------------------------------------------
  // Tenant-Isolated Audit Log
  // -------------------------------------------------------------------------
  const auditHandler = (req: AuthedRequest, res: Response) => {
    const orgId = req.principal!.orgId;
    res.json({ orgId, logs: auditLogs.filter((l) => l.orgId === orgId) });
  };
  app.get("/api/audit", auditHandler);
  app.get("/api/v1/audit", auditHandler);

  // -------------------------------------------------------------------------
  // Real Demo-Repo Sandbox Endpoints
  // -------------------------------------------------------------------------
  app.get("/api/sandbox/files", (_req, res) => {
    const { graph, fileContents, manifest } = loadDemoRepoGraph(DEMO_REPO_DIR);
    const files = graph.nodes.map((node) => ({
      filePath: node.filePath,
      service: node.service,
      slaTier: node.slaTier,
      ownerTeam: node.ownerTeam,
      onCall: node.onCall,
      criticalPath: node.criticalPath,
      exportedSymbols: node.exportedSymbols,
      content: fileContents[node.filePath],
    }));

    const scenarios = TAMPER_SCENARIOS.map((s) => ({
      id: s.id,
      label: s.label,
      expectedGate: s.expectedGate,
      filePath: s.filePath,
      prTitle: s.prTitle,
      description: s.description,
      modifiedCode: s.apply(fileContents[s.filePath] || BASELINE_FILES[s.filePath]),
    }));

    res.json({
      repository: manifest.repository,
      defaultBranch: manifest.defaultBranch,
      files,
      scenarios,
    });
  });

  app.get("/api/sandbox/graph", (_req, res) => {
    const { graph } = loadDemoRepoGraph(DEMO_REPO_DIR);
    res.json(graph);
  });

  app.post("/api/sandbox/pr", requirePermission("assessments:create"), (req: AuthedRequest, res) => {
    const principal = req.principal!;
    const filePath = typeof req.body?.filePath === "string" ? req.body.filePath.trim() : "";
    const modifiedCode = typeof req.body?.modifiedCode === "string" ? req.body.modifiedCode : "";
    const prTitle =
      typeof req.body?.prTitle === "string" && req.body.prTitle.trim()
        ? req.body.prTitle.trim().slice(0, 140)
        : "";
    const author =
      typeof req.body?.author === "string" && req.body.author.trim()
        ? req.body.author.trim().slice(0, 40)
        : principal.email.split("@")[0];

    if (!prTitle) return res.status(400).json({ error: "Please enter a Pull Request title." });
    if (!modifiedCode.trim()) return res.status(400).json({ error: "Modified code cannot be empty." });

    let absPath: string;
    try {
      absPath = resolveSafeDemoFile(filePath);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }

    const baseCode = fs.readFileSync(absPath, "utf-8");
    if (baseCode.replace(/\r\n/g, "\n") === modifiedCode.replace(/\r\n/g, "\n")) {
      return res.status(400).json({
        error: "No code changes detected. Edit at least one line or load a test scenario before submitting a PR.",
      });
    }

    const { graph } = loadDemoRepoGraph(DEMO_REPO_DIR);
    const prNumber = nextPrNumber++;
    const repoPolicy = getRepoPolicy(principal.orgId, graph.repository);

    const assessment = analyzeSandboxPullRequest({
      id: `pr-${prNumber}-${crypto.randomBytes(2).toString("hex")}`,
      orgId: principal.orgId,
      prNumber,
      title: prTitle,
      author,
      filePath: path.posix.normalize(filePath),
      baseCode,
      headCode: modifiedCode,
      graph,
      policy: repoPolicy,
      updatedAt: "Just now",
    });

    assessments.unshift(assessment);
    metrics.assessmentsTotal++;
    if (assessment.gateStatus === "BLOCK") metrics.blockedTotal++;

    addAudit({
      orgId: principal.orgId,
      action: "PR_ANALYZED",
      repo: assessment.repo,
      prNumber: assessment.prNumber,
      operator: principal.email,
      role: principal.role,
      detail: `Analyzed ${assessment.filePath} (+${assessment.linesAdded}/-${assessment.linesRemoved}, ${assessment.breakingChanges.length} breaking AST change(s)) -> ${assessment.gateStatus} (${assessment.riskScore}/100).`,
      riskScore: assessment.riskScore,
      gateStatus: assessment.gateStatus,
    });

    return res.status(201).json({ assessment, total: assessments.length });
  });

  app.post("/api/sandbox/reset", requirePermission("sandbox:reset"), (req: AuthedRequest, res) => {
    const principal = req.principal!;
    for (const [relPath, content] of Object.entries(BASELINE_FILES)) {
      const absPath = resolveSafeDemoFile(relPath);
      fs.writeFileSync(absPath, content, "utf-8");
    }
    assessments = seedRealAssessments();
    addAudit({
      orgId: principal.orgId,
      action: "SANDBOX_RESET",
      repo: initialRepoState.graph.repository,
      operator: principal.email,
      role: principal.role,
      detail: "Reset all 7 demo-repo service files to clean main branch baseline.",
    });
    return res.json({
      status: "reset",
      assessments: assessments.filter((a) => a.orgId === principal.orgId),
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  });

  // -------------------------------------------------------------------------
  // Real Public GitHub PR Analyzer (Strict Allowlist to api.github.com)
  // -------------------------------------------------------------------------
  app.post("/api/github/analyze", requirePermission("assessments:create"), async (req: AuthedRequest, res) => {
    const principal = req.principal!;
    const rawRepo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
    const prNumber = Number(req.body?.prNumber);

    const repoMatch = rawRepo.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    if (!repoMatch || !Number.isInteger(prNumber) || prNumber <= 0 || prNumber > 1_000_000) {
      return res.status(400).json({
        error: "Enter a valid GitHub repository (owner/repo) and positive Pull Request number.",
      });
    }

    const [, owner, repo] = repoMatch;
    const headers: Record<string, string> = {
      "User-Agent": "DeployGuard-AI/2.0",
      Accept: "application/vnd.github+json",
    };
    if (process.env.GITHUB_API_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_API_TOKEN}`;
    }

    try {
      const prUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`;
      const metaRes = await fetch(prUrl, { headers, signal: AbortSignal.timeout(8000) });
      if (!metaRes.ok) {
        return res.status(metaRes.status === 404 ? 404 : 502).json({
          error:
            metaRes.status === 404
              ? `Pull request ${owner}/${repo}#${prNumber} not found (or repository is private).`
              : `GitHub API returned HTTP ${metaRes.status}.`,
        });
      }
      const meta: any = await metaRes.json();

      const diffRes = await fetch(prUrl, {
        headers: { ...headers, Accept: "application/vnd.github.v3.diff" },
        signal: AbortSignal.timeout(8000),
      });
      if (!diffRes.ok) {
        return res.status(502).json({ error: `Could not fetch PR diff (HTTP ${diffRes.status}).` });
      }
      const rawDiff = await diffRes.text();

      const repoPolicy = getRepoPolicy(principal.orgId, `${owner}/${repo}`);
      const assessment = analyzeExternalGitHubPr({
        id: `gh-${owner}-${repo}-${prNumber}-${crypto.randomBytes(2).toString("hex")}`,
        orgId: principal.orgId,
        repo: `${owner}/${repo}`,
        prNumber,
        title: String(meta.title || `Pull Request #${prNumber}`),
        author: String(meta.user?.login || "github-user"),
        rawDiff,
        policy: repoPolicy,
      });

      assessments.unshift(assessment);
      metrics.assessmentsTotal++;
      if (assessment.gateStatus === "BLOCK") metrics.blockedTotal++;

      addAudit({
        orgId: principal.orgId,
        action: "PR_ANALYZED",
        repo: assessment.repo,
        prNumber: assessment.prNumber,
        operator: principal.email,
        role: principal.role,
        detail: `Fetched live GitHub PR #${prNumber} (+${assessment.linesAdded}/-${assessment.linesRemoved}) -> ${assessment.gateStatus} (${assessment.riskScore}/100).`,
        riskScore: assessment.riskScore,
        gateStatus: assessment.gateStatus,
      });

      return res.status(201).json({ assessment });
    } catch (err: any) {
      return res.status(502).json({
        error: `Failed to fetch GitHub PR: ${err?.message || "Network timeout"}`,
      });
    }
  });

  // -------------------------------------------------------------------------
  // GitHub Webhook Ingestion + Self-Test Endpoint (Constant-Time HMAC-SHA256)
  // -------------------------------------------------------------------------
  const webhookHandler = (req: Request, res: Response) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
    const bodyBuf = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}));

    if (secret) {
      const signature =
        typeof req.headers["x-hub-signature-256"] === "string"
          ? req.headers["x-hub-signature-256"]
          : undefined;
      if (!verifyWebhookSignature(bodyBuf, signature, secret)) {
        return res.status(401).json({ error: "Invalid or missing X-Hub-Signature-256 header." });
      }
    }
    return res.status(202).json({
      status: "accepted",
      signatureVerified: Boolean(secret),
      deliveryId: req.headers["x-github-delivery"] || crypto.randomUUID(),
    });
  };

  app.post("/api/v1/webhook/github", express.raw({ type: "*/*", limit: "2mb" }), webhookHandler);
  app.post("/api/webhook/github", express.raw({ type: "*/*", limit: "2mb" }), webhookHandler);

  app.post("/api/v1/webhook/test", requirePermission("webhooks:test"), (req: AuthedRequest, res) => {
    const principal = req.principal!;
    const testSecret = process.env.GITHUB_WEBHOOK_SECRET || "ephemeral-connectivity-test-key";
    const samplePayload = JSON.stringify({
      event: "pull_request",
      action: "synchronize",
      org_id: principal.orgId,
      delivery: crypto.randomUUID(),
    });
    const validSig = signWebhookPayload(samplePayload, testSecret);
    const validPassed = verifyWebhookSignature(samplePayload, validSig, testSecret);
    const invalidRejected = !verifyWebhookSignature(samplePayload, "sha256=invalid", testSecret);

    addAudit({
      orgId: principal.orgId,
      action: "WEBHOOK_VERIFIED",
      repo: "*",
      operator: principal.email,
      role: principal.role,
      detail: `Verified HMAC-SHA256 webhook pipeline (valid accepted: ${validPassed}, tampered rejected: ${invalidRejected}).`,
    });

    return res.json({
      status: validPassed && invalidRejected ? "verified" : "failed",
      endpoint: "/api/v1/webhook/github",
      hmacValidAccepted: validPassed,
      hmacTamperedRejected: invalidRejected,
      secretConfiguredInEnv: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
      auditLog: auditLogs.filter((l) => l.orgId === principal.orgId),
    });
  });

  // -------------------------------------------------------------------------
  // Frontend Serving (Vite middleware in dev, static dist in production)
  // -------------------------------------------------------------------------
  if (IS_PROD) {
    const distDir = path.resolve(FRONTEND_DIR, "dist");
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method === "GET") {
        return res.sendFile(path.join(distDir, "index.html"));
      }
      return next();
    });
  } else {
    const localViteEntry = path.resolve(FRONTEND_DIR, "node_modules", "vite", "dist", "node", "index.js");
    const rootViteEntry = path.resolve(ROOT_DIR, "node_modules", "vite", "dist", "node", "index.js");
    const viteModuleUrl = fs.existsSync(localViteEntry)
      ? pathToFileURL(localViteEntry).href
      : fs.existsSync(rootViteEntry)
      ? pathToFileURL(rootViteEntry).href
      : "vite";
    const { createServer: createViteServer } = await import(viteModuleUrl);
    const vite = await createViteServer({
      root: FRONTEND_DIR,
      configFile: path.resolve(FRONTEND_DIR, "vite.config.js"),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        service: "deployguard-ai",
        message: `Server listening on http://0.0.0.0:${PORT}`,
        mode: IS_PROD ? "production" : "development",
      })
    );
  });
}

startServer().catch((err) => {
  console.error("Failed to start DeployGuard AI server:", err);
  process.exit(1);
});
