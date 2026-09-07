# Indexly — SEO Change Monitor

A focused MVP for monitoring meaningful technical SEO changes between website crawls.

## Architecture and implementation plan

- [整体架构设计](docs/ARCHITECTURE.md): team workspaces, system boundaries, crawl safety, data model, APIs, and report semantics.
- [分阶段实施计划](docs/IMPLEMENTATION_PLAN.md): delivery sequence, dependencies, and acceptance tests.
- [本地开发指南](docs/LOCAL_DEV.md): toolchain, scripts, local database, and current implementation status.
- [部署与运维手册](docs/OPERATIONS.md): topology, configuration, health probes, backups, retention, quotas.

Progress: **P0–P4 are complete** — the first-version feature set is closed (identity, workspaces, verified projects, safe crawling, the report loop, weekly scheduling, quotas, retention cleanup, health probes, and deployment assets). The first P5 enhancement — the **site health score v1** — is also implemented (formula, coverage gate, and versioning per [ARCHITECTURE.md §9](docs/ARCHITECTURE.md)). Remaining P5 items (email digests, webhooks, link graph, rendered crawling) are intentionally out of the first version.

## Repository layout

```text
app/                          Next.js App Router: dashboard prototype, auth pages, /api/v1 routes
server/                       auth, api helpers, repositories, services, workers
packages/contracts/           Shared DTOs, enums, error codes, env schema (Zod)
packages/crawler/             URL identity v1, scope checks, literal address classification
packages/change-detection/    Pure snapshot comparison and summary
packages/issue-rules/         Pure three-valued issue rule evaluation
packages/health-score/        Pure site health score v1 (weights, coverage gate, versioning)
packages/db/                  Prisma schema, migrations, client singleton
tests/unit/                   Unit tests (Node test runner, no database required)
tests/integration/            PostgreSQL-backed tests (tenancy, members, invitations, verification)
```

Packages are npm workspaces exporting TypeScript source directly. Pure rules import nothing from Next.js, Prisma, the queue, or network code.

## Implemented so far

**P0 — engineering foundation**

- TypeScript workspace packages, ESLint (next/core-web-vitals + next/typescript), Prettier, CI
- URL identity v1 with explicit tracking-parameter stripping; literal SSRF checks (localhost variants, private/special IPv4 & IPv6 incl. mapped/NAT64/6to4, credentials/port/protocol rules)
- Snapshot comparison, severity classification, summary generation

**P1 — identity & data foundation**

- Better Auth: email+password with mandatory email verification, database sessions (verification emails print to the dev console)
- Workspaces, roles (OWNER/ADMIN/MEMBER/VIEWER), one-time invitations (SHA-256 token hashes, 72h expiry, verified-email match, atomic consume)
- Last-owner protection, cross-workspace isolation (404 for outsiders), audit log with redaction, cursor pagination, idempotency helper
- Projects with policy v1 and DNS TXT domain verification (30-day validity, challenge rotation fencing, retry/backoff via the transactional Outbox)
- `/api/v1` routes for workspaces/members/invitations/projects/verification/audit-logs plus login/register/accept-invitation pages

**P2 — reliable crawling**

- Safe fetch pipeline: per-hop literal URL policy, exact-hostname scope, DNS resolution with every resolved address required to be public, redirect chains (≤5 hops, out-of-scope recorded not followed), body and byte budgets — with injectable DNS/transport for tests and a production node transport that pins validated IPs into the TCP connection (TLS SNI/Host keep the original hostname)
- robots.txt parsing/matching (RFC 9309 core), sitemap index/urlset walking with document/candidate budgets, HTML extraction (title, description, canonical candidates, robots index synthesis incl. X-Robots-Tag, same-host links)
- Crawl executor: conservative robots policy (401/403 deny, 5xx retry), seeds (entry + sitemaps + monitored pages), persistent frontier with retries/backoff, page/duration/byte budgets, hostname rate pacing, lease fencing, cooperative cancellation, crash recovery after lease expiry
- Crawl API: create (Idempotency-Key, verification guard, single active run per project), cancel, list, detail

**P3 — report loop**

- Change events with field-validity gating: only KNOWN, comparable fields produce content events; error pages and redirect sources never do; "not observed this run" is never a deletion event; URL_ADDED only when a baseline exists
- Issue rules as a pure package (`@seo/issue-rules`): HTTP 404/410/5xx, noindex on expected-indexable pages, missing title, canonical invalid/conflict — each returning PRESENT/ABSENT/UNKNOWN with evidence; UNKNOWN never flips state
- Issue lifecycle: OPEN ↔ RESOLVED with occurrence increments on re-open, append-only transition history with idempotency keys, evidence freshness tracking
- Publish transaction: FULL runs freeze (FINALIZING), select the comparable baseline (latest published FULL run on the same immutable policy), and atomically write events + issue transitions + summary + `publishedAt`; PARTIAL/CANCELLED runs complete unpublished and never advance the baseline
- Report APIs: overview, changes (published runs only), issues, pages
- Real dashboard: workspace/project switching, DNS verification guidance, published metrics, change cards, issue table, crawl history with run/cancel and live polling — no mock data
- Site health score v1 (`@seo/health-score`): computed inside the publish transaction and stored on the summary; displayed with grade, coverage, and per-rule deduction breakdown; suppressed with an explicit reason when decisive coverage is below 50%

The production fetch worker (P2) must still resolve DNS and re-run the SSRF check against every resolved address, including after each redirect.

## Run locally

Requires Node.js 24+.

```bash
npm install
npm run db:up      # terminal 1: disposable embedded PostgreSQL 17
npm run db:migrate # terminal 2: create schema
npm run dev        # terminal 2: web app on http://localhost:3000
npm run worker     # terminal 3 (optional): verification worker
```

All quality gates (also run by CI on every push and pull request):

```bash
npm run typecheck          # tsc --noEmit across app, packages, and tests
npm run lint               # ESLint
npm test                   # unit tests (no database needed)
npm run test:integration   # migrations + PostgreSQL integration tests
npm run build              # Next.js production build
npm run format             # Prettier
```

Copy `.env.example` to `.env` for the dev server; `parseEnv` in `packages/contracts` validates the schema and enforces production-only variables.

## Hardening pass (2026-09-07)

- **Content decoding**: the production transport now streams gzip/deflate/brotli-decoded bodies (compressed bytes capped separately from the decompressed cap); corrupt or oversized payloads map to the existing fetch outcomes.
- **Protocol fallback**: robots probing tries HTTPS first and falls back to HTTP:80 only on network-level failure or an HTTPS 404/410 (plain-HTTP-only sites); an HTTP answer is never re-asked over HTTPS, and authoritative 401/403 refusals never fall back.
- **CSRF & brute-force defence**: `/api/v1` state-changing requests are Origin-checked (cross-site browser requests rejected); `/api/auth` sign-in/sign-up/verification endpoints are rate-limited per IP with a sliding window (in-memory; a shared store is required for multi-process auth).
- **Member management UI**: workspace members/invitations panel with role changes, removal (last-owner protected server-side), one-time invitations with single-display shareable link, and revocation of pending invites.
