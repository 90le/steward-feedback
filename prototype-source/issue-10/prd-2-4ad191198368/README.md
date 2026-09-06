# Octo 小码（runtimeId: implementation）

PRD v2 · 候选 r1

# 提醒稍后再提醒（snooze）原型 · PRD #10 v2

演示 PRD v2 的用户结果 R1–R11 与验收标准 AC1–AC12。这是模拟原型，不接入真实 Octo，不写入宿主数据，不联网。

## 目录内容

- `index.html`：单文件前端。默认在浏览器直接打开可用本地模拟数据操作；当被 `server.mjs` 提供时，页面 `<html>` 会被注入 `data-api="1"`，前端切换到 `fetch` 联调模式。
- `server.mjs`：Node 24 HTTP 服务（仅内置模块），提供 `GET /` 返回带 `data-api="1"` 的 HTML，以及模拟数据的 REST 接口。
- `README.md`：本说明。

## 启动

```
node server.mjs                 # 默认端口 3000
PORT=8080 node server.mjs       # 自定义端口
```

打开 `http://127.0.0.1:PORT/` 使用联调模式。也可以直接双击 `index.html`（无后端，纯本地模拟）。

## 静态预览（无后端）

页面 `<html>` 无 `data-api="1"`，前端使用内存模拟数据。所有交互、模拟身份切换、"稍后再提醒"设置/修改/取消、明确处理/仅查看、延后到点重现、失败模拟均可操作。数据仅在本页面生命周期内保留。

## 联调预览（有后端）

`server.mjs` 提供 `GET /` 时在 HTML 上加 `data-api="1"`。前端所有业务动作走同源 `/api/...`，服务端独立校验身份与业务边界（如时间必须晚于当前、他人提醒禁止操作、已处理不能再延后）。

## 模拟身份

服务端不接真实用户系统，仅识别以下三个模拟账户，通过 `X-User-Id` 头传递：

| userId | 说明 |
|---|---|
| `u1` | 我（Alice） |
| `u2` | 队友 Bob |
| `u3` | 队友 Carol |

前端顶部下拉切换即可。任何未列出的 userId 视为未认证。

## 模拟"当前时间"

页面顶部可调节 "模拟当前时间" 和 "+1 分钟 / +15 分钟"。前端在调用后端时通过查询串 `?now=<毫秒>` 或 `X-Now` 头传递，用于稳定验证 AC3（到点重现）与 AC7（时间校验）。真实系统应以服务端时钟为准；这里为演示 PRD 的可感知结果而暴露此开关。

## 接口

- `GET /api/health` → `{ok:true, ...}`
- `GET /api/reminders?userId=<u1|u2|u3>&now=<ms>` → `{now, reminders:[{...,view:'active'|'snoozed'|'done'}]}`
- `POST /api/reminders/:id/snooze`（`X-User-Id`, body `{until, now?}`）→ 设置/修改延后；服务端校验：属于本人、未处理、until > now
- `DELETE /api/reminders/:id/snooze`（`X-User-Id`, `X-Now`）→ 取消延后
- `POST /api/reminders/:id/done`（`X-User-Id`, `X-Now`）→ 明确标记已处理；同时清除本人对该提醒的延后安排（R9）
- `POST /api/reminders/:id/undone`（`X-User-Id`, `X-Now`）→ 恢复为未处理（原型用，便于测试）
- `POST /api/reminders/:id/view`（`X-User-Id`, `X-Now`）→ 仅记录本人查看时间，不改变处理/延后状态（R10）
- `POST /api/reset` → 恢复初始模拟数据（原型用）

错误统一返回 JSON `{code, message}`，HTTP 状态码使用 4xx/5xx，用于验证 AC8（失败可感知）。

## 覆盖 PRD 验收点

- AC1/R1、AC2、AC3/R3、AC4/R4、AC5/R4：通过 "稍后再提醒"、"修改延后"、"取消延后"、调整当前时间验证。
- AC6/NG1、NG3：本原型仅在提醒列表内展示，不模拟"原消息状态"变更，也不产生任何群内系统消息；后端接口不会修改原消息字段（原型无原消息实体）。
- AC7/R8：前端与服务端均校验 `until > now`，任一端拒绝均给出错误提示。
- AC8/R7：切换"模拟网络失败"开关或让 until 非法可看到红色提示，UI 状态不改。
- AC9/R6：切换到其他身份或"其他人视图"标签页，可以看到他人的提醒无 snooze/done 入口；后端对非本人操作返回 403。
- AC10/R9：延后中点"标记已处理"，delete snoozeUntil，到期不再重现。
- AC11/R10：延后中点"查看原消息"仅记录 viewedAt，到达延后时间仍按 AC3 重现。
- AC12/R11：以上处理/查看动作只影响操作人本人；其他用户的同一 `messageId` 提醒不受影响，可在"其他人视图"验证。

## 边界

- 演示用途，进程重启数据丢失；无持久化、无鉴权、无审计。
- 不实现真实的原消息、群、通知推送。R5/AC6 中的"原消息零改动"由"接口根本不触碰原消息实体"隐式满足。
- 不联网加载资源；`iframe`、外链、cookie 未使用。
- 不作为 Octo 真实功能上线的证据；生产实现的存储、并发、多端联动策略需另行设计与评审。
