import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveGateStatus,
  calculateSimulatedScore,
  filterAssessments,
  computeMetrics,
} from "./riskUtils.js";

test("deriveGateStatus classifies scores into PASS, WARN, BLOCK", () => {
  assert.equal(deriveGateStatus(0), "PASS");
  assert.equal(deriveGateStatus(39), "PASS");
  assert.equal(deriveGateStatus(40), "WARN");
  assert.equal(deriveGateStatus(69), "WARN");
  assert.equal(deriveGateStatus(70), "BLOCK");
  assert.equal(deriveGateStatus(95), "BLOCK");
});

test("calculateSimulatedScore clamps between 5 and 99", () => {
  assert.equal(
    calculateSimulatedScore({
      filesChanged: 1,
      blastHops: 0,
      pastIncidents: 0,
      touchesCore: false,
    }),
    5
  );
  assert.equal(
    calculateSimulatedScore({
      filesChanged: 8,
      blastHops: 3,
      pastIncidents: 1,
      touchesCore: true,
    }),
    95
  );
  assert.equal(
    calculateSimulatedScore({
      filesChanged: 40,
      blastHops: 6,
      pastIncidents: 5,
      touchesCore: true,
    }),
    99
  );
});

test("filterAssessments filters by gateStatus and searchQuery", () => {
  const sample = [
    { id: "1", repo: "acme/payments-core", prNumber: 418, title: "Settlement lock", gateStatus: "BLOCK", riskScore: 84, blastRadiusHops: 4 },
    { id: "2", repo: "acme/billing-ui", prNumber: 425, title: "CSV export", gateStatus: "PASS", riskScore: 18, blastRadiusHops: 1 },
  ];
  assert.equal(filterAssessments(sample, "BLOCK", "").length, 1);
  assert.equal(filterAssessments(sample, "ALL", "billing").length, 1);
  assert.equal(filterAssessments(sample, "ALL", "425").length, 1);
  assert.equal(filterAssessments(sample, "WARN", "").length, 0);
});

test("computeMetrics computes totals, blocked count, avgScore, maxHops, and MTTR saved", () => {
  const sample = [
    {
      gateStatus: "BLOCK",
      riskScore: 84,
      blastRadiusHops: 4,
      matchedIncidents: [{ id: "INC-1", durationMinutes: 40 }],
    },
    { gateStatus: "WARN", riskScore: 46, blastRadiusHops: 2 },
    { gateStatus: "PASS", riskScore: 18, blastRadiusHops: 1 },
  ];
  assert.deepEqual(computeMetrics(sample), {
    blocked: 1,
    avgScore: 49,
    maxHops: 4,
    total: 3,
    incidentsPrevented: 1,
    mttrMinutesSaved: 40,
  });
});
