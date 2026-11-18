/**
 * dsh-go-work —— 五個給 agent 用的瀏覽器工具
 *
 * 刻意不用 `defineTool`（那要 peer import @deepseek-ai/dsh-tools），
 * 這裡直接吐 registry 認得的形狀，插件零依賴就能跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from './browser.js';

/* ---- 關鍵字 → 上次挑中的網站。同樣的關鍵字再問，就直接開，不搜、不問。 ---- */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const MEMORY_PATH = path.join(DSH_HOME, 'go-work.memory.json');
const MEMORY_TTL_MS = 30 * 24 * 3600 * 1000;
const MEMORY_MAX = 200;

function normQuery(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function readMemory() {
  try {
    const raw = JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeMemory(next) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_PATH), { recursive: true });
    fs.writeFileSync(MEMORY_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* 記憶只是加速，寫不進去不算錯 */
  }
}

/* 記憶檔會留在 ~/.dsh 很久，所以不要把帶 session / 追蹤參數的網址原樣存進去。
   （實例：bilibili 的網址帶 msockid=…，存下來等於留一條過期的登入痕跡。） */
const DROP_PARAMS = /^(msockid|sid|session|sessionid|sess|token|access_token|auth|ticket|utm_\w+|spm_id_from|vd_source|share_source|share_medium|bbid|ts)$/i;

function tidyUrl(raw) {
  try {
    const u = new URL(String(raw));
    for (const key of [...u.searchParams.keys()]) {
      if (DROP_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.href;
  } catch {
    return String(raw || '');
  }
}

function lookupMemory(q) {
  const hit = readMemory()?.queries?.[normQuery(q)];
  if (!hit?.url) return undefined;
  if (Date.now() - Number(hit.at || 0) > MEMORY_TTL_MS) return undefined;
  return hit;
}

function rememberQuery(q, url, title) {
  const mem = readMemory();
  const queries = mem.queries && typeof mem.queries === 'object' ? mem.queries : {};
  queries[normQuery(q)] = { url: tidyUrl(url), title: String(title || ''), at: Date.now() };
  const keys = Object.keys(queries);
  if (keys.length > MEMORY_MAX) {
    keys.sort((a, b) => Number(queries[a]?.at || 0) - Number(queries[b]?.at || 0));
    for (const key of keys.slice(0, keys.length - MEMORY_MAX)) delete queries[key];
  }
  writeMemory({ ...mem, queries });
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * 宿主是這樣叫 render 的：`tool.output.render(exec.arguments, value)`
 * （dsh-tools/lib/index.js:3544）。
 * 之前簽名寫成 render(value)，等於只拿到**參數**，於是我看到的工具結果一直
 * 是 `{"q":"…"}` / `{}`（參數原樣），真正的結果被丟掉。這裡兩個都收。
 */
function render(_args, value) {
  const payload = value === undefined ? _args : value;
  if (payload && typeof payload === 'object' && payload.ok === false) {
    return text(`⚠ ${payload.error || payload.warning || '失敗'}`);
  }
  return text(payload);
}

function tool({ name, description, parameters, timeoutMs, execute }) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render },
    timeoutMs,
    execute: async (args, exec) => plain(await execute(args, exec)),
  };
}

/**
 * 有些頁面抓回來的物件帶 `undefined`／`NaN`（Playwright 自己的序列化會保留它們），
 * 而宿主只收「無損 JSON」——gw_read 之前就是死在這裡：
 * `tool "gw_read" returned invalid output: value is not lossless JSON`。
 * 所以在工具出口統一過一次 JSON：undefined 的鍵直接消失，NaN/Infinity 變 null。
 */
function plain(value) {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) return null;
        if (typeof item === 'bigint') return String(item);
        if (typeof item === 'function' || typeof item === 'symbol') return undefined;
        return item;
      }),
    );
  } catch (err) {
    return { ok: false, error: `工具回傳值無法序列化成 JSON：${String(err?.message ?? err)}` };
  }
}

