# Indexly Architecture Implementation Plan

[简体中文](./IMPLEMENTATION_PLAN.md) | English

This plan follows the [overall architecture design](./ARCHITECTURE.en.md) and organizes the work into verifiable product increments. Every phase remains to be implemented; this documentation change adds design documents only.

## 1. Phases and exit criteria

| Phase | Main deliverables | Exit criteria |
| --- | --- | --- |
| P0 Engineering foundation | npm workspaces, TypeScript core packages, contracts package, ESLint, formatting, CI, environment configuration schema, and PostgreSQL local development instructions | A fresh installation can run lint/typecheck/test/build; existing algorithm test cases are migrated; the user's uncommitted work is preserved |
| P1 Identity and data foundation | Better Auth, workspaces/members/invitations, projects/domain verification, Prisma migrations, scoped repositories, auditing, idempotency/Outbox, and a minimal verification Worker | All cross-team access attempts are rejected; the last OWNER is protected; unverified projects cannot trigger crawls; verification task retries and challenge rotation work correctly |
| P2 Reliable crawling | pg-boss Worker, safe HTTP, robots/sitemap processing, frontier, page extraction, leases/fencing, rate limits/budgets, cancellation, and recovery | A real crawl completes against a controlled site; the security matrix passes; the Worker recovers after being killed; duplicate tasks do not create duplicate observations |
| P3 Complete reporting flow | Comparable baselines, field-level validity, events, issue states, publication transactions, Summary, and a dashboard and detail views backed by real data | Three crawls demonstrate “baseline → change → resolution”; partial, failed, and cancelled crawls do not advance the baseline; pages no longer depend on mock data |
| P4 Initial team release | Weekly scheduling, quota administration UI, fairness load tests, complete navigation/mobile interactions, query performance, monitoring, backup recovery, and historical data cleanup | Scheduled triggers are deduplicated; capacity and recovery targets are measured; critical E2E and cross-tenant tests pass; release configuration is complete |
| P5 Later enhancements | Separate requirements for email digests, Webhooks, link graphs/broken-link tracing, public API tokens, rendered crawling, and other enhancements; the health score v1 has already been implemented per ARCHITECTURE.md §9 | Define semantics, resource budgets, and acceptance criteria for each feature separately; do not present these as capabilities already available in the initial release |

P0 → P1 → P2 → P3 → P4 is the main dependency chain for the initial release. Once P1 data contracts are stable, P2 crawling and P3 pure rules/UI can proceed in parallel; full P3 acceptance depends on P2. Authentication verification emails and the minimal verification consumer belong to P1; crawl report emails belong to P5. P2 includes basic crawl quotas and the policy for releasing consumers while waiting for capacity; P4 validates these at production scale.

Do not estimate calendar timelines before validating capacity, staffing, and the deployment environment. Each phase delivers a demonstrable result and verification records. Later phases continue to use the established interfaces and semantics.

## 2. Recommended batches of code changes

1. Add engineering configuration and shared contracts, migrate the core `.mjs` modules, and separately correct URL identity and address classification. Preserve valid tests and add regression coverage for reproduced defects.
2. Establish database migrations and tenant-scoped repositories; add identity, membership, invitations, and permissions. Define partial unique indexes, composite foreign keys, and lock ordering in the migrations.
3. Implement project policy versions and DNS verification. The create-crawl API writes the Run, idempotency record, audit entry, and Outbox event in one transaction.
4. Connect Outbox → pg-boss → Worker → Run state. Verify duplicate delivery, failure recovery, and cancellation before enabling public network access.
5. Implement SafeHttpClient and simulated DNS/network adapters. After security tests pass, add robots, sitemap processing, parsing, frontier, and budgets.
6. Implement frozen observations, comparable baselines, events, issue transitions, and atomic publication. Verify metric definitions and rule-version changes.
7. Gradually connect the dashboard, history, page details, and issue list to authorized queries. Add error states, partial-crawl states, and mobile interactions.
8. Add scheduling, cleanup, operations, and backup procedures. Run tests with production-scale samples and perform end-to-end acceptance for the initial release.
9. Add the `@seo/health-score` pure rule package: compute the health score inside the publication transaction and write it to CrawlSummary; display it via the overview API and dashboard. Degrade to reason-and-coverage display without a score when coverage is insufficient.

Each batch should focus on one independently reviewable behavior. Avoid a large rewrite that introduces the database, queue, crawler, and entire UI at once.

## 3. Required test matrix

