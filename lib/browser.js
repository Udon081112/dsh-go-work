/**
 * dsh-go-work 瀏覽器層（browser.js）
 * 一個常駐的 Chrome session，五支工具共用：goto / read / act / shot / done。
 * 不用 Playwright MCP 那個，它要走 Chrome 的 debug pipe，多一層又唔穩。
 * 這裡自己 launch、自己管生命週期；Playwright 從 `@playwright/mcp` 借（不是依賴），沒有就報缺什麼。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

const PW_CANDIDATES = [
  process.env.DSH_GO_WORK_PLAYWRIGHT,
  /* DSH 的實驗性瀏覽器外掛（@deepseek-ai/dsh-experimental-browser-use-playwright-mcp）
     首次使用時會把微軟的 @playwright/mcp 裝在這，借它的 node_modules 即可。 */
  path.join(os.homedir(), '.dsh', 'mcp', 'browser', 'node_modules', 'playwright'),
  path.join(os.homedir(), '.dsh', 'mcp', 'browser', 'node_modules', 'playwright-core'),
  /* 使用者在插件目錄自行 npm i playwright，或裝在 npm 全域時走這兩條。 */
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'playwright'),
  path.join(process.cwd(), 'node_modules', 'playwright'),
].filter(Boolean);

const CHROME_CANDIDATES = [
  process.env.DSH_GO_WORK_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/** 只擋「按下去就要錢」的字眼。發佈／提交類（submit / 送出 / 提交）已全部放行。 */
const PAY_WORDS = /付款|支付|購買|结账|結帳|下單|下单|確認支付|确认支付|立即购买|立即購買|充值|儲值|check\s*out|buy\s*now|place\s*order|pay\b|purchase/i;

/** e1 / e2 / … → element 對照表，每次 read 重建。 */
let refs = new Map();

let session = null;

/* 搜尋預算：連續搜尋超過 2 輪就停手。不是怕花錢，是怕「搜完又搜、就是不肯開頁」這個循環。 */
const SEARCH_BUDGET = 2;
let searchesSinceNavigate = 0;

export function takeSearchBudget() {
  if (searchesSinceNavigate >= SEARCH_BUDGET) {
    return {
      ok: false,
      error:
        `已經搜了 ${SEARCH_BUDGET} 輪，還沒開任何頁面，停手。` +
        '要麼請主人給新關鍵字或直接貼網址，不要自己再換關鍵字搜——那只是在燒輪次。',
    };
  }
  searchesSinceNavigate += 1;
  return { ok: true, remaining: SEARCH_BUDGET - searchesSinceNavigate };
}

export function resetSearchBudget() {
  searchesSinceNavigate = 0;
}

function nowMs() {
  return Date.now();
}

export function loadPlaywright() {
  const errs = [];
  /* 先試 bare specifier：在插件目錄 npm i playwright 之後，這一步就會命中。 */
  for (const spec of ['playwright', 'playwright-core']) {
    try {
      const mod = require(spec);
      if (mod && (mod.chromium || (mod.default && mod.default.chromium))) {
        return { mod: mod.chromium ? mod : mod.default, from: spec };
      }
    } catch (e) {
      errs.push(`${spec}: ${e.message}`);
    }
  }
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
  /* Chrome 被主人手動關掉之後，page.url() 會 throw；gw_done 第一句就是呼叫這裡，
     所以這裡無論如何都要回一個物件，不能把「關不掉」變成「整個工具炸掉」。 */
  let url = '';
  try {
    url = session.page.url();
  } catch (e) {
    return { open: false, error: `瀏覽器已經被關掉了（${e.message.split('\n')[0]}）` };
  }
  return {
    open: true,
    url,
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

/** 回傳：null 表示通過，字串表示被擋（理由）。 */
export function domainBlocked(url, cfg) {
  const policy = cfg?.domainPolicy ?? 'off';
  if (policy === 'off') return null;
  const host = hostOf(url);
  if (!host) return null;

  const list = (cfg.domainList || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const hit = list.some((domain) => host === domain || host.endsWith(`.${domain}`));

  if (policy === 'blocklist') {
    return hit ? `網域政策：${host} 在封鎖名單裡，不能開。` : null;
  }
  if (policy === 'allowlist') {
    if (list.length === 0) return '網域政策：白名單是空的，所以哪裡都不能開。請主人先在設定裡加網域。';
    return hit ? null : `網域政策：${host} 不在白名單裡，不能開。`;
  }
  return null;
}

export async function closeSession() {
  const current = session;
  session = null;
  refs = new Map();
  /* 預算要跟 session 一起消失。以前只在成功 navigate 時歸零，於是「搜兩輪 → gw_done →
     下一個任務再 gw_goto {q}」會被判定「已經搜了 2 輪」而直接拒絕，跨任務殘留。 */
  resetSearchBudget();
  if (!current) return { closed: false };
  if (current.timer) clearTimeout(current.timer);
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
 * 拿到（需要時新建）當前的 session。
 * 每次呼叫前檢查兩條預算：總點擊次數、存活分鐘數。
 */
export async function ensureSession(cfg) {
  if (cfg && cfg.chromeProfile === 'current') {
    return {
      ok: false,
      error:
        '啟用現在這個 Chrome 的話，就要接管你正在用的視窗——不建議，跑一個乾淨的 Chrome 完全不會撞上。' +
        '硬要這樣的話請主人自己開，或者把設定改成「乾淨」模式。',
    };
  }

  if (session) {
    session.cfg = cfg;
    /* Chrome 可能被主人手動關掉（或自己崩掉）。以前這裡只看存活時間，
       於是死掉的 session 會一直卡著，每次呼叫都只拿到 "Target page ... has been closed"。
       先確認瀏覽器還連著、頁面還開著，死了就清乾淨重開。 */
    let dead = false;
    try {
      dead = !session.browser.isConnected() || session.page.isClosed();
    } catch {
      dead = true;
    }
    if (dead) {
      await closeSession();
      return ensureSession(cfg);
    }
    const alive = nowMs() - session.startedAt;
    const limitMs = (Number(cfg?.maxMinutes) || 30) * 60_000;
    if (alive > limitMs) {
      await closeSession();
      return { ok: false, error: `超過時限了：已開 ${Math.round(alive / 60_000)} 分鐘（上限 ${cfg?.maxMinutes ?? 30}）。已經關掉了，要再開就重新來一次。` };
    }
    return { ok: true, session };
  }

  const { mod, error } = loadPlaywright();
  if (!mod) {
    return {
      ok: false,
      error:
        '找不到 Playwright，工具暫時用不了。找過的地方：\n' + PW_CANDIDATES.map((p) => `  - ${p}`).join('\n') +
        `\n\n（${error}）\n\n最快的修法：在插件目錄執行 npm i playwright（或安裝 @playwright/mcp），` +
        '也可以設環境變數 DSH_GO_WORK_PLAYWRIGHT 指到 playwright 的資料夾。',
    };
  }

  const chrome = findChrome();
  if (!chrome) {
    return { ok: false, error: '找不到 Chrome / Edge 的執行檔。設 DSH_GO_WORK_CHROME 指到它的路徑。' };
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

  session = { browser, context, page, clicks: 0, startedAt: nowMs(), readStreak: 0, readUrl: '', cfg };
  refs = new Map();

  /* 新分頁／彈窗：很多站（OAuth、下載頁、遊戲）用 target=_blank。以前只有 context.newPage()
     那一頁，AI 會一直對著舊頁面瞎點。現在誰最新開就讀誰，而且新分頁也要過網域政策。 */
  context.on('page', (next) => {
    if (!session || session.context !== context) return;
    session.page = next;
    session.readStreak = 0;
    session.readUrl = '';
    next.on('close', () => {
      if (!session || session.page !== next) return;
      const alive = context.pages().filter((p) => !p.isClosed());
      session.page = alive[alive.length - 1] ?? next;
    });
    next
      .waitForLoadState('domcontentloaded', { timeout: 10_000 })
      .catch(() => {})
      .then(() => {
        if (!session || session.page !== next) return;
        let blocked = null;
        try {
          blocked = domainBlocked(next.url(), session.cfg);
        } catch {
          /* ignore */
        }
        if (blocked) next.close().catch(() => {});
      });
  });

  /* 沒有人會主動關 Chrome：AI 一停手它就一直在。所以掛個 timer，時間到自動關；每次呼叫前也會檢查一次。 */
  const limitMs = (Number(cfg?.maxMinutes) || 30) * 60_000;
  session.timer = setTimeout(() => {
    if (session && session.browser === browser) closeSession().catch(() => {});
  }, limitMs);
  session.timer.unref?.();

  return { ok: true, session };
}

/**
 * 動作之後的網域檢查。
 * 以前只在 `gw_goto` 進站那一刻檢查：點了連結跳去黑名單、302 到別的站、表單提交後跑掉，
 * 全部都不會再過濾。這裡做完一件事就把落地網址再過一次政策，中了就退回原頁。
 * 回傳 null = 通過；物件 = 已經退回、要當失敗回報。
 */
async function leash(cfg, from) {
  const page = session?.page;
  if (!page) return null;
  let here = '';
  try {
    here = page.url();
  } catch {
    return null;
  }
  const blocked = domainBlocked(here, cfg);
  if (!blocked) return null;
  try {
    if (from && from !== here) await page.goto(from, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    else await page.goto('about:blank');
  } catch {
    /* 退不回去就算了，至少不要再動 */
  }
  let back = '';
  try {
    back = page.url();
  } catch {
    /* ignore */
  }
  return { ok: false, blocked: true, error: `${blocked}（動作把頁面帶到 ${here}，已經退回 ${back || '上一頁'}）`, url: back };
}

export async function navigate(cfg, url, opts = {}) {
  /* opts.bypassPolicy 只給搜尋引擎用：白名單模式下 bing / duckduckgo / google 一定不在名單裡，
     不放行的話 `gw_goto { q }` 整個功能作廢。使用者自己挑的那條網址才過政策。 */
  const blocked = opts.bypassPolicy ? null : domainBlocked(url, cfg);
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
  /* 自己叫 navigate 的那種（例如搜尋引擎）不算「真的到目的地」，所以搜尋預算不歸零。 */
  if (!opts.keepBudget) resetSearchBudget();

  /* 重定向也是跳站，落地網址同樣要過政策。 */
  const after = opts.bypassPolicy ? null : await leash(cfg, '');
  if (after) return after;

  return {
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ''),
  };
}

/** 搜尋引擎：依序試，開得起來就抽結果，不行就下一個；一次只交三條。 */
const SEARCH_ENGINES = [
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-Hant`, timeoutMs: 15_000 },
  { name: 'duckduckgo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, timeoutMs: 12_000 },
  { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=zh-TW`, timeoutMs: 15_000 },
];

/**
 * 直接搜尋：一次搞定「開引擎頁 → read → parse」，把候選清單交出去，由 agent 拿去問主人挑哪個。
 */
export async function search(cfg, q, opts = {}) {
  const query = String(q || '').trim();
  if (!query) return { ok: false, error: '要找什麼？請給 q。' };

  const limit = Number(opts.limit) || 8;
  const tried = [];

  for (const engine of SEARCH_ENGINES) {
    const opened = await navigate(cfg, engine.url(query), {
      timeoutMs: engine.timeoutMs,
      keepBudget: true,
      bypassPolicy: true,
    });
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

        /* Bing 的結果連結是 bing.com/ck/a?u=a1<base64url> 跳轉，不解碼就只是 bing 自己的網址，會被我們的引擎頁過濾掉。 */
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

        // Google / 舊版
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
        hint: '這些只是候選，三條一起交給主人挑；gw_goto 會自動彈決策卡，不要自己點進去亂逛。',
      };
    }
    tried.push(`${engine.name}: 頁面開了但抽不到結果`);
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
 * 讀頁面：文字裁短，抓可點元素，每個元素編 data-gwref，act 就直接用它。
 */
export async function readPage(cfg, opts = {}) {
  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  /* 預設值刻意給小：頁面一大，agent 就在裡面迷路。自己可以調大，但別讓「預設」抽 90 個元素出來。 */
  const maxText = Number(opts.maxText) || 1500;
  const maxEls = Number(opts.maxElements) || 12;

  const data = await page
    .evaluate(
      ({ interactive, maxEls: cap, maxText: textCap }) => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return false;
          const s = getComputedStyle(el);
          if (s.visibility === 'hidden' || s.display === 'none' || !(Number(s.opacity) > 0.05)) {
            return false;
          }
          /* 很多 UI 會留一個 aria-hidden 的「影子」版本（例如按鈕的無障礙副本），
             長得跟真的那個一樣但永遠點不到。這種一定 skip，否則 ref 會指到幻影。 */
          if (el.closest('[aria-hidden="true"]')) return false;
          return true;
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

        /* 以前的 totalElements 其實是「掃到幾個」，跟內容無關，容易誤判。現在拆兩個：shown 給你看、total 講真正有幾個，而且只計可見性檢查過的。 */
        const all = document.querySelectorAll(interactive);
        const scanCap = 4000;
        const picked = [];
        let total = 0;
        for (let i = 0; i < all.length && i < scanCap; i += 1) {
          const el = all[i];
          if (!visible(el)) continue;
          total += 1;
          if (picked.length < cap) picked.push(el);
        }

        const elements = picked.map((el, i) => {
          const ref = `e${i + 1}`;
          el.setAttribute('data-gwref', ref);
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          const src =
            tag === 'img' ? String(el.currentSrc || el.src || '').slice(0, 300) : undefined;
          return {
            ref,
            tag: type ? `${tag}[${type}]` : tag,
            text: label(el),
            name: el.getAttribute('name') || undefined,
            href: tag === 'a' ? String(el.getAttribute('href') || '').slice(0, 120) : undefined,
            src: src || undefined,
          };
        });

        /* 圖片本身讀不到內容（文字層冇），但 URL 可以拿到：之後 gw_image 抓原圖，agent 就見到完整畫面。 */
        const imgSeen = new Set();
        const imgs = [];
        const addImage = (src, kind, rect, alt) => {
          if (!src || src.startsWith('data:')) return;
          const key = src.split('#')[0];
          if (imgSeen.has(key)) return;
          imgSeen.add(key);
          imgs.push({
            src: src.slice(0, 300),
            kind,
            alt: String(alt || '').slice(0, 60),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          });
        };

        for (const el of document.querySelectorAll('img')) {
          if (!visible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 48 || r.height < 48) continue;
          addImage(String(el.currentSrc || el.src || ''), 'img', r, el.getAttribute('alt'));
        }

        /* 很多站（Kahoot 的圖片題就是一例）把主視覺放在 CSS background-image，DOM 裡根本沒有 <img>。
           只找 <img> 會完全漏掉，所以順手掃背景圖。相對路徑要 resolve 成絕對網址。
           掃描有上限：getComputedStyle 不便宜，不能對整棵 DOM 無節制地叫。 */
        const BG_URL = /url\((['"]?)([^'")]+)\1\)/g;
        const bgScanCap = 2000;
        let scanned = 0;
        for (const el of document.querySelectorAll('div,section,figure,header,article,li,span,a')) {
          if (scanned >= bgScanCap || imgs.length >= 8) break;
          scanned += 1;
          const r = el.getBoundingClientRect();
          if (r.width < 96 || r.height < 96) continue;
          if (el.closest('[aria-hidden="true"]')) continue;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || !(Number(cs.opacity) > 0.05)) {
            continue;
          }
          const bg = cs.backgroundImage;
          if (!bg || bg === 'none') continue;
          BG_URL.lastIndex = 0;
          let m;
          while ((m = BG_URL.exec(bg)) !== null) {
            const raw = m[2];
            if (!raw || raw.startsWith('data:')) continue;
            let abs = raw;
            try {
              abs = new URL(raw, location.href).href;
            } catch {
              continue;
            }
            addImage(abs, 'background', r);
          }
        }

        imgs.sort((a, b) => b.w * b.h - a.w * a.h);
        const images = imgs.slice(0, 6);

        const body = document.body ? document.body.innerText || '' : '';
        const text = body.replace(/\n{3,}/g, '\n\n').trim().slice(0, textCap);

        return {
          url: location.href,
          title: document.title,
          text,
          truncated: body.length > textCap,
          elements,
          elementsShown: picked.length,
          elementsTotal: total,
          elementsScanCapped: all.length > scanCap,
          images,
          imagesTotal: imgs.length,
        };
      },
      { interactive: INTERACTIVE, maxEls, maxText },
    )
    .catch((e) => ({ error: e.message }));

  if (data.error) return { ok: false, error: `讀頁面失敗：${data.error}` };

  refs = new Map(data.elements.map((el) => [el.ref, el]));

  /* 偵測卡住：同一個網址一直 read 不停，就提醒一下。第三次就出聲，不要讓它喊第四次。 */
  const here = data.url || '';
  if (session.readUrl === here) session.readStreak += 1;
  else {
    session.readUrl = here;
    session.readStreak = 1;
  }

  const out = { ok: true, ...data, readCount: session.readStreak };
  /* 有圖就講清楚怎麼「真的看到」它：文字層看不到圖，只有像素才看得到。 */
  if (Array.isArray(out.images) && out.images.length > 0) {
    out.imagesNote =
      '圖片內容文字層讀不到。要看清就用 gw_image { src } 抓原圖落盤，再 read_image 該檔案（最清晰）；' +
      '臨時也可以 gw_goto { url: src } 再 gw_shot。kind=background 的圖是 CSS 背景圖，DOM 裡沒有 <img>。';
  }
  /* 遊戲常常整個在 iframe 裡（Poki 就是），裡面的 DOM 這支讀不到——所以加「有冇 iframe」這個提示，讓 agent 知道該改用截圖＋座標。 */
  try {
    const frames = page.frames();
    if (frames.length > 1) {
      out.frames = frames.slice(0, 6).map((f) => ({ name: f.name() || '', url: String(f.url()).slice(0, 140) }));
      out.frameNote =
        '這頁有 iframe：裡面的元素 read 不到。要操作就用 gw_shot 截圖看清楚，再用 gw_act { action:"click", x, y } 按座標點。';
    }
  } catch {}
  if (session.readStreak >= 3) {
    out.stuck = true;
    out.hint =
      `頁面已經讀了 ${session.readStreak} 次都沒動手。` +
      '要麼立刻 gw_act 點下去，要麼跟主人講你卡在哪裡——別再讀第四次。';
  }
  return out;
}

/**
 * 唯一的風險判斷：只擋付款 / 購買。
 * 發佈、提交、送出、留言、貼文一律放行——主人明確要求「所有詞語剷除，只擋付款」，
 * 因為測驗站（Kahoot 等）每一題都要按提交，擋住就玩不了。
 */
function looksRisky(text, cfg) {
  const t = String(text || '');
  if (cfg?.guardPayment && PAY_WORDS.test(t)) return '這看起來是付款 / 購買的按鈕';
  return null;
}

export async function actOn(cfg, args) {
  /* 連續動作：一 call 做完一串點擊，省掉「點一下 → 回模型 → 再想 → 再點」的輪次。遊戲、表單、連點下一步都是這種形狀。每步跟單步呼叫完全一樣的語義。 */
  if (Array.isArray(args?.steps) && args.steps.length > 0) {
    const did = [];
    for (const step of args.steps.slice(0, 30)) {
      const result = await actOn(cfg, { ...step, steps: undefined });
      did.push({ action: step?.action, ref: step?.ref, at: result?.at, ok: result?.ok !== false });
      if (result?.ok === false) {
        return { ok: false, action: 'steps', failedAt: did.length - 1, error: result.error, did };
      }
      const wait = Math.min(Math.max(Number(step?.waitMs) || 0, 0), 10_000);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    return { ok: true, action: 'steps', count: did.length, did };
  }

  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  const maxClicks = Number(cfg?.maxClicks) || 200;
  if (ready.session.clicks >= maxClicks) {
    return { ok: false, error: `點擊到達上限（已點 ${ready.session.clicks} 次，上限 ${maxClicks}）。要更多就跟主人講。` };
  }

  const action = args.action;
  const ref = args.ref;

  if (action === 'scroll') {
    await page.mouse.wheel(0, Number(args.dy) || 600);
    await page.waitForTimeout(250);
    return { ok: true, action: 'scroll', dy: Number(args.dy) || 600 };
  }

  /* 拖曳：Kahoot 排序題、拉桿、拖放都用這個。起點 (x, y) → 終點 (x2, y2)，全部截圖像素，viewport 1:1。Playwright 要「按實、分幾步移、中途才放手」才算 drag，庫自己認。 */
  const px = Number(args.x);
  const py = Number(args.y);
  if (action === 'drag') {
    const x2 = Number(args.x2);
    const y2 = Number(args.y2);
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
      return { ok: false, error: 'drag 要給 x, y（起點）同 x2, y2（終點），都係截圖像素。' };
    }
    try {
      const before = page.url();
      await page.mouse.move(px, py);
      await page.mouse.down();
      await page.mouse.move((px + x2) / 2, (py + y2) / 2, { steps: 8 });
      await page.mouse.move(x2, y2, { steps: 12 });
      await page.waitForTimeout(120);
      await page.mouse.up();
      ready.session.clicks += 1;
      ready.session.readStreak = 0;
      await page.waitForTimeout(400);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return {
        ok: true,
        action: 'drag',
        from: { x: px, y: py },
        to: { x: x2, y: y2 },
        clicks: ready.session.clicks,
        url: page.url(),
      };
    } catch (e) {
      return { ok: false, error: `拖曳失敗：${e.message}` };
    }
  }

  /* 冇 ref 都可以按鍵：直接按喺 focus 的元素（例如填完表按 Enter 送出）。 */
  if (action === 'press' && !ref) {
    /* 密碼保護唔可以只擋 ref 填字：主人可以用座標點進 password 欄，再用 press 逐個字打，
       等於繞過 guardPassword。所以按鍵前先睇 focus 係咪喺密碼欄。 */
    if (cfg?.guardPassword) {
      const onPassword = await page
        .evaluate(() => {
          const el = document.activeElement;
          return !!el && el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password';
        })
        .catch(() => false);
      if (onPassword) {
        return { ok: false, blocked: true, error: '目前焦點在密碼欄位，被政策擋下了。要填的話叫主人自己來，或去設定關掉密碼欄保護。' };
      }
    }
    try {
      const before = page.url();
      await page.keyboard.press(String(args.key || 'Enter'));
      await page.waitForTimeout(200);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'press', key: String(args.key || 'Enter'), url: page.url() };
    } catch (e) {
      return { ok: false, error: `按鍵失敗：${e.message}` };
    }
  }

  /* 座標點擊：canvas / iframe 遊戲（Poki 這類）根本冇 DOM ref 可拿，read 也讀不到棋盤，所以允許直接給 (x, y) —— 就是截圖上的像素座標。
     viewport 1:1，不用換算。冇 ref 就靠這裡的 info，所以照樣做同一套風險檢查。 */
  if (action === 'click' && Number.isFinite(px) && Number.isFinite(py)) {
    try {
      const probe = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { text: '', password: false };
          return {
            text: String(el.innerText || el.textContent || el.getAttribute?.('aria-label') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120),
            password: !!el.closest?.('input[type="password"]'),
          };
        },
        [px, py],
      );
      const under = probe.text;
      if (probe.password && cfg?.guardPassword) {
        return { ok: false, blocked: true, error: '座標點到了密碼欄位，被政策擋下了。要填的話叫主人自己來，或去設定關掉密碼欄保護。' };
      }
      const risk = looksRisky(under, cfg);
      if (risk) {
        return {
          ok: false,
          blocked: true,
          error: `${risk}（座標點到「${under}」），被政策擋下了。要繼續的話先問主人，或去設定關掉對應的保護。`,
        };
      }
      const before = page.url();
      await page.mouse.click(px, py);
      ready.session.clicks += 1;
      ready.session.readStreak = 0;
      await page.waitForTimeout(400);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'click', at: { x: px, y: py }, clicks: ready.session.clicks, url: page.url() };
    } catch (e) {
      return { ok: false, error: `點不到座標 (${px}, ${py})：${e.message}` };
    }
  }

  if (!ref) return { ok: false, error: '要給 ref（先 read 一次拿元素清單），或者 canvas 遊戲給 x / y 座標。' };
  if (!refs.has(ref)) return { ok: false, error: `沒有 ${ref} 這個元素。頁面可能換了，重新 read 一次。` };

  const info = refs.get(ref);
  const locator = page.locator(`[data-gwref="${ref}"]`).first();

  if (action === 'type') {
    const isPassword = /password/i.test(info.tag);
    if (isPassword && cfg?.guardPassword) {
      return { ok: false, blocked: true, error: '這是密碼欄位，被政策擋下了。要填的話叫主人自己來，或去設定關掉密碼欄保護。' };
    }
    const before = page.url();
    try {
      await locator.fill(String(args.text ?? ''));
      await page.waitForTimeout(150);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'type', ref, chars: String(args.text ?? '').length, password: isPassword };
    } catch (e) {
      return { ok: false, error: `填不進去：${e.message}` };
    }
  }

  /* 下拉選單：以前只能 type（fill 對 <select> 冇用）或者用座標亂點，乾脆加一個動作。
     text 當顯示文字、value 當實際值，兩邊都試一次。 */
  if (action === 'select') {
    const want = String(args.text ?? args.value ?? '').trim();
    if (!want) return { ok: false, error: 'select 要給 text（選項顯示文字）或 value（選項的值）。' };
    const before = page.url();
    try {
      let picked;
      try {
        picked = await locator.selectOption({ label: want }, { timeout: 5000 });
      } catch {
        picked = await locator.selectOption(want, { timeout: 5000 });
      }
      await page.waitForTimeout(200);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'select', ref, selected: picked, url: page.url() };
    } catch (e) {
      return { ok: false, error: `選不到「${want}」（要選單 <select> 才可以用 select）：${e.message}` };
    }
  }

  if (action === 'press') {
    const before = page.url();
    try {
      await locator.press(String(args.key || 'Enter'));
      await page.waitForTimeout(250);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'press', ref, key: String(args.key || 'Enter'), url: page.url() };
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
    const before = page.url();
    try {
      await locator.click({ timeout: 8000 });
      ready.session.clicks += 1;
      ready.session.readStreak = 0;
      await page.waitForTimeout(350);
      const leashed = await leash(cfg, before);
      if (leashed) return leashed;
      return { ok: true, action: 'click', ref, clicks: ready.session.clicks, url: page.url() };
    } catch (e) {
      return { ok: false, error: `點不到：${e.message}` };
    }
  }

  return { ok: false, error: `不認識的 action「${action}」，可以用的是 click / type / select / press / scroll / drag。` };
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
      note: '沒有設定儲存位置，所以這張圖沒有落盤。要留底的話，請在設定裡填 shotDir，或者叫 gw_shot 時給 dir。',
    };
  }

  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `shot-${stamp}.png`);
  fs.writeFileSync(file, buf);
  return { ok: true, path: file, bytes: buf.length, url: page.url() };
}

