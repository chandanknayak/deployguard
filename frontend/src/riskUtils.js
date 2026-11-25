export function deriveGateStatus(score, threshold = 70) {
  if (score >= threshold) return "BLOCK";
  if (score >= 40) return "WARN";
  return "PASS";
}

export function calculateSimulatedScore({
  filesChanged,
  blastHops,
  pastIncidents,
  touchesCore,
}) {
  const raw =
    filesChanged * 3.5 +
    blastHops * 11 +
    pastIncidents * 16 +
    (touchesCore ? 18 : 0);
  return Math.min(99, Math.max(5, Math.round(raw)));
}

export function filterAssessments(assessments, filterStatus, searchQuery) {
  const q = searchQuery.trim().toLowerCase();
  return assessments.filter((item) => {
    const matchesStatus = filterStatus === "ALL" || item.gateStatus === filterStatus;
    const matchesQuery =
      !q ||
      item.title.toLowerCase().includes(q) ||
      item.repo.toLowerCase().includes(q) ||
      String(item.prNumber).includes(q);
    return matchesStatus && matchesQuery;
  });
}

export function computeMetrics(assessments) {
  const blockedItems = assessments.filter((a) => a.gateStatus === "BLOCK");
  const blocked = blockedItems.length;
  const avgScore = assessments.length
    ? Math.round(assessments.reduce((acc, a) => acc + a.riskScore, 0) / assessments.length)
    : 0;
  const maxHops = assessments.reduce((max, a) => Math.max(max, a.blastRadiusHops), 0);

  let incidentsPrevented = 0;
  let mttrMinutesSaved = 0;
  for (const item of blockedItems) {
    const matched = Array.isArray(item.matchedIncidents) ? item.matchedIncidents : [];
    if (matched.length > 0) {
      incidentsPrevented += matched.length;
      for (const inc of matched) {
        mttrMinutesSaved += Number(inc.durationMinutes || 35);
      }
    } else {
      incidentsPrevented += 1;
      mttrMinutesSaved += 45;
    }
  }

  return {
    blocked,
    avgScore,
    maxHops,
    total: assessments.length,
    incidentsPrevented,
    mttrMinutesSaved,
  };
}