| Layer | Key scenarios | Tools/environment |
| --- | --- | --- |
| Pure functions | `/a` versus `/a/`, repeated query parameters, relative-link base URLs, robots directives, canonical candidates, three-valued rules, and the first baseline | Node test runner or the chosen common TypeScript test runner |
| Safe HTTP | Valid fc/fd domain names, private IPv4/IPv6, mapped addresses, hostnames with a trailing dot, mixed DNS answers, rebinding, redirects, TLS, proxies, and response bodies exceeding decompression limits | Injectable DNS/connectors and controlled test servers; the production implementation must not expose a switch that permits arbitrary private-network access |
| Data and tenancy | Composite foreign keys, scoped reads, role revocation, the last OWNER, repeated invitation-token consumption, and cross-tenant cursors and detail requests | Temporary PostgreSQL instances with real migrations |
| Concurrency and recovery | Idempotency keys across projects, two schedulers, a crash before marking an Outbox event as delivered, lease takeover, stale Worker writes, cancellation/publication races, and two workspaces competing for consumers | Two Worker processes, fault injection, and real pg-boss |
| Crawl completeness | Network failures, 429, 404, robots denial, non-HTML responses, parsing failures, exhausted budgets, and known URLs that are no longer linked | A controlled site graph and fixtures with fixed responses |
| Reports and issues | Initial baseline/changes in the second crawl/fixes in the third, UNKNOWN never resolving an issue, anomalies on new URLs, policy resets, suppression, and recurrence | Pure-rule tests plus publication transaction integration tests |
| UI E2E | Login and invitations, workspace switching, starting a crawl, polling, cancellation, retrying failed crawls, filtering and pagination, mobile navigation, and accessible names | Playwright connected to real Web/Worker/DB processes in the test environment |
| Operations | Migration compatibility, graceful shutdown, database outages, cleanup that preserves baseline/Issue references after more than 20 crawls, backup recovery, quotas, and query latency | A staging environment with raw measurements recorded |

Tests must not depend on the stability of real third-party websites. Network security boundary tests use controlled adapters. A small number of real public-network smoke tests run only against explicitly configured verification sites.

## 4. Initial release acceptance demonstration

Prepare a controlled website with a verifiable domain. It must include at least a normal HTML page, a page without a title, a redirecting page, a page blocked by robots, and a sitemap.

1. An OWNER creates a workspace and invites a MEMBER and a VIEWER. A member of another workspace must be denied access to its projects.
2. Create a project and verify DNS. Complete the first crawl; the UI shows an established baseline and current issues supported by evidence.
3. Change one page to return 404, change another page to noindex, and change a title. The second crawl shows the corresponding events, the number of distinct affected pages, and issue evidence.
4. Fix those issues. The third crawl records the correct resolution transitions. Changing a title again produces a change event without creating an additional open issue.
5. Deliberately cause a timeout or lower the page budget. Confirm that partial results can be inspected without incorrectly advancing the baseline or issue states.
6. Terminate the Worker during a crawl and restart it. Then test cancellation and duplicate triggers. Confirm that no duplicate reports appear and that tasks can reach a terminal state.
7. Demonstrate deduplication of weekly schedule slots, skipping stale schedule occurrences, monitoring alerts, historical data cleanup, and a backup recovery.

## 5. Design decisions and future changes

| Established decision | Trigger for reassessment |
| --- | --- |
| Next.js plus a separate Worker | If the Web and jobs need different runtime environments, split their deployments while preserving the contracts |
| PostgreSQL + pg-boss + Outbox | Measurements show that contention between queue work and business queries persistently affects the targets |
| One exact hostname per project | If the product explicitly requires www/multiple-subdomain projects, add domain authorization and cross-host scheduling designs |
| HTTP crawling | Customer pages depend primarily on JavaScript, and the resource cost of rendering is acceptable |
| PARTIAL does not publish formal changes | If users need alerts from partial results, first design per-field baselines and deduplication to prevent false issue resolutions |
| Health score v1 (implemented; see ARCHITECTURE.md §9) | Adjusting weights, saturation rate, coverage gate, or aggregation semantics requires bumping scoreVersion; historical scores keep their original interpretation |
| Application-level tenant isolation plus data constraints | Security or scale requirements call for an additional database-level safeguard; introduce and validate RLS |

Select the deployment provider, authentication email provider, and specific dependency patch versions during their respective phases. If capacity, the role model, or scope changes, update the architecture documents and affected acceptance criteria before implementing the changes.