/**
 * 抓一張圖的原始 bytes 落盤，回檔案路徑 —— 之後 read_image 就見到完整原圖。
 * 用 page 的 request context 抓，所以同一個瀏覽器的 cookie / referer 都帶上，免受防盜鏈影響。
 */
export async function saveImage(cfg, opts = {}) {
  const src = String(opts.src || '').trim();
  if (!/^https?:\/\//i.test(src)) return { ok: false, error: 'src 要是 http(s) 開頭的完整網址。' };

  const ready = await ensureSession(cfg);
  if (!ready.ok) return ready;
  const { page } = ready.session;

  const dir = String(opts.dir || cfg?.shotDir || '').trim();
  if (!dir) return { ok: false, error: '沒有儲存位置：設定裡填 shotDir，或者叫 gw_image 時給 dir。' };

  let resp;
  try {
    resp = await page.context().request.get(src, { timeout: 30_000 });
  } catch (e) {
    return { ok: false, error: `抓圖失敗：${e.message}` };
  }
  if (!resp.ok()) return { ok: false, error: `抓圖失敗：HTTP ${resp.status()}`, url: src };

  const type = String(resp.headers()['content-type'] || '');
  const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : /gif/i.test(type) ? 'gif' : 'jpg';
  const buf = await resp.body();

  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `image-${stamp}.${ext}`);
  fs.writeFileSync(file, buf);

  return {
    ok: true,
    path: file,
    bytes: buf.length,
    type: type || undefined,
    url: src,
    hint: '用 read_image 開這個 path 就見到原圖（唔使再截圖）。',
  };
}

