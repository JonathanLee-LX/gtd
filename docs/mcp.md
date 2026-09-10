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

```json
{
  "mcpServers": {
    "gtd": {
      "type": "http",
      "url": "http://localhost:5173/mcp",
      "headers": {
        "Authorization": "Bearer gtd_your_token"
      }
    }
  }
}
```
