/**
 * dsh-go-work —— 瀏覽器引擎
 *
 * 一個常駐的 Chrome session，五個工具共用：goto / read / act / shot / done。
 * 不用 Playwright 的 MCP，因為那個開的 Chrome 走 debug pipe，外部連不上；
 * 這裡自己 launch，自己管生命週期。
 *
 * Playwright 從外面的 `@playwright/mcp` 借（不裝依賴），找不到就回報缺什麼。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

const PW_CANDIDATES = [
  process.env.DSH_GO_WORK_PLAYWRIGHT,
  path.join(os.homedir(), '.dsh', 'mcp', 'browser', 'node_modules', 'playwright'),
  path.join(os.homedir(), '.dsh', 'mcp', 'browser', 'node_modules', 'playwright-core'),
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.DSH_GO_WORK_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/** 這兩個是「按下去就要錢 / 就要公開」的字眼，擋在點擊之前。 */
const PAY_WORDS = /付款|支付|購買|结账|結帳|下單|下单|確認支付|确认支付|立即购买|立即購買|結帳|充值|儲值|check\s*out|buy\s*now|place\s*order|pay\b|purchase/i;
const PUBLISH_WORDS = /發佈|發布|发布|送出|提交|留言|评论|評論|點讚|点赞|按讚|转发|轉發|publish|post\b|submit|comment|send\b|tweet/i;

/** e1 / e2 / … → element handle 的對照表，每次 read 重建。 */
let refs = new Map();

let session = null;

function nowMs() {
  return Date.now();
}

export function loadPlaywright() {
  const errs = [];
  for (const candidate of PW_CANDIDATES) {
    try {
      const mod = require(candidate);
      if (mod && (mod.chromium || (mod.default && mod.default.chromium))) {
        return { mod: mod.chromium ? mod : mod.default, from: candidate };
      }
      errs.push(`${candidate}: no chromium export`);
    } catch (e) {
      errs.push(`${candidate}: ${e.message}`);
    }
  }
  return { mod: null, error: errs.join(' | ') };
}

export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function status() {
  if (!session) return { open: false };
  return {
    open: true,
    url: session.page.url(),
    clicks: session.clicks,
    startedAt: new Date(session.startedAt).toISOString(),
    elapsedMs: nowMs() - session.startedAt,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 政策：回 null 表示放行，回字串表示拒絕理由。 */
export function domainBlocked(url, cfg) {
  const policy = cfg?.domainPolicy ?? 'off';
  if (policy === 'off') return null;
  const host = hostOf(url);
  if (!host) return null;

  const list = (cfg.domainList || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const hit = list.some((domain) => host === domain || host.endsWith(`.${domain}`));

  if (policy === 'blocklist') {
    return hit ? `網域政策：${host} 在黑名單裡，不去。` : null;
  }
  if (policy === 'allowlist') {
    if (list.length === 0) return '網域政策：白名單是空的，所以哪裡都不能去。請主人先在設定裡加網域。';
    return hit ? null : `網域政策：${host} 不在白名單裡，不去。`;
  }
  return null;
}

export async function closeSession() {
  const current = session;
  session = null;
  refs = new Map();
  if (!current) return { closed: false };
  try {
    await current.context.close();
  } catch {
    /* ignore */
  }
  try {
    await current.browser.close();
  } catch {
    /* ignore */
  }
  return { closed: true, clicks: current.clicks, elapsedMs: nowMs() - current.startedAt };
}

/**
 * 拿到（必要時建立）當前 session。
 * 每次呼叫都檢查兩條預算：點擊次數、存活分鐘數。
 */
export async function ensureSession(cfg) {
  if (cfg && cfg.chromeProfile === 'current') {
    return {
      ok: false,
      error:
        '「用現在這個 Chrome」還沒做。它需要先把你正在跑的 Chrome 完全關掉才連得上，' +
        '硬連會把你的登入態弄壞。目前請用「乾淨」。',
    };
  }

  if (session) {
    const alive = nowMs() - session.startedAt;
    const limitMs = (Number(cfg?.maxMinutes) || 30) * 60_000;
    if (alive > limitMs) {
      await closeSession();
      return { ok: false, error: `預算用完了：已經開了 ${Math.round(alive / 60_000)} 分鐘（上限 ${cfg?.maxMinutes ?? 30}）。已經關掉，重新來的話再叫偶一次。` };
    }
    return { ok: true, session };
  }

  const { mod, error, from } = loadPlaywright();
  if (!mod) {
    return {
      ok: false,
      error:
        '找不到 Playwright。偶會去這些地方找：\n' + PW_CANDIDATES.map((p) => `  - ${p}`).join('\n') +
        `\n\n（${error}）\n\n最快的修法：裝 @playwright/mcp，或設環境變數 DSH_GO_WORK_PLAYWRIGHT 指到 playwright 目錄。`,
    };
  }

  const chrome = findChrome();
  if (!chrome) {
    return { ok: false, error: '找不到 Chrome / Edge 執行檔。設 DSH_GO_WORK_CHROME 指過去。' };
  }

  let browser;
  try {
    browser = await mod.chromium.launch({
      executablePath: chrome,
      headless: false,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 880 },
    });
  } catch (e) {
    return { ok: false, error: `開 Chrome 失敗：${e.message}` };
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 880 } });
  const page = await context.newPage();

  session = { browser, context, page, clicks: 0, startedAt: nowMs(), pw: from, chrome, readStreak: 0, readUrl: '' };
  refs = new Map();
  return { ok: true, session };
}

