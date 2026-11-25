import { computeUnifiedDiff, parseExternalUnifiedDiff } from "./diffParser.ts";
import { compareFileAsts, type BreakingChange } from "./astAnalyzer.ts";
import {
  computeBlastRadius,
  type DependencyGraph,
  type ImpactedService,
  type ServiceGraphEdge,
} from "./dependencyGraph.ts";
import { matchHistoricalIncidents, type MatchedIncident } from "./incidentMatcher.ts";
import {
  createDefaultRepoPolicy,
  matchCriticalFilePatterns,
  type RepoPolicy,
} from "./policyEngine.ts";
import {
  buildGitHubCheckRun,
  renderGitHubPrComment,
  type GitHubCheckRunPayload,
} from "./prCommentRenderer.ts";

export interface GatePolicy {
  blockThreshold: number;
  warnThreshold: number;
  requiredApprovers?: number;
  criticalPathPatterns?: string[];
  blockOnBreakingApi: boolean;
  blockOnP0Impact: boolean;
}

export const DEFAULT_POLICY: GatePolicy = {
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
};

export interface RiskBreakdown {
  blastRadiusScore: number; // 0..40
  incidentSimilarityScore: number; // 0..30
  complexityAndCriticalPathScore: number; // 0..30
  totalScore: number; // 0..100
}

export interface MitigationPlan {
  canaryRolloutPercent: number;
  requiredApprovers: number;
  requiredTests: string[];
  rollbackSteps: string[];
}

export interface AssessmentRecord {
  id: string;
  orgId: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  filePath: string;
  sourceType: "sandbox" | "github";
  status: "OPEN" | "MERGED";
  riskScore: number;
  gateStatus: "PASS" | "WARN" | "BLOCK";
  scoringEngineMode: "deterministic-ast-v2" | "llm-synthesized-v2" | "deterministic-fallback";
  riskBreakdown: RiskBreakdown;
  mitigationPlan: MitigationPlan;
  matchedCriticalPaths: string[];
  blastRadiusHops: number;
  affectedServices: string[];
  impactedDetails: ImpactedService[];
  traversedEdges: ServiceGraphEdge[];
  originService: string;
  originSlaTier: "P0" | "P1" | "P2";
  matchedIncidents: MatchedIncident[];
  modifiedSymbols: string[];
  addedSymbols: string[];
  deletedSymbols: string[];
  breakingChanges: BreakingChange[];
  riskyPatterns: string[];
  linesAdded: number;
  linesRemoved: number;
  unifiedDiff: string;
  proposedCode?: string;
  recommendation: string;
  recommendedTests: string[];
  reasoningTrace: string[];
  deploymentStrategy: "STANDARD" | "CANARY" | "ROLLBACK_READY";
  prCommentMarkdown: string;
  checkRun: GitHubCheckRunPayload;
  updatedAt: string;
  createdAtIso: string;
}

export function deriveGateDecision(
  score: number,
  breakingCount: number,
  hasP0Impact: boolean,
  policy: GatePolicy = DEFAULT_POLICY
): "PASS" | "WARN" | "BLOCK" {
  if (score >= policy.blockThreshold) return "BLOCK";
  if (policy.blockOnBreakingApi && breakingCount > 0) return "BLOCK";
  if (policy.blockOnP0Impact && hasP0Impact && score >= policy.warnThreshold) return "BLOCK";
  if (score >= policy.warnThreshold) return "WARN";
  return "PASS";
}

function buildRollbackSteps(
  service: string,
  filePath: string,
  strategy: "STANDARD" | "CANARY" | "ROLLBACK_READY"
): string[] {
  if (strategy === "STANDARD") {
    return [
      `Revert commit touching ${filePath} via GitHub PR revert.`,
      `Verify 200 OK health check on ${service}.`,
    ];
  }
  return [
    `Halt canary traffic shift and route 100% traffic back to previous stable ${service} revision.`,
    `Revert ${filePath} and re-run contract tests before re-attempting rollout.`,
    `Inspect error rate, p95 latency, and lock contention metrics for 10 minutes post-rollback.`,
  ];
}

