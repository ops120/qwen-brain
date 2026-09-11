#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { VERSION, dirs, ensureDir, writeJson, readJson, workspaceId, nowIso } from "./src/paths.mjs";
import { log, tailLines } from "./src/logger.mjs";
import { sanitizeOutbound } from "./src/sanitize.mjs";
import {
  getSession,
  setSession,
  appendAudit,
  saveDebugHtml,
  acquireLock,
} from "./src/session.mjs";
import {
  launchBrowser,
  findBrowser,
  depsInstalled,
  depsEntry,
  exportStorageState,
  readLoginCookies,
  collapseToSinglePage,
  closeBrowser,
} from "./src/browser.mjs";
import * as site from "./src/site.mjs";

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    version: { type: "boolean", default: false },
    model: { type: "string" },
    think: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    attach: { type: "string" },
    thread: { type: "string" },
    timeout: { type: "string" },
    deep: { type: "boolean", default: false },
    html: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    "allow-sensitive": { type: "boolean", default: false },
    "allow-large": { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    "captcha-wait": { type: "string", default: "180000" },
    verbose: { type: "boolean", default: false },
    lines: { type: "string" },
    n: { type: "string" },
    force: { type: "boolean", default: false },
    url: { type: "string" },
    title: { type: "string" },
    task: { type: "string" },
    iteration: { type: "string" },
    state: { type: "string" },
    protocol: { type: "string" },
    "protocol-state": { type: "string" },
    "waiting-for": { type: "string" },
    "next-step": { type: "string" },
    goal: { type: "string" },
    "known-issues": { type: "string" },
    "clear-checkpoint": { type: "boolean", default: false },
  },
});

const cmd = String(positionals[0] ?? "help").toLowerCase();
const json = !!flags.json;

function emit(payload, { exitCode = 0 } = {}) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else printHuman(payload);
  if (exitCode) process.exitCode = exitCode;
  return payload;
}

function fail(reason, message, extra = {}) {
  const payload = { ok: false, reason, message, ...extra };
  log("error", `${reason}: ${message}`);
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`✗ ${reason}: ${message}\n`);
  process.exitCode = 1;
  return payload;
}

function printHuman(payload) {
  if (!payload || typeof payload !== "object" || payload.ok === false) return;
  if (typeof payload.text === "string") {
    process.stdout.write(`${payload.text}\n`);
    const m = payload.modes ?? {};
    process.stdout.write(
      `\n来源：qianwen.com · 模型：${m.model ?? "-"} · 模式：${m.mode ?? "-"} · request: ${payload.requestId ?? "-"} · 截断：${payload.truncated ? "是" : "否"}\n`
    );
    if (payload.files?.length) {
      process.stdout.write(`产物：\n${payload.files.map((f) => `  ${f.file} (${f.bytes} bytes)`).join("\n")}\n`);
    }
    return;
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "ok") continue;
    process.stdout.write(`✓ ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}\n`);
  }
}


/**
 * 打开浏览器的命令共用入口：先拿全局会话锁（profile 是排他资源，且孤儿浏览器
 * 回收必须持锁进行，否则会误杀另一会话的窗口），再执行，finally 释放。
 */