export async function navigate(cfg, url, opts = {}) {
  const blocked = domainBlocked(url, cfg);
  if (blocked) return { ok: false, error: blocked, blocked: true };

  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  const timeout = Number(opts.timeoutMs) || 30_000;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (e) {
    return { ok: false, error: `開不了 ${url}：${e.message.split('\n')[0]}` };
  }
  await page.waitForTimeout(350);
  ready.session.readStreak = 0;
  ready.session.readUrl = page.url();
  return {
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/** 搜尋引擎依序試：前面掛了才換下一個，不要一次等三個超時。 */
const SEARCH_ENGINES = [
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hant`, timeoutMs: 15_000 },
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, timeoutMs: 12_000 },
  { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=zh-TW`, timeoutMs: 15_000 },
];

/**
 * 直接搜尋，不用「開搜尋頁 → read → parse → 再 goto」繞三圈。
 * 一次呼叫就把候選清單交出去，讓 agent 拿去問主人挑哪個。
 */
export async function search(cfg, q, opts = {}) {
  const query = String(q || '').trim();
  if (!query) return { ok: false, error: '要找什麼？給 q。' };

  const limit = Number(opts.limit) || 8;
  const tried = [];

  for (const engine of SEARCH_ENGINES) {
    const opened = await navigate(cfg, engine.url(query), { timeoutMs: engine.timeoutMs });
    if (!opened.ok) {
      tried.push(`${engine.name}: ${opened.error}`);
      continue;
    }

    const { page } = session;
    const results = await page
      .evaluate((cap) => {
        const seen = new Set();
        const out = [];
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

        /* Bing 的結果連結是 bing.com/ck/a?…&u=a1<base64url> 的跳板。
           不解開就全是 bing 自己的網域，會被當成搜尋引擎頁面濾掉。 */
        const realUrl = (href) => {
          try {
            const u = new URL(href);
            if (!/(^|\.)bing\.com$/i.test(u.hostname)) return href;
            const raw = u.searchParams.get('u');
            if (!raw || !raw.startsWith('a1')) return href;
            const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            const decoded = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
            return /^https?:\/\//i.test(decoded) ? decoded : href;
          } catch {
            return href;
          }
        };

        const add = (href, title, body) => {
          if (out.length >= cap) return;
          if (!/^https?:\/\//i.test(href)) return;
          if (/^https?:\/\/(www\.)?(bing|google|duckduckgo)\./i.test(href)) return;
          if (seen.has(href)) return;
          seen.add(href);
          const t = clean(title);
          const snippet = clean(body).replace(t, '').trim();
          out.push({ title: t.slice(0, 90), url: href.slice(0, 220), snippet: snippet.slice(0, 180) });
        };

        // Bing
        for (const li of document.querySelectorAll('#b_results li.b_algo')) {
          const a = li.querySelector('h2 a') || li.querySelector('a');
          if (!a) continue;
          const h2 = li.querySelector('h2');
          add(realUrl(a.href), h2 ? h2.textContent : a.textContent, li.innerText || li.textContent);
        }

        // DuckDuckGo
        if (out.length === 0) {
          for (const a of document.querySelectorAll('.result__a')) {
            const box = a.closest('.result');
            add(realUrl(a.href), a.textContent, box ? box.innerText : '');
          }
        }

        // Google / 通用
        if (out.length === 0) {
          for (const h of document.querySelectorAll('a h3')) {
            const a = h.closest('a');
            if (!a) continue;
            add(realUrl(a.href), h.textContent, a.parentElement ? a.parentElement.innerText : '');
          }
        }

        return out;
      }, limit)
      .catch(() => []);

    if (results.length > 0) {
      return {
        ok: true,
        query,
        engine: engine.name,
        results,
        hint: '把這幾條原樣給主人挑，不要自己點進去亂逛。主人點頭再 goto。',
      };
    }
    tried.push(`${engine.name}: 頁面開了但抓不到結果`);
  }

  return { ok: false, error: `搜尋都失敗了：\n${tried.join('\n')}` };
}

const INTERACTIVE = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=checkbox]',
  '[onclick]',
  '[contenteditable=true]',
].join(',');

