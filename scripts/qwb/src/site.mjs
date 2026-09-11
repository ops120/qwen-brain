import fs from "node:fs";
import path from "node:path";

/**
 * qianwen.com（千问，阿里）页面交互层
 *
 * 所有选择器均来自真机验证（2026-09），完整记录见 references/site-map.md。
 * 与同族 brain 的关键差异：
 *   - 输入框是 contenteditable（role=textbox，在 [data-testid="chat-input-content-measure"] 内）
 *     —— **不能用 execCommand("insertText")**：文本进去了但 React 状态不更新，发送按钮保持禁用
 *     （实测踩过）；必须用 Playwright 的 keyboard.insertText()
 *   - class 名带随机后缀（CSS Modules，如 answer-common-card-xxx），选择器一律用 [class*=] 前缀匹配
 *   - 发送可能触发阿里滑块验证（nocaptcha），需等待用户完成后重试
 */

export const SITE_URL = "https://www.qianwen.com/";

/** 会话 URL：https://www.qianwen.com/chat/<16位十六进制> */
export const CONV_URL_RE = /qianwen\.com\/chat\/[0-9a-f]{8,}/i;

/** 生成请求端点（完成判定的网络信号；真机验证 2026-09） */
export const COMPLETION_URL_PARTS = ["/api/v2/chat"];

export const LABELS = {
  editor: "chat-input-content-measure 内的 contenteditable",
  send: "发送消息",
  newChat: "新建对话",
  modeSelector: "快速 / 思考研究（composer 工具栏）",
  attach: "添加附件",
};

export async function gotoSite(page, url = SITE_URL, { readyTimeoutMs = 25000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const started = Date.now();
  while (Date.now() - started < readyTimeoutMs) {
    const st = await page.evaluate(STATE_FN).catch(() => null);
    if (st?.hasEditor || st?.challenge) return st;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  return page.evaluate(STATE_FN).catch(() => null);
}

/* --------------------------------- 状态探测 --------------------------------- */

export const STATE_FN = () => {
  const vis = (el) =>
    !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
  const body = document.body ? document.body.innerText || "" : "";
  const editors = [...document.querySelectorAll('[contenteditable="true"]')].filter(vis);
  const signIn = [...document.querySelectorAll("button,a")].some(
    (e) => /^(登录|注册)$/.test((e.innerText || "").trim()) && e.getClientRects().length > 0
  );
  return {
    url: location.href,
    title: document.title,
    hasEditor: editors.length > 0,
    editorCount: editors.length,
    // 注意：未登录也有输入框（可匿名问答），不能只看这个
    signedOut: signIn,
    // 阿里滑块验证（nocaptcha）
    challenge:
      /请拖动下方滑块完成验证|请完成验证|拖动滑块|通过验证以确保正常访问/.test(body.slice(0, 3000)) ||
      /nc_1_nocaptcha|nocaptcha/i.test(document.documentElement.innerHTML.slice(0, 8000)),
    rateLimited: /请求过于频繁|稍后再试|已达到上限|额度已用完|rate limit|try again later/i.test(body),
    consent: false,
    textSample: body.replace(/\s+/g, " ").trim().slice(0, 240),
  };
};

export async function pageState(page) {
  return page.evaluate(STATE_FN);
}

/** 等输入框就绪（登录判定必须看 cookie，不看界面） */
export async function waitForEditor(page, { timeoutMs = 1800000, pollMs = 3000, onTick } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(STATE_FN).catch(() => null);
    if (last?.hasEditor) return { ok: true, state: last };
    onTick?.(last, Date.now() - started);
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, state: last };
}

/** 等滑块验证消失（用户在浏览器里完成）。返回是否在时限内通过。 */
export async function waitForChallengeCleared(page, { timeoutMs = 300000, pollMs = 3000, onWait } = {}) {
  const started = Date.now();
  let first = true;
  while (Date.now() - started < timeoutMs) {
    const st = await page.evaluate(STATE_FN).catch(() => null);
    if (!st?.challenge) return { cleared: true, waitedMs: Date.now() - started };
    if (first) {
      first = false;
      onWait?.();
    }
    await page.waitForTimeout(pollMs);
  }
  return { cleared: false, waitedMs: Date.now() - started };
}

/* --------------------------------- 输入与发送 -------------------------------- */

/**
 * 注入 prompt。
 * ⚠️ 必须用 keyboard.insertText()（点击编辑器获得焦点后）：
 *   execCommand("insertText") 对这个编辑器**不触发 React 状态更新**——
 *   文本看得见但发送按钮保持禁用，点了也发不出去（实测踩过）。
 */
export async function injectPrompt(page, text) {
  const editor = page.locator(
    '[data-testid="chat-input-content-measure"] [contenteditable="true"], [contenteditable="true"][role="textbox"]'
  ).first();
  await editor.waitFor({ state: "visible", timeout: 25000 });
  await editor.click({ timeout: 15000 });
  await page.waitForTimeout(400);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(800);

  const len = await page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const ed = [...document.querySelectorAll('[contenteditable="true"]')].find(vis);
    return ed ? (ed.innerText || "").length : -1;
  });
  return { ok: len > 0, valueLength: len, expected: text.length };
}