function objectParams(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** 每個工具都先過一遍「這功能有沒有被關掉」。 */
function guard(cfg, key) {
  if (!cfg.enabled) return { ok: false, error: '整個瀏覽器功能在設定裡被關掉了。請主人去「AI瀏覽器」那一頁打開。' };
  const t = cfg.tools || {};
  if (t[key] === false) return { ok: false, error: `「${key}」這個工具在設定裡被關掉了。` };
  return null;
}

/** 一個工具名 → 定義。`deps.ask` 是宿主給的「臨時決策卡」通道（見 index.js）。 */
export function buildTools(getConfig, deps = {}) {
  const config = () => getConfig();

  /* ---------------- 搜到之後：問主人挑一個 ----------------
     這一段是這個插件的重點。以前：搜尋 → 模型看結果 → 自己想「好像不對」→ 換關鍵字再搜
     → 再搜 → 繞三圈。現在：只搜一次、最多三條，然後直接把決策卡推到主人面前，
     模型沒有「自己再想想」的空間。 */
  const PICK_ID = 'pick_site';
  /* 這不是「第 4 個選項」，是逃生門：主人不想被偶猜，就自己去看搜尋頁點。
     Chrome 是 headed 開的，他看得到、點得到。零決策、零思考、零猜測。 */
  const SELF_PICK = '都不要，就開搜尋頁給我自己點';

  function shortLabel(hit, index) {
    const title = String(hit?.title || '').replace(/\s+/g, ' ').trim() || '(無標題)';
    const label = `${index + 1}. ${title.slice(0, 60)}`;
    return label.slice(0, 80);
  }

  async function askWhichOne(exec, query, results) {
    const options = results.map((hit, i) => ({ label: shortLabel(hit, i), description: hit.url }));
    options.push({ label: '都不是，換個說法', description: '直接跟偶說要打什麼關鍵字，或貼網址。' });
    options.push({ label: SELF_PICK, description: '把搜尋結果頁留在 Chrome 視窗，你自己點。' });
    const answers = await deps.ask(
      [
        {
          id: PICK_ID,
          header: '開哪一個？',
          question: `「${query}」只拿前三條，開哪一個？`,
          options,
        },
      ],
      exec,
    );
    const answer = Array.isArray(answers) ? answers.find((a) => a?.id === PICK_ID) ?? answers[0] : undefined;
    const custom = String(answer?.custom || '').trim();
    if (/^https?:\/\//i.test(custom) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(custom)) {
      return { url: /^https?:\/\//i.test(custom) ? custom : `https://${custom}`, how: 'custom-url' };
    }
    const selected = Array.isArray(answer?.selected) ? answer.selected.map((s) => String(s)) : [];
    if (selected.length === 0) return { cancelled: true };
    const pick = selected[0];
    if (pick === SELF_PICK) return { searchPage: true };
    const index = results.findIndex((hit, i) => shortLabel(hit, i) === pick);
    if (index >= 0) return { url: results[index].url, how: 'picked', title: results[index].title };
    /* 主人可能只回了編號（"2"）或自己改過標籤，退一步用寬鬆比對。 */
    const loose = results.findIndex((hit, i) => pick.startsWith(`${i + 1}.`) || pick.includes(String(hit.url)));
    if (loose >= 0) return { url: results[loose].url, how: 'picked-loose', title: results[loose].title };
    return { cancelled: true };
  }

  function needsPick(query, results, why) {
    const lines = results.map((hit, i) => `${i + 1}. ${hit.title || '(無標題)'}\n   ${hit.url}`);
    return {
      ok: false,
      needUserPick: true,
      query,
      results,
      reason: why,
      /* 模型看這行就知道下一步該幹嘛，不用猜。 */
      instruction:
        '不要再自己搜第二次。立刻用 ask_user_question 把上面這幾條原樣做成選項讓主人挑，挑完再用 gw_goto { url } 開。\n' +
        lines.join('\n'),
    };
  }

  return [
    tool({
      name: 'gw_goto',
      description:
        '開網頁。給 url：直接開，不做多餘的事。給 q：**只搜一次、只取前三條**，' +
        '然後插件自己彈「開哪一個？」的決策卡讓主人挑，挑完直接開好。' +
        '所以你不需要、也不可以因為「看起來不對」就自己換關鍵字再搜——一次 q 就是一次對話。' +
        '回應帶 needUserPick 就照 instruction 做：把候選交給主人，不要再搜。' +
        '【節奏】目標清楚就**一氣呵成做到完**：開頁 → 讀 → 點 → 驗證 → 收工，都在同一個回合內連續做完；' +
        '玩遊戲就自己把整局玩到「遊戲結束」，不要每步都停下來等主人。' +
        '只有「真的缺資料」「要主人批准」「任務已完成」三種情況才停。' +
        '（已知關鍵字會直接開上次挑中的網站，不搜也不問。）',
      parameters: objectParams({
        url: { type: 'string', description: '完整網址，含 scheme，例如 https://www.bilibili.com' },
        q: { type: 'string', description: '搜尋關鍵字。和 url 二選一；兩個都給時 url 優先。' },
      }),
      timeoutMs: 240_000,
      async execute(args, exec) {
        const cfg = config();
        const blocked = guard(cfg, 'goto');
        if (blocked) return blocked;

        const url = String(args?.url || '').trim();
        if (url) return B.navigate(cfg, url);

        const q = String(args?.q || '').trim();
        if (!q) return { ok: false, error: '要給 url 或 q 其中一個。' };

        /* 同一個關鍵字之前已經挑過 → 直接開。這一條最省：不搜、不問、不思考。 */
        const memo = lookupMemory(q);
        if (memo) {
          const again = await B.navigate(cfg, memo.url);
          if (again?.ok) {
            return {
              ...again,
              query: q,
              fromMemory: true,
              hint: '這條關鍵字之前挑過，直接開。開錯了就說一聲，偶會重搜。',
            };
          }
        }

        /* 煞車：一次導航之內最多２輪搜尋。省的不是錢，是主人的耐性。 */
        const budget = B.takeSearchBudget();
        if (!budget.ok) return { ok: false, error: budget.error, needUserPick: true };

        const found = await B.search(cfg, q, { limit: 3 });
        if (!found.ok) return found;
        const top = (found.results || []).slice(0, 3);
        if (top.length === 0) {
          return {
            ok: false,
            needUserPick: true,
            query: q,
            error: `「${q}」三條都撈不到。換個說法，或直接把網址貼給偶——不要再自己搜。`,
          };
        }

        let picked;
        try {
          picked = await askWhichOne(exec, q, top);
        } catch (err) {
          /* 沒有決策卡通道（服務缺席／非活著的 agent／超時）→ 三條交回去，讓模型自己問。 */
          return needsPick(q, top, String(err?.message ?? err));
        }
        if (picked?.cancelled) return needsPick(q, top, '主人選了「都不是」');
        if (picked?.searchPage) {
          return {
            ok: true,
            searchPage: true,
            url: B.status()?.url,
            query: q,
            candidates: top.map((hit) => ({ title: hit.title, url: hit.url })),
            hint: '搜尋結果頁已經開在 Chrome 視窗裡，主人自己點。點完他會講，你再用 gw_read 接手。',
          };
        }

        const opened = await B.navigate(cfg, picked.url);
        if (opened?.ok) rememberQuery(q, picked.url, picked.title ?? opened?.title);
        return {
          ...opened,
          query: q,
          picked: { url: picked.url, title: picked.title ?? opened?.title ?? '', how: picked.how },
          candidates: top.map((hit) => ({ title: hit.title, url: hit.url })),
          hint: '已經開好了。要繼續就用 gw_read 拿頁面內容；任務做完 gw_done 收工。',
        };
      },
    }),

    tool({
      name: 'gw_read',
      description:
        '讀目前這一頁：正文（前 1500 字）+ 前 12 個可互動元素，每個有 ref（e1、e2…）。' +
        '**要 gw_act 點東西之前先叫這個拿 ref**；但同一頁如果你手上已經有 ref，就直接點，唔使再讀。' +
        '（一般 DOM 頁面的 ref 在頁面自己更新後通常仍然有效；只有跳頁／大改版才要重讀。）' +
        '讀東西要省：只要幾個元素就調細 maxElements，只要短摘要就調細 maxText —— 讀得越多，回應越慢。' +
        '同一頁連續讀 3 次還沒動手，回應會帶 stuck 提醒，那就別再讀第四次。' +
        '回傳的 images 欄位列出頁上較大的圖（src / kind / alt / 尺寸；kind=img 係 <img>，kind=background 係 CSS 背景圖）：' +
        '圖片內容文字層讀不到，要真的看清就 gw_image { src } 抓原圖落盤再 read_image。' +
        '純文字能解決就別截圖（截圖慢又貴）；只有畫面內容唔在 DOM（canvas / iframe 遊戲）才用 gw_shot。',
      parameters: objectParams({
        maxText: { type: 'number', description: '正文最多幾個字，預設 1500。' },
        maxElements: { type: 'number', description: '最多列幾個可互動元素，預設 12。' },
      }),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'read');
        if (blocked) return blocked;
        return B.readPage(cfg, args || {});
      },
    }),

    tool({
      name: 'gw_act',
      description:
        '操作頁面元素。action=click 點、type 填字、select 選下拉、press 按鍵、scroll 捲動、drag 拖曳。' +
        'ref 從 gw_read 拿；**canvas / iframe 遊戲沒有 ref 可拿**，那就用 x / y 給座標' +
        '（截圖上的像素，viewport 1:1 不用換算）。' +
        '排序題 / 拖放（例如 Kahoot 拖圖磚）：action="drag" + x,y（起點）+ x2,y2（終點）。' +
        '下拉選單（<select>）用 action="select" + text（選項文字）或 value（選項的值）；type 對 <select> 冇用。' +
        'press 唔指定 ref 就等於「按喺目前 focus 嘅元素」，填完表按 Enter 用得上。' +
        '**連續動作優先**：同一串操作（幾個格子、幾步下一步、填表後提交）就一次給 `steps: [{action,…}, …]`，' +
        '一個 call 做完，唔使每次點完都回到模型再想——呢個係最省時間嘅做法。' +
        '每步可加 `waitMs` 等頁面反應（上限 10 秒）。' +
        '唔好每次點完都截圖：要知結果先 gw_read（DOM 頁面）或者最後才 gw_shot 一次。' +
        '填密碼欄位、點付款 / 購買按鈕會被政策擋下（座標點擊一樣會查）——擋了就轉告主人，不要換個方式硬來。' +
        '提交、送出、發佈、留言一律照按：只有付款會擋。',
      parameters: objectParams(
        {
          action: {
            type: 'string',
            enum: ['click', 'type', 'select', 'press', 'scroll', 'drag'],
            description: '要做什麼',
          },
          ref: { type: 'string', description: '元素 ref，例如 e3。scroll / 座標操作不用給。' },
          x: { type: 'number', description: '座標的 x（截圖像素，1:1）。click / drag 起點用。' },
          y: { type: 'number', description: '座標的 y（截圖像素，1:1）。' },
          x2: { type: 'number', description: 'drag 終點的 x。' },
          y2: { type: 'number', description: 'drag 終點的 y。' },
          text: { type: 'string', description: 'action=type 時要填的字；action=select 時是選項的顯示文字' },
          value: { type: 'string', description: 'action=select 時選項的值（text 找不到時才用）' },
          key: { type: 'string', description: 'action=press 時的按鍵，例如 Enter、Tab、Escape' },
          dy: { type: 'number', description: 'action=scroll 時捲多少像素，正數往下，預設 600' },
          steps: {
            type: 'array',
            description:
              '連續動作：每項都是 {action, ref|x/y, text, key, dy, waitMs}，最多 30 步，順序執行。' +
              '一步失敗就停並回報 failedAt。',
            items: { type: 'object', additionalProperties: true },
          },
        },
        [],
      ),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'act');
        if (blocked) return blocked;
        const a = args || {};
        if (!Array.isArray(a.steps) && !a.action) {
          return { ok: false, error: '要給 action（單步），或者 steps（連續動作）。' };
        }
        return B.actOn(cfg, a);
      },
    }),

    tool({
      name: 'gw_shot',
      description:
        '截圖（最後手段，慢又貴）。設定裡有「存哪裡」就存成 png 並回檔案路徑（再用 read_image 看它）；' +
        '沒設定的話只回檔案大小、看不到內容——就別截了，回去用 gw_read。' +
        '用得著的場合：canvas / iframe 遊戲要算座標、或者要確認版面外觀。DOM 頁面有文字就直接 gw_read，唔使截圖。',
      parameters: objectParams({
        full: { type: 'boolean', description: 'true = 整頁長截圖，預設只截視窗' },
        dir: { type: 'string', description: '這次臨時指定的存檔目錄，蓋過設定值' },
      }),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'shot');
        if (blocked) return blocked;
        if (cfg.shotMode === 'off') {
          return { ok: false, error: '截圖在設定裡被關掉了（截圖 = 關）。要用的話去「AI瀏覽器」設定改成「需要時才截」。' };
        }
        return B.screenshot(cfg, args || {});
      },
    }),

    tool({
      name: 'gw_image',
      description:
        '把頁上一張圖的原始檔抓落盤，回檔案路徑 → 之後 read_image 就見到完整原圖。' +
        'gw_read 的 images 欄位有 src；或者任何圖片網址都可以。' +
        '用得著的時候：圖被遮住／縮得好細／文字層讀唔到（例如測驗題遮蓋圖、圖表、地圖）。' +
        '這樣比截圖好：拿到的是原圖，唔受視窗大小同縮放影響。',
      parameters: objectParams(
        {
          src: { type: 'string', description: '圖片的完整網址（http/https），通常由 gw_read 的 images 拿到' },
          dir: { type: 'string', description: '這次臨時指定的存檔目錄，蓋過設定值' },
        },
        ['src'],
      ),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        /* 跟截圖分開：抓圖很便宜，主人關掉截圖不代表想關掉「真的看到圖」。 */
        const blocked = guard(cfg, 'image');
        if (blocked) return blocked;
        return B.saveImage(cfg, args || {});
      },
    }),

    tool({
      name: 'gw_done',
      description:
        '收工：關掉 Chrome，把資源還回去。**任務真的做完**（遊戲玩完、資料搵齊、訂單提交完）或者主人叫你停，才叫一次。' +
        '中途停手唔係「完成」——目標未達成唔好叫呢個。回傳這次總共點了幾次、花了多久。',
      parameters: objectParams({
        summary: { type: 'string', description: '可選：一句話說做了什麼' },
      }),
      timeoutMs: 15_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'done');
        if (blocked) return blocked;
        const was = B.status();
        const closed = await B.closeSession();
        return { ...closed, url: was.url, summary: args?.summary };
      },
    }),
  ];
}