/**
 * 讀頁面：文字（裁過）+ 可互動元素清單。
 * 每個元素掛 data-gwref，act 的時候直接用它。
 */
export async function readPage(cfg, opts = {}) {
  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  /* 預設值刻意給小：頁面一長，agent 就在裡面瞎挖。
     想多看再自己傳參數，但別讓「預設」變成 90 個元素的雜訊。 */
  const maxText = Number(opts.maxText) || 1500;
  const maxEls = Number(opts.maxElements) || 12;

  const data = await page
    .evaluate(
      ({ interactive, maxEls: cap, maxText: textCap }) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const s = getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
        };
        const label = (el) => {
          const raw =
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.getAttribute('placeholder') ||
            el.innerText ||
            el.value ||
            el.getAttribute('alt') ||
            '';
          return String(raw).replace(/\s+/g, ' ').trim().slice(0, 90);
        };

        const picked = [];
        for (const el of document.querySelectorAll(interactive)) {
          if (picked.length >= cap) break;
          if (!visible(el)) continue;
          picked.push(el);
        }

        const elements = picked.map((el, i) => {
          const ref = `e${i + 1}`;
          el.setAttribute('data-gwref', ref);
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          return {
            ref,
            tag: type ? `${tag}[${type}]` : tag,
            text: label(el),
            name: el.getAttribute('name') || undefined,
            href: tag === 'a' ? String(el.getAttribute('href') || '').slice(0, 120) : undefined,
          };
        });

        const body = document.body ? document.body.innerText || '' : '';
        const text = body.replace(/\n{3,}/g, '\n\n').trim().slice(0, textCap);

        return {
          url: location.href,
          title: document.title,
          text,
          truncated: body.length > textCap,
          elements,
          totalElements: picked.length,
        };
      },
      { interactive: INTERACTIVE, maxEls, maxText },
    )
    .catch((e) => ({ error: e.message }));

  if (data.error) return { ok: false, error: `讀頁面失敗：${data.error}` };

  refs = new Map(data.elements.map((el) => [el.ref, el]));

  /* 探索預算：同一個網址一直 read 卻不動手，就是在瞎挖。
     第三次就明講，不要讓它讀第四次。 */
  const here = data.url || '';
  if (session.readUrl === here) session.readStreak += 1;
  else {
    session.readUrl = here;
    session.readStreak = 1;
  }

  const out = { ok: true, ...data, readCount: session.readStreak };
  if (session.readStreak >= 3) {
    out.stuck = true;
    out.hint =
      `這一頁你已經讀了 ${session.readStreak} 次還沒動手。` +
      '要嘛立刻 gw_act 點一個，要嘛跟主人講你卡在哪——別再讀第四次。';
  }
  return out;
}