/** 发送：优先点「发送消息」按钮，兜底 Enter。 */
export async function sendPrompt(page) {
  try {
    await page.locator('button[aria-label="发送消息"], button[aria-label="发送"]').first().click({ timeout: 6000 });
    await page.waitForTimeout(1500);
    return { ok: true, method: "button" };
  } catch {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    return { ok: true, method: "enter" };
  }
}

/* ---------------------------------- 模型选择器 -------------------------------- */

/**
 * 读取当前模型：顶栏的模型按钮（文案形如「Qwen3.7-千问」，带下拉箭头）。
 * 注意 aria-label 不稳定，用「顶栏区域内、文案匹配 Qwen/千问」来定位。
 */
export async function readModel(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const btn = [...document.querySelectorAll("button,[role=button],div[role=combobox]")]
      .filter(vis)
      .find((b) => {
        const t = (b.innerText || "").replace(/\s+/g, " ").trim();
        return /^(Qwen|千问)/i.test(t) && t.length <= 30 && b.getBoundingClientRect().top < 120;
      });
    if (!btn) return null;
    const raw = (btn.innerText || "").replace(/\s+/g, " ").trim();
    return { raw, current: raw || null };
  });
}

/**
 * 切换模式（composer 工具栏的「快速 / 思考研究」，aria-label=当前模式名）。
 * target 匹配：快速 / 思考研究（也接受 think→思考研究、fast→快速 的别名）。
 * ⚠️ 必须真实鼠标点击：合成 click() 打不开菜单（实测踩过，与模型选择器同坑）。
 */
