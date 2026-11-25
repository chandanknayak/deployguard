import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadDemoRepoGraph, computeBlastRadius } from "./dependencyGraph.ts";
import { analyzeSandboxPullRequest } from "./riskEngine.ts";

const DEMO_REPO_DIR = path.resolve("demo-repo");

test("dependency graph parses all 7 demo-repo services and real cross-service edges", () => {
  const { graph } = loadDemoRepoGraph(DEMO_REPO_DIR);
  assert.equal(graph.nodes.length, 7);
  assert.ok(graph.edges.length >= 6);

  const blast = computeBlastRadius(graph, "services/payment_service.js", ["chargeCard"]);
  assert.equal(blast.originService, "payment-service");
  assert.equal(blast.hasP0Impact, true);
  assert.ok(blast.affectedServices.includes("order-service"));
  assert.ok(blast.affectedServices.includes("subscription-billing"));
});

test("breaking chargeCard signature & removing idempotency guard triggers BLOCK with P0 blast radius and incident match", () => {
  const { graph, fileContents } = loadDemoRepoGraph(DEMO_REPO_DIR);
  const baseCode = fileContents["services/payment_service.js"];
  const tamperedCode = baseCode
    .replace(
      "export async function chargeCard(amount, currency, idempotencyKey, retryPolicy = { maxAttempts: 3 }) {",
      "export async function chargeCard(amount, currency) {"
    )
    .replace(
      `  if (!idempotencyKey) {\n    throw new Error("Missing idempotencyKey: refusing duplicate debit risk");\n  }\n`,
      ""
    )
    .replace("computeBackoff(1, 200, 0.25)", "computeBackoff(4, 1000, 0)");

  const result = analyzeSandboxPullRequest({
    id: "test-pr-block",
    prNumber: 501,
    title: "Remove idempotencyKey param and increase retry backoff",
    author: "dev-test",
    filePath: "services/payment_service.js",
    baseCode,
    headCode: tamperedCode,
    graph,
  });

  assert.equal(result.gateStatus, "BLOCK");
  assert.ok(result.riskScore >= 70, `Expected score >= 70, got ${result.riskScore}`);
  assert.ok(result.breakingChanges.some((b) => b.kind === "SIGNATURE_CHANGED"));
  assert.ok(result.breakingChanges.some((b) => b.kind === "GUARD_REMOVED"));
  assert.ok(result.affectedServices.includes("order-service"));
  assert.ok(result.affectedServices.includes("subscription-billing"));
  assert.ok(result.matchedIncidents.length >= 1);
});

test("safe formatting edit in leaf billing_ui.js triggers PASS with zero breaking changes", () => {
  const { graph, fileContents } = loadDemoRepoGraph(DEMO_REPO_DIR);
  const baseCode = fileContents["services/billing_ui.js"];
  const safeCode = baseCode.replace(
    '["Invoice ID", "Date", "Customer", "Amount", "Status"]',
    '["Invoice #", "Issued Date", "Customer Name", "Amount", "Status"]'
  );

  const result = analyzeSandboxPullRequest({
    id: "test-pr-pass",
    prNumber: 502,
    title: "Improve invoice CSV column header labels",
    author: "a.verma",
    filePath: "services/billing_ui.js",
    baseCode,
    headCode: safeCode,
    graph,
  });

  assert.equal(result.gateStatus, "PASS");
  assert.ok(result.riskScore < 40, `Expected score < 40, got ${result.riskScore}`);
  assert.equal(result.breakingChanges.length, 0);
  assert.equal(result.impactedDetails.length, 0);
});

test("invalid JavaScript syntax in PR is caught deterministically as CRITICAL BLOCK", () => {
  const { graph, fileContents } = loadDemoRepoGraph(DEMO_REPO_DIR);
  const baseCode = fileContents["services/billing_ui.js"];
  const brokenSyntax = "export function formatInvoiceCsv(rows { return ;;;";

  const result = analyzeSandboxPullRequest({
    id: "test-pr-syntax",
    prNumber: 503,
    title: "Broken syntax test",
    author: "dev-test",
    filePath: "services/billing_ui.js",
    baseCode,
    headCode: brokenSyntax,
    graph,
  });

  assert.equal(result.gateStatus, "BLOCK");
  assert.ok(result.riskScore >= 95);
  assert.ok(result.breakingChanges.some((b) => b.kind === "SYNTAX_ERROR"));
});