export function analyzeSandboxPullRequest(params: {
  id: string;
  orgId?: string;
  prNumber: number;
  title: string;
  author: string;
  filePath: string;
  baseCode: string;
  headCode: string;
  graph: DependencyGraph;
  policy?: GatePolicy | RepoPolicy;
  updatedAt?: string;
}): AssessmentRecord {
  const orgId = params.orgId || "acme-corp";
  const policy: GatePolicy =
    params.policy ?? createDefaultRepoPolicy(orgId, params.graph.repository);
  const trace: string[] = [];

  // Stage 1: Diff Extraction
  const diff = computeUnifiedDiff(params.baseCode, params.headCode, params.filePath);
  trace.push(
    `STAGE 1 [DIFF]: Computed unified diff for ${params.filePath} (+${diff.addedCount} / -${diff.removedCount} lines).`
  );

  // Stage 2: Deterministic AST Comparison
  const astReport = compareFileAsts(
    params.baseCode,
    params.headCode,
    diff.modifiedOldLines,
    diff.modifiedNewLines
  );
  const touchedSymbols = [
    ...astReport.modifiedSymbols,
    ...astReport.deletedSymbols,
    ...astReport.addedSymbols,
  ];
  trace.push(
    astReport.parseError
      ? `STAGE 2 [AST]: Syntax error detected — ${astReport.parseError}`
      : `STAGE 2 [AST]: Parsed Base & Head ASTs. Modified: [${astReport.modifiedSymbols.join(", ") || "none"}], Breaking changes: ${astReport.breakingChanges.length}.`
  );

  // Stage 3: Multi-Hop Dependency Graph Blast Radius
  const blast = computeBlastRadius(
    params.graph,
    params.filePath,
    astReport.parseError ? [] : touchedSymbols,
    5
  );
  trace.push(
    `STAGE 3 [GRAPH]: Origin ${blast.originService} (${blast.originSlaTier}) -> ${blast.totalAffected} upstream service(s) reached within ${blast.maxDepthReached} hop(s): [${blast.affectedServices.join(", ")}].`
  );

  // Stage 4: Historical Incident Recall
  const matchedIncidents = matchHistoricalIncidents({
    originService: blast.originService,
    affectedServices: blast.affectedServices,
    prTitle: params.title,
    modifiedSymbols: touchedSymbols,
    riskyPatterns: astReport.riskyPatterns,
    diffSnippet: diff.unifiedText,
  });
  trace.push(
    matchedIncidents.length > 0
      ? `STAGE 4 [INCIDENTS]: Recalled ${matchedIncidents.length} similar outage(s); top match ${matchedIncidents[0].id} (${Math.round(matchedIncidents[0].similarity * 100)}% similarity).`
      : `STAGE 4 [INCIDENTS]: No matching historical P0/P1 incidents detected.`
  );

  // Stage 5: Explainable 3-Pillar Risk Breakdown
  const matchedCriticalPaths = matchCriticalFilePatterns(
    params.filePath,
    policy.criticalPathPatterns || DEFAULT_POLICY.criticalPathPatterns || []
  );

  // Pillar 1: Blast Radius Score (0..40)
  const p0Callers = blast.impactedDetails.filter((s) => s.slaTier === "P0").length;
  const p1Callers = blast.impactedDetails.filter((s) => s.slaTier === "P1").length;
  let blastRadiusScore = 2;
  if (blast.originSlaTier === "P0") blastRadiusScore += 14;
  else if (blast.originSlaTier === "P1") blastRadiusScore += 8;
  blastRadiusScore += Math.min(16, p0Callers * 9 + p1Callers * 5);
  blastRadiusScore += Math.min(8, blast.maxDepthReached * 4);
  blastRadiusScore = Math.min(40, blastRadiusScore);

  // Pillar 2: Historical Incident Similarity Score (0..30)
  let incidentSimilarityScore = 0;
  if (matchedIncidents.length > 0) {
    const top = matchedIncidents[0];
    const severityMultiplier = top.severity === "P0" ? 26 : top.severity === "P1" ? 18 : 10;
    incidentSimilarityScore = Math.min(
      30,
      Math.round(top.similarity * severityMultiplier) + Math.min(4, (matchedIncidents.length - 1) * 2)
    );
  }

  // Pillar 3: Change Complexity & Critical Path Score (0..30)
  let complexityScore = 4;
  complexityScore += Math.min(7, Math.round((diff.addedCount + diff.removedCount) * 0.6));
  if (matchedCriticalPaths.length > 0) complexityScore += 5;
  for (const bc of astReport.breakingChanges) {
    complexityScore += bc.severity === "CRITICAL" ? 12 : bc.severity === "HIGH" ? 8 : 5;
  }
  complexityScore += Math.min(8, astReport.riskyPatterns.length * 4);
  complexityScore = Math.min(30, complexityScore);

  let totalScore = blastRadiusScore + incidentSimilarityScore + complexityScore;
  if (astReport.parseError) {
    complexityScore = 30;
    totalScore = Math.max(totalScore, 96);
  }
  const finalScore = Math.min(99, Math.max(5, totalScore));

  const gateStatus = deriveGateDecision(
    finalScore,
    astReport.breakingChanges.length,
    blast.hasP0Impact,
    policy
  );

  const deploymentStrategy =
    gateStatus === "BLOCK"
      ? "ROLLBACK_READY"
      : gateStatus === "WARN"
      ? "CANARY"
      : "STANDARD";

  const requiredTests: string[] = [];
  if (astReport.breakingChanges.length > 0) {
    requiredTests.push(
      `Resolve breaking AST contract change(s): ${astReport.breakingChanges.map((b) => b.symbol).join(", ")}`
    );
  }
  for (const caller of blast.impactedDetails.slice(0, 2)) {
    requiredTests.push(
      `Run upstream contract suite for ${caller.service} (${caller.slaTier}, owner: ${caller.ownerTeam})`
    );
  }
  if (matchedIncidents.length > 0) {
    requiredTests.push(
      `Run regression test covering ${matchedIncidents[0].id}: ${matchedIncidents[0].title}`
    );
  }
  if (requiredTests.length === 0) {
    requiredTests.push(`Run unit test suite for ${blast.originService}`);
  }

  const mitigationPlan: MitigationPlan = {
    canaryRolloutPercent: gateStatus === "BLOCK" ? 0 : gateStatus === "WARN" ? 5 : 100,
    requiredApprovers:
      gateStatus === "PASS" ? 1 : Math.max(1, policy.requiredApprovers ?? 2),
    requiredTests,
    rollbackSteps: buildRollbackSteps(blast.originService, params.filePath, deploymentStrategy),
  };

  let recommendation = "";
  if (gateStatus === "BLOCK") {
    const reasonParts: string[] = [];
    if (astReport.breakingChanges.length > 0) {
      reasonParts.push(astReport.breakingChanges[0].detail);
    }
    if (blast.totalAffected > 0) {
      reasonParts.push(
        `Impacts ${blast.totalAffected} upstream service(s) (${blast.impactedDetails
          .map((s) => `${s.service} ${s.slaTier}`)
          .join(", ")}).`
      );
    }
    if (matchedIncidents.length > 0) {
      reasonParts.push(
        `Matches past outage ${matchedIncidents[0].id} (${Math.round(
          matchedIncidents[0].similarity * 100
        )}%).`
      );
    }
    recommendation = `Hold merge. ${reasonParts.join(" ")} Remediate breaking contracts or require Release Manager override with audit reason.`;
  } else if (gateStatus === "WARN") {
    recommendation = `Proceed with caution. ${blast.originService} (${blast.originSlaTier}) touches ${
      blast.totalAffected
    } downstream caller(s). Deploy via 5% canary rollout and monitor error rates for 15 minutes.`;
  } else {
    recommendation = `Safe to merge. ${blast.originService} (${blast.originSlaTier}) has ${blast.totalAffected} upstream caller(s), zero breaking AST contract changes, and no high-severity incident matches.`;
  }

  trace.push(
    `STAGE 5 [GATE]: Breakdown [Blast=${blastRadiusScore}/40, Incidents=${incidentSimilarityScore}/30, Complexity=${complexityScore}/30] -> Score ${finalScore}/100 -> Decision: ${gateStatus}.`
  );

  const partial: Omit<AssessmentRecord, "prCommentMarkdown" | "checkRun"> = {
    id: params.id,
    orgId,
    repo: params.graph.repository,
    prNumber: params.prNumber,
    title: params.title,
    author: params.author,
    filePath: params.filePath,
    sourceType: "sandbox",
    status: "OPEN",
    riskScore: finalScore,
    gateStatus,
    scoringEngineMode: "deterministic-ast-v2",
    riskBreakdown: {
      blastRadiusScore,
      incidentSimilarityScore,
      complexityAndCriticalPathScore: complexityScore,
      totalScore: finalScore,
    },
    mitigationPlan,
    matchedCriticalPaths,
    blastRadiusHops: Math.max(1, blast.maxDepthReached || (blast.totalAffected > 0 ? 1 : 0)),
    affectedServices: blast.affectedServices,
    impactedDetails: blast.impactedDetails,
    traversedEdges: blast.traversedEdges,
    originService: blast.originService,
    originSlaTier: blast.originSlaTier,
    matchedIncidents,
    modifiedSymbols: astReport.modifiedSymbols,
    addedSymbols: astReport.addedSymbols,
    deletedSymbols: astReport.deletedSymbols,
    breakingChanges: astReport.breakingChanges,
    riskyPatterns: astReport.riskyPatterns,
    linesAdded: diff.addedCount,
    linesRemoved: diff.removedCount,
    unifiedDiff: diff.unifiedText,
    proposedCode: params.headCode,
    recommendation,
    recommendedTests: requiredTests,
    reasoningTrace: trace,
    deploymentStrategy,
    updatedAt: params.updatedAt || "Just now",
    createdAtIso: new Date().toISOString(),
  };

  const fullRecord: AssessmentRecord = {
    ...partial,
    prCommentMarkdown: "",
    checkRun: {
      name: "DeployGuard AI / Release Risk Gate",
      status: "completed",
      conclusion: "success",
      output: { title: "", summary: "", text: "" },
    },
  };
  fullRecord.prCommentMarkdown = renderGitHubPrComment(fullRecord);
  fullRecord.checkRun = buildGitHubCheckRun(fullRecord);
  return fullRecord;
}

