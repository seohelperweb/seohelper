"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  Bell,
  Check,
  CircleHelp,
  Globe2,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  Play,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  type ChangeItem,
  type CrawlItem,
  type IssueItem,
  type Overview,
  type ProjectSummary,
  type WorkspaceSummary,
} from "./dashboard/client";
import { MembersPanel } from "./dashboard/members-panel";
import { healthGrade } from "@seo/health-score";
import type { HealthGrade } from "@seo/health-score";

const CHANGE_LABELS: Record<string, string> = {
  HTTP_STATUS_CHANGED: "HTTP 状态变化",
  ROBOTS_CHANGED: "索引指令变化",
  CANONICAL_CHANGED: "Canonical 变化",
  TITLE_CHANGED: "标题变化",
  META_DESCRIPTION_CHANGED: "描述变化",
  INTERNAL_LINKS_CHANGED: "内链数量变化",
  URL_ADDED: "新页面纳入监控",
};

const ISSUE_LABELS: Record<string, string> = {
  http_4xx_5xx: "HTTP 404/410/5xx",
  noindex_on_indexable: "预期可索引页被 noindex",
  missing_title: "HTML 缺少标题",
  canonical_conflict: "canonical 无效或多值冲突",
};

const GRADE_LABELS: Record<HealthGrade, string> = {
  good: "优秀",
  fair: "良好",
  poor: "需关注",
  critical: "较差",
};

