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
| `create_task` | 创建（建议 `idempotencyKey`；可选 `parentId` 挂子任务） |
| `update_task` | 部分更新（可改 `parentId`，`null` 取消父子） |
| `nudge_waiting` | 对等待任务「要催」（生成下一步，幂等） |
| `complete_task` | 完成 |
| `delete_task` | 软删除 |
| `restore_task` | 从回收站恢复软删任务（默认列表不含软删） |

`dueAt` 使用 `YYYY-MM-DD`。

### `parentId` 子任务

- `create_task` / `update_task` 可传 `parentId`（任务 id）把当前任务挂到父任务下。
- 省略或 `null` 表示顶层任务。
- 服务端会拒绝自引用与成环（例如 A 父是 B、B 父是 A）。
- 硬删除父任务时，子任务的 `parent_id` 由数据库 `ON DELETE SET NULL` 清成顶层。
- 完成父任务（网页 / `complete_task`）时：未完成子任务提升为顶层（`parent_id` 清空，状态不变）；已完成子任务保持挂在父任务下；**不会**自动完成子任务。

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
