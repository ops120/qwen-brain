# 安装、配置与维护

## 依赖

- Node.js ≥ 20
- 系统已安装 Chrome / Edge / Brave / Chromium 任一（自动探测，无需下载 Chromium）
- 能访问 `qianwen.com` 的**浏览器**
- 一个阿里系账号（**可选**：千问支持匿名问答；登录解锁更多额度、生图 / 生视频等能力与云空间同步）

**无需 API key。**

> **合规与账号风险**：本项目通过浏览器自动化驱动千问官方网页版，
> 可能不符合阿里服务条款，存在账号被风控或限制的风险（表现为滑块验证 / 限流）。
> 请自行评估并遵守平台条款，**风险自负**；仅供低频个人使用。

## 安装

本仓库根目录就是 skill 目录：

```bash
git clone https://github.com/ops120/qwen-brain ~/.claude/skills/qwen-brain     # Claude Code
git clone https://github.com/ops120/qwen-brain ~/.codex/skills/qwen-brain      # Codex
git clone https://github.com/ops120/qwen-brain ~/.agents/skills/qwen-brain     # 通用
```

## 定位 skill 根

命令里的 `<skill-root>` = `SKILL.md` 所在目录。按顺序尝试：

1. 宿主的 skill 加载路径（通常已在上下文里给出）；
2. 常见位置：`~/.claude/skills/qwen-brain`、`~/.codex/skills/qwen-brain`、`~/.agents/skills/qwen-brain`；
3. 仍找不到 → 问用户。

## 首次配置

```bash
node "<skill-root>/scripts/qwb/cli.mjs" setup
```

依次：检查 Node 与浏览器 → 把依赖装到状态目录 → 打开浏览器等待登录（**可跳过**）→ 导出登录态。

登录说明：

- **匿名即可用**：setup 过程中直接关闭浏览器窗口即跳过登录（CLI 会报告 `loginState: "anonymous"`），
  之后走游客模式（额度受限、对话不进云空间）。
- 登录页支持**手机号验证码 / 支付宝 / 阿里系账号**，需用户本人操作。
- 登录判定用 cookie：出现 `tongyi_sso_ticket` / `tongyi_sso_ticket_hash` / `b-user-id` 即已登录
  （`.qianwen.com` 域，**持久型**，实测一次登录长期复用）。
- ⚠️ **滑块验证**：阿里风控对自动化浏览器可能弹出「请拖动下方滑块完成验证」，
  尤其是全新环境首次使用时。这是正常风控，**必须用户本人完成**；
  通过后一般会安静一段时间（设备被记住）。`ask` 命令遇到时会自动等待并重发
  （`--captcha-wait`，默认 180 秒）。

## 登录持久化原理

千问的登录 cookie 是**持久型**（带 `Expires`），登录一次长期复用 —— 全家族里与 DeepSeek / 豆包 /
Grok 同级的「省事」档（Gemini 的 session cookie 才需要三重保险）。机制层仍保留同族的
三重保险实现（`src/browser.mjs`），以覆盖站点将来改用 session cookie 的情况：

| 措施 | 作用 |
| --- | --- |
| `--restore-last-session` 启动参数 | 让 Chrome 恢复上次会话 |
| `storage-state.json` 导出 + 启动时注入 | cookie 的完整备份（Playwright 官方 API） |
| 优雅关闭 `ctx.close()` | 触发 Chrome 落盘（**强杀会跳过落盘**） |

**实测验证（2026-09）**：人工登录（阿里系账号）→ 导出 50 个 cookie（含 3 个登录 cookie）→
关闭浏览器 → 重新 `setup` / `doctor --deep` → **直接是登录态，没有任何人工介入**。

**登录判定必须用 cookie**：未登录时界面同样有完整输入框（游客模式），
看界面无法区分登录态。可靠判据：

```
tongyi_sso_ticket, tongyi_sso_ticket_hash, b-user-id
```

⚠️ `XSRF-TOKEN` / `acw_tc` / `cna` / `tfstk` / `isg` 在未登录时也存在，**不能**用于判定。

**降低风控的启动参数**（已内置）：`chromiumSandbox: true`、`viewport: null`、
`--disable-blink-features=AutomationControlled`、抹除 `navigator.webdriver`。

## 状态目录

- Windows `%LOCALAPPDATA%\qwen-brain\`；macOS `~/Library/Application Support/qwen-brain/`；Linux `$XDG_STATE_HOME/qwen-brain/`（`QWB_STATE_DIR` 可覆盖）。
- 内容：`profile/`（登录态与设备指纹——**滑块验证的「免检通行证」就在这里，删除后要重新过验证**）、`storage-state.json`（cookie 备份）、`downloads/<workspace>/`（产物）、`threads/`、`logs/`、`outputs/`。
- cookie **永不**导出到项目目录、**永不**进日志、**永不**进 prompt。

## 更新

```bash
cd <skill-root> && git pull
node scripts/qwb/cli.mjs update-check --force --json
```

站点改版时 `doctor --deep` 会报 `SITE_CHANGED`，拉取最新版即可（选择器集中在 `src/site.mjs`）。

## 敏感数据与 `--allow-sensitive`

默认拒绝私钥、`.env`、密钥形状。确需发送时（**用户明确知情同意**后）加 `--allow-sensitive`。
不要替用户做这个决定。

## 卸载

1. 删除宿主 skills 目录下的 `qwen-brain/`；
2. 删除状态目录（含登录态、设备指纹与产物）。
