# 千问网页版交互地图（仅诊断 / 维护用）

> 正常流程一律走 `qwb` CLI，不要读本文件去手写 DOM 操作。
> 本文件只在 `SITE_CHANGED` 诊断或维护选择器时使用。
> **全部来自真机验证（2026-09，Windows / Chrome 151 / Playwright 1.63）**。

## 页面结构（qianwen.com，中文界面）

- **输入框**：`[data-testid="chat-input-content-measure"]` 内的
  `[contenteditable="true"][role="textbox"]`（placeholder「向千问提问」）
  - **不是 textarea**（页面无可见 textarea）
- **发送**：`button[aria-label="发送消息"]`（有文字时才可用）
- **模式选择器**（composer 工具栏）：`button[aria-label="快速"|"思考研究"]`
  - **aria-label 就是当前模式名**，可直接读
  - 点开是菜单（`[role="menuitemcheckbox"]`）：
    `快速 适用于大多数情况` / `思考研究 深度搜索、深度研究`
  - ⚠️ **必须真实鼠标点击**（Playwright locator.click）；
    `element.click()` 合成点击**打不开菜单**（实测踩过）
- **新建对话**：侧栏「新建对话」按钮（aria「新建对话」）
- **附件**：`button[aria-label="添加附件"]`（触发隐藏 `input[type=file]`）
- **顶栏**：当前底层模型名（如「Qwen3.7-千问」）带下拉——v1 **未接**（见下「模型 vs 模式」）

## 回答 DOM（⚠️ CSS Modules：class 带随机后缀，必须 `[class*=]` 前缀匹配）

| 锚点 | 用途 |
| --- | --- |
| `[class*="question-text-card"]` | 用户消息卡片 |
| `[class*="answers-card-wrap"]` | 回答区容器 |
| `[class*="answer-common-card"]` | 单条回答（**推荐**） |
| `[class*="answer-receiving-card"]` | 生成中占位（可作为 streaming 信号） |
| `[class*="message-list-container"]` | 消息列表 |
| `[data-testid="chat-input-content-measure"]` | 输入区（稳定 testid） |

**判定模型回答**：`[class*="answer-common-card"]` 的最后一个；正文取其内部
`[class*="markdown"]` / `[class*="prose"]`，无则取卡片本身。
发送前必须记录 `answerCount` 基线，**只认新增**（页面会恢复上次会话）。

## ⚠️ 输入注入（本站最关键的坑）

**必须**：点击编辑器获得焦点 → `keyboard.insertText(text)` 一次性插入。

**禁止** `document.execCommand("insertText")`：文本能看见，但 **React 状态不更新，
发送按钮保持禁用**，点击无效（实测踩过——文本进了输入框、消息发不出去）。
也**不要**用 `keyboard.type()` 逐字符输入（慢，可能触发编辑器快捷键）。

## ⚠️ 阿里滑块验证（nocaptcha）

发送消息后**可能**弹出「亲，请拖动下方滑块完成验证」（阿里 `_____tmd_____/punish` 风控）：

- 新环境 / 新 profile 首次使用**大概率弹**；通过一次后设备被记住，通常安静一段时间
- 验证弹窗会**拦住已发出的消息**：回答卡在 `answer-receiving-card` 占位、
  `POST /api/v2/chat` 被 punish，**不会有文本**
- 处理：检测到验证 → 停止轮询等用户完成（`waitForChallengeCleared`）→
  通过后**重新发送**（原消息已被拦，不会自动恢复）
- 检测锚点：body 全文匹配 `请拖动下方滑块完成验证|通过验证以确保正常访问`
  （⚠️ 不要按「元素结构」找——弹窗层级深、文本长，结构匹配会漏检，实测踩过）

## 生成请求端点

```
POST https://chat2.qianwen.com/api/v2/chat?biz_id=ai_qwen&...   （生成主端点，主判据）
GET  https://www.qianwen.com/api/v2/models/                      （模型配置）
POST https://www.qianwen.com/api/v2/users/status                 （登录态）
GET  https://www.qianwen.com/api/v1/auths/                       （账号信息）
```

**完成判定**：网络结束 + 文本连续 N 次采样不变 + 只认新增回答，三个条件都要满足。

## 会话 URL

```
https://www.qianwen.com/chat/<16位十六进制>
例：https://www.qianwen.com/chat/08119b08967e439cabf41d1a2af35ad3
游客模式：https://chat.qwen.ai/c/guest（国际站 chat.qwen.ai 的游客会话）
```

## 匿名（游客）模式

未登录可完整问答（额度受限）。注意 `qianwen.com`（国内站）与 `chat.qwen.ai`（国际站，
标题「Qwen Studio」）是**两个前端**；本仓库只驱动 `qianwen.com`。

## 模型 vs 模式（v1 设计决策）

- composer 工具栏的「快速 / 思考研究」是**模式**（对应 deepseek 的开关语义），
  CLI 映射为 `--think on/off`。
- 顶栏的「Qwen3.7-千问 ⌄」是底层模型选择，**其菜单锚点未真机验证**（v1 未接入）；
  底层模型由站点自动分配。接入前不要猜选择器。

## 失败形态

- 滑块验证：body 含「请拖动下方滑块完成验证」；网络侧 `_____tmd_____/punish`
- 限流：`请求过于频繁` / `稍后再试`
- 站点改版：编辑器 / 发送按钮 / 模式选择器定位失败

## 维护规则

- 选择器集中在 `scripts/qwb/src/site.mjs`，改完跑 `doctor --deep` 与单测。
- 不要在别处散落选择器。
