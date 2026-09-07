"use client";

/** Typed fetch helpers for the dashboard. 401 redirects to login. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    error?: { code: string; message: string };
  } | null;
  if (response.status === 401) {
    window.location.href = "/login";
    throw new ApiError(401, "UNAUTHENTICATED", "redirecting to login");
  }
  if (!response.ok || !body?.data) {
    throw new ApiError(
      response.status,
      body?.error?.code ?? "UNKNOWN",
      body?.error?.message ?? `request failed (${response.status})`,
    );
  }
  return body.data;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}

export interface ProjectSummary {
  id: string;
  hostname: string;
  displayName: string | null;
  verificationStatus: string;
  archivedAt: string | null;
  verification: {
    status: string;
    verifiedAt: string | null;
    expiresAt: string | null;
    valid: boolean;
    lastError: string | null;
  } | null;
  activeChallenge: { recordName: string; recordValue: string | null } | null;
}

export interface HealthComponent {
  ruleKey: string;
  openIssues: number;
  rate: number;
  deduction: number;
  maxDeduction: number;
}

export interface OverviewHealth {
  score: number | null;
  scoreVersion: number | null;
  coverage: number | null;
  reason: string | null;
  components: HealthComponent[] | null;
}

export interface Overview {
  project: { id: string; hostname: string; displayName: string | null; verificationStatus: string };
  latestPublishedRunId: string | null;
  publishedAt: string | null;
  comparisonMode: string;
  summary: {
    urlsCrawled: number;
    changesTotal: number;
    changesCritical: number;
    changesWarning: number;
    changesInfo: number;
    affectedPages: number;
    issuesOpen: number;
    issuesResolvedThisRun: number;
  } | null;
  health: OverviewHealth | null;
  openIssues: number;
  activeRun: { id: string; status: string; pagesDone: number; pagesKnown: number } | null;
  lastTerminalRun: { id: string; status: string; failureCode: string | null; createdAt: string } | null;
  firstBaselinePending: boolean;
}

export interface ChangeItem {
  id: string;
  type: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  before: string | number | null;
  after: string | number | null;
  url: string;
  createdAt: string;
}

export interface IssueItem {
  id: string;
  ruleKey: string;
  state: string;
  occurrence: number;
  evidence: Record<string, string | number | null> | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
  url: string;
}

export interface MemberItem {
  id: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string; email: string; emailVerified: boolean };
}

export interface InvitationItem {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface InviteCreated {
  invitationId: string;
  token: string;
  expiresAt: string;
  email: string;
  role: string;
}

export interface CrawlItem {
  id: string;
  status: string;
  completeness: string;
  comparisonMode: string;
  trigger: string;
  failureCode: string | null;
  pagesDone: number;
  pagesKnown: number;
  createdAt: string;
  finishedAt: string | null;
  publishedAt: string | null;
}