export async function setMode(page, target) {
  const ALIAS = { fast: "快速", quick: "快速", think: "思考研究", thinking: "思考研究", research: "思考研究" };
  const wanted = ALIAS[String(target).toLowerCase()] ?? String(target);
  const before = await readMode(page);
  if (before === wanted) return { ok: true, before, after: before, clicked: false };

  const opened = await openModeMenu(page);
  if (!opened) return { ok: false, reason: "SITE_CHANGED", message: "未找到模式选择器（快速/思考研究）" };

  const hit = await page.locator('[role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"]').all();
  let target2 = null;
  const seen = [];
  for (const o of hit) {
    if (!(await o.isVisible().catch(() => false))) continue;
    const t = ((await o.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!t) continue;
    seen.push(t.slice(0, 40));
    if (!target2 && t.startsWith(wanted)) target2 = o;
  }
  if (!target2) {
    await page.keyboard.press("Escape");
    return { ok: false, reason: "INVALID_ARGUMENTS", message: `模式列表里没有「${wanted}」`, options: seen };
  }
  await target2.click();
  await page.waitForTimeout(1500);
  const after = await readMode(page);
  return { ok: after === wanted, before, after, clicked: true, options: seen };
}

/** 打开模式菜单（真实点击 composer 工具栏的当前模式按钮）。 */
async function openModeMenu(page) {
  try {
    await page.locator('button[aria-label="快速"], button[aria-label="思考研究"]').first().click({ timeout: 6000 });
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

/** 读取当前模式（composer 工具栏 aria-label=当前模式名）。 */
export async function readMode(page) {
  return page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const btn = [...document.querySelectorAll("button")].find(
      (b) => vis(b) && /^(快速|思考研究)$/.test((b.getAttribute("aria-label") ?? "").trim())
    );
    return btn ? (btn.getAttribute("aria-label") || "").trim() : null;
  });
}

/** 列出可用模式（真实点击打开菜单读取，不切换）。 */
export async function listModes(page) {
  const current = await readMode(page);
  const opened = await openModeMenu(page);
  if (!opened) return { ok: false, reason: "SITE_CHANGED", message: "未找到模式选择器", current };
  await page.waitForTimeout(1500);
  const opts = await page.locator('[role="menuitemcheckbox"], [role="menuitemradio"], [role="menuitem"]').all();
  const options = [];
  for (const o of opts) {
    if (!(await o.isVisible().catch(() => false))) continue;
    const t = ((await o.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (t) options.push(t.slice(0, 60));
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  return { ok: options.length > 0, current, options };
}

/* ---------------------------------- 完成判定 --------------------------------- */

/** 监听生成请求（主判据：POST /api/v2/chat 结束） */
export function watchCompletion(page, urlParts = COMPLETION_URL_PARTS) {
  const state = { seen: false, done: false, failed: false };
  const match = (req) => urlParts.some((p) => req.url().includes(p));
  const onRequest = (req) => match(req) && (state.seen = true);
  const onFinished = (req) => match(req) && (state.done = true);
  const onFailed = (req) => match(req) && (state.failed = true);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return {
    get state() {
      return { ...state };
    },
    reset() {
      state.seen = false;
      state.done = false;
      state.failed = false;
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

/**
 * 回答区状态（真机验证 2026-09，CSS Modules 随机后缀 → 必须 [class*=] 前缀匹配）：
 *   - 用户消息：`question-text-card`
 *   - 回答容器：`answers-card-wrap` / `answer-common-card`（生成中是 `answer-receiving-card`）
 */
export const EXTRACT_FN = () => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
  const clean = (s) =>
    (s || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const collectText = (node) => {
    let out = "";
    const BLOCK = /^(p|div|li|tr|h[1-6]|pre|blockquote|section|article|table|ul|ol)$/;
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (tag === "sup" || tag === "sub") {
        out += collectText(el);
        continue;
      }
      if (tag === "br") {
        out += "\n";
        continue;
      }
      if (tag === "tr") out += "\n";
      if (tag === "td" || tag === "th") out += " | ";
      const isBlock = BLOCK.test(tag);
      if (isBlock) out += "\n";
      out += collectText(el);
      if (isBlock) out += "\n";
    }
    return out;
  };

  const answers = [...document.querySelectorAll('[class*="answer-common-card"]')].filter(vis);
  const last = answers[answers.length - 1] ?? null;
  const bodyEl =
    last?.querySelector('[class*="markdown"], [class*="prose"]') ?? last;
  const text = bodyEl ? clean(collectText(bodyEl)) : "";

  const stopVisible = [...document.querySelectorAll("button,[role=button]")].some(
    (el) => /^(停止|Stop|终止)$/.test((el.innerText || "").trim()) && el.getClientRects().length > 0
  );
  const receiving = [...document.querySelectorAll('[class*="answer-receiving-card"]')].some(vis);

  const buttons = [...document.querySelectorAll("button, [role=button]")]
    .map((b) => ({
      label: `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim(),
      visible: vis(b),
    }))
    .filter((b) => b.visible && /下载|复制|download|copy/i.test(b.label));

  return {
    text,
    textLen: text.length,
    answerCount: answers.length,
    stopVisible: stopVisible || receiving,
    isStreaming: stopVisible || receiving,
    buttons,
    downloadLabel: buttons.find((b) => /下载|download/i.test(b.label))?.label ?? null,
    url: location.href,
  };
};

export async function snapshotMarkers(page) {
  try {
    return await page.evaluate(EXTRACT_FN);
  } catch {
    return { text: "", textLen: 0, answerCount: 0, stopVisible: false, buttons: [] };
  }
}

/**
 * 等本次回答完成：网络结束 + 文本连续 N 次采样不变 + 只认新增回答。
 * minAnswers：发送前的回答数基线（页面可能恢复旧会话，必须只认新增）。
 * 期间出现滑块验证 → onChallenge 回调（由调用方决定等用户还是失败）。
 */
export async function waitForAnswer(
  page,
  { timeoutMs = 300000, pollMs = 2000, stableSamples = 3, completion = null, minAnswers = 0, onPoll, onChallenge } = {}
) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  let lastState = null;
  let challengeSeen = false;

  while (Date.now() - started < timeoutMs) {
    lastState = await page.evaluate(EXTRACT_FN).catch(() => null);
    const st = await page.evaluate(STATE_FN).catch(() => null);
    const cs = completion?.state ?? { seen: false, done: false, failed: false };
    const netIdle = !cs.seen || cs.done || cs.failed;

    if (st?.challenge) {
      if (!challengeSeen) {
        challengeSeen = true;
        onChallenge?.();
      }
      onPoll?.({ challenge: true });
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (lastState) {
      const fresh = (lastState.answerCount ?? 0) > minAnswers;
      const t = fresh ? lastState.text ?? "" : "";
      if (netIdle && t.length > 0 && t === last) stable++;
      else stable = 0;
      last = t;

      onPoll?.({
        len: t.length,
        stable,
        fresh,
        net: `${cs.seen ? "seen" : "-"}/${cs.done ? "done" : cs.failed ? "failed" : "-"}`,
        streaming: lastState.stopVisible,
      });

      if (fresh && netIdle && t.length > 0 && stable >= stableSamples) {
        return { ok: true, ...lastState, mode: "chat", elapsedMs: Date.now() - started };
      }
      if (fresh && netIdle && !lastState.stopVisible && Date.now() - started > 20000 && stable >= 2) {
        return { ok: true, ...lastState, mode: "chat", elapsedMs: Date.now() - started };
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, reason: "STREAM_STALLED", ...(lastState ?? {}), challenge: challengeSeen || undefined, elapsedMs: Date.now() - started };
}

/** 开新对话：点侧栏「新建对话」。 */
export async function startNewChat(page) {
  const clicked = await page.evaluate(() => {
    const vis = (e) => !!e && e.getClientRects().length > 0;
    const btn = [...document.querySelectorAll("button,[role=button]")].find(
      (b) => vis(b) && (b.getAttribute("aria-label") === "新建对话" || /^新建对话$/.test((b.innerText || "").trim()))
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (clicked) await page.waitForTimeout(2500);
  return { clicked };
}

/* ---------------------------------- 产物下载 --------------------------------- */

/**
 * 回答里的产物（生图等）下载按钮。与同族 downloadArtifact 同构。
 */
export const DOWNLOAD_BUTTONS_FN = () => {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  return [...document.querySelectorAll("button, [role=button]")]
    .map((b, idx) => {
      const r = b.getBoundingClientRect();
      const inView = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw;
      return {
        idx,
        label: `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim(),
        visible: r.width > 0 && r.height > 0,
        inView,
      };
    })
    .filter((b) => b.visible && /下载|保存|download|save/i.test(b.label))
    .sort((a, b) => Number(b.inView) - Number(a.inView) || a.idx - b.idx);
};

export const LOCATE_BUTTON_FN = async ({ idx, label }) => {
  const b = [...document.querySelectorAll("button, [role=button]")][idx];
  if (!b) return null;
  const now = `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`.trim();
  if (now !== label) return null;
  b.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await new Promise((r) => setTimeout(r, 250));
  const r = b.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return {
    label,
    x,
    y,
    hitSelf: !!hit && (hit === b || b.contains(hit) || hit.closest("button, [role=button]") === b),
  };
};

export async function downloadArtifact(page, ctx, outDir, { timeoutMs = 60000 } = {}) {
  const candidates = await page.evaluate(DOWNLOAD_BUTTONS_FN);
  if (!candidates.length) return { ok: false, reason: "NOT_FOUND", message: "页面上没有下载/保存按钮" };

  const saved = [];
  const onDownload = async (d) => {
    try {
      const file = path.join(outDir, d.suggestedFilename());
      await d.saveAs(file);
      saved.push({ file, suggested: d.suggestedFilename(), bytes: fs.statSync(file).size });
    } catch (error) {
      saved.push({ ok: false, error: String(error).slice(0, 150) });
    }
  };
  page.on("download", onDownload);

  const waitSaved = async (ms) => {
    const started = Date.now();
    while (!saved.length && Date.now() - started < ms) await page.waitForTimeout(800);
    return saved.length > 0;
  };

  let used = null;
  const diag = [];
  try {
    for (const cand of candidates.slice(0, 3)) {
      const loc = await page.evaluate(LOCATE_BUTTON_FN, cand).catch(() => null);
      if (!loc) continue;
      diag.push(`${loc.label}@${loc.x},${loc.y}${loc.hitSelf ? "" : "(被遮挡)"}`);
      if (!loc.hitSelf) continue;
      await page.mouse.click(loc.x, loc.y);
      if (await waitSaved(Math.min(timeoutMs, 20000))) {
        used = loc.label;
        break;
      }
    }
  } finally {
    page.off("download", onDownload);
  }
  return saved.length
    ? { ok: true, label: used, files: saved }
    : { ok: false, reason: "SEND_FAILED", message: `点击下载后没有触发下载事件（候选：${diag.join(" | ") || "无"}）` };
}
