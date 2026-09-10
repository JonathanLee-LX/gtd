# MCP

远程无状态 Streamable HTTP，JSON-RPC 2.0。

- URL: `https://<your-worker>/mcp`（本地 `http://localhost:5173/mcp`）
- Header: `Authorization: Bearer gtd_...`
- Token 在网页「设置 / MCP」创建，明文只显示一次

## 工具

| 工具 | 用途 |
|---|---|
| `today_focus` | 逾期 + 今天 + 下一步 + P1 |
| `list_projects` / `create_project` | 项目 |
| `list_tasks` / `get_task` / `search_tasks` | 查询 |
| `create_task` | 创建（建议 `idempotencyKey`） |
| `update_task` | 部分更新 |
| `complete_task` | 完成 |

`dueAt` 使用 `YYYY-MM-DD`。

## 客户端配置示例

Cursor 全局配置：`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "gtd": {
      "type": "http",
      "url": "https://gtd.jonathanleelx.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer gtd_your_token"
      }
    }
  }
}
```

本地开发可把 `url` 换成 `http://localhost:5173/mcp`。改完后在 Cursor 里打开 **Settings → MCP**，确认 `gtd` 已启用；必要时 Reload。
