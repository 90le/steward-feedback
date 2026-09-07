# Octo 小码（runtimeId: implementation）

PRD v1 · 候选 r1

# 原型：incoming-webhooks 的 GitHub 适配器强制 X-Hub-Signature-256 校验

对应 Issue #11 / PRD v1（`5a730c3d916e999b65f88fbb6d75f67b18d1d418` 版本源码作为差距参考）。这只是**交互原型**，用于评审 PRD v1 中 UR-1～UR-7、AC-1～AC-9 描述的用户可感知行为，**不是 octo-server 真实实现**，也不改动上游任何代码。

## 启动方式

```bash
# Node 24（Node 内置模块，无外部依赖）
node server.mjs
# 或指定端口
PORT=4000 node server.mjs
```

- 打开 <http://127.0.0.1:PORT/>（默认 3000）即可看到管理端原型。
- 服务端渲染入口 `GET /` 会给页面根元素注入 `data-api="1"` 标记，前端凭该标记调用同源 `/api/...`；直接双击打开 `index.html`（无后端）时页面仍可用完整的**本地模拟**逻辑，便于纯前端预览。

## 页面主要交互

- **身份切换**：右上角下拉切换到 4 个模拟身份，`admin_alice` / `operator_bob` 拥有写权限，`viewer_carol` 只读，`anonymous` 未登录。前端会禁用写按钮；服务端也会独立校验（不仅依赖前端 disabled）。
- **Webhook 列表**：3 条模拟 webhook，展示是否开启「强制签名」和 secret 是否已配置；点击行选中。
- **详情面板**：
  - 切换「强制校验 X-Hub-Signature-256」开关（对应 UR-1/AC-2/AC-9）
  - 设置或清空 secret（保存后不再明文回显，对应 UR-6/AC-8）
  - 只读身份可看到禁用状态与提示
- **模拟 GitHub 投递**：
  - 选事件类型（`ping`/`push`/`pull_request`/`issues`）
  - 输入 URL token（自动带入选中 webhook 的 token）
  - 输入用于签名的 secret（留空 = 不携带签名）
  - 勾选「篡改请求体」以模拟中途被改包（对应 AC-4）
  - 点击「发送模拟投递」，页面通过 `/api/simulate-delivery` 让服务端按同一逻辑判定，或在无后端时使用本地 WebCrypto HMAC 校验
- **投递记录**：显示最近的受理/拒收结果和原因（`signature_missing` / `signature_mismatch` / `secret_missing` / `url_token_mismatch`），对应 UR-5/AC-7 演示。

## API 一览

| Method | Path | 说明 |
|-------|------|------|
| GET | `/api/health` | 健康检查（含当前身份） |
| GET | `/api/whoami` | 返回当前身份 |
| GET | `/api/webhooks` | 列出 webhook（不返回 secret 原文） |
| GET | `/api/deliveries` | 最近的模拟投递记录 |
| PUT | `/api/webhooks/{id}/signature` | 修改「强制签名」开关（admin） |
| PUT | `/api/webhooks/{id}/secret` | 设置/清空 secret（admin，响应不回显原文） |
| POST | `/api/simulate-delivery` | 用给定参数模拟一次 GitHub 投递，服务端按同一签名逻辑判定 |

所有请求携带 `X-User-Id` 或 `X-Acting-User` 用于选择模拟身份，头部长度上限 64。请求体最大 32 KiB，响应 JSON。

## 模拟身份

| ID | 角色 | 说明 |
|----|-----|------|
| `admin_alice` | admin | 可编辑开关与 secret |
| `operator_bob` | admin | 可编辑开关与 secret |
| `viewer_carol` | viewer | 只读 |
| `anonymous` | anon | 只读 |

## 原型与真实功能的边界

- 本原型**不**读写宿主文件、不联网、不调用真实 GitHub 或 octo-server 实例；所有数据在内存中，重启即清空。
- octo-server 上游 `POST /v1/incoming-webhooks/:webhook_id/:token/github` 当前实现（源码 `5a730c3d916e999b65f88fbb6d75f67b18d1d418`）仅使用 URL token 鉴权，`X-Hub-Signature-256` 校验为「留作后续可选项」。本原型演示的是 PRD v1 建议增加该能力后的**用户可感知行为**，不代表上游已实现。
- Secret、开关、投递记录都是模拟数据；secret 在管理端读接口中不返回原文，仅显示是否已配置。真实系统还应考虑存储加密、审计、轮换等，超出本原型范围。
- 前端「模拟投递」界面为便于演示直接展示 URL token 与 secret 输入框；真实系统的 secret 只在受控写路径进入服务端，不在管理端明文回显（详情面板已按此约束展示）。
- PRD v1 的 Q-1～Q-7 开放问题未在本原型中做假设：粒度默认按 webhook；secret 缺失时对所有事件（含 ping）一律拒收；仅报警不拒收的观察模式未提供。这些是评审前的临时选择，非最终结论。

## 无后端预览

将 `index.html` 单独打开（或放到静态托管）也可以体验完整交互：无 `data-api="1"` 标记时前端使用 WebCrypto 在本地按同样规则计算 HMAC-SHA256，用于展示投递受理/拒收。此模式与后端联调模式行为一致，但记录不会持久化。

## 自测记录

见任务返回的 `selfTest` 字段，包含语法检查、后端启动与几条 curl 用例的实际输出。
