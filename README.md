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

打开 http://localhost:5173。公开注册默认关闭；本地若需注册，在 `.dev.vars` 设置 `ALLOW_SIGNUP=true`。MCP 说明见 `docs/mcp.md`。情境标签约定（`@电脑` / `@出门` / `@电话`）见 `docs/gtd.md`。

## 部署

远端 D1 `gtd` 已创建（`database_id` 在 `wrangler.json`）。本地开发继续用 `.dev.vars` 里的 `BETTER_AUTH_URL=http://localhost:5173`。

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm db:migrate
pnpm run deploy
```

线上地址：https://gtd.jonathanleelx.workers.dev

产品内 AI 需要 Worker secret `XAI_API_KEY`（https://console.x.ai）。没配时普通创建任务仍可用。

### GitHub 自动部署

推送到 `main` 会跑 GitHub Actions：先测试，再应用 D1 迁移并 `wrangler deploy`。

仓库 Secrets（Settings → Secrets and variables → Actions）：

- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID
- `CLOUDFLARE_API_TOKEN`：权限至少包含 **Edit Cloudflare Workers** 和 **D1 Edit**

创建 Token：https://dash.cloudflare.com/profile/api-tokens

`BETTER_AUTH_SECRET` 已写在 Worker secrets 里，部署不会覆盖。

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
5. 产品内 AI（xAI：自然语言 → 草稿 → 确认写入）
