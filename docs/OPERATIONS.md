# 部署与运维手册

面向 Indexly 首版上线（对应实施计划 P4）。架构与数据模型见 [ARCHITECTURE.md](./ARCHITECTURE.md)，本地开发见 [LOCAL_DEV.md](./LOCAL_DEV.md)。

## 部署拓扑

```text
入口 TLS → Web 容器（Next.js：页面 + /api）
          → Worker 容器（抓取/验证/调度/清理，同一构建产物）
          → PostgreSQL 17（受保护网络，仅 Web/Worker 可访问）
```

- Web 与 Worker 使用**同一镜像**，分别以 `npm run start` 与 `npm run worker` 启动。
- 数据库版本部署时锁定（示例使用 `postgres:17`，生产固定具体补丁版本并记录在变更单）。
- 先执行数据库迁移（`prisma migrate deploy`），再发布新版本 Web/Worker；回滚按"先扩展、再迁移数据、最后清理"原则评估破坏性变更。

参考 `docker-compose.prod.yml`（单机演示拓扑；生产建议托管数据库 + 独立 Worker 副本）。

## 环境变量

| 变量 | 必填（生产） | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 是 | PostgreSQL 连接串 |
| `AUTH_SECRET` | 是 | 会话密钥，≥32 字符，轮换需使所有会话失效 |
| `APP_ORIGIN` | 是 | 站点绝对地址（Better Auth baseURL/trustedOrigins） |
| `CRAWLER_USER_AGENT` | 是 | 抓取 UA，建议含联系地址 |
| `APP_ENV` | 否 | production/test/development |
| `LOG_LEVEL` | 否 | debug/info/warn/error |

启动时由 `packages/contracts` 的 `parseEnv` 校验；缺生产必填项直接失败退出。

## 健康检查与监控

| 探针 | 路径 | 含义 |
| --- | --- | --- |
| 存活 | `GET /api/healthz` | 进程存活，不依赖数据库 |
| 就绪 | `GET /api/readyz` | 数据库可应答（`SELECT 1`），失败返回 503 |

建议告警项（架构 §13）：

- Outbox 最老未投递事件 > 5 分钟；
- 抓取取消请求 > 30 秒未确认（`cancelRequestedAt` 挂起）；
- Worker 心跳日志（每轮 tick 输出）中断 > 2 分钟；
- `readyz` 连续失败；PostgreSQL 连接池与磁盘水位；
- 抓取 FAILED 比例、单站请求速率超限日志。

结构化日志关联 `requestId` / `workspaceId` / `projectId` / `crawlId`（`[worker]` 前缀行），日志默认不记录 URL 查询参数与任何令牌。

## 备份与恢复（目标 RPO ≤ 1h，RTO ≤ 4h）

1. **备份**：启用 PostgreSQL 持续 WAL 归档或托管 PITR；每日基础备份保留 ≥ 14 天。
2. **演练**（每月至少一次，在隔离环境执行）：
   ```bash
   # 备份
   pg_dump --format=custom "$DATABASE_URL" > indexly-$(date +%F).dump
   # 恢复到隔离库并验证
   createdb indexly_verify && pg_restore -d indexly_verify indexly-YYYY-MM-DD.dump
   psql "$VERIFY_URL" -c "select count(*) from \"CrawlRun\";"
   ```
   验证清单：迁移状态一致（`prisma migrate status`）、登录会话可用、最新已发布报告可读。
3. **恢复步骤**：停 Worker → 恢复数据库到目标时间点 → `prisma migrate deploy` 校验 → 起 Worker → 抽查最新报告。RPO/RTO 只有在实测演练后才算达标。

## 保留与清理

Worker 内置维护循环（每 10 分钟）：

- 观测/事件/frontier 详情：90 天，或每项目最多 20 个已完成 run——任一条件触发即清理；
- 当前基线（`latestPublishedRunId`）与活跃 run 引用的 baseRun 永不清理；
- 清理后的 run 保留元数据与 Summary，标记 `detailsExpiredAt`，界面显示"历史详情已过期"；
- Issue 转换历史保留 90 天窗口；审计日志保留 180 天（建议由数据库任务执行）。

## 配额与限制（首版默认值）

| 项 | 值 |
| --- | --- |
| 手动抓取 | 每项目每日 ≤10 次，间隔 ≥5 分钟（429 + 下次允许时间） |
| 同项目并发 | 1 个活跃 run（409 CRAWL_ALREADY_ACTIVE） |
| 每周调度 | 固定 7 天间隔，UTC 时间槽；错过周期只补最近一次，其余记 SKIPPED_MISSED |
| 页面/frontier | 5,000 / 20,000 |
| 单响应/总预算 | 2 MiB / 500 MiB |
| 域名验证 | 有效期 30 天；过期后手动抓取 409 VERIFICATION_REQUIRED，调度记 SKIPPED_UNVERIFIED |

## 已知边界（首版）

- 队列为 Outbox 直轮询（SKIP LOCKED + 租约），未引入 pg-boss；替换点集中在 `server/workers/main.ts`。
- 邮件为开发控制台输出；开放注册前必须配置真实邮件通道（架构 §4）。
- 健康分未上线（评分规则定义后启用）；邮件报告/Webhook/链接图属 P5。
- 5xx 响应未做页面级重试（按 HTTP 观测记录）；仅网络/超时类失败重试 2 次。
