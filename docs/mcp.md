# MCP

远程无状态 Streamable HTTP，JSON-RPC 2.0。

- URL: `https://<your-worker>/mcp`（本地 `http://localhost:5173/mcp`）
- Header: `Authorization: Bearer gtd_...`
- Token 在网页「设置 / MCP」创建，明文只显示一次

## 工具

| 工具 | 用途 |
|---|---|
| `today_focus` | 逾期 + 今天 + 下一步 + P1，只出可执行叶子 |
| `list_projects` / `create_project` / `update_project` | 项目（`list_projects` 默认不含已归档） |
| `list_tags` / `create_tag` / `delete_tag` | 标签（`list_tags` 含关联未删任务数 `taskCount`；`delete_tag` 同步从所有任务移除） |
| `list_tasks` / `get_task` / `search_tasks` | 查询（`get_task` 包含标签与附件列表） |
| `create_task` | 创建（建议 `idempotencyKey`；可选 `parentId` 挂子任务） |
| `update_task` | 部分更新（可改 `parentId`，`null` 取消父子） |
| `nudge_waiting` | 对等待任务「要催」（生成下一步，幂等） |
| `complete_task` | 完成 |
| `delete_task` | 软删除 |
| `restore_task` | 从回收站恢复软删任务（默认列表不含软删） |
| `list_attachments` | 列出任务附件及当前存储配额用量 |
| `upload_attachment` | 上传任务附件（支持 base64，图片 / PDF，单文件 <=10MB） |
| `delete_attachment` | 删除任务附件并同步清理 R2 对象 |

`dueAt` 使用 `YYYY-MM-DD`。

### 项目归档

- `update_project` 传 `archived: true` 归档、`false` 取消归档。收件箱不能归档。
- 归档不删项目行，也不删、不改项目下的任务。
- `list_projects` 默认不含已归档；需要时传 `includeArchived: true`。

### `parentId` 子任务

- `create_task` / `update_task` 可传 `parentId`（任务 id）把当前任务挂到父任务下。
- 省略或 `null` 表示顶层任务。
- 服务端会拒绝自引用与成环（例如 A 父是 B、B 父是 A）。
- 硬删除父任务时，子任务的 `parent_id` 由数据库 `ON DELETE SET NULL` 清成顶层。
- 完成父任务（网页 / `complete_task`）时：未完成子任务提升为顶层（`parent_id` 清空，状态不变）；已完成子任务保持挂在父任务下；**不会**自动完成子任务。

### 今日焦点叶子

- `today_focus` 与网页今日同一条规则：有未完成（非 completed/cancelled、未软删）子任务的父任务不出现，只出可执行叶子。
- 下一步 / 项目列表仍会缩进展示父子，不受此规则影响。

### 任务附件（#133）

- `list_attachments`: 传 `taskId`，返回该任务的所有附件（含 `fileName`、`mime`、`size`、`contentUrl` 等）以及当前用户附件配额与用量 `usage`。
- `upload_attachment`: 传 `taskId`、`fileName`、`content`（文件的 base64 字符串，支持纯 base64 或 `data:image/...;base64,...`），可选 `mimeType`。单文件上限 10MB，支持格式：JPG、PNG、GIF、WebP、HEIC、PDF。
- `delete_attachment`: 传 `taskId` 与附件 `id`，从数据库与 R2 存储中同步删除。
- `get_task`: 返回的任务对象中包含 `attachments: AttachmentDto[]` 列表，方便助手直接查看附件元数据与下载地址。

### 标签管理（#122）

- `list_tags`: 返回当前用户的所有标签，每条带 `taskCount`（关联的未删除任务数，含已完成/已取消，不含回收站中的软删任务）。
- `create_tag`: 传 `name` 创建标签；同名已存在时返回已有标签。
- `delete_tag`: 传标签 `id` 删除当前用户的标签，自动从所有关联任务上移除该标签（不可恢复），并记入 `activity_log`；不存在或不属于当前用户时返回错误。

## 客户端配置示例

Cursor 全局配置：`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "gtd": {
      "type": "http",
      "url": "https://gtd.livs.top/mcp",
      "headers": {
        "Authorization": "Bearer gtd_your_token"
      }
    }
  }
}
```

本地开发可把 `url` 换成 `http://localhost:5173/mcp`。旧地址 `https://gtd.jonathanleelx.workers.dev/mcp` 仍然照常服务（不跳转，避免客户端丢掉 Authorization 头），已经配好的不用急着改，新配置请用 gtd.livs.top。改完后在 Cursor 里打开 **Settings → MCP**，确认 `gtd` 已启用；必要时 Reload。

### 活动记录合并（#115）

同一任务、同一来源的连续 `update_task` 如果只改标题 / 备注 / 优先级 / 日期 / 标签 / 等待谁，距上一次不到 2 分钟、且这段编辑从第一次起不超过 10 分钟，会合并成一条「更新任务」（时间取最后一次）。改状态 / 项目 / 父任务总是新起一条。网页和 MCP 规则相同，但两者之间互不合并。
