# Indexly — SEO 变更监控

一个聚焦的 MVP：监控两次网站爬取之间有意义的技术 SEO 变化。

> English version: [README.md](./README.md)

## 架构与实施计划

- [整体架构设计](docs/ARCHITECTURE.md)：团队工作区、系统边界、抓取安全、数据模型、API 与报告语义（英文版：[ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md)）。
- [分阶段实施计划](docs/IMPLEMENTATION_PLAN.md)：交付顺序、依赖与验收测试（英文版：[IMPLEMENTATION_PLAN.en.md](docs/IMPLEMENTATION_PLAN.en.md)）。
- [本地开发指南](docs/LOCAL_DEV.md)：工具链、脚本、本地数据库与当前实现状态。
- [部署与运维手册](docs/OPERATIONS.md)：拓扑、配置、健康探针、备份、保留策略与配额。

进度：**P0–P4 已全部完成** —— 首版功能集已闭环（身份、工作区、已验证项目、安全抓取、报告循环、每周调度、配额、保留清理、健康探针与部署资产）。首个 P5 增强 —— **站点健康评分 v1** —— 也已实现（公式、覆盖率门槛与版本化，见 [ARCHITECTURE.md §9](docs/ARCHITECTURE.md)）。其余 P5 项（邮件摘要、Webhook、链接图、渲染抓取）明确不在首版范围内。

