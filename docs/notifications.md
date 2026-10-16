# 到期提醒（网页推送，第一期）

每天在用户选的本地时刻发一条网页推送，列出今天到期和逾期的任务。点通知打开 `/today`。可选「明天到期」预览，默认关。渠道目前只有网页推送；定时任务和去重不认识具体渠道，以后加邮件只要再实现一个 `NotificationChannel`。

## 行为

- 时间只能选 `:00` / `:15` / `:30` / `:45`。默认 09:00，时区默认 `Asia/Shanghai`。
- 「今天 / 明天」是用户 IANA 时区里的 `YYYY-MM-DD`，和任务的 `dueAt` 按日期字符串比较。已完成、已取消、已删除、以及还有未完成子任务的父任务都不进推送。当天没有任务就不发。
- 标题：`今天 N 条到期 · M 条逾期`。正文最多 3 条标题（超出用 `…` 截断），还有更多时加一行 `还有 K 条`。任务集合和排序与今日页相同，但没有今日页的 100 行上限，所以「还有 K 条」是全量。
- 测试通知走同一个 `sendWebPush`，不写 `notification_log`，所以不会占掉当天的正式汇总。

## 定时任务

`wrangler.json` 里两条 cron：

- `*/15 * * * *`：到期提醒
- `0 3 * * *`：原有的每日清理（附件、回收站）

`scheduled` 按 `event.cron` 分支。提醒这一轮只做两条带索引的查询：`next_due_digest_at <= now`，以及 `next_tomorrow_at <= now`。不扫全部用户，也不在 cron 里重算时区。

保存设置时，在同一次 D1 batch 里把下次触发时间写成 UTC（`next_due_digest_at` / `next_tomorrow_at`）。总开关或「明天」关掉时，对应列写成 NULL，索引扫不到。发送成功、用户改时间或改时区之后重算。

## 去重和失败

`notification_log` 的主键是 `(user_id, kind, local_date)`。`local_date` 是**预定时刻**在用户时区的日期，不是 cron 跑起来的那一瞬间，所以同一档补发共用一条占位。

`INSERT … ON CONFLICT DO NOTHING`。只有插入成功才发送。

- 全部设备都失败（超时等）：删掉占位，`next_*_at` 不动。下一轮 15 分钟会再试。
- 预定时刻之后超过 2 小时仍没发成：放弃当天，把 `next_*_at` 推到下一天。正好 2 小时仍算可补发。
- 部分成功：算已发，不补发，避免成功的设备收到两条。
- 订阅返回 HTTP 404 或 410：删掉那一行。只要还有别的设备成功，就不算全部失败。一台都没成功时，仍按全部失败补发。
- 当天没有任务：保留占位，并把下次时间推到下一天，当天不再试。
- 还没有 VAPID 密钥：不占位，留给下一轮；超过 2 小时则放弃并推到下一天。

## 表

迁移 `drizzle/0006_notifications.sql`：

- `push_subscriptions`：`user_id`、`endpoint`（主键，全局唯一）、`p256dh`、`auth`、`created_at`、`last_success_at`
- `notification_settings`：每人一行。总开关、汇总时间、明天开关和时间、是否包含逾期、IANA 时区、两个 `next_*_at`
- `notification_log`：主键 `(user_id, kind, local_date)`

## D1 往返

次数来自 `createCountingD1`（一次 `db.batch` 算 1 次往返）。本地测到的数字：

| 操作 | 往返 | 语句 |
| --- | --- | --- |
| 保存设置（不带订阅） | 1 | 2（upsert + 数订阅） |
| 保存设置（带本机订阅） | 1 | 3 |
| cron，没有人到期 | 1 | 2（两条索引查询） |
| cron，N 个用户要处理且发送成功 | 1 + 3N | 扫描 2 条，每人：占位 1 + 任务和订阅 1 次 batch（2 条）+ 收尾 1 次 batch（推进下次时间，并更新或删除订阅） |

N = 2 时测到 7 次往返、12 条语句。增长跟「这一刻 `next_*_at` 已到」的人数走，不跟用户总数走。

## 延迟

这套环境打不到生产 D1，下面不是线上毫秒数。

- 保存设置是 1 次 D1 batch，和现有设置自动保存同一量级，设计上落在 1 秒以内。本地 sqlite 上这一次 batch 远小于 1 秒。
- 打开任务的路径没有改，仍是 #119 的至多 1 次 D1 往返，仍在 0.8 秒那一档。推送不参与打开任务。

## VAPID

加密是 Workers 上的 WebCrypto（RFC 8291 `aes128gcm` + RFC 8292 VAPID），不用 Node 的 `web-push`。私钥只来自 Worker secret。

本地：

```sh
node scripts/generate-vapid.mjs
```

把打印出来的 `VAPID_PUBLIC_KEY` 和 `VAPID_PRIVATE_KEY`（一行 JWK JSON）写进 `.dev.vars`。`VAPID_SUBJECT` 可选，须是 `mailto:` 或 `https:`，默认 `mailto:push@gtd.livs.top`。

生产（不要写进 `wrangler.json`，也不要提交私钥）：

```sh
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
wrangler secret put VAPID_SUBJECT
```

公钥也可以只放在前端；这里改成从接口读 `VAPID_PUBLIC_KEY`，这样本地和生产可以用不同的密钥对。接口不会返回私钥。

推送的 POST 只发往已知推送主机（FCM、Mozilla、Apple、Windows），并且 `redirect: "manual"`，避免 cron 被拿去请求任意 URL。

## 设置页

权限只在总开关打开时请求，进页面不请求。总开关关掉时，时间和子开关变灰但还在。明天的时间只在「明天到期」打开时出现。本机没订阅、账号已经开着、而且还有别的设备时，显示「其他 N 台设备已开启」。浏览器不支持、权限被拒、或 iPhone 没加到主屏幕时，开关是 `aria-disabled`，并用 `aria-describedby` 指到说明。保存状态是「保存中…」然后「已保存」。

## 测试

`pnpm test` 覆盖：

- 同一窗口跑两次 cron，只推一条（占位唯一）
- 404 / 410 删除订阅，其它状态保留
- 全部失败删占位，下一轮补发；超过预定时刻 2 小时则放弃并改到下一天；正好 2 小时仍补发
- 部分成功不补发
- 测试通知不写占位，同一天的正式汇总仍会发
- RFC 8291 附录密文
- 设置页：权限只在打开时请求、15 分钟档、关掉时子项变灰但仍可见、三种不可用状态的 `aria-disabled`、其它设备文案、「已发送」

需要真人的部分：已开启的设置页截图、iPhone 未添加到主屏幕的截图、真机收到推送。这三种状态在界面上都可以走到（`data-push-block` 分别为 `ok` / `ios-install`，以及系统通知），但本环境没有登录会话，也没有 iPhone，没有截这些图。
