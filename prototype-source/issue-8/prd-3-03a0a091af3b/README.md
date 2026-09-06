# Octo 小码（runtimeId: implementation）

PRD v3 · 候选 r1

# 群投票 · 发起人修改未截止投票的截止时间（演示原型）

> 关联 Issue [#8](https://github.com/90le/steward-feedback/issues/8) · PRD v3
> 这是 Octo 小码为评审用的可运行原型，不是 Octo 上游的真实功能。数据只保存在进程内存，重启即失。

## 目录内容

- `index.html`：单文件前端（原生 HTML/CSS/JS，无第三方依赖，无外链，无 iframe）。
- `server.mjs`：Node 24 内置 `http` 模块实现的演示后端，无第三方依赖。
- `README.md`：本说明。

## 启动方式

Node 24 已可用，无需 `npm install`。

```
# 默认端口 3000
node server.mjs

# 指定端口
PORT=8080 node server.mjs
```

访问 `http://127.0.0.1:3000/`，服务端会给 HTML 注入 `data-api="1"` 标记，前端据此调用同源 `/api/...`。
直接双击打开 `index.html` 亦可预览：此时无后端，前端会自动降级为本地模拟数据，可完整操作。

## 模拟身份（不接真实账户系统）

| x-user-id | 说明 |
| --- | --- |
| `u_alice` | 发起人（发起 p1、p3） |
| `u_bob` | 已投票成员（对 p1 投火锅、对 p3 投坚果） |
| `u_carol` | 未投票成员（对 p1 未投） |
| `u_dave` | 其他群成员，非发起人；同时也是 p2 的发起人 |
| `u_admin` | 群管理员，非 p1/p2/p3 发起人 |

演示投票种子数据：

- `p1` 周五团建去哪家？ 发起人 Alice，未截止，Bob 已投票。
- `p2` 下季度技术分享主题，发起人 Dave，未截止，无人投票。
- `p3` 办公室零食采购，发起人 Alice，**已截止**，Bob/Carol 曾投票。

前端右上方切换身份即会重新拉取；后端识别请求头 `x-user-id`（前端自动携带）。

## HTTP 接口

所有接口需要通过 `x-user-id` 表明模拟身份（`GET /api/polls` 允许匿名，仅缺少 `myVote`/`isOwner`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 返回带 `data-api="1"` 的前端页面 |
| `GET` | `/api/health` | 健康检查，返回 `{ok:true, ...}` |
| `GET` | `/api/polls` | 群内投票列表，含每选项票数、我的投票、`isOwner`、`isClosed` |
| `POST` | `/api/polls/:id/vote` `{optionId}` | 投票（仅在未截止时可投） |
| `PATCH` | `/api/polls/:id/deadline` `{deadline: ISO8601}` | 发起人修改截止时间 |
| `GET` | `/api/notices` | 当前身份收到的"截止时间变更"通知 |
| `POST` | `/api/notices/:id/read` | 标记通知为已读 |
| `POST` | `/api/reset` | 重置演示数据（测试辅助） |

## 服务端独立校验（不只靠前端禁按钮）

`PATCH /api/polls/:id/deadline` 服务端会依次拒绝：

- `401 not_authenticated`：`x-user-id` 未提供或无效。
- `404 poll_not_found`：投票不存在。
- `403 not_owner`：当前身份不是该投票的发起人（即便前端隐藏了按钮）。
- `409 poll_closed`：投票已截止。
- `400 bad_json` / `400 bad_deadline` / `400 deadline_not_future`：请求体或时间不合法。

任一失败分支都**不**修改 `poll.deadline`，保持原状态（对应 PRD R5/AC6）。

修改成功后：

- 更新 `deadline`，`changeSeq +1`（对应 PRD R3/AC4）。
- 仅对**已投票成员**写入一条通知，同一次 `changeSeq` 对同一成员不重复（对应 PRD R4/AC5、N6）。
- 不改动选项、投票记录、参与资格（对应 PRD R6/AC7）。

## 与 PRD 验收标准的对应

| PRD | 演示表现 |
| --- | --- |
| AC1 发起人可见入口 | 切换到 Alice 查看 `p1`/`p3`：`p1`（未截止）显示"修改截止时间"按钮 |
| AC2 非发起人不可修改 | Bob/Carol/Dave/Admin 看 `p1` 时无按钮；有后端时可点"尝试直接调用 API"，被 403 拒绝 |
| AC3 已截止不能修改 | Alice 看 `p3`（已截止）无按钮；直接调 API 返回 409 |
| AC4 修改后展示新时间 | 成功后列表中的截止时间刷新为新值 |
| AC5 已投票成员收到一次提示 | Alice 改 `p1`，Bob 切换身份后可见通知 1 条；同一次修改再次刷新不会新增 |
| AC6 失败保持原状态 | 输入过去时间或无权限，前端提示失败，`deadline` 未变 |
| AC7 已投票记录不变 | 改截止时间前后 Bob 的选票仍为火锅、总票数不变 |

## 前端行为

- 稳定 `data-testid`：`identity-switch`、`poll-<id>`、`deadline-<id>`、`options-<id>`、`vote-<pollId>-<optionId>`、`count-<pollId>-<optionId>`、`edit-btn-<id>`、`edit-hint-<id>`、`edit-modal`、`edit-input`、`edit-submit`、`edit-cancel`、`notice-list`、`notice-<id>`、`notice-open-<id>`、`notice-read-<id>`、`notice-count`、`toast`、`toast-item`、`mode-tag`、`reset-btn`、`badge-open`、`badge-closed`、`tag-owner`、`force-edit-<id>`。
- 无外链资源、无 cookie 读取、无 `iframe`、无外部脚本。
- 页面顶部"模式：本地模拟 / 真实后端"随 `data-api` 自动切换。

## 边界与限制（不是 Octo 真实功能）

- 仅本地内存数据，重启清空；不写入宿主任何文件。
- 身份切换只靠请求头 `x-user-id`，无鉴权、无会话，不用于生产。
- 通知投递通道为原型内的"我的通知"面板；PRD 开放问题 Q3（真实通道形式）留待人类产品负责人决策。
- 未实现 PRD 非目标 N1–N6 中的任何附加动作（例如群管理员代改、题目/选项修改等）。
- 是否允许多次修改（Q4）原型不做次数限制，等评审确认策略后再收敛。
