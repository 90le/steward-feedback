# Octo 小码（runtimeId: implementation）

PRD v3 · 候选 r1

# 提醒稍后再提醒（snooze）· 原型 v3-r1

对应需求：[steward-feedback#10](https://github.com/90le/steward-feedback/issues/10) PRD v3。
仅为交互原型与演示代码，用于评审与人工验收，**不是** Octo 真实功能。

## 启动

Node 24，无外部依赖。任意工作目录：

```bash
node server.mjs            # 默认监听 3000
PORT=4000 node server.mjs  # 或自定义端口
```

打开 http://localhost:3000/ 即可。

- 静态预览（无后端，直接双击 `index.html` 或用静态服务器打开）也可运行：此时页面不带 `data-api` 标记，自动使用内置本地模拟数据；所有交互仍可点。
- 通过 `server.mjs` 启动时，`GET /` 会在 `<html>` 上注入 `data-api="1"`，前端通过 `fetch('/api/...')` 与同源后端联调。

## 模拟身份

只作为演示数据，服务端从请求头 `x-uid` 读取；不接真实用户系统。

- `alice`、`bob`、`carol`：三个成员。
- 未提供或未知身份视为未认证（HTTP 401）。

前端左侧「身份切换」直接点选。前端每次 `fetch` 自动带 `x-uid`。

## 接口（同源，JSON）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/`                       | 返回带 `data-api="1"` 的前端 |
| GET  | `/api/health`             | 健康检查，返回 `{ok, now}` |
| GET  | `/api/list`               | 当前身份的提醒列表（含到期自动激活） |
| GET  | `/api/messages`           | 群消息全量（用于展示"原消息位置"） |
| POST | `/api/setSnooze`          | `{id, until}` 设置延后，`until` 为 ms 时间戳，须晚于服务端当前时间 |
| POST | `/api/editSnooze`         | `{id, until}` 修改延后，语义同上，要求当前处于 snoozed |
| POST | `/api/cancelSnooze`       | `{id}` 取消延后，恢复未处理 |
| POST | `/api/resolve`            | `{id}` 明确标记为已处理；延后期间调用等同于同时取消延后 |
| POST | `/api/view`               | `{id}` 记录"查看原消息"，**不改变**任何状态 |
| POST | `/api/fail`               | 手动注入失败，用于 AC8 演示 |

**服务端强制约束**（不依赖前端禁按钮）：

- 未认证：401。
- 操作他人提醒：403。
- `setSnooze/editSnooze` 时 `until <= 服务端当前时间`：400 `NOT_FUTURE`，附 `serverNow`，前端据此把"当前时间"提示对齐到校验基准。
- 已处理的提醒不可再延后：409 `ALREADY_DONE`。
- 未在延后状态却调用 `editSnooze/cancelSnooze`：409 `NOT_SNOOZED`。
- 请求体过大 / JSON 解析失败：400。

失败一律不修改状态，前端 toast 明确提示错误码或原因（对应 R7/AC8）。

## 与 PRD 验收标准的对应

| AC | 演示位置 |
|---|---|
| AC1 设置后消失于活跃列表 | 点某条活跃提醒的「稍后再提醒」，选未来时间，确定；该项从「活跃提醒」消失，出现在「已延后」标签页。 |
| AC2 只影响本人 | 左侧「其他人视图」黄条实时显示其他 uid 的提醒状态未变。 |
| AC3 到点重现 + 真实定位原消息 | 用「+16 分钟」推进模拟时钟到 snoozeUntil 之后，提醒回到「活跃提醒」；点「查看原消息」——左侧群聊视图会**滚动定位并高亮闪烁**对应消息（不是仅弹一句"已定位"）。 |
| AC4 修改时间 | 「已延后」中的「修改时间」，选另一未来时间点，保存后按新时间到点重现。 |
| AC5 取消延后 | 「已延后」中的「取消延后」立即恢复到活跃列表且状态为未处理。 |
| AC6 原消息零改动 | 左侧群聊视图内容/顺序/展示与操作前一致，未出现任何"系统提示"。 |
| AC7 不晚于当前时间 | 在弹窗中选择过去时刻确定；错误 toast 显示，且模态框「当前时间」标签变红并对齐到服务端 now。 |
| AC8 失败保留原状态 | 触发 `/api/fail`（或断网、调用不存在的 id）时，UI 保持原状态并弹出错误。 |
| AC9 不能操作他人提醒 | 切到 alice，`fetch /api/setSnooze` 传 bob 的提醒 id 会 403。前端仅显示本人提醒的入口。 |
| AC10 明确处理即取消延后 | 在「已延后」标签内点「标记已处理」；即使推进时钟超过 snoozeUntil，也不会重现。 |
| AC11 仅查看不视为处理 | 在「已延后」点「查看原消息」后，延后状态和 snoozeUntil 均未变；到点仍会重现。 |
| AC12 只影响本人 | 「其他人视图」实时对照 alice/bob/carol 各自的状态互不干扰。 |
| AC13 时间基准一致 | 打开「模拟前端时间偏移（+3 分钟）」，选一个前端看晚于当前但服务端认为不晚于的时刻，会得到 `NOT_FUTURE`，弹窗提示自动切到服务端 now。 |
| AC14 查看不改状态 | 在延后状态下点「查看原消息」——群聊视图真实展示并高亮；返回列表，延后 / 再次提醒时间 / 未处理标记均不变，推进时钟到点后仍按 AC3 重现。 |

## 稳定 `data-testid`

前端主要控件均有稳定 `data-testid`，供独立测试者定位：

- 身份：`identity-switch`、`user-alice/bob/carol`
- 时钟：`sim-clock`、`clock-advance-1m/16m/1h`、`clock-reset`、`skew-toggle`
- 群聊：`chat-view`、`chat-msg-<msgId>`
- 列表：`reminder-list`、`tab-active/snoozed/resolved`、`reminder-<id>`（带 `data-status`/`data-msgid`）、`empty-<tab>`
- 单项按钮：`snooze-<id>`、`edit-snooze-<id>`、`cancel-snooze-<id>`、`resolve-<id>`、`view-orig-<id>`、`snooze-until-<id>`
- 延后弹窗：`snooze-modal`、`snooze-datetime`、`preset-15m/1h/3h`、`snooze-cancel`、`snooze-confirm`、`now-hint`
- Toast：`toast-area`、`ok-snooze-<id>`、`err-not-future-<id>`、`err-resolve-<id>` 等
- 他人视图：`others-alice/bob/carol`

## 原型与真实功能的边界

- 本原型只演示 PRD 用户结果与验收路径，**未接入** Octo 真实用户体系、真实群消息、真实提醒存储、推送/桌面通知、多端联动等。
- 内存模拟数据，进程重启即重置。
- 「模拟当前时间」与「前端时间偏移」按钮只是为了让评审者在几秒内验证 AC3/AC13/AC14；真实系统的时间来源不在 PRD 范围内。
- 未加载任何外部资源、未使用 iframe、未读取 cookie、未弹外链。
- 不修改上游仓库，不发布，不写宿主目录。