async function withBrowserLock(command, fn) {
  const lock = acquireLock({ command });
  if (!lock.ok) {
    return fail(
      "LOCKED",
      `另一个 qwb 会话正在运行（pid=${lock.holder?.pid ?? "?"}，${lock.holder?.command ?? "?"}），同一时间只允许一个会话占用浏览器。等它结束后再试。`,
      { holder: lock.holder ?? null, lockFile: lock.lockFile }
    );
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

function newRequestId() {
  return `qwb_${crypto.randomBytes(2).toString("hex")}`;
}

/* ------------------------- 滑块验证：提示与失败文案 ------------------------- */

/**
 * 阿里风控提示。原则（用户明确要求）：
 *   - 滑块一律由用户本人在浏览器里拖动，CLI **只等待，绝不代拖**；
 *   - 不能干等 —— 每次触发都要在终端讲清楚：触发了风控、需要人工验证、还剩多少时间。
 */
function captchaNotice(scene, waitMs) {
  process.stderr.write(
    `⚠️  ${scene}：触发了阿里风控，需要人工验证。\n` +
      `   请在打开的浏览器窗口里手动拖动滑块（CLI 不代拖，只等待，最多 ${Math.round(waitMs / 1000)} 秒）。\n` +
      "   通过后设备会被记住，一般会安静一段时间；若频繁弹出，建议降低提问频率或稍后再试。\n"
  );
}

function captchaFailMessage(waitMs) {
  return (
    `滑块验证未在 ${Math.round(waitMs / 1000)} 秒内完成（风控要求人工操作，CLI 不会代拖）。` +
    "重跑同一条命令，出现滑块时尽快拖动即可；频繁触发时建议过段时间再试。"
  );
}

/* --------------------------- 中断清理（防孤儿窗口） --------------------------- */

/**
 * 进程被 Ctrl-C / kill / 任务取消时，Node 直接退出会**留下一个孤儿 Chrome 窗口**
 * （实测：上游取消任务后窗口一直挂着，用户看到「怎么打开了这么多」）。
 * 这里注册信号处理，退出前优雅关闭浏览器。
 */
let activeCtx = null;
let cleaningUp = false;
async function cleanupAndExit(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  process.stderr.write(`\n收到 ${signal}，正在关闭浏览器…\n`);
  if (activeCtx) await closeBrowser(activeCtx).catch(() => {});
  process.exit(130);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanupAndExit(sig);
  });
}

/* ------------------------------ [QWB] 协议 ------------------------------ */

const PROTOCOL_STATES = ["INIT", "PLAN", "EXECUTING", "EXECUTED", "REVIEW", "HANDOFF"];
const CHECKPOINT_FOR_REPLY = {
  PLAN: { protocolState: "PLAN_RECEIVED", waitingFor: "none" },
  REVIEW: { protocolState: "EXECUTED_SENT", waitingFor: "BRAIN_REVIEW" },
  DONE: { protocolState: "DONE", waitingFor: "none" },
  BLOCKED: { protocolState: "BLOCKED", waitingFor: "USER" },
};

export function buildProtocolMessage(state, body, { taskId, iteration }) {
  return `[QWB]\nSTATE: ${state}\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\n${body}`;
}

export function parseProtocolReply(text) {
  if (!text) return null;
  const state = text.match(/STATE:\s*([A-Z_]+)/);
  if (!state) return null;
  const task = text.match(/TASK_ID:\s*(\S+)/);
  const iter = text.match(/ITERATION:\s*(\d+)/);
  return { state: state[1], taskId: task ? task[1] : null, iteration: iter ? Number(iter[1]) : null };
}

/* ---------------------------------- setup --------------------------------- */

function installDeps() {
  const d = dirs();
  ensureDir(d.deps);
  writeJson(path.join(d.deps, "package.json"), {
    name: "qwb-deps",
    private: true,
    dependencies: { "playwright-core": "^1.40.0" },
  });
  const args = ["install", "--prefix", d.deps, "--no-audit", "--no-fund", "--loglevel", "error"];
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const res = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
  return res.status === 0;
}

/**
 * 登录流程。判定必须用 cookie：登录后出现 `tongyi_sso_ticket` / `tongyi_sso_ticket_hash`
 * （.qianwen.com 域，持久型）与 `b-user-id`。未登录时这些 cookie 不存在。
 * 千问允许匿名问答（游客模式），登录解锁：视频生成、更多额度、云空间同步。
 */