2026-09-07 的第二轮加固关闭了评审中发现的全部安全与体验问题，详见[加固记录](#加固记录2026-09-07)。

## 仓库结构

```text
app/                          Next.js App Router：仪表盘原型、认证页、/api/v1 路由
server/                       认证、API 辅助、仓储、服务、worker
packages/contracts/           共享 DTO、枚举、错误码、env schema（Zod）
packages/crawler/             URL 身份 v1、范围检查、字面地址分类
packages/change-detection/    纯快照比较与摘要
packages/issue-rules/         纯三值 issue 规则评估
packages/health-score/        纯站点健康评分 v1（权重、覆盖率门槛、版本化）
packages/db/                  Prisma schema、迁移、客户端单例
tests/unit/                   单元测试（Node test runner，无需数据库）
tests/integration/            PostgreSQL 集成测试（租户、成员、邀请、验证）
```

包为 npm workspaces，直接导出 TypeScript 源码。纯规则包不引入 Next.js、Prisma、队列或任何网络代码。

## 已实现内容

**P0 — 工程基础**

- TypeScript workspace 包、ESLint（next/core-web-vitals + next/typescript）、Prettier、CI
- URL 身份 v1，显式去除跟踪参数；字面 SSRF 检查（localhost 变体、私有/特殊 IPv4 与 IPv6，含 mapped/NAT64/6to4、凭证/端口/协议规则）
- 快照比较、严重度分级、摘要生成

**P1 — 身份与数据基础**

- Better Auth：邮箱+密码，强制邮箱验证，数据库会话（验证邮件打印到开发控制台）
- 工作区、角色（OWNER/ADMIN/MEMBER/VIEWER）、一次性邀请（SHA-256 token 哈希、72 小时过期、验证邮箱匹配、原子消费）
- 最后一位 OWNER 保护、跨工作区隔离（外部人员一律 404）、带脱敏的审计日志、游标分页、幂等辅助
- 项目与策略 v1、DNS TXT 域名验证（30 天有效期、challenge 轮换 fencing、经事务型 Outbox 重试/退避）
- workspaces/members/invitations/projects/verification/audit-logs 的 `/api/v1` 路由，以及 login/register/accept-invitation 页面

**P2 — 可靠抓取**

- 安全抓取管线：逐跳字面 URL 策略、精确主机名范围、DNS 解析要求每个解析地址均为公网、重定向链（≤5 跳，超出范围只记录不跟随）、体积与字节预算 —— 测试可注入 DNS/transport，生产 node transport 将已验证 IP 钉入 TCP 连接（TLS SNI/Host 保留原始主机名）
- robots.txt 解析/匹配（RFC 9309 核心）、sitemap index/urlset 遍历（文档/候选预算）、HTML 提取（title、description、canonical 候选、robots index 合成含 X-Robots-Tag、同主机链接）
- 抓取执行器：保守 robots 策略（401/403 拒绝，5xx 重试）、种子（入口 + sitemap + 监控页面）、带重试/退避的持久 frontier、页面/时长/字节预算、主机名速率控制、租约 fencing、协作式取消、租约过期后崩溃恢复
- 抓取 API：创建（Idempotency-Key、验证护栏、每项目单活跃 run）、取消、列表、详情

**P3 — 报告循环**

- 带字段有效性门控的变更事件：只有 KNOWN、可比较的字段才产生内容事件；错误页与重定向源永不产生；"本次未观测到"永不是删除事件；只有存在基线时才有 URL_ADDED
- 纯包 issue 规则（`@seo/issue-rules`）：HTTP 404/410/5xx、预期可索引页的 noindex、缺失 title、canonical 无效/冲突 —— 每项返回 PRESENT/ABSENT/UNKNOWN 并附证据；UNKNOWN 永不翻转状态
- Issue 生命周期：OPEN ↔ RESOLVED，重开时次数递增，带幂等键的只追加转换历史，证据新鲜度跟踪
- 发布事务：FULL run 冻结（FINALIZING），选择可比较基线（同一不可变 policy 下最新已发布的 FULL run），原子写入事件 + issue 转换 + 摘要 + `publishedAt`；PARTIAL/CANCELLED run 完成但不发布、永不推进基线
- 报告 API：概览、变更（仅已发布 run）、issue、页面
- 真实仪表盘：工作区/项目切换、DNS 验证指引、已发布指标、变更卡片、issue 表格、抓取历史（可运行/取消）与实时轮询 —— 无模拟数据
- 站点健康评分 v1（`@seo/health-score`）：在发布事务内计算并存入摘要；展示等级、覆盖率与逐规则扣分明细；决定性覆盖率低于 50% 时附明确原因抑制

生产抓取 worker（P2）仍须对每个解析地址解析 DNS 并重跑 SSRF 检查，包括每次重定向之后。

## 部署方式

### 生产环境（Docker Compose）

参考拓扑见 [`docker-compose.prod.yml`](docker-compose.prod.yml)：同一镜像同时提供 Web 应用与 Worker；PostgreSQL 17 使用持久化卷。

1. 创建 `.env`（模板：[.env.example](.env.example)）并填写生产值：
   - `POSTGRES_PASSWORD` —— 数据库密码
   - `APP_ORIGIN` —— 站点公开地址，例如 `https://indexly.example.com`（用于认证与 CSRF 源检查，必须与浏览器实际访问的地址一致）
   - `AUTH_SECRET` —— 随机密钥，至少 32 个字符
   - `CRAWLER_USER_AGENT` —— 可选；默认 `IndexlyBot/0.1`，建议配置含联系方式的 UA
2. 先启动数据库并执行 schema 迁移（应用启动前必须完成）：
   ```bash
   docker compose -f docker-compose.prod.yml up -d postgres
   docker compose -f docker-compose.prod.yml run --rm web \
     npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
   ```
3. 启动 Web 与 Worker：
   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```
4. 验证：`GET /api/healthz`（存活探针）与 `GET /api/readyz`（数据库就绪探针，数据库不可达时返回 503）。在 `web:3000` 前置 TLS 终结；`APP_ORIGIN` 必须与公开地址一致。

Web 与 Worker 共用同一镜像；Worker 运行 `node server/workers/main.ts`，负责抓取、验证、调度与保留清理。生产建议使用托管 PostgreSQL、按版本固定镜像 tag、独立扩缩 Worker。备份、保留、配额与监控详见 [OPERATIONS.md](docs/OPERATIONS.md)。

### 裸机部署（Node.js）

需要 Node.js 24+ 与 PostgreSQL 17：

```bash
npm ci
npm run build
DATABASE_URL=... AUTH_SECRET=... APP_ORIGIN=... npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
DATABASE_URL=... AUTH_SECRET=... APP_ORIGIN=... npm start      # Web（端口 3000）
DATABASE_URL=... AUTH_SECRET=... APP_ORIGIN=... npm run worker # Worker（独立进程）
```

### 环境变量

| 变量                 | 生产必填 | 说明                                     |
| -------------------- | -------- | ---------------------------------------- |
| `DATABASE_URL`       | 是       | PostgreSQL 连接串                        |
| `AUTH_SECRET`        | 是       | 会话密钥，≥32 字符；轮换会使所有会话失效 |
| `APP_ORIGIN`         | 是       | 站点公开地址（认证 baseURL 与源检查）    |
| `CRAWLER_USER_AGENT` | 是       | 抓取 UA，建议包含联系地址                |
| `APP_ENV`            | 否       | `production` / `test` / `development`    |
| `LOG_LEVEL`          | 否       | `debug` / `info` / `warn` / `error`      |

启动时由 `packages/contracts` 的 `parseEnv` 校验；缺少生产必填变量直接终止启动。

## 本地运行

需要 Node.js 24+。

```bash
npm install
npm run db:up      # 终端 1：一次性内嵌 PostgreSQL 17
npm run db:migrate # 终端 2：建表
npm run dev        # 终端 2：Web 应用 http://localhost:3000
npm run worker     # 终端 3（可选）：验证 worker
```

全部质量门禁（CI 在每次 push 与 PR 上同样执行）：

```bash
npm run typecheck          # 全仓 tsc --noEmit
npm run lint               # ESLint
npm test                   # 单元测试（无需数据库；当前 90 项）
npm run test:integration   # 迁移 + PostgreSQL 集成测试（当前 40 项）
npm run build              # Next.js 生产构建
npm run format             # Prettier
```

开发服务器请将 `.env.example` 复制为 `.env`；`packages/contracts` 的 `parseEnv` 校验 schema 并强制生产变量。

## 加固记录（2026-09-07）

- **内容解码**：生产 transport 现以流式解码 gzip/deflate/brotli 响应体（压缩字节与解压后字节分别设上限）；损坏或超限载荷映射到既有抓取结果。
- **协议回退**：robots 探测先试 HTTPS，仅在网络层失败或 HTTPS 404/410（纯 HTTP 站点）时回退 HTTP:80；HTTP 已有应答绝不回问 HTTPS，权威 401/403 拒绝绝不回退。
- **CSRF 与暴力破解防护**：`/api/v1` 变更类请求做 Origin 检查（拒绝跨站浏览器请求）；`/api/auth` 登录/注册/验证端点按 IP 滑动窗口限流（内存实现；多进程部署需共享存储）。
- **成员管理 UI**：工作区成员/邀请面板，支持角色变更、移除（服务端保护最后一位 OWNER）、单次展示的一次性邀请链接、撤销待处理邀请。

### 第二轮加固（2026-09-07）

- **权限隔离**：抓取详情与取消按工作区隔离（外部人员一律 404）；issue 抑制拒绝跨工作区请求；无操作变更的请求同样强制角色矩阵；并发降级场景下最后一位 OWNER 仍受保护。
- **幂等性**：幂等键记录与业务变更在同一个原子事务中写入 —— 记录失败即回滚业务变更。
- **验证任务竞态**：其他 worker 取得任务后，DNS 结果不能覆盖验证状态；租约过期且无替补时 worker 不能发布结果。
- **报告规则**：发布拒绝已取消、已请求取消与未完成的抓取；重复发布幂等；当前 issue 读取排除旧策略范围与旧规则版本；游标分页保证每条变更/issue 恰好访问一次。
- **前端**：切换工作区/项目会使在途请求失效，旧响应不会覆盖新数据；验证挑战进行中 DNS 验证状态自动刷新；"重发验证邮件"改走 auth client 的正确端点；登录支持同源 `next` 回跳；剪贴板失败有兜底提示；畸形 JSON 请求体返回 400 而非 500。
