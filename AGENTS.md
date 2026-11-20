# GTD 工作台 — 给 AI 编程助手

个人 GTD，Cloudflare Workers 全栈。人用网页，助手用 MCP / REST，**必须走同一套 service**。

## 目录

- `src/shared/` Zod 契约、焦点规则、分页游标。改任务字段先改这里。
- `src/db/schema.ts` Drizzle 表（含部分唯一索引与 FK，须与迁移一致）。改表后同步 `drizzle/0001_init.sql`（或新增 `0002_*.sql`）。
- `src/worker/services/` 领域逻辑。禁止在 route / MCP 里写 SQL。
- `src/worker/routes/` REST。入口把 `source` 设成 `human` 或 `mcp`。
- `src/worker/mcp/` MCP JSON-RPC。工具要少，优先 `today_focus`。
- `src/react-app/` SPA。中文 UI。
- `src-tauri/` 桌面壳（Tauri 2）：只加载现网，不写业务 / 不设 `source`。见 `docs/desktop.md`。

## 命令

```sh
pnpm test
pnpm db:migrate:local
pnpm dev
pnpm build
```

## 硬约束

- 所有业务表带 `user_id`，查询必须带当前用户。
- 客户端不能设置 `source`。服务端按入口写入：网页 `human`，Token `mcp`，未来 LLM `ai`。
- D1 没有传统事务。多语句用顺序写入；同请求读写用 Sessions API（`createDb` 已包）。
- 不要引入 `McpAgent` / Durable Objects 做 CRUD。
- 密钥只放 `.dev.vars` 和 Worker secrets。
- 不要让模型直接写 SQL。
- 附件（#68）：二进制只进 R2（绑定 `UPLOADS`，生产桶 `gtd-uploads`），上传 / 下载都经 Worker 代理，不发 R2 凭据或预签名 URL。额度与类型白名单在 `src/shared/limits.ts`（前后端共用）。附件清理挂在现有每日 cron 上，必须先于回收站任务硬删。
- Worker 固定在 `aws:ap-southeast-1`（`wrangler.json` 的 `placement.region`；`region` 与 `mode` 不能同时写）。不要改回 Smart Placement：AMS/IAD 流量太低，分析结果不稳定；2026-10-17 的 2 次部署加 3 个 secret 版本把分析重置后，Worker 退回 `local-IAD`，每次 D1 往返都跨到 APAC 主库。区域是探针量出来的（主库几乎确定在新加坡，`remote-SIN`；备选 `aws:ap-east-1`）。`run_worker_first` 覆盖 `/*`（`/assets/*` 除外），HTML 和 `sw.js` 也走这个区域。
- 生产部署只走 GitHub Actions（`.github/workflows/deploy.yml`）。Cloudflare Workers Builds 的生产触发器已删，只留分支预览。不要再接新的部署路径；部署后的 `/api/health` 冒烟（HTTP 200，且 `cf-placement` 以 `remote-` 开头）会顺带发现异常部署。
- Actions 里先跑 D1 migration（`wrangler d1 migrations apply gtd --remote`），成功后再部署。migration 失败就不部署：这一步不要加 `continue-on-error`，deploy 步骤和它所在的 job 不要加 `if: always()` / `failure()` / `cancelled()`。
- migration 必须是增量、向后兼容：新代码上线前，旧代码也能跑新 schema。删列或改列名分两次发版（先停用，后删）。

## 任务状态

`inbox | next | waiting | scheduled | someday | completed | cancelled`