async function waitLoginFlow({ timeoutMs }) {
  const ctx = await launchBrowser({ headless: false });
  activeCtx = ctx;
  try {
    const page = await collapseToSinglePage(ctx);
    await site.gotoSite(page);
    process.stderr.write("浏览器已打开。请完成千问登录（手机号 / 支付宝 / 阿里云账号，需你本人操作）。\n");
    process.stderr.write("（匿名模式也可用；登录是为了解锁视频生成与同步对话记录，可直接关闭浏览器跳过。）\n");

    const before = new Set((await readLoginCookies(ctx)).names ?? []);
    const started = Date.now();
    let lastBeat = 0;
    let ck = await readLoginCookies(ctx);

    while (Date.now() - started < timeoutMs) {
      if (ck.loggedIn) break;
      await page.waitForTimeout(3000).catch(() => {});
      try {
        ck = await readLoginCookies(ctx);
      } catch {
        return { ok: false, reason: "LOGIN_ABORTED", state: null }; // 用户关了浏览器 = 跳过登录
      }
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec - lastBeat >= 30) {
        lastBeat = sec;
        process.stderr.write(`  …等待登录 ${sec}s（登录 cookie ${ck.loginCookies.length} 个）\n`);
      }
    }

    const d = dirs();
    const prefs = readJson(d.prefs) ?? {};
    if (!ck.loggedIn) {
      ensureDir(d.debug);
      return { ok: false, reason: "LOGIN_REQUIRED", state: null };
    }

    const exported = await exportStorageState(ctx, d.storageState);
    writeJson(d.prefs, { ...prefs, lastLoginAt: nowIso() });
    return { ok: true, loginState: "logged-in", url: page.url(), loginCookies: ck.loginCookies, storageState: exported };
  } finally {
    await closeBrowser(ctx); // 优雅关闭：确保 cookie 落盘
  }
}

async function cmdSetup() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) return fail("DEPENDENCY_MISSING", `需要 Node ≥ 20，当前 ${process.version}`);

  if (!depsInstalled()) {
    process.stderr.write("安装依赖（playwright-core）到状态目录…\n");
    if (!installDeps() || !depsInstalled()) return fail("DEPENDENCY_MISSING", `依赖安装失败（目标：${depsEntry()}）`);
  }
  const br = findBrowser();
  if (!br) return fail("DEPENDENCY_MISSING", "未找到系统 Chrome / Edge；请安装其一后重试。");

  const res = await withBrowserLock("setup", () => waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) }));
  if (!res.ok) {
    if (res.reason === "LOGIN_ABORTED") return emit({ ok: true, loginState: "anonymous", note: "未登录（匿名模式可用）；要解锁视频生成与同步请再跑 qwb login" });
    return fail(res.reason, "等待登录超时，请重试。", res);
  }
  return emit({ ok: true, ...res, browser: br.executablePath ?? br.channel, stateDir: dirs().root });
}

async function cmdLogin() {
  const res = await withBrowserLock("login", () => waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) }));
  if (!res.ok) return fail(res.reason, "登录未完成，请重试。", res);
  return emit({ ok: true, ...res });
}

async function cmdLogout() {
  const d = dirs();
  for (const target of [d.profile, d.storageState]) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      return fail("LOCKED", `清除失败（可能有浏览器仍在运行）：${error.message}`);
    }
  }
  return emit({ ok: true, loggedOut: true, cleared: [d.profile, d.storageState] });
}

/* --------------------------------- doctor --------------------------------- */

async function cmdDoctor() {
  // 只有 --deep 会开浏览器，需要锁；轻量体检直接跑
  return flags.deep ? withBrowserLock("doctor --deep", () => cmdDoctorInner()) : cmdDoctorInner();
}

