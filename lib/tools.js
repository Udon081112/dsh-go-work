/**
 * dsh-go-work —— 五個給 agent 用的瀏覽器工具
 *
 * 刻意不用 `defineTool`（那要 peer import @deepseek-ai/dsh-tools），
 * 這裡直接吐 registry 認得的形狀，插件零依賴就能跑。
 */
import * as B from './browser.js';

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function render(value) {
  if (value && typeof value === 'object' && value.ok === false) {
    return text(`⚠ ${value.error || value.warning || '失敗'}`);
  }
  return text(value);
}

function tool({ name, description, parameters, timeoutMs, execute }) {
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render },
    timeoutMs,
    execute,
  };
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

export function buildTools(getConfig) {
  const config = () => getConfig();

  return [
    tool({
      name: 'gw_goto',
      description:
        '在實體 Chrome 裡打開一個網址（會真的開視窗，第一次啟動要幾秒）。' +
        '之後用 gw_read 看頁面內容、gw_act 點東西、gw_shot 截圖，做完叫 gw_done 收工。' +
        '網域如果有黑白名單，這裡就會被擋下來，被擋的話把理由轉告主人，不要自己繞。',
      parameters: objectParams(
        {
          url: { type: 'string', description: '完整網址，含 scheme，例如 https://www.bilibili.com' },
        },
        ['url'],
      ),
      timeoutMs: 60_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'goto');
        if (blocked) return blocked;
        return B.navigate(cfg, String(args.url || '').trim());
      },
    }),

    tool({
      name: 'gw_read',
      description:
        '讀目前這一頁：正文（會裁短）+ 可互動元素清單，每個元素有 ref（e1、e2…）。' +
        '**要用 gw_act 點任何東西之前，一定先叫這個拿 ref**——ref 只在最後一次 read 之後有效，頁面一變就作廢。' +
        '純文字能解決就別截圖，截圖很貴。',
      parameters: objectParams({
        maxText: { type: 'number', description: '正文最多幾個字，預設 3500。想多看就調大。' },
        maxElements: { type: 'number', description: '最多列幾個可互動元素，預設 90。' },
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
        '操作頁面元素。action=click 點、type 填字、press 按鍵、scroll 捲動。' +
        'ref 從 gw_read 拿。填密碼欄位、點付款 / 發佈按鈕會被政策擋下——擋了就轉告主人，不要換個方式硬來。',
      parameters: objectParams(
        {
          action: { type: 'string', enum: ['click', 'type', 'press', 'scroll'], description: '要做什麼' },
          ref: { type: 'string', description: '元素 ref，例如 e3。scroll 不用給。' },
          text: { type: 'string', description: 'action=type 時要填的字' },
          key: { type: 'string', description: 'action=press 時的按鍵，例如 Enter、Tab、Escape' },
          dy: { type: 'number', description: 'action=scroll 時捲多少像素，正數往下，預設 600' },
        },
        ['action'],
      ),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'act');
        if (blocked) return blocked;
        return B.actOn(cfg, args || {});
      },
    }),

    tool({
      name: 'gw_shot',
      description:
        '截圖。設定裡有「存哪裡」就存成 png 並回檔案路徑（再用 read_image 看它）；' +
        '沒設定的話只回檔案大小，看不到內容——那時候就別截了，回去用 gw_read。',
      parameters: objectParams({
        full: { type: 'boolean', description: 'true = 整頁長截圖，預設只截視窗' },
        dir: { type: 'string', description: '這次臨時指定的存檔目錄，蓋過設定值' },
      }),
      timeoutMs: 45_000,
      async execute(args) {
        const cfg = config();
        const blocked = guard(cfg, 'shot');
        if (blocked) return blocked;
        return B.screenshot(cfg, args || {});
      },
    }),

    tool({
      name: 'gw_done',
      description:
        '收工：關掉 Chrome，把資源還回去。任務做完、或主人叫你停的時候叫一次。' +
        '回傳這次總共點了幾次、花了多久。',
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