function looksRisky(text, cfg) {
  const t = String(text || '');
  if (cfg?.guardPayment && PAY_WORDS.test(t)) return '這看起來是付款 / 購買的按鈕';
  if (cfg?.guardPublish && PUBLISH_WORDS.test(t)) return '這看起來是發佈 / 提交的按鈕';
  return null;
}

export async function actOn(cfg, args) {
  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  const maxClicks = Number(cfg?.maxClicks) || 200;
  if (ready.session.clicks >= maxClicks) {
    return { ok: false, error: `預算用完了：已經點了 ${ready.session.clicks} 次（上限 ${maxClicks}）。換個做法，或跟主人講。` };
  }

  const action = args.action;
  const ref = args.ref;

  if (action === 'scroll') {
    await page.mouse.wheel(0, Number(args.dy) || 600);
    await page.waitForTimeout(250);
    return { ok: true, action: 'scroll', dy: Number(args.dy) || 600 };
  }

  if (!ref) return { ok: false, error: '要給 ref。先 read 一次拿元素清單。' };
  if (!refs.has(ref)) return { ok: false, error: `沒有 ${ref} 這個元素。頁面可能變了，重新 read 一次。` };

  const info = refs.get(ref);
  const locator = page.locator(`[data-gwref="${ref}"]`).first();

  if (action === 'type') {
    const isPassword = /password/i.test(info.tag);
    if (isPassword && cfg?.guardPassword) {
      return { ok: false, blocked: true, error: '這是密碼欄位，被政策擋下了。要填的話叫主人自己來，或去設定關掉「不准填密碼」。' };
    }
    try {
      await locator.fill(String(args.text ?? ''));
      await page.waitForTimeout(150);
      return { ok: true, action: 'type', ref, chars: String(args.text ?? '').length, password: isPassword };
    } catch (e) {
      return { ok: false, error: `填不進去：${e.message}` };
    }
  }

  if (action === 'press') {
    try {
      await locator.press(String(args.key || 'Enter'));
      await page.waitForTimeout(250);
      return { ok: true, action: 'press', ref, key: String(args.key || 'Enter') };
    } catch (e) {
      return { ok: false, error: `按鍵失敗：${e.message}` };
    }
  }

  if (action === 'click') {
    const risk = looksRisky(info.text, cfg);
    if (risk) {
      return {
        ok: false,
        blocked: true,
        error: `${risk}（「${info.text}」），被政策擋下了。要繼續的話先問主人，或去設定關掉對應的保護。`,
      };
    }
    try {
      await locator.click({ timeout: 8000 });
      ready.session.clicks += 1;
      ready.session.readStreak = 0;
      await page.waitForTimeout(350);
      return { ok: true, action: 'click', ref, clicks: ready.session.clicks, url: page.url() };
    } catch (e) {
      return { ok: false, error: `點不到：${e.message}` };
    }
  }

  return { ok: false, error: `不認識的 action：${action}。可以用的：click / type / press / scroll。` };
}

export async function screenshot(cfg, opts = {}) {
  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  const dir = String(opts.dir || cfg?.shotDir || '').trim();
  const buf = await page.screenshot({ type: 'png', fullPage: !!opts.full });

  if (!dir) {
    return {
      ok: true,
      bytes: buf.length,
      note: '沒有設定存檔位置，所以這張圖沒有落地。要讓偶看，請在設定裡填「存哪裡」，或叫偶截圖時給 dir。',
      base64Sample: buf.toString('base64').slice(0, 0),
    };
  }

  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `shot-${stamp}.png`);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, bytes: buf.length, url: page.url() };
}

export function countClicks() {
  return session ? session.clicks : 0;
}