// ---------------------------------------------------------------------------
// Strict LLM Schema Validator + Automatic Deterministic Fallback
// ---------------------------------------------------------------------------
export interface LlmSynthesisOutput {
  riskScore: number;
  recommendation: string;
  additionalTests?: string[];
}

export function validateLlmSynthesisSchema(raw: unknown): LlmSynthesisOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.riskScore !== "number" ||
    !Number.isFinite(obj.riskScore) ||
    obj.riskScore < 0 ||
    obj.riskScore > 100
  ) {
    return null;
  }
  if (typeof obj.recommendation !== "string" || obj.recommendation.trim().length < 10) {
    return null;
  }
  const additionalTests = Array.isArray(obj.additionalTests)
    ? obj.additionalTests.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    : [];
  return {
    riskScore: Math.round(obj.riskScore),
    recommendation: obj.recommendation.trim().slice(0, 600),
    additionalTests,
  };
}

export async function synthesizeWithLlmFallback(
  baseAssessment: AssessmentRecord,
  llmCall?: () => Promise<unknown>,
  timeoutMs = 3000
): Promise<AssessmentRecord> {
  if (!llmCall) return baseAssessment;

  try {
    const raw = await Promise.race([
      llmCall(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM synthesis timeout")), timeoutMs)
      ),
    ]);
    const validated = validateLlmSynthesisSchema(raw);
    if (!validated) {
      return {
        ...baseAssessment,
        scoringEngineMode: "deterministic-fallback",
        reasoningTrace: [
          ...baseAssessment.reasoningTrace,
          "FALLBACK [LLM]: Received malformed LLM output; enforced deterministic AST risk score.",
        ],
      };
    }

    const mergedTests = Array.from(
      new Set([...baseAssessment.mitigationPlan.requiredTests, ...(validated.additionalTests || [])])
    );
    const updated: AssessmentRecord = {
      ...baseAssessment,
      recommendation: validated.recommendation,
      scoringEngineMode: "llm-synthesized-v2",
      mitigationPlan: {
        ...baseAssessment.mitigationPlan,
        requiredTests: mergedTests,
      },
      recommendedTests: mergedTests,
      reasoningTrace: [
        ...baseAssessment.reasoningTrace,
        "STAGE 5B [LLM]: Validated structured synthesis response against strict JSON schema.",
      ],
    };
    updated.prCommentMarkdown = renderGitHubPrComment(updated);
    updated.checkRun = buildGitHubCheckRun(updated);
    return updated;
  } catch {
    return {
      ...baseAssessment,
      scoringEngineMode: "deterministic-fallback",
      reasoningTrace: [
        ...baseAssessment.reasoningTrace,
        "FALLBACK [LLM]: LLM unavailable or timed out; enforced deterministic AST risk score.",
      ],
    };
  }
}

