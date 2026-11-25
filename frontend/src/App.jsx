import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Moon, Plus, ShieldCheck, Sun, UserCheck } from "lucide-react";
import {
  deriveGateStatus,
  calculateSimulatedScore,
  filterAssessments,
  computeMetrics,
} from "./riskUtils";
import PrDetailInspector from "./components/PrDetailInspector";
import LivePrSandbox from "./components/LivePrSandbox";
import ServiceGraphView from "./components/ServiceGraphView";
import AuditPolicyView from "./components/AuditPolicyView";
import AuthModal from "./components/AuthModal";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  "";

const DEFAULT_ORGS = [
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

const DEMO_ASSESSMENTS = [
  {
    id: "pr-418",
    orgId: "acme-corp",
    repo: "acme/payments-platform",
    prNumber: 418,
    title: "Refactor ledger settlement lock & retry backoff",
    author: "r.patel",
    filePath: "services/payment_service.js",
    status: "OPEN",
    riskScore: 84,
    gateStatus: "BLOCK",
    scoringEngineMode: "deterministic_fallback",
    riskBreakdown: {
      blastRadiusScore: 34,
      incidentSimilarityScore: 26,
      complexityAndCriticalPathScore: 24,
      totalScore: 84,
    },
    mitigationPlan: {
      canaryRolloutPercent: 5,
      requiredApprovers: 2,
      requiredTests: [
        "Run contract integration tests for downstream callers: order-service, subscription-billing",
        "Verify idempotency key enforcement under concurrent retry load",
      ],
      rollbackSteps: [
        "Halt 5% canary promotion immediately if error rate exceeds 0.5% or p99 latency spikes >25%.",
        "Revert commit for services/payment_service.js via automated rollback pipeline.",
        "Drain in-flight payment settlement locks before resuming traffic.",
      ],
    },
    blastRadiusHops: 2,
    originService: "payment-service",
    originSlaTier: "P0",
    affectedServices: ["payment-service", "order-service", "subscription-billing"],
    impactedDetails: [],
    matchedIncidents: [
      {
        id: "INC-2024-0317",
        title: "Payment retry storm caused 40-minute checkout outage",
        similarity: 0.92,
        durationMinutes: 40,
      },
      {
        id: "INC-2024-0174",
        title: "Duplicate ledger debit on missing idempotency key guard",
        similarity: 0.85,
        durationMinutes: 35,
      },
    ],
    modifiedSymbols: ["chargeCard"],
    breakingChanges: [],
    linesAdded: 0,
    linesRemoved: 0,
    recommendation:
      "Hold merge. Add idempotency key guard on retry path and run canary on 5% traffic first.",
    recommendedTests: [
      "Run contract integration tests for downstream callers: order-service, subscription-billing",
      "Verify idempotency key enforcement under concurrent retry load",
    ],
    reasoningTrace: [],
    prCommentMarkdown:
      "## DeployGuard AI Release Risk Report\n\n| Metric | Value |\n| --- | --- |\n| **Gate Decision** | **BLOCK** |\n| **Composite Risk Score** | **84 / 100** |",
    checkRun: {
      name: "DeployGuard AI Release Risk Gate",
      status: "completed",
      conclusion: "failure",
    },
    updatedAt: "12m ago",
  },
];

const DEFAULT_POLICIES = [
  {
    orgId: "acme-corp",
    repo: "acme/payments-platform",
    blockThreshold: 70,
    warnThreshold: 40,
    requiredApprovers: 2,
    criticalPathPatterns: ["services/payment_*", "services/auth_*", "services/order_*"],
    blockOnBreakingApi: true,
    blockOnP0Impact: false,
  },
];

function badgeClasses(status) {
  switch (status) {
    case "BLOCK":
      return "bg-red-500/15 text-red-300 border-red-500/40";
    case "WARN":
      return "bg-amber-500/15 text-amber-300 border-amber-500/40";
    default:
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  }
}

function normalizeAssessment(item, idx = 0) {
  const agent = item.agent_assessment || {};
  const blast = item.blast_radius || {};
  const score = Number(agent.risk_score ?? item.risk_score ?? item.riskScore ?? 25);
  return {
    id: item.assessment_id || item.id || item._id || `live-${idx}`,
    orgId: item.orgId || item.org_id || "acme-corp",
    repo: item.repo_full_name || item.repo || item.repository || "unknown/repo",
    prNumber: item.pr_number ?? item.prNumber ?? idx + 1,
    title: item.pr_title || item.title || "Pull request assessment",
    author: item.pr_author || item.author || "ci-bot",
    filePath: item.filePath || item.file_path || "",
    sourceType: item.sourceType || "sandbox",
    status: item.status || "OPEN",
    riskScore: score,
    gateStatus: item.risk_level || item.gate_status || item.gateStatus || deriveGateStatus(score),
    scoringEngineMode: item.scoringEngineMode || "deterministic_fallback",
    riskBreakdown: item.riskBreakdown || null,
    mitigationPlan: item.mitigationPlan || null,
    matchedCriticalPaths: item.matchedCriticalPaths || [],
    blastRadiusHops: Number(
      blast.max_depth_reached ?? item.blast_radius_hops ?? item.blastRadiusHops ?? 1
    ),
    originService: item.originService || "",
    originSlaTier: item.originSlaTier || "P1",
    affectedServices:
      blast.affected_services ||
      item.affected_services ||
      item.affectedServices || ["core-service"],
    impactedDetails: item.impactedDetails || [],
    matchedIncidents: item.matched_incidents || item.matchedIncidents || [],
    modifiedSymbols: item.modifiedSymbols || [],
    breakingChanges: item.breakingChanges || [],
    linesAdded: item.linesAdded ?? 0,
    linesRemoved: item.linesRemoved ?? 0,
    unifiedDiff: item.unifiedDiff || "",
    recommendation:
      agent.executive_summary || item.recommendation || "Review AST blast radius before merging.",
    recommendedTests: item.recommendedTests || [],
    reasoningTrace: item.reasoningTrace || [],
    deploymentStrategy: item.deploymentStrategy || "STANDARD",
    prCommentMarkdown: item.prCommentMarkdown || "",
    checkRun: item.checkRun || null,
    updatedAt: item.created_at || item.updated_at || item.updatedAt || "Live",
  };
}

const NAV_TABS = [
  { id: "gate", label: "PR Gate" },
  { id: "sandbox", label: "PR Sandbox" },
  { id: "graph", label: "Service Graph" },
  { id: "audit", label: "Audit & Policy" },
];

export default function App() {
  const [activeTab, setActiveTab] = useState("gate");
  const [theme, setTheme] = useState("dark");

  // Enterprise Auth & Multi-Tenant Session (JWT stored strictly in React memory)
  const authTokenRef = useRef("");
  const [currentUser, setCurrentUser] = useState({
    email: "admin@acme-corp.io",
    name: "Admin (Acme Payments Corp)",
    orgId: "acme-corp",
    orgName: "Acme Payments Corp",
    role: "Admin",
  });
  const [organizations, setOrganizations] = useState(DEFAULT_ORGS);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Core Workspace State
  const [assessments, setAssessments] = useState(DEMO_ASSESSMENTS);
  const [selectedId, setSelectedId] = useState(DEMO_ASSESSMENTS[0].id);
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [apiOnline, setApiOnline] = useState(false);
  const [loading, setLoading] = useState(false);

  // Backend state for Sandbox, Dependency Graph, Policies, API Keys, Audit
  const [sandboxData, setSandboxData] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [policies, setPolicies] = useState(DEFAULT_POLICIES);
  const [apiKeys, setApiKeys] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState(null);

  // Interactive PR Risk Simulator state
  const [simFilesChanged, setSimFilesChanged] = useState(8);
  const [simBlastHops, setSimBlastHops] = useState(3);
  const [simPastIncidents, setSimPastIncidents] = useState(1);
  const [simTouchesCore, setSimTouchesCore] = useState(true);

  const authHeaders = useCallback((tokenOverride) => {
    const tok = tokenOverride ?? authTokenRef.current;
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  }, []);

  const refreshBackendState = useCallback(
    async (selectFirst = false, tokenOverride) => {
      const headers = authHeaders(tokenOverride);
      try {
        const [listRes, sandboxRes, graphRes, policiesRes, keysRes, auditRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/assessments`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${API_BASE}/api/sandbox/files`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${API_BASE}/api/sandbox/graph`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${API_BASE}/api/v1/policies`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${API_BASE}/api/v1/api-keys`, { headers, signal: AbortSignal.timeout(5000) }),
          fetch(`${API_BASE}/api/v1/audit`, { headers, signal: AbortSignal.timeout(5000) }),
        ]);

        if (listRes.ok) {
          const payload = await listRes.json();
          const items = Array.isArray(payload)
            ? payload
            : payload?.results || payload?.items || payload?.assessments;
          if (Array.isArray(items)) {
            const normalized = items.map(normalizeAssessment);
            setAssessments(normalized);
            if (selectFirst && normalized.length > 0) setSelectedId(normalized[0].id);
          }
        }
        if (sandboxRes.ok) setSandboxData(await sandboxRes.json());
        if (graphRes.ok) setGraphData(await graphRes.json());
        if (policiesRes.ok) {
          const data = await policiesRes.json();
          if (Array.isArray(data.policies) && data.policies.length > 0) {
            setPolicies(data.policies);
          }
        }
        if (keysRes.ok) {
          const data = await keysRes.json();
          setApiKeys(data.apiKeys || []);
        }
        if (auditRes.ok) {
          const data = await auditRes.json();
          setAuditLog(data.logs || []);
        }
      } catch {
        // retain current state on transient error
      }
    },
    [authHeaders]
  );

  const establishDemoSession = useCallback(
    async (orgId, role) => {
      const res = await fetch(`${API_BASE}/api/v1/auth/demo-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, role }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Could not initialize enterprise session");
      const data = await res.json();
      authTokenRef.current = data.token;
      setCurrentUser(data.user);
      if (Array.isArray(data.organizations) && data.organizations.length > 0) {
        setOrganizations(data.organizations);
      }
      await refreshBackendState(true, data.token);
    },
    [refreshBackendState]
  );

  useEffect(() => {
    let active = true;
    async function boot() {
      setLoading(true);
      try {
        const healthRes = await fetch(`${API_BASE}/healthz`, { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error("Health check failed");
        if (!active) return;
        setApiOnline(true);
        await establishDemoSession("acme-corp", "Admin");
      } catch {
        if (active) setApiOnline(false);
      } finally {
        if (active) setLoading(false);
      }
    }
    boot();
    return () => {
      active = false;
    };
  }, [establishDemoSession]);

  async function handleSwitchOrg(nextOrgId) {
    setActionFeedback(null);
    setFilterStatus("ALL");
    setSearchQuery("");
    if (!apiOnline) {
      const org = organizations.find((o) => o.id === nextOrgId) || organizations[0];
      setCurrentUser((prev) => ({ ...prev, orgId: org.id, orgName: org.name }));
      return;
    }
    try {
      await establishDemoSession(nextOrgId, currentUser.role);
    } catch {
      // ignore transient switch failure
    }
  }

  async function handleSwitchRole(nextRole) {
    setActionFeedback(null);
    if (!apiOnline) {
      setCurrentUser((prev) => ({ ...prev, role: nextRole }));
      return;
    }
    try {
      await establishDemoSession(currentUser.orgId, nextRole);
    } catch {
      // ignore transient switch failure
    }
  }

  async function handleAuthenticated(token, user) {
    authTokenRef.current = token;
    setCurrentUser(user);
    setActionFeedback({
      type: "success",
      message: `Signed in as ${user.email} (${user.role} · ${user.orgName}).`,
    });
    await refreshBackendState(true, token);
  }

  const activePolicy = policies[0] || DEFAULT_POLICIES[0];

  const filteredAssessments = useMemo(
    () => filterAssessments(assessments, filterStatus, searchQuery),
    [assessments, filterStatus, searchQuery]
  );

  const activeAssessment = useMemo(() => {
    return (
      filteredAssessments.find((a) => a.id === selectedId) ||
      filteredAssessments[0] ||
      assessments[0]
    );
  }, [filteredAssessments, selectedId, assessments]);

  const simulatedScore = useMemo(
    () =>
      calculateSimulatedScore({
        filesChanged: simFilesChanged,
        blastHops: simBlastHops,
        pastIncidents: simPastIncidents,
        touchesCore: simTouchesCore,
      }),
    [simFilesChanged, simBlastHops, simPastIncidents, simTouchesCore]
  );

  const simulatedGate = deriveGateStatus(simulatedScore, activePolicy.blockThreshold);
  const metrics = useMemo(() => computeMetrics(assessments), [assessments]);

  async function handleSubmitSandboxPr(payload) {
    try {
      const res = await fetch(`${API_BASE}/api/sandbox/pr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Failed to analyze PR" };

      const normalized = normalizeAssessment(data.assessment);
      setAssessments((prev) => [normalized, ...prev]);
      setFilterStatus("ALL");
      setSearchQuery("");
      setSelectedId(normalized.id);
      setActionFeedback({
        type: normalized.gateStatus === "BLOCK" ? "error" : "success",
        message: `PR #${normalized.prNumber} analyzed live via Acorn AST & Graph Engine -> GATE: ${normalized.gateStatus} (${normalized.riskScore}/100).`,
      });
      setActiveTab("gate");
      refreshBackendState(false);
      return { ok: true };
    } catch {
      return { ok: false, error: "Could not reach DeployGuard analysis engine." };
    }
  }

  async function handleAnalyzeGitHubPr(payload) {
    try {
      const res = await fetch(`${API_BASE}/api/github/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "GitHub PR scan failed" };

      const normalized = normalizeAssessment(data.assessment);
      setAssessments((prev) => [normalized, ...prev]);
      setFilterStatus("ALL");
      setSearchQuery("");
      setSelectedId(normalized.id);
      setActionFeedback({
        type: normalized.gateStatus === "BLOCK" ? "error" : "success",
        message: `Live GitHub PR ${normalized.repo}#${normalized.prNumber} scanned -> GATE: ${normalized.gateStatus} (${normalized.riskScore}/100).`,
      });
      setActiveTab("gate");
      refreshBackendState(false);
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error reaching GitHub PR analyzer." };
    }
  }

  async function handleResetSandbox() {
    const res = await fetch(`${API_BASE}/api/sandbox/reset`, {
      method: "POST",
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setActionFeedback({
        type: "error",
        message: data.error || "Forbidden: Admin role required to reset demo repository.",
      });
      return;
    }
    await refreshBackendState(true);
    setActionFeedback({
      type: "success",
      message: "Demo repository files reset to clean main branch baseline.",
    });
  }

  async function handleMerge(id, opts) {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/assessments/${encodeURIComponent(id)}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionFeedback({ type: "error", message: data.error || "Merge rejected by gate." });
        return false;
      }
      const updated = normalizeAssessment(data.assessment);
      setAssessments((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
      if (data.auditLog) setAuditLog(data.auditLog);
      setActionFeedback({
        type: "success",
        message: opts.override
          ? `PR #${updated.prNumber} merged with Override (${currentUser.role}) and recorded in Audit Log.`
          : `PR #${updated.prNumber} safely merged into main branch.`,
      });
      refreshBackendState(false);
      return true;
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDeploy(id, opts) {
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/assessments/${encodeURIComponent(id)}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionFeedback({ type: "error", message: data.error || "Deployment failed." });
        return;
      }
      if (data.auditLog) setAuditLog(data.auditLog);
      const dep = data.deployment;
      setActionFeedback({
        type: "success",
        message: `Deployment ${dep.deploymentId} active: ${dep.strategy} (${dep.trafficPercent}% traffic) · Status: ${dep.status}.`,
      });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSavePolicy(nextPolicy) {
    const res = await fetch(`${API_BASE}/api/v1/policies`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(nextPolicy),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Failed to save policy" };
    if (Array.isArray(data.policies)) setPolicies(data.policies);
    if (data.auditLog) setAuditLog(data.auditLog);
    return { ok: true };
  }

  async function handleCreateApiKey(payload) {
    const res = await fetch(`${API_BASE}/api/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || "Could not generate API key" };
    setApiKeys((prev) => [data.apiKey, ...prev]);
    if (data.auditLog) setAuditLog(data.auditLog);
    return { ok: true, rawKey: data.rawKey };
  }

  async function handleRevokeApiKey(keyId) {
    const res = await fetch(`${API_BASE}/api/v1/api-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    const data = await res.json();
    if (res.ok) {
      setApiKeys((prev) => prev.map((k) => (k.id === keyId ? { ...k, revoked: true } : k)));
      if (data.auditLog) setAuditLog(data.auditLog);
    }
  }

  async function handleTestWebhook() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/webhook/test`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || "Webhook verification failed" };
      if (data.auditLog) setAuditLog(data.auditLog);
      return { ok: data.status === "verified", ...data };
    } catch {
      return { ok: false, error: "Could not reach webhook test endpoint." };
    }
  }

  return (
    <div
      className={`min-h-screen bg-slate-950 text-slate-100 transition-colors ${
        theme === "light" ? "dg-light" : ""
      }`}
    >
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold tracking-tight text-white">DeployGuard AI</h1>
                <span className="rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-300">
                  Release Risk Gate
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                AST Blast Radius · Historical Incident Vector Recall · Multi-Tenant CI/CD Policy
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <nav
                aria-label="Workspace Views"
                className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1"
              >
                {NAV_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(tab.id);
                      setActionFeedback(null);
                    }}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      activeTab === tab.id
                        ? "bg-indigo-600 text-white"
                        : "text-slate-300 hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <button
                type="button"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-700 hover:text-white transition"
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>

              <span
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
                  apiOnline
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-300"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    apiOnline ? "bg-emerald-400" : "bg-amber-400"
                  }`}
                />
                {loading ? "Syncing API..." : apiOnline ? "Live Engine Connected" : "Demo Fallback Mode"}
              </span>
            </div>
          </div>

          {/* Enterprise Multi-Tenant & RBAC Control Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 pt-3 text-xs">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-1.5 text-slate-400">
                <Building2 className="h-3.5 w-3.5 text-indigo-400" />
                <span>Org:</span>
                <select
                  aria-label="Active Organization"
                  value={currentUser.orgId}
                  onChange={(e) => handleSwitchOrg(e.target.value)}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs font-medium text-white focus:border-indigo-500 focus:outline-none"
                >
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="inline-flex items-center gap-1.5 text-slate-400">
                <ShieldCheck className="h-3.5 w-3.5 text-indigo-400" />
                <span>Role:</span>
                <select
                  aria-label="Active RBAC Role"
                  value={currentUser.role}
                  onChange={(e) => handleSwitchRole(e.target.value)}
                  className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs font-medium text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="Admin">Admin</option>
                  <option value="Release Manager">Release Manager</option>
                  <option value="Viewer">Viewer</option>
                </select>
              </label>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="hidden sm:inline font-mono text-[11px] text-slate-400">
                {currentUser.email}
              </span>
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-indigo-500 hover:text-white transition"
              >
                <UserCheck className="h-3.5 w-3.5 text-indigo-400" />
                <span>Account / Sign In</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-6 py-6">
        {activeTab === "gate" && (
          <>
            {/* Executive KPI Cards (5-Card Enterprise Strip) */}
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Evaluated PRs
                </p>
                <p className="mt-2 text-2xl font-bold text-white">{metrics.total}</p>
                <p className="mt-1 text-xs text-slate-400">Tenant release candidates</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Blocked Releases
                </p>
                <p className="mt-2 text-2xl font-bold text-red-400">{metrics.blocked}</p>
                <p className="mt-1 text-xs text-slate-400">
                  Score &gt;= {activePolicy.blockThreshold} gate threshold
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Avg Risk Score
                </p>
                <p className="mt-2 text-2xl font-bold text-indigo-300">{metrics.avgScore}/100</p>
                <p className="mt-1 text-xs text-slate-400">Composite risk index</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Est. MTTR Saved
                </p>
                <p className="mt-2 text-2xl font-bold text-emerald-400">
                  {metrics.mttrMinutesSaved}m
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {metrics.incidentsPrevented} incident pattern(s) stopped
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
                  Max Blast Radius
                </p>
                <p className="mt-2 text-2xl font-bold text-amber-300">{metrics.maxHops} hops</p>
                <p className="mt-1 text-xs text-slate-400">Dependency graph depth</p>
              </div>
            </section>

            {/* Assessments Queue + Detail Inspector */}
            <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-4 lg:col-span-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-white">Pull Request Queue</h2>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setActiveTab("sandbox")}
                      className="inline-flex items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/25 transition"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>Test PR</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1">
                  {["ALL", "BLOCK", "WARN", "PASS"].map((status) => (
                    <button
                      key={status}
                      type="button"
                      onClick={() => setFilterStatus(status)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                        filterStatus === status
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                      }`}
                    >
                      {status}
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by repo, PR #, or title..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />

                <div className="space-y-2.5">
                  {filteredAssessments.map((item) => {
                    const isSelected = activeAssessment?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSelectedId(item.id);
                          setActionFeedback(null);
                        }}
                        className={`w-full rounded-lg border p-3 text-left transition ${
                          isSelected
                            ? "border-indigo-500 bg-slate-800/90"
                            : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono text-slate-400">
                            {item.repo} #{item.prNumber}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {item.status === "MERGED" && (
                              <span className="rounded border border-indigo-500/40 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
                                MERGED
                              </span>
                            )}
                            <span
                              className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${badgeClasses(
                                item.gateStatus
                              )}`}
                            >
                              {item.gateStatus} · {item.riskScore}
                            </span>
                          </div>
                        </div>
                        <p className="mt-1 text-sm font-medium text-white line-clamp-1">
                          {item.title}
                        </p>
                        <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                          <span>by {item.author}</span>
                          <span>{item.blastRadiusHops} graph hops</span>
                          <span>{item.updatedAt}</span>
                        </div>
                      </button>
                    );
                  })}

                  {filteredAssessments.length === 0 && (
                    <p className="py-8 text-center text-sm text-slate-400">
                      No pull requests match the current filter.
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-7">
                <PrDetailInspector
                  assessment={activeAssessment}
                  userRole={currentUser.role}
                  onMerge={handleMerge}
                  onDeploy={handleDeploy}
                  actionBusy={actionBusy}
                  actionFeedback={actionFeedback}
                />
              </div>
            </section>

            {/* Interactive Risk Simulator */}
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-base font-bold text-white">Release Risk Simulator</h2>
                  <p className="text-xs text-slate-400">
                    Model how diff size, dependency hops, incident history, and core paths affect the gate
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-300">
                    Simulated Score: <strong className="text-white">{simulatedScore}/100</strong>
                  </span>
                  <span
                    className={`rounded-md border px-2.5 py-1 text-xs font-bold ${badgeClasses(
                      simulatedGate
                    )}`}
                  >
                    {simulatedGate}
                  </span>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-4">
                <label className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span>Modified Files</span>
                    <span className="font-mono text-white">{simFilesChanged}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="40"
                    value={simFilesChanged}
                    onChange={(e) => setSimFilesChanged(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span>Blast Radius Hops</span>
                    <span className="font-mono text-white">{simBlastHops}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="6"
                    value={simBlastHops}
                    onChange={(e) => setSimBlastHops(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="space-y-1.5 text-xs text-slate-300">
                  <div className="flex justify-between">
                    <span>Past Incidents</span>
                    <span className="font-mono text-white">{simPastIncidents}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    value={simPastIncidents}
                    onChange={(e) => setSimPastIncidents(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5">
                  <span className="text-xs font-medium text-slate-300">Touches Critical Path</span>
                  <input
                    type="checkbox"
                    checked={simTouchesCore}
                    onChange={(e) => setSimTouchesCore(e.target.checked)}
                    className="h-4 w-4 accent-indigo-500"
                  />
                </label>
              </div>
            </section>
          </>
        )}

        {activeTab === "sandbox" && (
          <LivePrSandbox
            sandboxData={sandboxData}
            onSubmitSandboxPr={handleSubmitSandboxPr}
            onAnalyzeGitHubPr={handleAnalyzeGitHubPr}
            onResetSandbox={handleResetSandbox}
          />
        )}

        {activeTab === "graph" && (
          <ServiceGraphView
            graph={graphData}
            activeAssessment={activeAssessment}
          />
        )}

        {activeTab === "audit" && (
          <AuditPolicyView
            policies={policies}
            apiKeys={apiKeys}
            auditLog={auditLog}
            userRole={currentUser.role}
            onSavePolicy={handleSavePolicy}
            onCreateApiKey={handleCreateApiKey}
            onRevokeApiKey={handleRevokeApiKey}
            onTestWebhook={handleTestWebhook}
          />
        )}
      </main>

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        organizations={organizations}
        onAuthenticated={handleAuthenticated}
      />
    </div>
  );
}
