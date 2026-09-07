# 本地开发指南

本文描述当前仓库的本地开发方式。架构与阶段目标见 [ARCHITECTURE.md](./ARCHITECTURE.md) 与 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。

## 工具链

| 工具 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 24 | 统一运行环境；测试直接运行 `.ts`（内置 type stripping） |
| npm | ≥ 11 | workspaces 管理 `packages/*` |
| （可选）Docker | 任意近期版本 | 不再必需——本地数据库可用内置嵌入式 PostgreSQL 代替 |

Windows 环境建议在 PowerShell 中使用 `npm.cmd run <script>` 形式，避免执行策略限制。

## 常用命令

```bash
npm install              # 安装依赖、链接 workspaces、生成 Prisma Client
npm run dev              # Next.js 开发服务器（http://localhost:3000）
npm run db:up            # 启动本地嵌入式 PostgreSQL 17（无需 Docker，Ctrl+C 停止并清空数据）
npm run db:migrate       # prisma migrate dev（新增/应用迁移，需要 db:up 运行中）
npm run db:studio        # Prisma Studio 查看数据
npm run worker           # 启动后台 Worker（当前：域名验证 Outbox 消费者）
npm run typecheck        # 全仓 TypeScript 检查
npm run lint             # ESLint
npm test                 # 单元测试（无需数据库）
npm run test:integration # 迁移 + 集成测试（需要 db:up 运行中）
npm run build            # Next.js 生产构建
npm run format           # Prettier 格式化
```

CI（GitHub Actions）在 postgres:17 服务容器上执行同一组检查。

## 本地数据库

`npm run db:up` 启动一个一次性的嵌入式 PostgreSQL 17（数据在临时目录，停止即清空）。把连接串写入 `.env`：

```text
DATABASE_URL=postgresql://indexly:indexly@127.0.0.1:5433/indexly
```

`npm run test:integration` 会先执行 `prisma migrate deploy` 再运行 `tests/integration/`。首次使用前先 `npm run db:migrate` 建立迁移历史。

生产环境使用独立 PostgreSQL（版本在部署时锁定），连接串由部署环境注入，不得写入仓库。

## 环境变量

复制 `.env.example` 为 `.env`（已被 `.gitignore` 排除）。Schema 由 `packages/contracts/src/env.ts` 的 `parseEnv` 在启动时校验：

| 变量 | 说明 |
| --- | --- |
| `APP_ENV` | `development` / `test` / `production`，默认取 `NODE_ENV` 再默认 `development` |
| `APP_ORIGIN` | 站点绝对地址；production 必填 |
| `AUTH_SECRET` | 会话密钥，≥32 字符；production 必填 |
| `DATABASE_URL` | PostgreSQL 连接串；production 必填 |
| `CRAWLER_USER_AGENT` | 抓取 UA 与联系地址；production 必填 |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error`，默认 `info` |

development 环境允许这些键缺席，便于无外部服务运行页面与测试。开发邮件（邮箱验证链接）打印在 `npm run dev` / `npm run worker` 的控制台。

## 包结构与依赖方向

```text
packages/contracts/           契约：DTO、枚举、错误码、env schema（依赖 zod）
packages/crawler/             纯函数：URL 身份、scope、字面地址分类
packages/change-detection/    纯函数：快照比较（依赖 @seo/contracts）
packages/db/                  Prisma schema、迁移、客户端单例
server/                       应用层：auth / api / repositories / services / workers
app/                          Next.js 页面与 /api/v1 路由
tests/unit/                   纯逻辑单元测试（无需数据库）
tests/integration/            PostgreSQL 集成测试（租户隔离、成员、邀请、验证）
```

- 纯规则包不导入 Next.js、Prisma、队列或网络模块（架构文档 §3）。
- 包直接导出 TypeScript 源；消费方为 `DbClient`（事务客户端）与 `PrismaClient`（事务编排）两种类型。
- 数据库约定：业务表全部带 workspaceId 作用域；成员变更在 Workspace 行锁内校验最后 OWNER；Outbox 用 `FOR UPDATE SKIP LOCKED` 认领。

## 当前实现状态（P0–P4 已完成，含加固；健康分 v1 已实现）

- Better Auth（邮箱密码 + 强制邮箱验证 + 数据库会话；登录/注册/验证邮件端点按 IP 滑动窗口限流）
- 工作区/成员/角色/一次性邀请（令牌哈希存储、72 小时过期、验证邮箱匹配；仪表盘成员与邀请管理面板）
- 项目与策略 v1、DNS TXT 域名验证（30 天有效期、挑战轮换 fencing、最多 3 次重试）
- 安全抓取核心：逐跳 URL/scope/DNS 校验、重定向链、正文/预算上限、可注入 DNS+传输层
- 生产传输层支持 gzip/deflate/brotli 流式解压（压缩/解压双向字节上限）；robots 探测 HTTPS 优先、网络失败或 HTTPS 404 时回退 HTTP:80
- robots.txt（RFC 9309 核心）/ sitemap / HTML 提取；抓取执行器（robots 保守策略、种子、持久化 frontier、预算/限速、租约 fencing、取消、崩溃恢复）
- 报告闭环：字段有效性门控的变更事件、三值问题规则与生命周期、可比基线、原子发布、Summary
- API：工作区/成员/邀请/项目/验证/审计/抓取/overview/changes/issues/schedule；写接口统一 Origin（CSRF）校验
- 每周调度、保留清理（90 天 / 20 run / 基线保护）、健康探针、部署文件、运维手册（OPERATIONS.md）
- 真实仪表盘：项目切换、验证引导、指标、变更、问题、抓取历史、调度开关、成员面板、锚点导航与移动菜单
- 站点健康分 v1（`@seo/health-score` 纯规则包）：发布事务内计算并写入 Summary；公式 `100 − Σ 扣分`，规则权重 http_4xx_5xx 40 / noindex_on_indexable 25 / missing_title 20 / canonical_conflict 15，20% 饱和；决定性覆盖率 < 50% 时不给分并记录原因；overview API 与仪表盘展示分数、等级、覆盖率与扣分明细

后续（P5，独立排期）：邮件摘要、Webhook、链接图/断链溯源、公开 API token、浏览器渲染抓取、真实邮件通道、多进程共享限流存储。
