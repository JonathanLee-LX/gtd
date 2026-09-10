# 个人 GTD 工作台

全栈待办：React SPA + Hono API + D1 + MCP，部署在 Cloudflare Workers。

网页和 AI 助手共用同一套 `TaskService`。第一版覆盖 GTD 工作台（收件箱、项目、优先级、截止日期、今日焦点）和个人 MCP Token。产品内自然语言建任务刻意放到后面。

## 栈

- Cloudflare Workers + Vite + React
- Hono + Zod
- D1 + Drizzle
- Better Auth（邮箱密码，session 在 D1）
- MCP：`/mcp` Streamable HTTP JSON-RPC

## 本地

```sh
cd gtd
cp .dev.vars.example .dev.vars   # 已有则跳过
pnpm install
pnpm db:migrate:local
pnpm test
pnpm dev
```

打开 http://localhost:5173 注册后即可用。MCP 说明见 `docs/mcp.md`。

## 部署

远端 D1 `gtd` 已创建（`database_id` 在 `wrangler.json`）。本地开发继续用 `.dev.vars` 里的 `BETTER_AUTH_URL=http://localhost:5173`。

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm db:migrate
pnpm deploy
```

生产环境 `BETTER_AUTH_URL` 不写进 `wrangler.json`，Worker 会用请求 Origin。需要固定值时：

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

## 阶段

0. 脚手架（本仓库）
1. schema / auth / REST
2. GTD Web
3. MCP Token
4. Cloudflare 部署
5. 产品内 AI（xAI，未做）
