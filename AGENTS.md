# GTD 工作台 — 给 AI 编程助手

个人 GTD，Cloudflare Workers 全栈。人用网页，助手用 MCP / REST，**必须走同一套 service**。

## 目录

- `src/shared/` Zod 契约、焦点规则、分页游标。改任务字段先改这里。
- `src/db/schema.ts` Drizzle 表（含部分唯一索引与 FK，须与迁移一致）。改表后同步 `drizzle/0001_init.sql`（或新增 `0002_*.sql`）。
- `src/worker/services/` 领域逻辑。禁止在 route / MCP 里写 SQL。
- `src/worker/routes/` REST。入口把 `source` 设成 `human` 或 `mcp`。
- `src/worker/mcp/` MCP JSON-RPC。工具要少，优先 `today_focus`。
- `src/react-app/` SPA。中文 UI。

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

## 任务状态

`inbox | next | waiting | scheduled | someday | completed | cancelled`
