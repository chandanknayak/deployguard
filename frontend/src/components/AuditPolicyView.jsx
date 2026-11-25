import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  ScrollText,
  SlidersHorizontal,
  Trash2,
  Webhook,
} from "lucide-react";

export default function AuditPolicyView({
  policies = [],
  apiKeys = [],
  auditLog = [],
  userRole = "Admin",
  onSavePolicy,
  onCreateApiKey,
  onRevokeApiKey,
  onTestWebhook,
}) {
  const isAdmin = userRole === "Admin";
  const [selectedRepo, setSelectedRepo] = useState(policies[0]?.repo || "");
  const activePolicy = policies.find((p) => p.repo === selectedRepo) || policies[0];

  const [blockThreshold, setBlockThreshold] = useState(activePolicy?.blockThreshold ?? 70);
  const [warnThreshold, setWarnThreshold] = useState(activePolicy?.warnThreshold ?? 40);
  const [requiredApprovers, setRequiredApprovers] = useState(activePolicy?.requiredApprovers ?? 2);
  const [patternsText, setPatternsText] = useState(
    (activePolicy?.criticalPathPatterns || []).join(", ")
  );
  const [blockOnBreakingApi, setBlockOnBreakingApi] = useState(
    activePolicy?.blockOnBreakingApi ?? true
  );
  const [blockOnP0Impact, setBlockOnP0Impact] = useState(activePolicy?.blockOnP0Impact ?? false);
  const [saving, setSaving] = useState(false);
  const [policyFeedback, setPolicyFeedback] = useState(null);

  // API Key provisioning state
  const [keyName, setKeyName] = useState("");
  const [keyRole, setKeyRole] = useState("Release Manager");
  const [issuedKey, setIssuedKey] = useState(null);
  const [keyError, setKeyError] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);

  // Webhook tester state
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [webhookResult, setWebhookResult] = useState(null);

  useEffect(() => {
    if (policies.length > 0 && !policies.some((p) => p.repo === selectedRepo)) {
      setSelectedRepo(policies[0].repo);
    }
  }, [policies, selectedRepo]);

  useEffect(() => {
    if (activePolicy) {
      setBlockThreshold(activePolicy.blockThreshold);
      setWarnThreshold(activePolicy.warnThreshold);
      setRequiredApprovers(activePolicy.requiredApprovers ?? 2);
      setPatternsText((activePolicy.criticalPathPatterns || []).join(", "));
      setBlockOnBreakingApi(activePolicy.blockOnBreakingApi);
      setBlockOnP0Impact(activePolicy.blockOnP0Impact);
    }
  }, [activePolicy]);

  async function handleSavePolicy(e) {
    e.preventDefault();
    setSaving(true);
    setPolicyFeedback(null);
    try {
      const patterns = patternsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await onSavePolicy({
        repo: activePolicy?.repo,
        blockThreshold,
        warnThreshold,
        requiredApprovers,
        criticalPathPatterns: patterns,
        blockOnBreakingApi,
        blockOnP0Impact,
      });
      setPolicyFeedback(
        res.ok
          ? { type: "ok", text: `Saved policy for ${activePolicy?.repo}.` }
          : { type: "err", text: res.error || "Failed to update policy." }
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateKey(e) {
    e.preventDefault();
    setKeyError("");
    setIssuedKey(null);
    if (!keyName.trim()) {
      setKeyError("Enter a label for the new API key.");
      return;
    }
    setKeyBusy(true);
    try {
      const res = await onCreateApiKey({ name: keyName.trim(), role: keyRole });
      if (!res.ok) {
        setKeyError(res.error || "Could not create API key.");
      } else {
        setIssuedKey(res.rawKey);
        setKeyName("");
      }
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleTestWebhook() {
    setWebhookBusy(true);
    setWebhookResult(null);
    try {
      const res = await onTestWebhook();
      setWebhookResult(res);
    } finally {
      setWebhookBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Per-Repository Risk Policy */}
        <form
          onSubmit={handleSavePolicy}
          className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-6 space-y-4"
        >
          <div className="border-b border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-indigo-400" />
                <h2 className="text-base font-bold text-white">Per-Repository Risk Policy</h2>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Customize gate thresholds, required approvers, and critical file path globs.
              </p>
            </div>
            {!isAdmin && (
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                Admin Role Required to Edit
              </span>
            )}
          </div>

          <label className="block text-xs text-slate-300">
            Repository
            <select
              value={activePolicy?.repo || ""}
              onChange={(e) => setSelectedRepo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
            >
              {policies.map((p) => (
                <option key={p.repo} value={p.repo}>
                  {p.repo}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5 text-xs text-slate-300">
              <div className="flex justify-between">
                <span>BLOCK Threshold</span>
                <span className="font-mono text-red-300">{blockThreshold}/100</span>
              </div>
              <input
                type="range"
                min="45"
                max="95"
                disabled={!isAdmin}
                value={blockThreshold}
                onChange={(e) => setBlockThreshold(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="block space-y-1.5 text-xs text-slate-300">
              <div className="flex justify-between">
                <span>WARN Threshold</span>
                <span className="font-mono text-amber-300">{warnThreshold}/100</span>
              </div>
              <input
                type="range"
                min="15"
                max={Math.max(20, blockThreshold - 5)}
                disabled={!isAdmin}
                value={warnThreshold}
                onChange={(e) => setWarnThreshold(Number(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-300">
              Required Approvers
              <input
                type="number"
                min="0"
                max="10"
                disabled={!isAdmin}
                value={requiredApprovers}
                onChange={(e) => setRequiredApprovers(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <label className="sm:col-span-2 text-xs text-slate-300">
              Critical Path Patterns (comma-separated globs)
              <input
                type="text"
                disabled={!isAdmin}
                value={patternsText}
                onChange={(e) => setPatternsText(e.target.value)}
                placeholder="services/payment_*, services/auth_*"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-white focus:border-indigo-500 focus:outline-none"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200">
              <span>Auto-BLOCK Breaking API</span>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={blockOnBreakingApi}
                onChange={(e) => setBlockOnBreakingApi(e.target.checked)}
                className="h-4 w-4 accent-indigo-500"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-200">
              <span>Auto-BLOCK WARN on P0</span>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={blockOnP0Impact}
                onChange={(e) => setBlockOnP0Impact(e.target.checked)}
                className="h-4 w-4 accent-indigo-500"
              />
            </label>
          </div>

          {policyFeedback && (
            <p
              className={`text-xs ${
                policyFeedback.type === "ok" ? "text-emerald-300" : "text-red-400"
              }`}
            >
              {policyFeedback.text}
            </p>
          )}

          <button
            type="submit"
            disabled={saving || !isAdmin}
            className="w-full rounded-lg bg-indigo-600 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-45 transition"
          >
            {saving ? "Saving Policy..." : "Save Repository Policy"}
          </button>
        </form>

        {/* Right: Enterprise API Keys & Webhook Connectivity */}
        <div className="space-y-6 lg:col-span-6">
          {/* API Keys */}
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
            <div className="border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-indigo-400" />
                <h2 className="text-base font-bold text-white">Tenant API Keys (CI/CD Access)</h2>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Issue SHA-256 hashed keys scoped to your organization and RBAC role.
              </p>
            </div>

            <form onSubmit={handleCreateKey} className="flex flex-wrap gap-2">
              <input
                type="text"
                disabled={!isAdmin}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Key name (e.g. GitHub Actions Prod)"
                className="flex-1 min-w-[160px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <select
                disabled={!isAdmin}
                value={keyRole}
                onChange={(e) => setKeyRole(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="Release Manager">Release Manager</option>
                <option value="Admin">Admin</option>
                <option value="Viewer">Viewer</option>
              </select>
              <button
                type="submit"
                disabled={!isAdmin || keyBusy}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-45"
              >
                {keyBusy ? "Issuing..." : "Generate Key"}
              </button>
            </form>

            {keyError && <p className="text-xs text-red-400">{keyError}</p>}

            {issuedKey && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 space-y-1.5">
                <p className="text-[11px] font-semibold text-emerald-300">
                  New API Key Issued (copy now — stored hashed on server):
                </p>
                <div className="flex items-center justify-between gap-2 rounded bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-emerald-200">
                  <span className="truncate">{issuedKey}</span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(issuedKey).catch(() => {})}
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-300 hover:text-white"
                  >
                    <Copy className="h-3 w-3" /> Copy
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2 max-h-40 overflow-y-auto">
              {apiKeys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-xs"
                >
                  <div>
                    <span className="font-semibold text-white">{k.name}</span>{" "}
                    <span className="font-mono text-slate-400">{k.prefix}</span>
                    <span className="ml-2 rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300">
                      {k.role}
                    </span>
                    {k.revoked && (
                      <span className="ml-2 text-[10px] font-semibold text-red-400">REVOKED</span>
                    )}
                  </div>
                  {!k.revoked && isAdmin && (
                    <button
                      type="button"
                      onClick={() => onRevokeApiKey(k.id)}
                      aria-label={`Revoke API key ${k.name}`}
                      className="rounded p-1 text-slate-400 hover:bg-red-500/15 hover:text-red-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {apiKeys.length === 0 && (
                <p className="text-xs text-slate-500">
                  No API keys provisioned for this tenant yet.
                </p>
              )}
            </div>
          </div>

          {/* Webhook Connectivity & HMAC Tester */}
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <Webhook className="h-4 w-4 text-indigo-400" />
                  <h2 className="text-base font-bold text-white">GitHub Webhook & HMAC-SHA256</h2>
                </div>
                <p className="mt-0.5 text-xs font-mono text-slate-400">
                  POST /api/v1/webhook/github
                </p>
              </div>
              <button
                type="button"
                disabled={!isAdmin || webhookBusy}
                onClick={handleTestWebhook}
                className="rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/25 disabled:opacity-45"
              >
                {webhookBusy ? "Testing..." : "Test Webhook HMAC"}
              </button>
            </div>

            {webhookResult && (
              <div
                className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${
                  webhookResult.ok
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : "border-red-500/40 bg-red-500/10 text-red-300"
                }`}
              >
                {webhookResult.ok ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span>
                      HMAC-SHA256 verified · Valid signature accepted & tampered payload rejected.
                    </span>
                  </div>
                ) : (
                  <span>{webhookResult.error}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Tenant-Isolated Audit Log */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
        <div className="border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-indigo-400" />
            <h2 className="text-base font-bold text-white">
              Tenant Governance & Override Audit Log ({auditLog.length})
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Organization-isolated trail of AST scans, merge gates, overrides, API keys, and policy updates.
          </p>
        </div>

        <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
          {auditLog.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-xs space-y-1"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold text-indigo-300">
                    {entry.action.replace(/_/g, " ")}
                  </span>
                  <span className="font-mono text-slate-300">
                    {entry.repo}
                    {entry.prNumber ? ` #${entry.prNumber}` : ""}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 font-mono">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <p className="text-slate-200">{entry.detail}</p>
              <p className="text-[11px] text-slate-400">
                Operator: {entry.operator}
                {entry.role ? ` (${entry.role})` : ""}
              </p>
            </div>
          ))}
          {auditLog.length === 0 && (
            <p className="py-8 text-center text-xs text-slate-400">
              No audit events recorded for this organization yet.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
