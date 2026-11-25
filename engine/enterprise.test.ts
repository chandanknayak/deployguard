import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createApiKeyRecord,
  hasPermission,
  hashPassword,
  matchApiKey,
  signJwt,
  signWebhookPayload,
  verifyJwt,
  verifyPassword,
  verifyWebhookSignature,
} from "./authRbac.ts";
import { matchCriticalFilePatterns, validatePolicyUpdate } from "./policyEngine.ts";
import { SlidingWindowRateLimiter } from "./observability.ts";
import { loadDemoRepoGraph } from "./dependencyGraph.ts";
import { analyzeSandboxPullRequest, synthesizeWithLlmFallback } from "./riskEngine.ts";

test("JWT signing, verification, and tamper rejection", () => {
  const secret = "unit-test-ephemeral-secret-value";
  const token = signJwt(
    { sub: "u1", email: "admin@acme.io", name: "Admin", orgId: "acme-corp", role: "Admin" },
    secret,
    60
  );
  const decoded = verifyJwt(token, secret);
  assert.ok(decoded);
  assert.equal(decoded.orgId, "acme-corp");
  assert.equal(decoded.role, "Admin");

  // Tampered signature must fail
  assert.equal(verifyJwt(`${token}tamper`, secret), null);
  assert.equal(verifyJwt(token, "wrong-secret"), null);
});

test("scrypt password hashing verifies valid passwords and rejects wrong ones", () => {
  const hash = hashPassword("StrongPass#2026");
  assert.ok(hash.startsWith("scrypt$"));
  assert.equal(verifyPassword("StrongPass#2026", hash), true);
  assert.equal(verifyPassword("WrongPass#2026", hash), false);
});

test("RBAC enforces Admin, Release Manager, and Viewer permission boundaries", () => {
  assert.equal(hasPermission("Viewer", "assessments:read"), true);
  assert.equal(hasPermission("Viewer", "assessments:override"), false);
  assert.equal(hasPermission("Viewer", "policies:write"), false);

  assert.equal(hasPermission("Release Manager", "assessments:override"), true);
  assert.equal(hasPermission("Release Manager", "assessments:deploy"), true);
  assert.equal(hasPermission("Release Manager", "policies:write"), false);
  assert.equal(hasPermission("Release Manager", "apikeys:write"), false);

  assert.equal(hasPermission("Admin", "policies:write"), true);
  assert.equal(hasPermission("Admin", "apikeys:write"), true);
});

test("API keys hash securely, authenticate when active, and fail after revocation", () => {
  const { rawKey, record } = createApiKeyRecord({
    orgId: "acme-corp",
    name: "CI Pipeline Key",
    role: "Release Manager",
    createdBy: "admin@acme.io",
  });
  assert.ok(rawKey.startsWith("dg_live_"));
  assert.notEqual(record.keyHash, rawKey);

  const matched = matchApiKey(rawKey, [record]);
  assert.equal(matched?.id, record.id);
  assert.equal(matched?.orgId, "acme-corp");

  record.revoked = true;
  assert.equal(matchApiKey(rawKey, [record]), null);
});

test("Webhook HMAC SHA-256 verification handles valid, invalid, and missing signatures", () => {
  const secret = "whsec_test_secret_123";
  const body = JSON.stringify({ action: "opened", pull_request: { number: 42 } });
  const sig = signWebhookPayload(body, secret);

  assert.equal(verifyWebhookSignature(body, sig, secret), true);
  assert.equal(verifyWebhookSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyWebhookSignature(body, undefined, secret), false);
});

test("Policy critical path matching and threshold validation", () => {
  const matches = matchCriticalFilePatterns("services/payment_service.js", [
    "services/payment_*",
    "services/auth_*",
  ]);
  assert.deepEqual(matches, ["services/payment_*"]);

  assert.equal(validatePolicyUpdate({ warnThreshold: 40, blockThreshold: 70, requiredApprovers: 2 }).valid, true);
  assert.equal(validatePolicyUpdate({ warnThreshold: 80, blockThreshold: 70 }).valid, false);
});

test("LLM fallback gracefully recovers on malformed JSON and timeout while preserving deterministic score", async () => {
  const { graph, fileContents } = loadDemoRepoGraph(path.resolve("demo-repo"));
  const baseCode = fileContents["services/billing_ui.js"];
  const headCode = baseCode.replace('"Invoice ID"', '"Invoice #"');

  const base = analyzeSandboxPullRequest({
    id: "fallback-test",
    orgId: "acme-corp",
    prNumber: 700,
    title: "Header tweak",
    author: "tester",
    filePath: "services/billing_ui.js",
    baseCode,
    headCode,
    graph,
  });

  // Malformed LLM response
  const malformed = await synthesizeWithLlmFallback(base, async () => ({ bad: "schema" }));
  assert.equal(malformed.scoringEngineMode, "deterministic-fallback");
  assert.equal(malformed.riskScore, base.riskScore);

  // Timeout/rejection fallback
  const failed = await synthesizeWithLlmFallback(base, async () => {
    throw new Error("OpenAI 503");
  });
  assert.equal(failed.scoringEngineMode, "deterministic-fallback");
  assert.equal(failed.gateStatus, "PASS");

  // Valid structured LLM output
  const ok = await synthesizeWithLlmFallback(base, async () => ({
    riskScore: 15,
    recommendation: "Clean UI label update with zero downstream contract impact. Approved.",
    additionalTests: ["Verify CSV export column order in unit test"],
  }));
  assert.equal(ok.scoringEngineMode, "llm-synthesized-v2");
  assert.ok(ok.prCommentMarkdown.includes("DeployGuard AI"));
  assert.equal(ok.checkRun.conclusion, "success");
});

test("SlidingWindowRateLimiter enforces quota and rejects excess traffic", () => {
  const limiter = new SlidingWindowRateLimiter(3, 60_000);
  const now = 1_700_000_000_000;
  assert.equal(limiter.check("client-1", now).allowed, true);
  assert.equal(limiter.check("client-1", now + 100).allowed, true);
  assert.equal(limiter.check("client-1", now + 200).allowed, true);
  const blocked = limiter.check("client-1", now + 300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);

  // Different tenant/IP key stays unaffected
  assert.equal(limiter.check("client-2", now + 300).allowed, true);
});
