import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileCode2,
  GitMerge,
  MessageSquareCode,
  Rocket,
  ShieldAlert,
  Terminal,
} from "lucide-react";

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

function slaClasses(tier) {
  if (tier === "P0") return "bg-red-500/15 text-red-300 border-red-500/40";
  if (tier === "P1") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
}

function BreakdownBar({ label, value, max, colorClass }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="font-mono text-white">
          {value}/{max}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function PrDetailInspector({
  assessment,
  userRole = "Admin",
  onMerge,
  onDeploy,
  actionBusy,
  actionFeedback,
}) {
  const [showDiff, setShowDiff] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [showPrComment, setShowPrComment] = useState(false);
  const [copiedComment, setCopiedComment] = useState(false);
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideError, setOverrideError] = useState("");

  if (!assessment) return null;

  const isMerged = assessment.status === "MERGED";
  const isBlocked = assessment.gateStatus === "BLOCK";
  const canMutateGate = userRole === "Admin" || userRole === "Release Manager";

  const breakdown = assessment.riskBreakdown || {
    blastRadiusScore: Math.min(40, assessment.blastRadiusHops * 9),
    incidentSimilarityScore: Math.min(30, (assessment.matchedIncidents?.length || 0) * 12),
    complexityAndCriticalPathScore: Math.min(30, Math.max(5, assessment.riskScore - 30)),
    totalScore: assessment.riskScore,
  };

  async function handleOverrideSubmit(e) {
    e.preventDefault();
    const trimmed = overrideReason.trim();
    if (trimmed.length < 5) {
      setOverrideError("Enter a justification (min 5 characters) for the audit log.");
      return;
    }
    setOverrideError("");
    const ok = await onMerge(assessment.id, { override: true, overrideReason: trimmed });
    if (ok) {
      setShowOverrideForm(false);
      setOverrideReason("");
    }
  }

  function handleCopyPrComment() {
    if (!assessment.prCommentMarkdown) return;
    navigator.clipboard?.writeText(assessment.prCommentMarkdown).catch(() => {});
    setCopiedComment(true);
    setTimeout(() => setCopiedComment(false), 1800);
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-mono text-indigo-300">
              {assessment.repo} · Pull Request #{assessment.prNumber}
            </p>
            {assessment.filePath && (
              <span className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] font-mono text-slate-300">
                {assessment.filePath}
              </span>
            )}
            {isMerged && (
              <span className="inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[11px] font-semibold text-indigo-300">
                <GitMerge className="h-3 w-3" /> MERGED
              </span>
            )}
          </div>
          <h2 className="mt-1 text-lg font-bold text-white">{assessment.title}</h2>
          <p className="mt-1 text-xs text-slate-400">
            Author: <span className="text-slate-200">{assessment.author}</span>
            {(assessment.linesAdded > 0 || assessment.linesRemoved > 0) && (
              <span className="ml-3 font-mono">
                <span className="text-emerald-400">+{assessment.linesAdded}</span>{" "}
                <span className="text-red-400">-{assessment.linesRemoved}</span>
              </span>
            )}
            {assessment.scoringEngineMode && (
              <span className="ml-3 font-mono text-slate-500">
                engine: {assessment.scoringEngineMode}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <span
            className={`inline-block rounded-md border px-3 py-1 text-xs font-bold ${badgeClasses(
              assessment.gateStatus
            )}`}
          >
            GATE: {assessment.gateStatus}
          </span>
          <p className="mt-1 text-xs text-slate-400">
            Risk Score: <strong className="text-white">{assessment.riskScore}/100</strong>
          </p>
        </div>
      </div>

      {/* Explainable 3-Pillar Risk Breakdown */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/75 p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Explainable Risk Breakdown
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <BreakdownBar
            label="Blast Radius"
            value={breakdown.blastRadiusScore}
            max={40}
            colorClass="bg-indigo-500"
          />
          <BreakdownBar
            label="Incident Similarity"
            value={breakdown.incidentSimilarityScore}
            max={30}
            colorClass="bg-amber-500"
          />
          <BreakdownBar
            label="Complexity & Critical Path"
            value={breakdown.complexityAndCriticalPathScore}
            max={30}
            colorClass="bg-rose-500"
          />
        </div>
      </div>

      {/* Breaking AST Findings */}
      {assessment.breakingChanges?.length > 0 && (
        <div className="rounded-lg border border-red-500/35 bg-red-950/25 p-3.5 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-red-300">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>AST Breaking Changes Detected ({assessment.breakingChanges.length})</span>
          </div>
          <div className="space-y-1.5">
            {assessment.breakingChanges.map((bc, idx) => (
              <div
                key={`${bc.symbol}-${idx}`}
                className="flex items-start justify-between gap-3 rounded-md border border-red-500/20 bg-slate-950/80 px-3 py-2 text-xs"
              >
                <div>
                  <span className="font-mono font-semibold text-red-300">{bc.symbol}</span>{" "}
                  <span className="text-slate-200">{bc.detail}</span>
                </div>
                <span className="shrink-0 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                  {bc.kind.replace(/_/g, " ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modified AST Symbols */}
      {assessment.modifiedSymbols?.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            AST Symbols Modified ({assessment.modifiedSymbols.length})
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {assessment.modifiedSymbols.map((sym) => (
              <span
                key={sym}
                className="rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-mono text-indigo-200"
              >
                {sym}()
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Blast Radius Services */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Blast Radius Services ({assessment.blastRadiusHops} hops)
        </h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {assessment.affectedServices.map((svc) => {
            const detail = assessment.impactedDetails?.find((d) => d.service === svc);
            const isOrigin = svc === assessment.originService;
            return (
              <span
                key={svc}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-mono ${
                  isOrigin
                    ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-200"
                    : "border-slate-700 bg-slate-800 text-slate-200"
                }`}
              >
                <span>{svc}</span>
                {isOrigin && assessment.originSlaTier && (
                  <span
                    className={`rounded border px-1 text-[10px] font-sans font-semibold ${slaClasses(
                      assessment.originSlaTier
                    )}`}
                  >
                    ORIGIN · {assessment.originSlaTier}
                  </span>
                )}
                {detail && (
                  <span
                    className={`rounded border px-1 text-[10px] font-sans font-semibold ${slaClasses(
                      detail.slaTier
                    )}`}
                  >
                    +{detail.hops}h · {detail.slaTier}
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Historical Incident Matches */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Historical Incident Matches
        </h3>
        {assessment.matchedIncidents?.length > 0 ? (
          <div className="mt-2 space-y-2">
            {assessment.matchedIncidents.map((inc) => (
              <div
                key={inc.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm"
              >
                <div>
                  <span className="font-mono text-xs text-amber-300">{inc.id}</span>{" "}
                  <span className="text-slate-200">{inc.title}</span>
                </div>
                <span className="shrink-0 text-xs text-slate-400">
                  {Math.round(inc.similarity * 100)}% match
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-400">
            No similar historical incidents detected.
          </p>
        )}
      </div>

      {/* Release Agent Recommendation & Actionable Mitigation Plan */}
      <div className="rounded-lg border border-indigo-500/30 bg-indigo-950/30 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
            Actionable Mitigation Plan
          </h3>
          {assessment.mitigationPlan && (
            <div className="flex items-center gap-2 text-[11px] font-mono text-indigo-200">
              <span>Canary: {assessment.mitigationPlan.canaryRolloutPercent}%</span>
              <span>·</span>
              <span>Approvers: {assessment.mitigationPlan.requiredApprovers}</span>
            </div>
          )}
        </div>
        <p className="text-sm leading-relaxed text-slate-200">{assessment.recommendation}</p>
        {assessment.recommendedTests?.length > 0 && (
          <div className="border-t border-indigo-500/20 pt-2.5 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300">
              Required Tests
            </p>
            <ul className="space-y-1 text-xs text-slate-300">
              {assessment.recommendedTests.map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-indigo-400">•</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {assessment.mitigationPlan?.rollbackSteps?.length > 0 && (
          <div className="border-t border-indigo-500/20 pt-2.5 space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-300">
              Rollback Playbook
            </p>
            <ol className="list-decimal list-inside space-y-1 text-xs text-slate-300">
              {assessment.mitigationPlan.rollbackSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {/* Expandable Diff, Trace & GitHub PR Comment */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {assessment.unifiedDiff && (
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white transition"
            >
              <FileCode2 className="h-3.5 w-3.5 text-indigo-400" />
              <span>{showDiff ? "Hide Unified Diff" : "View Unified Diff"}</span>
              {showDiff ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
          {assessment.reasoningTrace?.length > 0 && (
            <button
              type="button"
              onClick={() => setShowTrace((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white transition"
            >
              <Terminal className="h-3.5 w-3.5 text-emerald-400" />
              <span>{showTrace ? "Hide Pipeline Trace" : "View Pipeline Trace"}</span>
              {showTrace ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
          {assessment.prCommentMarkdown && (
            <button
              type="button"
              onClick={() => setShowPrComment((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white transition"
            >
              <MessageSquareCode className="h-3.5 w-3.5 text-amber-400" />
              <span>{showPrComment ? "Hide PR Comment" : "GitHub PR Report"}</span>
              {showPrComment ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>

        {showDiff && assessment.unifiedDiff && (
          <pre className="max-h-56 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs font-mono leading-relaxed">
            {assessment.unifiedDiff.split("\n").map((line, i) => {
              const cls =
                line.startsWith("+") && !line.startsWith("+++")
                  ? "text-emerald-300 bg-emerald-500/10 block px-1"
                  : line.startsWith("-") && !line.startsWith("---")
                  ? "text-red-300 bg-red-500/10 block px-1"
                  : "text-slate-400 block px-1";
              return (
                <span key={i} className={cls}>
                  {line}
                </span>
              );
            })}
          </pre>
        )}

        {showTrace && assessment.reasoningTrace?.length > 0 && (
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-1.5 font-mono text-[11px] text-slate-300">
            {assessment.reasoningTrace.map((step, idx) => (
              <div key={idx} className="leading-relaxed">
                {step}
              </div>
            ))}
          </div>
        )}

        {showPrComment && assessment.prCommentMarkdown && (
          <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-slate-400">
                GitHub Check Run ({assessment.checkRun?.conclusion?.toUpperCase() || "COMPLETED"}) · PR Comment Markdown
              </span>
              <button
                type="button"
                onClick={handleCopyPrComment}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300 hover:text-white"
              >
                <Copy className="h-3 w-3" />
                <span>{copiedComment ? "Copied" : "Copy Markdown"}</span>
              </button>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">
              {assessment.prCommentMarkdown}
            </pre>
          </div>
        )}
      </div>

      {/* CI/CD Gate Action Bar (RBAC Enforced) */}
      <div className="border-t border-slate-800 pt-4 space-y-3">
        {actionFeedback && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              actionFeedback.type === "error"
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
            }`}
          >
            {actionFeedback.message}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {isMerged ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Merged into main
              </span>
            ) : !canMutateGate ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-400">
                Read-only ({userRole}) — Release Manager or Admin required to merge/override
              </span>
            ) : isBlocked ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
                  <AlertTriangle className="h-4 w-4" /> Merge Blocked by Gate
                </span>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setShowOverrideForm((v) => !v)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50 transition"
                >
                  Approve Override
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => onMerge(assessment.id, { override: false })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition"
              >
                <GitMerge className="h-3.5 w-3.5" />
                <span>
                  {assessment.gateStatus === "WARN"
                    ? "Merge with Canary Caution"
                    : "Approve & Merge PR"}
                </span>
              </button>
            )}
          </div>

          {canMutateGate && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() =>
                onDeploy(assessment.id, {
                  strategy: assessment.gateStatus === "PASS" ? "STANDARD" : "CANARY",
                })
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3.5 py-2 text-xs font-semibold text-indigo-200 hover:bg-indigo-500/25 disabled:opacity-50 transition"
            >
              <Rocket className="h-3.5 w-3.5" />
              <span>
                {assessment.gateStatus === "PASS"
                  ? "Deploy Standard (100%)"
                  : "Deploy Canary (5%)"}
              </span>
            </button>
          )}
        </div>

        {showOverrideForm && !isMerged && canMutateGate && (
          <form
            onSubmit={handleOverrideSubmit}
            className="rounded-lg border border-amber-500/35 bg-slate-950 p-3 space-y-2.5"
          >
            <label className="block text-xs font-medium text-amber-200">
              Override Justification (recorded in Audit Log under {userRole})
              <input
                type="text"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. Emergency hotfix approved by VP Eng; 5% canary monitored"
                className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none"
              />
            </label>
            {overrideError && <p className="text-xs text-red-400">{overrideError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowOverrideForm(false)}
                className="rounded-md bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={actionBusy}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                Confirm Override & Merge
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
