# DeployGuard AI — Enterprise Release Risk & Change-Impact Gate Platform

DeployGuard AI evaluates pull requests **before merge** by combining real AST symbol-diff analysis (`acorn`), reverse service-dependency graph blast-radius traversal, historical incident recall, and configurable per-repository release policies.

---

## Architecture Overview

```mermaid
flowchart LR
  GH[GitHub PR / Webhook<br/>HMAC-SHA256] -->|POST /api/v1/webhook/github| API[DeployGuard Express API<br/>Rate Limiter · JWT/API Key · RBAC]
  UI[Executive Web Console<br/>React + Vite + Tailwind] -->|Bearer JWT| API
  API --> DIFF[Unified Diff Parser]
  DIFF --> AST[Acorn AST Analyzer<br/>Breaking API & Symbol Diff]
  AST --> GRAPH[Service Dependency Graph<br/>BFS Blast Radius & SLA Tiers]
  AST --> INC[Historical Incident Matcher<br/>Root-Cause Citations]
  GRAPH --> ENGINE[3-Pillar Risk Engine<br/>+ Strict LLM Fallback]
  INC --> ENGINE
  ENGINE --> POLICY[Per-Repo Policy Gate<br/>PASS / WARN / BLOCK]
  POLICY --> REPORT[GitHub PR Comment &<br/>Check Run Generator]
  API --> OBS[/healthz · /readyz · /metrics<br/>Structured JSON Logs]
```

---

## Core Enterprise Capabilities

- **Multi-Tenant Isolation & RBAC**: Organization-scoped tenants (`Organization -> Repositories -> Assessments -> Policies -> Audit Log`) with HS256 JWT sessions, `scrypt` password hashing, SHA-256 hashed CI/CD API keys (`X-API-Key`), and role enforcement (`Admin`, `Release Manager`, `Viewer`).
- **Explainable 3-Pillar Risk Engine**:
  1. **Blast Radius Score (0–40)** — AST exported-symbol extraction + reverse BFS dependency graph hops & P0/P1 SLA tiers.
  2. **Historical Incident Similarity (0–30)** — Root-cause recall with similarity scores and outage duration (MTTR saved).
  3. **Change Complexity & Critical Path (0–30)** — Diff churn, breaking signature detection, and per-repo critical-path glob rules.
  4. **Deterministic Fallback Guarantee** — Validates structured LLM output strictly and falls back automatically to deterministic scoring on timeout, error, or schema mismatch.
- **GitHub PR Comment & Check Run Renderer**: Generates executive Markdown reports with 3-pillar scores, canary rollout %, required approvers, required tests, and rollback playbooks.
- **Live PR Sandbox & Real GitHub Scanner**: Includes a real 7-service JavaScript microservice repo (`demo-repo/`) to simulate breaking changes end-to-end, plus live scanning for public GitHub PRs.
- **Production Security & Observability**: Sliding-window per-IP / per-API-key rate limiting on `/api/v1/*`, constant-time GitHub HMAC-SHA256 webhook verification, strict `ALLOWED_ORIGINS` CORS, `X-Request-ID` structured JSON request logs, `/healthz`, `/readyz`, and Prometheus `/metrics`.

---

## 5-Minute Local Setup

### Prerequisites
- Node.js 22+

### 1. Configure Environment
```bash
cp .env.example .env
```
Recommended production environment variables:
- `JWT_SECRET` — 32+ byte random secret for signing HS256 JWT tokens
- `GITHUB_WEBHOOK_SECRET` — shared secret configured in GitHub Webhooks (`X-Hub-Signature-256`)
- `ALLOWED_ORIGINS` — comma-separated list of trusted frontend origins (e.g. `https://deployguard.yourdomain.com`)
- `RATE_LIMIT_MAX` — requests per minute per IP or API key on `/api/v1/*` (default `180`)
- `OPENAI_API_KEY` *(optional)* — enables LLM executive synthesis with automatic deterministic fallback

### 2. Install, Test & Run
```bash
npm install
npm test
npm run build
npm start
```
The platform serves both the API and executive web console on `http://localhost:3000`.

---

## Production Deployment Guide

### Option A: Single-Service Container / Render / Fly.io
1. Set build command: `npm install && npm run build`
2. Set start command: `npm start` (runs `node server.ts` on `PORT`)
3. Configure health checks:
   - Liveness probe: `GET /healthz`
   - Readiness probe: `GET /readyz`
   - Prometheus scrape: `GET /metrics`

### Option B: Split Frontend (Vercel) + Backend API (Render)
1. Deploy `frontend/` to Vercel with `VITE_API_BASE_URL=https://api.your-deployguard-domain.com`.
2. Deploy the root Node.js API service to Render with `ALLOWED_ORIGINS=https://your-vercel-domain.vercel.app`.

---

## Client Onboarding Guide (GitHub Webhook + API Keys)

1. **Select Organization & Role**: Sign in as an organization `Admin` (`Account / Sign In` in the top bar).
2. **Configure Repository Policies**: Open **Audit & Policy**, select a repository, and configure `BLOCK` / `WARN` thresholds, required approvers, and critical-path globs (e.g. `services/payment_*, services/auth_*`).
3. **Provision Scoped CI/CD API Key**: Under **Tenant API Keys**, issue a key scoped to `Release Manager` or `Viewer`. Pass it from CI pipelines via `X-API-Key: dg_live_...`.
4. **Connect GitHub Webhooks**:
   - Payload URL: `https://<your-domain>/api/v1/webhook/github`
   - Content type: `application/json`
   - Secret: matches `GITHUB_WEBHOOK_SECRET`
   - Events: `Pull requests`
   - Click **Test Webhook HMAC** in **Audit & Policy** to verify constant-time signature validation end-to-end.

---

## Automated Verification Suite

```bash
# Run unit & integration tests (AST engine, graph BFS, JWT/RBAC, API keys, HMAC webhooks, policy globs, LLM fallback, rate limiter)
npm test

# Lint and build production bundle
npm run lint
npm run build
```