async function cmdDoctorInner() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor >= 20, detail: process.version });
  checks.push({ name: "deps", ok: depsInstalled(), detail: depsInstalled() ? dirs().deps : "未安装（运行 qwb setup）" });

  const br = findBrowser();
  checks.push({ name: "browser", ok: !!br, detail: br ? br.executablePath ?? `channel=${br.channel}` : "未找到 Chrome / Edge" });

  let stateWritable = true;
  try {
    ensureDir(dirs().root);
    fs.accessSync(dirs().root, fs.constants.W_OK);
  } catch {
    stateWritable = false;
  }
  checks.push({ name: "stateDir", ok: stateWritable, detail: dirs().root });

  let netOk = false;
  let netDetail = "";
  try {
    const res = await fetch("https://www.qianwen.com/", {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    netOk = res.status > 0;
    netDetail = `HTTP ${res.status}`;
  } catch (error) {
    netDetail = `${error.message}（Node 直连失败；浏览器可能仍可用）`;
    netOk = true;
  }
  checks.push({ name: "network", ok: netOk, detail: netDetail });

  let deep = null;
  if (flags.deep) {
    if (!depsInstalled() || !br) {
      deep = { skipped: true, reason: "DEPENDENCY_MISSING" };
    } else {
      const ctx = await launchBrowser({ headless: !!flags.headless });
      activeCtx = ctx;
      try {
        const page = await collapseToSinglePage(ctx);
        await site.gotoSite(page);
        const st = await site.pageState(page);
        const cookies = await readLoginCookies(ctx);
        const mode = await site.readMode(page);
        deep = { state: st, cookies: { total: cookies.total, login: cookies.loginCookies }, mode };
        ensureDir(dirs().debug);
        const shot = path.join(dirs().debug, `doctor-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        deep.screenshot = shot;
        if (flags.html) deep.htmlFile = saveDebugHtml(await page.content(), "doctor");
      } finally {
        await closeBrowser(ctx);
      }
    }
  }

  const cookieCheck = deep?.cookies ? { name: "login", ok: deep.cookies.login.length > 0, detail: deep.cookies.login.join(", ") || "匿名模式（未登录）" } : null;
  if (cookieCheck) checks.push(cookieCheck);

  let ok = checks.filter((c) => c.name !== "login").every((c) => c.ok);
  let reason;
  if (!ok) {
    const firstBad = checks.find((c) => !c.ok && c.name !== "login")?.name;
    reason = ["deps", "browser"].includes(firstBad) ? "DEPENDENCY_MISSING" : "SEND_FAILED";
  }
  if (deep && !deep.skipped) {
    if (deep.state.challenge) {
      captchaNotice("doctor --deep 真机探测", Number(flags["captcha-wait"] ?? 180000));
      ok = false;
      reason = "HUMAN_VERIFICATION_REQUIRED";
    } else if (deep.state.rateLimited) {
      ok = false;
      reason = "RATE_LIMITED";
    } else if (!deep.state.hasEditor) {
      ok = false;
      reason = "COMPOSER_NOT_FOUND";
    }
    // 未登录不算 doctor 失败（匿名模式可用），login 检查项仅报告状态
  }
  return emit({ ok, checks, reason, deep }, { exitCode: ok ? 0 : 1 });
}

/* ----------------------------------- ask ---------------------------------- */

async function cmdAsk() {
  return withBrowserLock("ask", () => cmdAskInner());
}

async function cmdAskInner() {
  const wsid = workspaceId();
  const session = getSession(wsid);

  let promptText = flags.prompt ?? null;
  if (!promptText && flags["prompt-file"]) {
    try {
      promptText = fs.readFileSync(flags["prompt-file"], "utf8");
    } catch (error) {
      return fail("INVALID_ARGUMENTS", `读不到 --prompt-file：${error.message}`);
    }
  }
  if (!promptText) return fail("INVALID_ARGUMENTS", "缺少 --prompt 或 --prompt-file");

  // 协议封装
  let protocolState = null;
  let taskId = flags.task !== undefined ? String(flags.task) : session.taskId ?? null;
  let iteration = flags.iteration !== undefined ? Number(flags.iteration) : Number(session.iteration) || 0;
  if (flags.protocol !== undefined) {
    if (flags.protocol === true) return fail("INVALID_ARGUMENTS", `--protocol 需要值：${PROTOCOL_STATES.join(" | ")}`);
    protocolState = String(flags.protocol).toUpperCase();
    if (!PROTOCOL_STATES.includes(protocolState)) return fail("INVALID_ARGUMENTS", `--protocol 只接受 ${PROTOCOL_STATES.join(" | ")}`);
    if (!taskId) taskId = newRequestId();
  }

  const gate = sanitizeOutbound(
    protocolState ? buildProtocolMessage(protocolState, promptText, { taskId, iteration }) : promptText,
    { allowSensitive: !!flags["allow-sensitive"], allowLarge: !!flags["allow-large"] }
  );
  if (!gate.ok) return fail(gate.reason, gate.message);
  const subject = gate.text;

  const threadArg = flags.thread === true ? "new" : flags.thread ?? null;
  let targetUrl = site.SITE_URL;
  if (threadArg && threadArg !== "new" && /^https?:/.test(threadArg)) targetUrl = threadArg;
  else if (!threadArg && session.threadUrl) targetUrl = session.threadUrl;

  const requestId = newRequestId();
  const startedAt = Date.now();
  const timeoutMs = Number(flags.timeout ?? 300000);
  const captchaWaitMs = Number(flags["captcha-wait"] ?? 180000);

  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
    activeCtx = ctx;
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }

  const downloadsDir = ensureDir(path.join(dirs().downloads, wsid));

  try {
    const page = await collapseToSinglePage(ctx);
    const completion = site.watchCompletion(page);

    await site.gotoSite(page, targetUrl);

    let st = await site.pageState(page);
    if (st.challenge) {
      captchaNotice("页面加载时就带出了滑块验证", captchaWaitMs);
      const w = await site.waitForChallengeCleared(page, {
        timeoutMs: captchaWaitMs,
        onTick: ({ remainingMs }) =>
          process.stderr.write(
            `  …仍在等待人工验证（滑块），剩余 ${Math.round(remainingMs / 1000)} 秒。` +
              "验证窗口若已关闭请重跑本命令；频繁触发时建议降低提问频率。\n"
          ),
      });
      if (!w.cleared) return fail("HUMAN_VERIFICATION_REQUIRED", captchaFailMessage(captchaWaitMs), { state: st });
      process.stderr.write("✓ 人工验证通过，继续。\n");
      st = await site.pageState(page);
    }
    if (st.rateLimited) return fail("RATE_LIMITED", "千问提示请求过于频繁，请稍后再试。", { retryAfterMs: 300000 });

    let threadLost = false;
    if (!st.hasEditor) {
      if (targetUrl !== site.SITE_URL) {
        threadLost = true;
        await site.gotoSite(page, site.SITE_URL);
        st = await site.pageState(page);
      }
      if (!st.hasEditor) return fail("COMPOSER_NOT_FOUND", "页面上找不到输入框（可能改版）。", { state: st });
    }

    // 开新对话：显式点「新建对话」，避免追加到旧会话
    if (!targetUrl || threadArg === "new") {
      await site.startNewChat(page);
    }

    // 模式（快速 / 思考研究）
    const modeBefore = await site.readMode(page);
    let modeRes = { ok: true, before: modeBefore ?? null, after: modeBefore ?? null, clicked: false };
    if (flags.think !== undefined) {
      const want = String(flags.think).toLowerCase() === "on" ? "思考研究" : "快速";
      modeRes = await site.setMode(page, want);
      if (!modeRes.ok) {
        return fail(modeRes.reason ?? "SITE_CHANGED", modeRes.message ?? "模式切换失败", { options: modeRes.options });
      }
    }

    // 附件上传（点击「添加附件」→ 接住 filechooser 事件；页面常驻 DOM 无 input[type=file]）
    if (flags.attach) {
      const files = String(flags.attach).split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of files) {
        if (!fs.existsSync(f)) return fail("INVALID_ARGUMENTS", `附件不存在：${f}`);
      }
      const up = await site.uploadAttachments(page, files);
      if (!up.ok) return fail(up.reason, up.message);
      log("info", `附件已上传 ${up.count} 个`);
    }

    // 发送前记录回答数基线：只认「新增的回答气泡」
    const baseline = await site.snapshotMarkers(page).catch(() => ({ answerCount: 0 }));

    const injected = await site.injectPrompt(page, subject);
    if (!injected.ok) return fail("SEND_FAILED", `输入注入失败（${injected.valueLength}/${injected.expected} 字符）`);

    const sent = await site.sendPrompt(page);
    if (!sent.ok) return fail(sent.reason, sent.message);

    let reSent = false;
    const ans = await site.waitForAnswer(page, {
      timeoutMs,
      completion,
      minAnswers: baseline.answerCount ?? 0,
      challengeWaitMs: captchaWaitMs,
      onChallenge: ({ phase }) => {
        if (phase === "pending") {
          captchaNotice("发送后触发了滑块验证（该消息可能被风控拦截）", captchaWaitMs);
          process.stderr.write("   提示：通过验证后 CLI 会自动重发这条消息，无需手动操作。\n");
        } else if (phase === "cleared") {
          process.stderr.write("✓ 人工验证通过，继续等待回答…\n");
        }
      },
      onPoll: (info) => log("debug", "waitForAnswer poll", info),
    }).catch((e) => ({ ok: false, reason: "INTERNAL_ERROR", message: String(e).slice(0, 200) }));

    // 千问特性：验证会拦住已发出的消息（回答停在生成中占位、不会自动恢复）。
    // 验证通过后立即重发一次（不等满 timeout）。
    // ⚠️ completion 必须活着到重发结束（dispose 后状态不再更新，重发会永远等不到 netIdle）。
    if (ans.reason === "STREAM_STALLED" && ans.challenge && ans.cleared) {
      process.stderr.write("验证通过后回答未恢复（该消息已被打断），正在重发…\n");
      completion.reset();
      await site.startNewChat(page).catch(() => {});
      const inj2 = await site.injectPrompt(page, subject).catch(() => ({ ok: false }));
      if (inj2.ok) {
        const baseline2 = await site.snapshotMarkers(page).catch(() => ({ answerCount: 0 }));
        await site.sendPrompt(page);
        const ans2 = await site.waitForAnswer(page, {
          timeoutMs,
          completion,
          minAnswers: baseline2.answerCount ?? 0,
          challengeWaitMs: captchaWaitMs,
          onChallenge: ({ phase }) => {
            if (phase === "pending") captchaNotice("重发时再次触发滑块验证", captchaWaitMs);
            else if (phase === "cleared") process.stderr.write("✓ 人工验证通过，继续等待回答…\n");
          },
          onPoll: (info) => log("debug", "waitForAnswer poll(resend)", info),
        }).catch((e) => ({ ok: false, reason: "INTERNAL_ERROR", message: String(e).slice(0, 200) }));
        reSent = true;
        Object.assign(ans, ans2, ans2.ok ? {} : { reSentFailed: true });
      }
    }
    completion.dispose();

    if (flags.debug || !ans.ok) {
      const tag = ans.ok ? "ask" : "ask-timeout";
      const file = saveDebugHtml(await page.content(), tag);
      if (!ans.ok) process.stderr.write(`超时取证 HTML：${file}\n`);
      else if (flags.debug) process.stderr.write(`调试 HTML：${file}\n`);
    }

    // 有下载按钮 → 取产物
    let files = [];
    if (ans.downloadLabel) {
      const dl = await site.downloadArtifact(page, ctx, downloadsDir);
      if (dl.ok) files = dl.files;
      log("info", `产物下载: ${JSON.stringify(dl).slice(0, 200)}`);
    }

    if (!ans.ok && !ans.text && !files.length) {
      if (ans.reason === "HUMAN_VERIFICATION_REQUIRED") {
        return fail("HUMAN_VERIFICATION_REQUIRED", captchaFailMessage(captchaWaitMs), {
          threadUrl: ans.url,
          captchaWaitMs,
        });
      }
      return fail(ans.reason ?? "STREAM_STALLED", ans.message ?? "等待回答超时，且没有抓到文本或产物。", { threadUrl: ans.url });
    }

    const threadUrl = ans.url && site.CONV_URL_RE.test(ans.url) ? ans.url : session.threadUrl ?? null;
    const protocolReply = protocolState ? parseProtocolReply(ans.text) : null;
    const modeAfter = await site.readMode(page).catch(() => null);
    const patch = { threadUrl, title: session.title ?? null };
    if (protocolState) {
      patch.taskId = taskId;
      patch.iteration = iteration;
      patch.state = protocolReply?.state ?? protocolState;
      const cp = protocolReply ? CHECKPOINT_FOR_REPLY[protocolReply.state] : null;
      if (cp) patch.checkpointPatch = cp;
    } else {
      patch.state = "ANSWERED";
    }
    setSession(patch, wsid);

    appendAudit(
      {
        ts: nowIso(),
        requestId,
        threadUrl,
        mode: { requested: flags.think ?? null, before: modeRes.before, after: modeAfter ?? modeRes.after },
        chars: ans.text?.length ?? 0,
        files: files.map((f) => ({ suggested: f.suggested, bytes: f.bytes })),
        protocol: protocolState ? { sent: protocolState, reply: protocolReply?.state ?? null, taskId, iteration } : null,
        truncated: !ans.ok,
        redactions: gate.redactions,
        reSent,
        elapsedMs: Date.now() - startedAt,
      },
      wsid
    );

    return emit({
      ok: true,
      requestId,
      threadUrl,
      modes: { mode: modeAfter ?? modeRes.after, requested: flags.think ?? null },
      text: ans.text ?? "",
      files,
      mode: ans.mode ?? (files.length ? "artifact" : "chat"),
      truncated: !ans.ok,
      elapsedMs: ans.elapsedMs ?? Date.now() - startedAt,
      threadLost: threadLost || undefined,
      redactions: gate.redactions.length ? gate.redactions : undefined,
      modeSwitch: modeRes.clicked ? { before: modeRes.before, after: modeRes.after } : undefined,
      reSent: reSent || undefined,
      protocol: protocolState ? { sent: protocolState, taskId, iteration, reply: protocolReply } : undefined,
    });
  } finally {
    if (!flags["keep-open"]) await closeBrowser(ctx);
    activeCtx = null;
  }
}

/* -------------------------------- thread / session ------------------------------- */

function cmdThread() {
  const sub = String(positionals[1] ?? "status").toLowerCase();
  const wsid = workspaceId();
  const session = getSession(wsid);
  if (sub === "status" || sub === "list") {
    return emit({ ok: true, workspaceId: wsid, threadUrl: session.threadUrl, title: session.title, state: session.state, checkpoint: session.checkpoint });
  }
  if (sub === "use") {
    const url = flags.url ?? positionals[2];
    if (!url) return fail("INVALID_ARGUMENTS", "用法：qwb thread use <url>");
    return emit({ ok: true, ...setSession({ threadUrl: url }, wsid) });
  }
  if (sub === "new") {
    return emit({ ok: true, ...setSession({ threadUrl: null, state: "NEW" }, wsid), note: "下一条 ask 会从首页开新对话" });
  }
  return fail("INVALID_ARGUMENTS", `未知子命令 thread ${sub}`);
}

function cmdSession() {
  const sub = String(positionals[1] ?? "get").toLowerCase();
  const wsid = workspaceId();
  if (sub === "get") return emit({ ok: true, session: getSession(wsid) });
  if (sub !== "set") return fail("INVALID_ARGUMENTS", `未知子命令 session ${sub}`);

  const patch = {};
  const cp = {};
  if (flags.url !== undefined) patch.threadUrl = flags.url;
  if (flags.title !== undefined) patch.title = flags.title;
  if (flags.task !== undefined) patch.taskId = flags.task;
  if (flags.iteration !== undefined) patch.iteration = Number(flags.iteration);
  if (flags.state !== undefined) patch.state = flags.state;
  if (flags["protocol-state"] !== undefined) cp.protocolState = flags["protocol-state"];
  if (flags["waiting-for"] !== undefined) cp.waitingFor = flags["waiting-for"];
  if (flags["next-step"] !== undefined) cp.nextExpectedStep = flags["next-step"];
  if (flags.goal !== undefined) cp.originalGoal = flags.goal;
  if (flags["known-issues"] !== undefined) cp.knownIssues = flags["known-issues"];
  if (Object.keys(cp).length) patch.checkpointPatch = cp;
  if (flags["clear-checkpoint"]) patch.clearCheckpoint = true;
  if (!Object.keys(patch).length) return fail("INVALID_ARGUMENTS", "没有要写入的字段");

  try {
    return emit({ ok: true, ...setSession(patch, wsid) });
  } catch (error) {
    return fail(error.code ?? "INTERNAL_ERROR", error.message);
  }
}

function cmdLogs() {
  const n = Number(flags.n ?? flags.lines ?? 50);
  const lines = tailLines(Number.isFinite(n) && n > 0 ? n : 50, { verbose: !!flags.verbose });
  if (json) return emit({ ok: true, lines });
  process.stdout.write(`${lines.join("\n")}\n`);
  return { ok: true };
}

function cmdUpdateCheck() {
  const d = dirs();
  const cache = readJson(d.updateCheck) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (!flags.force && cache.checkedOn === today) {
    return emit({ ok: true, version: VERSION, checked: false, updateAvailable: cache.updateAvailable ?? false, note: "今日已检查（缓存）" });
  }
  const note = "未配置远端仓库（git remote），无法自动检查更新；更新方式见 references/install.md";
  writeJson(d.updateCheck, { checkedOn: today, updateAvailable: false, note });
  return emit({ ok: true, version: VERSION, checked: true, updateAvailable: false, note });
}

/** 列出当前模式档位（快速 / 思考研究） */
async function cmdListModels() {
  return withBrowserLock("list-models", () => cmdListModelsInner());
}

async function cmdListModelsInner() {
  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
    activeCtx = ctx;
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }
  try {
    const page = await collapseToSinglePage(ctx);
    await site.gotoSite(page);
    const res = await site.listModes(page);
    if (!res.ok) return fail(res.reason ?? "SITE_CHANGED", res.message ?? "未读到模式列表", { current: res.current });
    return emit({ ok: true, current: res.current, options: res.options });
  } finally {
    await closeBrowser(ctx);
    activeCtx = null;
  }
}

function usage() {
  process.stdout.write(`qwb ${VERSION} — qwen-brain 机制层

用法：node <skill-root>/scripts/qwb/cli.mjs <命令> [选项]

命令：
  setup                 首次配置：装依赖 → 打开浏览器 → 人工登录（可跳过，匿名可用）
  login / logout        重新登录 / 清除登录态
  doctor [--deep] [--html]   体检（--deep 真机探测页面与模式选择器）
  ask --prompt-file f [--think on] [--attach a.png] [--thread new|<url>] [--json]
  list-models           列出模式档位（快速 / 思考研究）
  thread status|use <url>|new
  session get|set [...]      工作区线程与 checkpoint
  logs [-n 50] [--verbose]
  update-check [--force]

通用：--json 机器可读；--debug 保存页面 HTML；--keep-open 保留浏览器窗口；
     --captcha-wait <ms> 滑块验证等待时限（默认 180000）
`);
  return { ok: true };
}

/* --------------------------------- dispatch --------------------------------- */

try {
  if (flags.version) emit({ ok: true, version: VERSION });
  else if (cmd === "setup") await cmdSetup();
  else if (cmd === "login") await cmdLogin();
  else if (cmd === "logout") await cmdLogout();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "ask") await cmdAsk();
  else if (cmd === "list-models") await cmdListModels();
  else if (cmd === "thread") cmdThread();
  else if (cmd === "session") cmdSession();
  else if (cmd === "logs") cmdLogs();
  else if (cmd === "update-check") cmdUpdateCheck();
  else usage();
} catch (error) {
  fail(error.code ?? "INTERNAL_ERROR", error.message ?? String(error));
}
