# qwen-brain

把**千问网页版**（qianwen.com，阿里）当作编码 agent 的**外部大脑**：它出推理、检索与内容，你的 agent 出执行。
不需要 API key，不做逆向代理 —— 只驱动官方网页。

- 由本地 CLI 驱动（文档中简写为 `qwb`；它等价于 `node "$SKILL_ROOT/scripts/qwb/cli.mjs"`，不是安装出来的可执行文件），Agent 只负责调用与判断
- **匿名即可用**（游客模式），登录可选 —— 全家族唯一；登录解锁更多额度与生图 / 生视频等能力
- 发送前有确定性脱敏闸门（私钥整段拒绝、密钥形状脱敏、家目录路径脱敏、尺寸上限）
- 支持 `[QWB]` 协作协议：让千问做 PLAN → 你执行 → 它 REVIEW 的循环

> ⚠️ **合规与账号风险**：本项目通过浏览器自动化驱动千问官方网页版，
> 可能不符合阿里服务条款，存在账号被风控（滑块验证 / 限流）的风险。
> 请自行评估并遵守平台条款，**风险自负**；仅供低频个人使用，不要批量滥用。

## 目录

- [能力](#能力)
- [安装](#安装)
- [登录（可选）与持久化](#登录可选与持久化)
- [快速上手](#快速上手)
- [自然语言驱动举例](#自然语言驱动举例)
- [命令面](#命令面)
- [返回值契约](#返回值契约)
- [协作协议](#协作协议qwb)
- [失败处理](#失败处理)
- [状态与隐私](#状态与隐私)
- [原理与已知坑](#原理与已知坑)
- [边界](#边界)
- [项目结构](#项目结构)
- [同族项目](#同族项目)

## 能力

千问网页版相对其他「网页版大脑」的差异能力：

| 能力 | 说明 | 怎么用 |
| --- | --- | --- |
| **思考研究模式** | 深度搜索 + 深度研究（多步检索归纳、带来源） | `--think on`（实测单轮 1–3 分钟） |
| **中文 / 本土信息** | 中文语义与国内实时信息是强项 | 直接提问即可 |
| **匿名可用** | 未登录即可问答（游客模式，额度受限） | `setup` 时关闭浏览器跳过登录 |
| **多模态理解** | 图片 / 文件分析 | `--attach a.png,b.pdf` |
| **长文本** | 单次正文 ≤ 50 KB（按 UTF-8 字节计，仅正文、不含附件）；超限报 `PAYLOAD_TOO_LARGE` | `--allow-large` 放宽到 200 KB |
| **协作循环** | 规划 / 执行 / 复核的迭代协议 | `--protocol <状态>` |

> **模式 vs 模型**：千问网页版对外暴露的是「模式」两档——`快速`（默认）与
> `思考研究`（深度搜索 / 深度研究），CLI 用 `--think on/off` 切换并回读实际生效模式。
> 底层模型（如 Qwen3.7-千问）由站点自动分配，**不可自选**。

**v1 未自动化**：AI 生图工作室 / PPT 创作 / 工作助理 / 定时任务
（这些是工具栏「入口型」功能，点击后进入独立工作流，不属于对话流）。

**对话流内的生图 / 生视频已可抓取**（3.0.2）：`ask` 命中生成意图（画图 / 生成视频等）
后自动等待图片/视频卡渲染完成，从卡片 hydration 数据取 `download_url` **原图直链**下载
（`--artifact-wait` 控制等待毫秒数，默认 120000）；实测单张原图 1760×2368 PNG（5.9 MB）。
生成请求的文字回答仍先行返回，产物追加在 `files[]`。

## 安装

### 前置要求

- **Node.js ≥ 20**，含 npm —— 首次配置要把 `playwright-core` 装到状态目录
- 系统已装 **Chrome / Edge / Brave / Chromium** 任一（自动探测，不下载 Chromium）
- 能访问 `qianwen.com` 的**浏览器**
- **阿里系账号（可选）**：匿名即可问答；登录解锁更多额度、对话云同步、生图 / 生视频入口
- **需要图形界面**：首次配置与每次问答都会真实打开浏览器窗口（问完自动关闭）；
  弹滑块验证时需你本人完成。纯 SSH / 容器环境无法使用

### 作为 Skill 安装

目标目录不存在时先建父目录（`git clone` 不会自动创建）：

```bash
mkdir -p ~/.claude/skills ~/.codex/skills ~/.agents/skills   # 已存在则无副作用

# 三条命令按你的宿主任选其一，不要全都执行
git clone https://github.com/ops120/qwen-brain ~/.claude/skills/qwen-brain     # Claude Code
git clone https://github.com/ops120/qwen-brain ~/.codex/skills/qwen-brain      # Codex
git clone https://github.com/ops120/qwen-brain ~/.agents/skills/qwen-brain     # 通用 / ZCode
```

> Windows 的 cmd / PowerShell 不展开 `~`，请改用绝对路径，例如：
> ```bat
> git clone https://github.com/ops120/qwen-brain "%USERPROFILE%\.agents\skills\qwen-brain"
> ```
> 目标目录已存在时 `git clone` 会失败：改用 `git -C <目录> pull` 更新，或先删掉旧目录。

装好后对 agent 说：**「用 qwen-brain 完成首次配置」**。

> **关于命令写法（重要）**：本文档里的 `qwb <命令>` 是**文档简写**，并非已安装的命令，
> 等价于 `node "$SKILL_ROOT/scripts/qwb/cli.mjs" <命令>`。
>
> **推荐先设变量再配别名**：
> ```bash
> SKILL_ROOT="$HOME/.agents/skills/qwen-brain"   # ← 改成你实际用的那个
> export SKILL_ROOT
> alias qwb='node "$SKILL_ROOT/scripts/qwb/cli.mjs"'
> ```
> Windows 用户（cmd / PowerShell 没有 `alias`）：
> ```powershell
> $SKILL_ROOT = "$env:USERPROFILE\.agents\skills\qwen-brain"
> node "$SKILL_ROOT\scripts\qwb\cli.mjs" doctor --json
> ```

### 首次配置

```bash
node "$SKILL_ROOT/scripts/qwb/cli.mjs" setup
```

1. 检查 Node 版本与系统浏览器
2. 把 `playwright-core` 装到**状态目录**
3. 打开有头浏览器等待登录 —— **想跳过登录就直接关闭浏览器**（CLI 报告 `loginState: "anonymous"`，匿名模式照常可用）
4. 登录了则导出登录态并冒烟验证

> **滑块验证提示**：全新环境首次使用，发送消息时**大概率**弹出阿里滑块验证
> （「请拖动下方滑块完成验证」）。这是正常风控，**必须你本人拖动**；
> 通过后设备会被记住，通常安静一段时间。`ask` 遇到时会自动等你完成并重发
> （`--captcha-wait`，默认 180 秒）。

## 登录（可选）与持久化

千问允许**匿名问答**（全家族唯一），所以登录是可选项：

| | 匿名（游客） | 登录后 |
| --- | --- | --- |
| 问答 / 思考研究 | ✓（额度受限） | ✓（额度更多） |
| 对话记录 | 不保存（URL 为游客会话） | 云空间同步，可从侧栏找回 |
| 生图 / 生视频 / PPT 入口 | 受限 | 解锁更多额度 |

> **额度实测（2026-09-12）**：登录账号约 1 小时内连续 ~6 次生图后触发**静默限流**——
> 生成请求先是挂死（等待 300 秒无任何返回、无滑块、无报错），随后一切请求（含纯文字问答
> 「1+1等于几」）都秒回罐头话术「你好，我无法回答这个问题，我们换一个话题聊聊吧。」。
> 页面自始至终**没有任何额度/风控提示**；换全新浏览器指纹（同一 cookie）依旧被拒
> → **账号/IP 级**，不是浏览器指纹级。恢复时长未知，触限后唯一正确动作是**彻底停手等待**。

登录 cookie 是**持久型**（带 `Expires`），登录一次长期复用。机制层仍保留同族三重保险
（`--restore-last-session` + `storage-state.json` 备份注入 + 优雅关闭），实现在 `src/browser.mjs`。

**实测验证（2026-09）**：人工登录 → 导出 50 个 cookie（含 3 个登录 cookie）→ 关闭浏览器 →
重新 `setup` / `doctor --deep` → **直接是登录态，零人工介入**。

**登录判定必须用 cookie**（未登录时界面同样有完整输入框，看界面区分不了）：

```
tongyi_sso_ticket, tongyi_sso_ticket_hash, b-user-id
```

⚠️ `XSRF-TOKEN` / `acw_tc` / `cna` / `tfstk` 未登录时也存在，不能用于判定。

## 快速上手

> **以下命令假定你已按安装章节设置 `SKILL_ROOT`**（或已配好别名）。

```bash
# 体检（建议每次任务前跑；--deep 真机探测页面与模式选择器）
node "$SKILL_ROOT/scripts/qwb/cli.mjs" doctor --json

# 普通问答（匿名即可）
node "$SKILL_ROOT/scripts/qwb/cli.mjs" ask --prompt "用一句话解释什么是事件循环" --thread new --json

# 思考研究模式（深度检索，1–3 分钟，给足超时）
node "$SKILL_ROOT/scripts/qwb/cli.mjs" ask \
  --prompt "调研 <问题>，给出处与结论" --think on --thread new --timeout 300000 --json

# 查看可用模式
node "$SKILL_ROOT/scripts/qwb/cli.mjs" list-models --json

# 追问（复用同一线程，省略 --thread 即可）
node "$SKILL_ROOT/scripts/qwb/cli.mjs" ask --prompt "展开讲讲第二点" --json

# 附件分析
node "$SKILL_ROOT/scripts/qwb/cli.mjs" ask --prompt "看下这张图" --attach ./pic.png --json
```

对 agent 说人话也一样：**「让千问深度研究一下这个问题」**、**「用千问查一下国内的价格」**。

## 自然语言驱动举例

| 你想做什么 | 直接对 agent 说 |
| --- | --- |
| 中文视角 / 本土信息 | 「用千问查一下国内 <话题> 的情况」 |
| 深度检索归纳 | 「让千问深度研究一下 <问题>，给出处」 |
| 第三方独立意见 | 「问问千问这个方案有什么问题」 |
| 分析图片 / 文件 | 「用千问看看这张图」 |
| 出方案 → 执行 → 复核 | 「让千问出方案，你执行，做完让它复核」 |

使用要点：

- **点名最稳**：话里带上「千问」或「qwen」，agent 就会走本 skill；也支持英文触发
  （`use qwen` / `ask qwen` / `qwen deep research`）。
- **深度问题开思考研究**：`--think on`，但单轮 1–3 分钟，别急着判失败。
- **不用登录也能跑**：临时环境 / 不想留记录就用匿名模式。
- **弹滑块不是故障**：CLI 会等你拖完自动重发；看到提示在浏览器里拖一下即可。

## 命令面

`--json`（机器可读）与 `--debug`（保存页面 HTML）为全局选项；
`--keep-open`（保留浏览器窗口）只对会打开浏览器的命令有意义。

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `setup` | 首次配置：装依赖 → 等待登录（可关闭浏览器跳过） | `--timeout <ms>` |
| `login` | 补充登录 | `--timeout <ms>` |
| `logout` | 清除登录态（清 `profile/` 与 `storage-state.json`；**设备指纹一并清除，滑块会重新弹**） | — |
| `doctor` | 体检 | `--deep`（真机探测页面 / 模式选择器）、`--html` |
| `ask` | 提问 / 分析 | `--prompt` / `--prompt-file`、`--think on/off`、`--attach`、`--thread new`、`--protocol <状态>`、`--timeout`、`--captcha-wait <ms>`、`--allow-sensitive`、`--allow-large` |
| `list-models` | 列出模式档位（快速 / 思考研究） | — |
| `thread` | 线程管理 | `status` / `use <url>` / `new` |
| `session` | 工作区级线程与检查点 | `get` / `set ...` |
| `logs` | 查看脱敏日志 | `-n <行数>`、`--verbose` |
| `update-check` | 检查更新 | `--force` |

> **注意 `--protocol` 与 `--protocol-state` 是两套不同的枚举，别混用**：
> `--protocol`（用于 `ask`）取 `INIT` / `PLAN` / `EXECUTING` / `EXECUTED` / `REVIEW` / `HANDOFF`；
> `--protocol-state`（用于 `session set`）取 `INIT` / `PLAN_RECEIVED` / `EXECUTING` / `EXECUTED_LOCAL` / `EXECUTED_SENT` / `DONE` / `BLOCKED`。

### doctor 检查项

| 检查项 | 含义 |
| --- | --- |
| `node` / `deps` / `browser` / `stateDir` / `network` | 同族通用（Node ≥ 20、依赖、浏览器、状态目录、站点可达） |
| `login` | **仅 `--deep` 时**：列出登录 cookie（匿名时显示「匿名模式」，**不算失败**） |
| `deep` | **仅 `--deep` 时**：真机探测编辑器 / 模式选择器，并截图 |

## 返回值契约

```json
{
  "ok": true,
  "requestId": "qwb_1019",
  "threadUrl": "https://www.qianwen.com/chat/08119b08967e439cabf41d1a2af35ad3",
  "modes": { "mode": "思考研究", "requested": "on" },
  "text": "……回答正文……",
  "files": [],
  "mode": "chat",
  "truncated": false,
  "elapsedMs": 8115
}
```

**字段说明**：

- `modes.mode` —— **实际生效**的模式（`快速` / `思考研究`），与请求不一致时必须标注
- `text` —— 回答正文
- `files[]` —— 下载到本地的产物：生成类（生图/生视频）由卡片 hydration 数据直链下载，
  记录含 `kind`（image/video）、`width`/`height`、`source: "card-data"`；`mode` 相应变为 `"artifact"`
- `truncated` —— `true` 表示可能被截断，需如实告知用户
- `reSent` —— 出现过滑块验证、通过后已自动重发（正常现象）

失败（**判别联合**）：`{ "ok": false, "reason": "HUMAN_VERIFICATION_REQUIRED", "message": "…" }`。

## 协作协议（`[QWB]`）

与 deepseek-brain 同构：让千问当「规划与审查大脑」，**执行权始终在本地 agent 手里**。

```bash
qwb ask --protocol INIT --task qwb_f81a --iteration 0 --prompt-file goal.txt --think on --json
qwb ask --protocol EXECUTED --iteration 1 --prompt-file report.txt --json
qwb thread status --json
```

- 返回 `protocol.reply.state`（`PLAN` / `DONE` / `BLOCKED`）；建议单任务 ≤ 12 轮
- 线程丢失 → 依据 checkpoint 发 HANDOFF，**不粘贴日志或 diff**
- 匿名模式下对话不进云空间，线程丢了找不回——重要任务建议登录后跑
- 详见 [references/protocol.md](references/protocol.md)

## 失败处理

| reason | 含义 | 动作 |
| --- | --- | --- |
| `HUMAN_VERIFICATION_REQUIRED` | 滑块验证未在 `--captcha-wait` 时限内完成（等待期间 CLI 会提醒且不计入超时；**绝不代拖**） | 让用户拖完重试，或加大时限 |
| `RATE_LIMITED` | 限流 / 游客额度用尽 | 退避；游客被限时建议登录 |
| `SITE_CHANGED` / `COMPOSER_NOT_FOUND` | 站点改版 | `doctor --deep` 确认后提 issue 等发版 |
| `SEND_FAILED` | 发送 / 注入失败 | 重试一次 |
| `STREAM_STALLED` | 超时（思考研究 1–3 分钟属正常） | 标注「可能截断」；确认 `--timeout` 足够 |
| `UPLOAD_REJECTED` | 附件被拒 | 检查格式与大小 |
| `THREAD_LOST` | 会话 404 | 新会话重问（或 HANDOFF） |
| `LOCKED` | 另一个 qwb 会话持有全局锁（profile 是浏览器排他资源） | 等持锁会话结束（失败信息带 pid 与命令）；持有进程已死的陈旧锁会自动接管 |
| `DEPENDENCY_MISSING` | 依赖缺失 | 运行 `setup` |
| `SENSITIVE_BLOCKED` | 闸门拦截 | 移除敏感内容；确需发送须用户同意 |
| `PAYLOAD_TOO_LARGE` | 正文超 50 KB | 摘要或分片；`--allow-large` 放宽到 200 KB |

完整表见 [references/failure-taxonomy.md](references/failure-taxonomy.md)。
遇到站点改版可在 <https://github.com/ops120/qwen-brain/issues> 反馈。

**硬规则**：绝不把失败伪装成结果；绝不静默降级后不告知；同类失败最多重试 2 次；
**绝不自动滑动滑块验证**——那是风控红线。

## 状态与隐私

状态目录（`QWB_STATE_DIR` 可覆盖）：

```
Windows  %LOCALAPPDATA%\qwen-brain\
macOS    ~/Library/Application Support/qwen-brain/
Linux    $XDG_STATE_HOME/qwen-brain/
```

| 内容 | 说明 |
| --- | --- |
| `deps/` | `playwright-core` |
| `profile/` | 持久化浏览器 profile —— 登录态 + **设备指纹（滑块免检凭证在这里，删了要重新过验证）** |
| `storage-state.json` | cookie 备份 |
| `downloads/<workspaceId>/` | 产物 |
| `threads/<workspaceId>.json` | 工作区级线程与检查点 |
| `outputs/<workspaceId>.jsonl` | 审计：每次问答一行元数据 |
| `logs/qwb.log` | 脱敏日志 |
| `debug/` | `--debug` 或失败时自动保存的截图与 HTML —— ⚠️ **含你的输入与回答原文、未脱敏**；排障后删除，**不要上传公开 issue** |

**隐私要点**：

- 状态目录权限 `0700`、文件 `0600`（仅 Unix/macOS 生效；Windows 依赖用户目录 ACL）
- **不要把状态目录同步 / 备份 / 分享** —— 含登录 cookie 与设备指纹
- **回答正文默认不落盘**，只记录元数据
- cookie / storageState **永不**导出到项目目录、**永不**进日志、**永不**进 prompt

## 原理与已知坑

### 工作方式

```
你 / Agent ──调用──▶ qwb CLI ──Playwright──▶ 持久 Chrome ──▶ qianwen.com
                        │
                        ├─ 全局会话锁：同一时间只允许一个会话开浏览器（并发报 LOCKED）
                        ├─ 发送前：确定性净化闸门
                        ├─ 输入框：contenteditable → keyboard.insertText 一次性注入
                        ├─ 等待：/api/v2/chat 网络信号 + 文本稳定性 + 只认新增回答
                        ├─ 滑块验证：检测 → 终端提醒（触发风控，需人工验证）→ 等用户拖动
                        │   （等待不计入回答超时）→ 通过后立即自动重发；CLI 绝不代拖
                        └─ 抽取：[class*="answer-common-card"]（CSS Modules 前缀匹配），
                            剔除推荐卡片 / 代码块 chrome / 行号
```

### 真机验证过的坑（别再踩）

1. **输入注入必须 `keyboard.insertText()`**：`execCommand("insertText")` 文本进得去但
   **React 状态不更新，发送按钮保持禁用**，点了也发不出去（实测踩过）。
   `keyboard.type()` 逐字符也不推荐（慢，可能触发快捷键）。
2. **滑块验证会拦住已发出的消息**：回答卡在 `answer-receiving-card` 占位、
   生成请求被 punish，**不会自动恢复**——通过后必须**重新发送**（CLI 已内置）。
   验证对**新环境**几乎必弹；通过后设备被记住。
3. **验证检测要按 body 全文匹配**（「请拖动下方滑块完成验证」）：
   按元素结构找会漏检（弹窗层级深、文本长，结构匹配失败，实测踩过）。
4. **class 名带随机后缀**（CSS Modules）：如 `answer-common-card-Ab3dE`——
   选择器一律 `[class*=]` 前缀匹配，写死完整类名必挂。
5. **模式菜单必须真实鼠标点击**：`element.click()` 合成点击打不开菜单（与同族 Radix 同坑）。
   菜单项从 `[role="menuitemcheckbox"]` 读。
6. **模式选择器的 aria-label 就是当前模式名**（`快速` / `思考研究`），读它即可，
   不要解析按钮文案（文案带副标题「适用于大多数情况」）。
7. **页面会恢复上次会话**：与同族一样，`--thread new` 显式点「新建对话」，
   且等待回答只认发送后**新增**的回答卡片。
8. **游客会话不进云空间**：URL 是游客会话，关了就找不回；重要任务登录后跑。
9. **不要加 `--restore-last-session`**：千问登录 cookie 是持久型（365 天 Expires），
   不需要这个「恢复上次会话」的 workaround；加了反而会在每次启动时恢复上次全部标签页，
   而 CLI 每次问答又新开一个标签 → 标签页逐次累加（实测：跑十几次后窗口里堆了二十多个）。
   现在的做法：不加开关 + 启动时收敛到单标签 + 持锁回收孤儿浏览器进程
   （CLI 被强杀残留的窗口会占用 profile 排他锁，下次启动前清掉）。
10. **附件是「两步菜单」**：`添加附件` 按钮点了不直接弹文件选择，先弹
    「上传文档 / 上传图片」菜单（`[role=menuitem]`），点菜单项才触发 filechooser；
    常驻 DOM 没有 `input[type=file]`，直接 `setInputFiles` 必报
    「页面上没有文件输入框」（实测踩过）。
11. **回答正文有三类污染**（EXTRACT_FN 已内置处理，新写抽取前先读
    `references/site-map.md` 的「回答正文抽取的三类污染」）：
    推荐视频卡片标题、代码块的固定头与行号、以及各类 `data-card-*` 卡片。
12. **滑块期间超时时钟要暂停**：用户拖滑块多久都不该烧 `--timeout` 预算；
    验证通过后回答若未恢复（消息已被拦），应**立即**重发——硬等满 timeout 才重发
    是旧实现的坑。CLI 会全程在终端提醒「触发风控、需人工验证、剩余等待时间」；
    **滑块永远由用户本人拖动，CLI 绝不代拖**。
13. **对话流生图：文字先到 ≠ 生成完成**：模型秒回「好嘞！这就为您描绘…」（~8 秒），
    图片卡 ~40-70 秒后才渲染完成；按「文本稳定」判完成并关窗的旧版**一个产物都抓不到**
    （图其实已在服务端生成并落盘线程，重开线程就能看到）。3.0.2 修正：生成意图的 ask
    自动进入产物等待（`waitForArtifacts`），读卡片 hydration 数据
    （`script#s-data-card_ai_generate_*`）里的 `download_url` **直接下原图**——
    不要去点下载按钮：那是悬停才显示的 popMenu（CSS 默认 `display:none`），
    菜单项不是 `<button>`、无 aria-label/title，按钮扫描对它天然失明（实测踩过）。
    生成期间页面还会从草稿线程重定向到正式线程（DOM 重建），等待循环必须容忍。
14. **静默限流无 UI 提示**：连续生成后（实测 ~6 次/小时）先挂死、后被拒，页面无任何报错
    （见「登录（可选）与持久化」的额度实测）；CLI 侧表现为 `STREAM_STALLED`（超时无文本）
    或正文是罐头拒绝话术。判据：同一 prompt 之前能答现在拒、连「1+1」都拒 → 大概率触限，
    **停手等待**，别再重试加重风控。

### 站点改版了怎么办

**普通用户**：跑 `doctor --deep --json` 确认是选择器漂移后，提 issue 等上游发版即可。

**维护者**：站点层改动通常只需改 **`scripts/qwb/src/site.mjs`**：

```bash
node "$SKILL_ROOT/scripts/qwb/cli.mjs" doctor --deep --html --json   # 定位漂移
# 改 scripts/qwb/src/site.mjs
node "$SKILL_ROOT/scripts/qwb/cli.mjs" doctor --deep --json          # 改完必须重跑
node "$SKILL_ROOT/scripts/qwb/tests/sanitize.test.mjs"               # 闸门单测
```

## 边界

- **低频辅助工具**：每次问答会真实打开浏览器窗口，不适合批量调用；思考研究单轮 1–3 分钟。
- **不做批量 / 不做并发**：同一时间只跑一个会话。
- **不做 web2api**：只在本机驱动官方网页，不逆向私有协议、不做 HTTP 代理、不对外暴露接口。
- **模型不可自选**：只有「模式」两档；底层模型由站点分配。
- **生图 / 生视频**：对话流已支持（3.0.2 起 `ask` 自动等卡片、直链下原图）；
  生图工作室 / 生视频编辑器等入口型工作流与 PPT / 工作助理仍需网页手动操作。
  额度硬上限低（实测 ~6 次/小时即触发静默限流，见坑 14），**严禁当批量生图用**。
- **滑块验证**：新环境几乎必弹，通过后安静一段时间；CLI 等待用户完成，**绝不代滑**。
- **合规风险**：自动化驱动网页版可能违反阿里服务条款，详见文首警告。

## 项目结构

```
LICENSE                 MIT 许可证
SKILL.md                给 agent 的说明书
README.md               本文件
references/
  install.md            安装 + 登录持久化原理（排障必读）
  failure-taxonomy.md   失败码 → 动作
  site-map.md           站点交互地图（含滑块验证 / 注入方式的坑）
  protocol.md           [QWB] 协作协议
scripts/qwb/
  cli.mjs               命令面 + JSON 契约
  src/browser.mjs       浏览器探测 + 登录三重保险 + cookie 判定
  src/site.mjs          站点层（输入、发送、模式选择器、完成判定、产物下载）
  src/sanitize.mjs      发送前确定性净化闸门
  src/session.mjs       线程 / 检查点 / 审计 / 全局会话锁
  src/paths.mjs         状态目录布局
  src/logger.mjs        脱敏日志
  tests/sanitize.test.mjs   14 项净化闸门单测
```

## 同族项目

四个「网页版大脑」共享同一套机制层，但**各自独立仓库、独立 skill、互不依赖**：

| | qwen-brain | deepseek-brain | gemini-brain | doubao-brain | grok-brain |
| --- | --- | --- | --- | --- | --- |
| CLI（均为文档简写，实际入口是 `node <仓库>/scripts/<cli>/cli.mjs`） | `qwb` | `dsb` | `gmb` | `dbb` | `grb` |
| 定位 | **中文 + 思考研究 + 匿名可用** | 推理 + 联网搜索 | 生图 + 代码 Canvas | 生图 + 生视频 + 音乐/播客 | X 实时信息 + 多档模型 |
| 生图 | ✓ 对话流直出（实测 1760×2368 PNG 原图） | ✗ | ✓（2816×1536 原图） | ✓（2048×2048） | ✗ |
| 生视频 | 对话流机制已就绪（3.0.2），端到端验收因触限暂缓 | ✗ | ✗ | ✓（1280×720） | ✗ |
| 模型可选 | 模式两档（快速 / 思考研究） | ✗（只有思考/搜索开关） | ✓（Flash-Lite / Flash / Pro） | ✓（快速 / 2.1 Turbo） | ✓（可用档位受订阅限制） |
| 登录持久化 | 简单（**可选登录，匿名可用**） | 简单 | **复杂**（需三重保险） | 简单 | 简单 |

> 上表涉及他仓的信息均为**编写时**的观察，未在本仓库核实，仅供参考；
> 请以各仓库最新 README 为准。

## 许可证

本项目基于 MIT License 开源，完整条款见 [LICENSE](LICENSE)。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