export function analyzeExternalGitHubPr(params: {
  id: string;
  orgId?: string;
  repo: string;
  prNumber: number;
  title: string;
  author: string;
  rawDiff: string;
  policy?: GatePolicy;
}): AssessmentRecord {
  const orgId = params.orgId || "acme-corp";
  const policy = params.policy ?? DEFAULT_POLICY;
  const files = parseExternalUnifiedDiff(params.rawDiff);
  const totalAdded = files.reduce((s, f) => s + f.addedCount, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removedCount, 0);
  const allAddedText = files.flatMap((f) => f.addedLinesText).join("\n");
  const allRemovedText = files.flatMap((f) => f.removedLinesText).join("\n");

  const breakingChanges: BreakingChange[] = [];
  const riskyPatterns: string[] = [];
  const modifiedSymbols: string[] = [];

  const fnRegex = /(?:export\s+)?(?:async\s+)?(?:function|def|func|class)\s+([a-zA-Z0-9_]+)/g;
  const removedFns = new Set<string>();
  const addedFns = new Set<string>();
  for (const m of allRemovedText.matchAll(fnRegex)) removedFns.add(m[1]);
  for (const m of allAddedText.matchAll(fnRegex)) addedFns.add(m[1]);

  for (const fn of removedFns) {
    modifiedSymbols.push(fn);
    if (!addedFns.has(fn)) {
      breakingChanges.push({
        symbol: fn,
        kind: "EXPORT_REMOVED",
        severity: "HIGH",
        detail: `Symbol '${fn}' appears removed in external PR diff.`,
      });
    } else {
      breakingChanges.push({
        symbol: fn,
        kind: "SIGNATURE_CHANGED",
        severity: "MEDIUM",
        detail: `Definition of '${fn}' was altered in PR diff.`,
      });
    }
  }
  for (const fn of addedFns) {
    if (!removedFns.has(fn)) modifiedSymbols.push(fn);
  }

  const combinedDiff = `${params.title}\n${allAddedText}\n${allRemovedText}`.toLowerCase();
  if (/auth|token|jwt|oauth|session|secret|password/.test(combinedDiff)) riskyPatterns.push("auth-security-path");
  if (/retry|backoff|lock|mutex|redis|queue/.test(combinedDiff)) riskyPatterns.push("concurrency-retry-path");
  if (/migration|drop table|alter table|schema|sql|payment|billing/.test(combinedDiff)) riskyPatterns.push("data-or-billing-critical");

  const affectedServices = Array.from(
    new Set(files.map((f) => f.filename.split("/")[0] || "core").filter(Boolean))
  ).slice(0, 6);

  const matchedIncidents = matchHistoricalIncidents({
    originService: affectedServices[0] || params.repo,
    affectedServices,
    prTitle: params.title,
    modifiedSymbols,
    riskyPatterns,
    diffSnippet: params.rawDiff.slice(0, 1200),
  });

  const blastRadiusScore = Math.min(40, 8 + files.length * 4 + affectedServices.length * 4);
  const incidentSimilarityScore =
    matchedIncidents.length > 0 ? Math.min(30, Math.round(matchedIncidents[0].similarity * 25)) : 0;
  const complexityScore = Math.min(
    30,
    6 +
      Math.min(10, Math.round((totalAdded + totalRemoved) * 0.1)) +
      breakingChanges.length * 8 +
      riskyPatterns.length * 6
  );

  const finalScore = Math.min(99, Math.max(8, blastRadiusScore + incidentSimilarityScore + complexityScore));
  const gateStatus = deriveGateDecision(finalScore, breakingChanges.length, false, policy);
  const deploymentStrategy =
    gateStatus === "BLOCK" ? "ROLLBACK_READY" : gateStatus === "WARN" ? "CANARY" : "STANDARD";

  const requiredTests = [
    `Run CI test suite across ${affectedServices.slice(0, 3).join(", ") || "changed modules"}`,
    ...(breakingChanges.length > 0
      ? [`Verify callers of modified symbol(s): ${breakingChanges.map((b) => b.symbol).join(", ")}`]
      : []),
  ];

  const trace = [
    `STAGE 1 [GITHUB DIFF]: Fetched live diff for ${params.repo}#${params.prNumber} (${files.length} files, +${totalAdded}/-${totalRemoved} lines).`,
    `STAGE 2 [SYMBOLS]: Detected ${modifiedSymbols.length} touched symbol(s) and ${breakingChanges.length} potential contract change(s).`,
    `STAGE 3 [SCOPE]: Affected repository modules: [${affectedServices.join(", ") || "root"}].`,
    `STAGE 4 [INCIDENTS]: Matched ${matchedIncidents.length} historical pattern(s).`,
    `STAGE 5 [GATE]: Breakdown [Blast=${blastRadiusScore}/40, Incidents=${incidentSimilarityScore}/30, Complexity=${complexityScore}/30] -> Score ${finalScore}/100 -> ${gateStatus}.`,
  ];

  const partial: AssessmentRecord = {
    id: params.id,
    orgId,
    repo: params.repo,
    prNumber: params.prNumber,
    title: params.title,
    author: params.author,
    filePath: files[0]?.filename || "multiple-files",
    sourceType: "github",
    status: "OPEN",
    riskScore: finalScore,
    gateStatus,
    scoringEngineMode: "deterministic-ast-v2",
    riskBreakdown: {
      blastRadiusScore,
      incidentSimilarityScore,
      complexityAndCriticalPathScore: complexityScore,
      totalScore: finalScore,
    },
    mitigationPlan: {
      canaryRolloutPercent: gateStatus === "BLOCK" ? 0 : gateStatus === "WARN" ? 5 : 100,
      requiredApprovers: gateStatus === "PASS" ? 1 : 2,
      requiredTests,
      rollbackSteps: buildRollbackSteps(
        affectedServices[0] || params.repo,
        files[0]?.filename || "PR diff",
        deploymentStrategy
      ),
    },
    matchedCriticalPaths: [],
    blastRadiusHops: Math.max(1, Math.min(4, affectedServices.length)),
    affectedServices: affectedServices.length > 0 ? affectedServices : [params.repo],
    impactedDetails: [],
    traversedEdges: [],
    originService: affectedServices[0] || params.repo,
    originSlaTier: finalScore >= 70 ? "P0" : finalScore >= 40 ? "P1" : "P2",
    matchedIncidents,
    modifiedSymbols: modifiedSymbols.slice(0, 10),
    addedSymbols: Array.from(addedFns).filter((f) => !removedFns.has(f)).slice(0, 6),
    deletedSymbols: Array.from(removedFns).filter((f) => !addedFns.has(f)).slice(0, 6),
    breakingChanges,
    riskyPatterns,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
    unifiedDiff: params.rawDiff.slice(0, 4000),
    recommendation:
      gateStatus === "BLOCK"
        ? `Hold merge on ${params.repo}#${params.prNumber}. High diff risk (${files.length} files, ${breakingChanges.length} contract change(s)). Verify downstream consumers before merging.`
        : gateStatus === "WARN"
        ? `Review carefully before merging ${params.repo}#${params.prNumber}. Touches sensitive paths (${riskyPatterns.join(", ") || "multi-module"}).`
        : `Safe to merge ${params.repo}#${params.prNumber}. Scoped diff with low risk profile.`,
    recommendedTests: requiredTests,
    reasoningTrace: trace,
    deploymentStrategy,
    prCommentMarkdown: "",
    checkRun: {
      name: "DeployGuard AI / Release Risk Gate",
      status: "completed",
      conclusion: "success",
      output: { title: "", summary: "", text: "" },
    },
    updatedAt: "Live GitHub PR",
    createdAtIso: new Date().toISOString(),
  };
  partial.prCommentMarkdown = renderGitHubPrComment(partial);
  partial.checkRun = buildGitHubCheckRun(partial);
  return partial;
}
