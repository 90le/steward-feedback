# octo-server 反馈与需求池

这里收集 **octo-server 的 Bug 和功能需求**，并在 Issue 中跟踪澄清、PRD、评审与修订记录。

上游源码位于 [Mininglamp-OSS/octo-server](https://github.com/Mininglamp-OSS/octo-server)。Steward 团队只读查阅上游源码；本仓库不托管上游代码，也不负责代码合并或软件发布。

## 从这里开始

| 你想做什么 | 入口 |
| --- | --- |
| 先查重、查看进度 | [搜索所有 Issue，包含已关闭事项](https://github.com/90le/steward-feedback/issues?q=is%3Aissue) |
| 报告已有行为异常 | [提交 Bug](https://github.com/90le/steward-feedback/issues/new?template=bug_report.yml) |
| 提出新能力或体验改进 | [提交 Feature](https://github.com/90le/steward-feedback/issues/new?template=feature_request.yml) |
| 不确定如何分类 | [选择模板或新建空白 Issue](https://github.com/90le/steward-feedback/issues/new/choose) |
| 了解填写方法与公开资料边界 | [反馈指南](CONTRIBUTING.md) |
| 看懂分类、优先级与进度 | [标签与状态](docs/labels.md) |
| 整理或评审需求 | [PRD 模板](docs/templates/prd.md) · [评审模板](docs/templates/review.md) |

在已接入且开通收单的 Octo 会话中，也可向小丘反馈。收到 Issue 链接后，请在该事项中继续补充，避免重复建单。

## 三个角色

| 角色 | 职责 |
| --- | --- |
| **小丘**（产品管家） | 产品问答、澄清场景、查重、收单与状态回报。 |
| **小助**（PRD 作者） | 根据原始诉求撰写 PRD，回应补充信息和评审意见，修订文档。 |
| **小衡**（独立评审） | 对照原始诉求与具体 PRD 版本，检查目标、范围和用户验收标准。作者不能自审。 |

## 预期协作流程

1. **查重与登记**：先搜索已有事项；重复反馈补充到原 Issue。信息不足时，只补充判断问题所需的事实。
2. **分类与澄清**：记录类型、影响和优先级，默认 `priority/p2`。Bug 留下可追踪的缺陷记录；功能需求进入 PRD 流程。Bug 不默认进入 PRD 流程。
3. **起草与评审**：小助写明用户问题、目标结果、范围和验收期待；小衡评审对应版本。需要修订时，小助逐项回应后再交评审；需要用户决策时，先澄清。
4. **PRD 就绪与后续跟踪**：独立评审通过后标记 `status/prd-ready`。新增诉求或修改范围仍需复核，旧评审只覆盖当时的版本。

**PRD 就绪表示需求文档已通过评审，不表示已经开发、修复或发布。** Issue 的打开、关闭及关闭原因需另外查看；具体含义见[标签与状态](docs/labels.md)。

以上说明预期协作方式。自动收单、扫描、PRD 流转和通知的可用性取决于实际接入与验收状态，不能由本文认定已稳定运行。请以 Issue 中已发布的产物、评审结论和实际回执为准；本仓库不承诺响应或软件交付时限。

通知约定是回报已有产物、实际变化或需要补充、人工处理的事项；没有变化时保持静默。你也可以关注 Issue，并在原记录中补充复现条件、使用场景或针对具体 PRD 版本的意见。

## 公开提交前

Issue、评论及附件公开可见。请勿提交密钥、Webhook 地址、私聊原文或个人身份信息；截图和日志需先脱敏。安全漏洞请使用[上游安全政策](https://github.com/Mininglamp-OSS/octo-server/blob/main/SECURITY.md)所列渠道私密报告。
