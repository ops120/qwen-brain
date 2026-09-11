# [QWB] 规划 / 审查协作协议（可选，实验性）

用途：让千问当「规划与审查大脑」，本地 agent 保留全部执行权。
与 deepseek-brain 的 `[DSB]` 同构；数据面是**推送**——千问网页版不能自己拉数据。

## 原则

- 控制消息 < 1 KB，只带状态与文件名；**不贴 diff、不贴日志、不贴整文件**。
- 需要代码时推送**最小片段**（`--prompt-file`），发送前过闸门。
- 会话即上下文：一个任务一个会话；会话丢了才 HANDOFF。

## 状态机

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED)
```

## 怎么跑（CLI 封装与解析）

信封由 `qwb` 自动封装，回复状态由代码解析，你只写正文：

```bash
# 起循环
qwb ask --protocol INIT --task qwb_f81a --iteration 0 --prompt-file goal.txt --json
# 执行完汇报（正文只写元数据）
qwb ask --protocol EXECUTED --iteration 1 --prompt-file report.txt --json
```

返回里读 `protocol.reply.state`（`PLAN` / `DONE` / `BLOCKED`）；
`--task` / `--iteration` 省略时自动沿用工作区 session 的值。
checkpoint 自动写入 session（`qwb thread status --json` 可查）。

> 深度规划建议加 `--think on`（思考研究模式）：PLAN 质量明显更好，但单轮 1–3 分钟，
> 请把 `--timeout` 给足。

## 消息形状（CLI 自动生成）

```
[QWB]
STATE: INIT
TASK_ID: qwb_f81a
ITERATION: 0

GOAL:
<一段话目标>
```

- **PLAN**（千问 → 你）：应含 ACTIONS / FILES_LIKELY_INVOLVED / TESTS / SUCCESS_CRITERIA；
  只有空泛结论就要求展开一次。
- **EXECUTED**（你 → 千问）：只报元数据（改动文件数、测试结果）+「请复核」。
  执行权永远在本地，**不要**交出去。
- **REVIEW**（千问）：DONE / PLAN（下一轮）/ BLOCKED。

## 限额与断点

- 建议单个任务不超过 12 轮；到顶暂停问用户（这是给 agent 的使用约定，不是 CLI 参数）。
- 进度写进工作区 session（`qwb session set`）：`protocolState / waitingFor / nextStep / knownIssues`（有长度上限）。
- 会话丢失 → 依据 session 生成 HANDOFF 简报（目标 / 进度 / 当前状态 / 已知问题 / 下一步），**不粘贴日志或 diff**。

## 注意

- 本协议是**约定**：千问不会真的执行任何操作，执行永远由本地 agent 完成。
- 每轮结束后把结论**逐字**带回当前对话，并附来源标签。
- 匿名（游客）模式下对话不进云空间，线程丢失后无法从侧栏找回——重要任务建议登录后跑。
