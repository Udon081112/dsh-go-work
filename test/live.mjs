/**
 * 真瀏覽器測試：開一次 Chrome、開一個頁面、讀一次、關掉。
 * 會真的彈視窗（大約 5–10 秒），跑完自己收。
 */
import * as B from '../lib/browser.js';

const cfg = {
  enabled: true,
  chromeProfile: 'clean',
  domainPolicy: 'off',
  domainList: [],
  guardPassword: true,
  guardPayment: true,
  guardPublish: true,
  maxClicks: 200,
  maxMinutes: 30,
  shotMode: 'onDemand',
  shotIntervalSec: 5,
  shotDir: '',
};

const t0 = Date.now();
const nav = await B.navigate(cfg, 'https://example.com');
console.log('[goto]', JSON.stringify(nav));
if (!nav.ok) process.exit(1);

const page = await B.readPage(cfg, { maxText: 400, maxElements: 20 });
console.log('[read] title=', page.title, '| elements=', page.elements?.length, '| text=', JSON.stringify(page.text?.slice(0, 120)));
console.log('[read] first element:', JSON.stringify(page.elements?.[0]));

const shot = await B.screenshot(cfg, { dir: '' });
console.log('[shot]', JSON.stringify({ ok: shot.ok, bytes: shot.bytes, note: shot.note }));

const done = await B.closeSession();
console.log('[done]', JSON.stringify(done), 'total', Date.now() - t0, 'ms');