export default function Dashboard() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const [crawls, setCrawls] = useState<CrawlItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newHostname, setNewHostname] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [schedule, setSchedule] = useState<{ enabled: boolean; nextRunAt: string | null } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const currentWorkspace = workspaces.find((w) => w.id === workspaceId) ?? null;

  const loadProjectData = useCallback(async (wsId: string, pId: string) => {
    const base = `/api/v1/workspaces/${wsId}/projects/${pId}`;
    const [overviewData, changesData, issuesData, crawlsData, scheduleData] = await Promise.all([
      api<Overview>(`${base}/overview`),
      api<{ items: ChangeItem[] }>(`${base}/changes`),
      api<{ items: IssueItem[] }>(`${base}/issues`),
      api<{ items: CrawlItem[] }>(`${base}/crawls?limit=10`),
      api<{ enabled: boolean; nextRunAt: string | null }>(`${base}/schedule`),
    ]);
    setOverview(overviewData);
    setChanges(changesData.items);
    setIssues(issuesData.items);
    setCrawls(crawlsData.items);
    setSchedule(scheduleData);
    if (pollTimer.current) clearTimeout(pollTimer.current);
    if (overviewData.activeRun) {
      pollTimer.current = setTimeout(() => void loadProjectData(wsId, pId), 3000);
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const data = await api<{ items: WorkspaceSummary[] }>("/api/v1/workspaces");
    setWorkspaces(data.items);
    const stored = localStorage.getItem("indexly.workspace");
    const selected = data.items.find((w) => w.id === stored) ?? data.items[0];
    if (selected) {
      setWorkspaceId(selected.id);
      localStorage.setItem("indexly.workspace", selected.id);
    }
  }, []);

  const loadProjects = useCallback(async (wsId: string) => {
    const data = await api<{ items: ProjectSummary[] }>(`/api/v1/workspaces/${wsId}/projects`);
    setProjects(data.items);
    const stored = localStorage.getItem(`indexly.project.${wsId}`);
    const selected = data.items.find((p) => p.id === stored) ?? data.items[0];
    if (selected) {
      setProjectId(selected.id);
    } else {
      setProjectId(null);
      setOverview(null);
      setChanges([]);
      setIssues([]);
      setCrawls([]);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(() => undefined);
  }, [loadWorkspaces]);

  useEffect(() => {
    if (workspaceId) void loadProjects(workspaceId).catch(() => undefined);
  }, [workspaceId, loadProjects]);

  useEffect(() => {
    if (workspaceId && projectId) void loadProjectData(workspaceId, projectId).catch(() => undefined);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [workspaceId, projectId, loadProjectData]);

  const createWorkspace = async () => {
    if (!newWorkspaceName.trim()) return;
    setBusy(true);
    try {
      const created = await api<WorkspaceSummary>("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: newWorkspaceName.trim() }),
      });
      setNewWorkspaceName("");
      await loadWorkspaces();
      setWorkspaceId(created.id);
      setToast(`工作区「${created.name}」已创建`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const createProject = async () => {
    if (!workspaceId || !newHostname.trim()) return;
    setBusy(true);
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/projects`, {
        method: "POST",
        body: JSON.stringify({ hostname: newHostname.trim() }),
      });
      setNewHostname("");
      await loadProjects(workspaceId);
      setToast("项目已创建，请先完成域名验证");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const requestVerification = async () => {
    if (!workspaceId || !projectId) return;
    setBusy(true);
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/verification`, { method: "POST" });
      await loadProjects(workspaceId);
      await loadProjectData(workspaceId, projectId);
      setToast("已发起验证：添加 TXT 记录后，后台会自动重试检查");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "发起验证失败");
    } finally {
      setBusy(false);
    }
  };

  const runCrawl = async () => {
    if (!workspaceId || !projectId) return;
    setBusy(true);
    try {
      await api<unknown>(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/crawls`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      setToast("抓取已开始");
      await loadProjectData(workspaceId, projectId);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "抓取启动失败");
    } finally {
      setBusy(false);
    }
  };

  const selectWorkspace = (id: string) => {
    setWorkspaceId(id);
    setMenuOpen(false);
    localStorage.setItem("indexly.workspace", id);
  };

  const selectProject = (id: string) => {
    setProjectId(id);
    setMenuOpen(false);
    if (workspaceId) localStorage.setItem(`indexly.project.${workspaceId}`, id);
  };

  const toggleSchedule = async () => {
    if (!workspaceId || !projectId) return;
    setBusy(true);
    try {
      const updated = await api<{ enabled: boolean; nextRunAt: string | null }>(
        `/api/v1/workspaces/${workspaceId}/projects/${projectId}/schedule`,
        { method: "PUT", body: JSON.stringify({ enabled: !(schedule?.enabled ?? false) }) },
      );
      setSchedule(updated);
      setToast(
        updated.enabled
          ? `每周抓取已启用，下次运行 ${updated.nextRunAt ? new Date(updated.nextRunAt).toLocaleString() : "待定"}`
          : "每周抓取已停用",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "调度更新失败");
    } finally {
      setBusy(false);
    }
  };

  const summary = overview?.summary ?? null;
  const health = overview?.health ?? null;
  const healthScore = health?.score ?? null;
  const healthGradeValue = healthScore !== null ? healthGrade(healthScore) : null;
  const healthCoveragePct =
    health?.coverage !== null && health?.coverage !== undefined ? Math.round(health.coverage * 100) : null;
  const healthDeductions = (health?.components ?? []).filter((component) => component.deduction > 0);

  return (
    <div className={`app-shell${menuOpen ? " menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">
            <Activity size={19} />
          </div>
          <span>indexly</span>
        </div>
        <nav>
          <p className="nav-label">工作区</p>
          {workspaces.map((workspace) => (
            <a
              key={workspace.id}
              className={`nav-item ${workspace.id === workspaceId ? "active" : ""}`}
              onClick={() => selectWorkspace(workspace.id)}
            >
              <LayoutDashboard />
              {workspace.name}
            </a>
          ))}
          {workspaces.length === 0 && <p className="hint">尚无工作区</p>}
          {projects.length > 0 && <p className="nav-label second">项目</p>}
          {projects.map((p) => (
            <a
              key={p.id}
              className={`nav-item ${p.id === projectId ? "active" : ""}`}
              onClick={() => selectProject(p.id)}
            >
              <Globe2 />
              {p.displayName ?? p.hostname}
            </a>
          ))}
          {project && (
            <>
              <p className="nav-label second">项目视图</p>
              <a className="nav-item anchor" href="#changes" onClick={() => setMenuOpen(false)}>
                <Activity />
                变更 <b className="badge">{changes.length}</b>
              </a>
              <a className="nav-item anchor" href="#issues" onClick={() => setMenuOpen(false)}>
                <TriangleAlert />
                问题 <b className="badge muted">{overview?.openIssues ?? 0}</b>
              </a>
              <a className="nav-item anchor" href="#schedule" onClick={() => setMenuOpen(false)}>
                <LayoutDashboard />
                调度 {schedule?.enabled ? "· 开" : ""}
              </a>
              <a className="nav-item anchor" href="#history" onClick={() => setMenuOpen(false)}>
                <Globe2 />
                抓取历史
              </a>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="help">
            <CircleHelp />
            <div>
              <strong>需要帮助？</strong>
              <span>阅读快速上手指南</span>
            </div>
          </div>
          <div className="new-item">
            <input
              placeholder="新工作区名称…"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
            />
            <button type="button" onClick={createWorkspace} disabled={busy}>
              创建
            </button>
          </div>
        </div>
      </aside>

      <main>
        <header>
          <button className="icon-btn mobile" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
            <Menu />
          </button>
          <div className="project-switch">
            <div className="site-icon">{(project?.hostname ?? "i")[0]}</div>
            <div>
              <strong>{project?.hostname ?? "选择或创建项目"}</strong>
              <span>{project ? `https://${project.hostname}` : "在工作区下创建项目开始监控"}</span>
            </div>
          </div>
          <div className="header-actions">
            {overview?.activeRun && (
              <span className="last-crawl">
                <i /> 正在抓取 · 已完成 {overview.activeRun.pagesDone} 页
              </span>
            )}
            <button
              className="run"
              onClick={runCrawl}
              disabled={busy || !project || (overview?.activeRun ?? null) !== null}
            >
              <Play fill="currentColor" />
              {overview?.activeRun ? "抓取中…" : "运行抓取"}
            </button>
            <button className="icon-btn">
              <Bell />
            </button>
          </div>
        </header>

        <div className="content">
          {toast && (
            <div className="toast">
              <Check /> {toast}
              <button onClick={() => setToast(null)}>×</button>
            </div>
          )}

          {workspaces.length > 0 && projects.length === 0 && (
            <section className="banner">
              <h2>创建第一个项目</h2>
              <p>输入要监控的精确主机名（例如 example.com）。创建后需通过 DNS TXT 验证域名所有权，验证有效期 30 天。</p>
              <div className="new-item">
                <input placeholder="example.com" value={newHostname} onChange={(e) => setNewHostname(e.target.value)} />
                <button type="button" onClick={createProject} disabled={busy || !workspaceId}>
                  创建项目
                </button>
              </div>
            </section>
          )}

          {project && project.verificationStatus !== "ACTIVE" && (
            <section className="banner warn">
              <h2>域名待验证</h2>
              {project.activeChallenge ? (
                <>
                  <p>请在你的 DNS 服务商添加以下 TXT 记录，后台将自动重试检查（最多 3 次）：</p>
                  <div className="kv">
                    <span>类型</span>
                    <code>TXT</code>
                    <span>主机记录</span>
                    <code>{project.activeChallenge.recordName}</code>
                    <span>记录值</span>
                    <code>{project.activeChallenge.recordValue ?? "（发起验证后显示）"}</code>
                  </div>
                </>
              ) : (
                <p>
                  项目尚未验证域名
                  {project.verification?.lastError ? `，上次验证失败：${project.verification.lastError}` : "。"}
                </p>
              )}
              <button className="run" onClick={requestVerification} disabled={busy || project.activeChallenge !== null}>
                {project.activeChallenge ? "验证进行中…" : "发起域名验证"}
              </button>
            </section>
          )}

          {overview?.firstBaselinePending && project?.verificationStatus === "ACTIVE" && (
            <section className="banner">
              <h2>等待首次基线</h2>
              <p>
                {crawls.length > 0
                  ? "最近一次抓取未发布（可能未完成或被取消）。成功完成一次抓取后将建立基线。"
                  : "域名已验证。运行第一次抓取以建立基线。"}
              </p>
            </section>
          )}

          {overview?.lastTerminalRun?.status === "FAILED" && (
            <section className="banner warn">
              <h2>最近一次抓取失败</h2>
              <p>原因：{overview.lastTerminalRun.failureCode ?? "未知"}。请检查域名验证与目标站点可用性后重试。</p>
            </section>
          )}

          {project && (
            <>
              <section className="metrics">
                <article>
                  <div className="metric-head">
                    <span>已抓取 URL</span>
                    <Globe2 />
                  </div>
                  <div className="metric-value">{summary ? summary.urlsCrawled : "—"}</div>
                  <p>
                    {overview?.publishedAt
                      ? `报告发布于 ${new Date(overview.publishedAt).toLocaleString()}`
                      : "尚未发布报告"}
                  </p>
                </article>
                <article className="accent">
                  <div className="metric-head">
                    <span>检测到变化</span>
                    <Activity />
                  </div>
                  <div className="metric-value">
                    {summary ? summary.changesTotal : "—"}
                    {summary && summary.changesCritical > 0 && (
                      <em className="negative">
                        <ArrowUp />
                        {summary.changesCritical} 严重
                      </em>
                    )}
                  </div>
                  <p>{summary ? `影响 ${summary.affectedPages} 个页面` : "等待基线建立"}</p>
                </article>
                <article>
                  <div className="metric-head">
                    <span>未解决问题</span>
                    <TriangleAlert />
                  </div>
                  <div className="metric-value">{overview?.openIssues ?? "—"}</div>
                  <p>{summary ? `本次报告解决 ${summary.issuesResolvedThisRun} 个` : "等待基线建立"}</p>
                </article>
                <article>
                  <div className="metric-head">
                    <span>站点健康</span>
                    <ShieldAlert />
                  </div>
                  <div
                    className={`metric-value${
                      healthGradeValue === "poor"
                        ? " health-poor"
                        : healthGradeValue === "critical"
                          ? " health-critical"
                          : ""
                    }`}
                  >
                    {healthScore !== null ? (
                      <>
                        {healthScore}
                        {healthGradeValue && (
                          <em
                            className={
                              healthGradeValue === "good" || healthGradeValue === "fair" ? "positive" : "negative"
                            }
                          >
                            {GRADE_LABELS[healthGradeValue]}
                          </em>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  {healthScore !== null && (
                    <div className="health">
                      <i style={{ width: `${healthScore}%` }} />
                    </div>
                  )}
                  <p>
                    {health === null
                      ? summary
                        ? "本报告早于评分功能发布"
                        : "等待基线建立"
                      : healthScore !== null
                        ? `覆盖率 ${healthCoveragePct}% · 评分规则 v${health.scoreVersion}`
                        : `有效覆盖 ${healthCoveragePct}%，低于 50% 暂不评分`}
                  </p>
                  {healthDeductions.length > 0 && (
                    <ul className="health-breakdown">
                      {healthDeductions.map((component) => (
                        <li key={component.ruleKey}>
                          <span>
                            {ISSUE_LABELS[component.ruleKey] ?? component.ruleKey} · {component.openIssues} 页
                          </span>
                          <b>−{component.deduction}</b>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              </section>

              <div className="section-heading" id="changes">
                <div>
                  <h2>需要关注的变化</h2>
                  <p>最近一次已发布报告中的变更事件（严重程度排序）。</p>
                </div>
              </div>
              {changes.length === 0 ? (
                <section className="banner">
                  <p>{overview?.latestPublishedRunId ? "本次报告没有检测到变化。" : "首次基线报告不包含变化事件。"}</p>
                </section>
              ) : (
                <section className="change-grid">
                  {changes.slice(0, 8).map((change) => (
                    <article className="change-card" key={change.id}>
                      <div className={`change-icon ${change.severity.toLowerCase()}`}>
                        {change.severity === "CRITICAL" ? "!!" : change.severity === "WARNING" ? "!" : "i"}
                      </div>
                      <div className="change-copy">
                        <div>
                          <span className={`pill ${change.severity.toLowerCase()}`}>{change.severity}</span>
                        </div>
                        <h3>{CHANGE_LABELS[change.type] ?? change.type}</h3>
                        <p className="mono">{change.url}</p>
                        <p>
                          {change.before !== null ? `${String(change.before).slice(0, 40)} → ` : ""}
                          {change.after !== null ? String(change.after).slice(0, 60) : ""}
                        </p>
                      </div>
                    </article>
                  ))}
                </section>
              )}

              <div className="section-heading" id="issues">
                <div>
                  <h2>未解决问题</h2>
                  <p>按当前策略规则评估的问题（含重复出现次数）。</p>
                </div>
              </div>
              <section className="history-card">
                <div className="table issue-table">
                  <div className="tr th">
                    <span>规则</span>
                    <span>页面</span>
                    <span>次数</span>
                    <span>最近确认</span>
                  </div>
                  {issues.length === 0 && (
                    <div className="tr">
                      <span>当前没有未解决的问题</span>
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                  {issues.slice(0, 10).map((issue) => (
                    <div className="tr" key={issue.id}>
                      <span>{ISSUE_LABELS[issue.ruleKey] ?? issue.ruleKey}</span>
                      <span className="mono">{issue.url}</span>
                      <span>{issue.occurrence}</span>
                      <span>{issue.lastConfirmedAt ? new Date(issue.lastConfirmedAt).toLocaleString() : "—"}</span>
                    </div>
                  ))}
                </div>
              </section>

              <div className="section-heading" id="schedule">
                <div>
                  <h2>每周调度</h2>
                  <p>
                    {schedule?.enabled
                      ? `已启用：每 7 天自动抓取一次，下次运行 ${schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "待定"}（UTC 时间槽，本地显示可能随时区偏移）。`
                      : "未启用。启用后每 7 天在同一 UTC 时间槽自动抓取。"}
                  </p>
                </div>
                <button
                  className="run"
                  onClick={toggleSchedule}
                  disabled={busy || !project || project.verificationStatus !== "ACTIVE"}
                >
                  {schedule?.enabled ? "停用" : "启用每周抓取"}
                </button>
              </div>

              <div className="section-heading" id="history">
                <div>
                  <h2>抓取历史</h2>
                  <p>运行状态、完整性与发布情况。</p>
                </div>
              </div>
              <section className="history-card">
                <div className="table crawl-table">
                  <div className="tr th">
                    <span>抓取</span>
                    <span>状态</span>
                    <span>页面</span>
                    <span>完整性</span>
                    <span>发布</span>
                  </div>
                  {crawls.length === 0 && (
                    <div className="tr">
                      <span>还没有抓取记录</span>
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                  {crawls.map((crawl) => (
                    <div className="tr" key={crawl.id}>
                      <span>
                        <b>{new Date(crawl.createdAt).toLocaleString()}</b>
                        <small>{crawl.trigger === "MANUAL" ? "手动" : "计划"}</small>
                      </span>
                      <span>
                        <i
                          className="status-dot"
                          style={{
                            background:
                              crawl.status === "COMPLETED"
                                ? "#28a56f"
                                : crawl.status === "FAILED"
                                  ? "#db4b45"
                                  : "#b96512",
                          }}
                        />
                        {crawl.status}
                        {crawl.failureCode ? `（${crawl.failureCode}）` : ""}
                      </span>
                      <span>{crawl.pagesDone}</span>
                      <span>{crawl.completeness}</span>
                      <span>{crawl.publishedAt ? "已发布" : "—"}</span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
          {currentWorkspace && (
            <MembersPanel workspaceId={currentWorkspace.id} currentRole={currentWorkspace.role} onToast={setToast} />
          )}
          <footer>
            <span>Indexly 按你的策略监控站点变更。</span>
            <button>
              <PanelLeftClose /> 发送反馈
            </button>
          </footer>
        </div>
      </main>
    </div>
  );
}
