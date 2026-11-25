import type { AssessmentRecord } from "./riskEngine.ts";

export interface GitHubCheckRunPayload {
  name: string;
  status: "completed";
  conclusion: "success" | "neutral" | "failure";
  output: {
    title: string;
    summary: string;
    text: string;
  };
}

export function renderGitHubPrComment(assessment: AssessmentRecord): string {
  const icon =
    assessment.gateStatus === "BLOCK"
      ? "🛑"
      : assessment.gateStatus === "WARN"
      ? "⚠️"
      : "✅";

  const breakdown = assessment.riskBreakdown;
  const breakingSection =
    assessment.breakingChanges.length > 0
      ? assessment.breakingChanges
          .map((b) => `- **${b.kind}** (\`${b.symbol}\`): ${b.detail}`)
          .join("\n")
      : "- None detected.";

  const incidentSection =
    assessment.matchedIncidents.length > 0
      ? assessment.matchedIncidents
          .map(
            (i) =>
              `- **${i.id}** (${i.severity}, ${Math.round(i.similarity * 100)}% match, ${i.durationMinutes}m outage): ${i.title}`
          )
          .join("\n")
      : "- No similar historical incidents matched.";

  const testsSection = assessment.mitigationPlan.requiredTests
    .map((t) => `- [ ] ${t}`)
    .join("\n");

  const rollbackSection = assessment.mitigationPlan.rollbackSteps
    .map((step, i) => `${i + 1}. ${step}`)
    .join("\n");

  return [
    `## ${icon} DeployGuard AI · Release Risk Gate: **${assessment.gateStatus}** (${assessment.riskScore}/100)`,
    "",
    `**Repository:** \`${assessment.repo}\` · **PR:** \`#${assessment.prNumber}\` · **File:** \`${assessment.filePath}\` · **Engine:** \`${assessment.scoringEngineMode}\``,
    "",
    "### Explainable Risk Breakdown",
    "| Risk Pillar | Score | Weight | Signal |",
    "|---|---:|---:|---|",
    `| Blast Radius | **${breakdown.blastRadiusScore}** | / 40 | ${assessment.affectedServices.length} service(s), ${assessment.blastRadiusHops} hop(s) |`,
    `| Historical Incident Recall | **${breakdown.incidentSimilarityScore}** | / 30 | ${assessment.matchedIncidents.length} matching postmortem(s) |`,
    `| Complexity & Critical Path | **${breakdown.complexityAndCriticalPathScore}** | / 30 | +${assessment.linesAdded}/-${assessment.linesRemoved} lines, ${assessment.breakingChanges.length} breaking change(s) |`,
    "",
    "### AST Contract Findings",
    breakingSection,
    "",
    "### Historical Incident Citations",
    incidentSection,
    "",
    "### Actionable Mitigation Plan",
    `- **Recommended Rollout:** ${assessment.deploymentStrategy} (${assessment.mitigationPlan.canaryRolloutPercent}% initial traffic)`,
    `- **Required Approvers:** ${assessment.mitigationPlan.requiredApprovers}`,
    "",
    "**Required Verification Checks:**",
    testsSection,
    "",
    "**Rollback Playbook:**",
    rollbackSection,
  ].join("\n");
}

export function buildGitHubCheckRun(assessment: AssessmentRecord): GitHubCheckRunPayload {
  const conclusion: GitHubCheckRunPayload["conclusion"] =
    assessment.gateStatus === "BLOCK"
      ? "failure"
      : assessment.gateStatus === "WARN"
      ? "neutral"
      : "success";

  return {
    name: "DeployGuard AI / Release Risk Gate",
    status: "completed",
    conclusion,
    output: {
      title: `${assessment.gateStatus} · Risk Score ${assessment.riskScore}/100 (${assessment.affectedServices.length} affected services)`,
      summary: assessment.recommendation,
      text: renderGitHubPrComment(assessment),
    },
  };
}
