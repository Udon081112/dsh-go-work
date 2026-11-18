/**
 * 真瀏覽器測試：開一次 Chrome、開一個頁面、讀一次、截一張、關掉。
 * 會真的彈視窗（大約 10 秒），跑完自己收。
 *
 * 這一支驗的是「煙霧測試驗不到的東西」：Chrome 起不起得來、ref 標得到不到、
 * 截圖檔真的落盤、關掉之後 status 不會 throw、搜尋預算有沒有跟著清。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as B from '../lib/browser.js'

const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-work-live-'))

const cfg = {
  enabled: true,
  chromeProfile: 'clean',
  domainPolicy: 'off',
  domainList: [],
  guardPassword: true,
  guardPayment: true,
  maxClicks: 200,
  maxMinutes: 30,
  shotMode: 'onDemand',
  shotDir,
}

const t0 = Date.now()
const nav = await B.navigate(cfg, 'https://example.com')
console.log('[goto]', JSON.stringify(nav))
if (!nav.ok) process.exit(1)

const page = await B.readPage(cfg, { maxText: 400, maxElements: 20 })
console.log('[read] title=', page.title, '| elements=', page.elements?.length, '| text=', JSON.stringify(page.text?.slice(0, 120)))
console.log('[read] first element:', JSON.stringify(page.elements?.[0]))
if (!page.ok) process.exit(1)

/* 有 ref 才代表 gw_act 點得到；example.com 上那一條是 <a href="https://iana.org/...">。 */
const first = page.elements?.[0]
if (first?.ref) {
  const scrolled = await B.actOn(cfg, { action: 'scroll', dy: 200 })
  console.log('[act]', JSON.stringify(scrolled))

  /* 網域政策要在「動作之後」也生效：點一條會被黑名單擋住的連結，應該被退回原頁。 */
  const guarded = { ...cfg, domainPolicy: 'blocklist', domainList: ['iana.org'] }
  const jumped = await B.actOn(guarded, { action: 'click', ref: first.ref })
  console.log('[leash]', JSON.stringify(jumped))
  if (jumped.ok !== false || !jumped.blocked) {
    console.error('[leash] 點了黑名單連結竟然成功了')
    process.exit(1)
  }
  const back = B.status()
  if (!String(back.url || '').includes('example.com')) {
    console.error('[leash] 沒有退回原頁:', back.url)
    process.exit(1)
  }
}

const shot = await B.screenshot(cfg, {})
console.log('[shot]', JSON.stringify({ ok: shot.ok, path: shot.path, bytes: shot.bytes }))
if (shot.ok && shot.path && !fs.existsSync(shot.path)) {
  console.error('[shot] 回了路徑但檔案不存在:', shot.path)
  process.exit(1)
}

/* 關掉之後：status() 不可以 throw，搜尋預算要一起清掉。 */
const done = await B.closeSession()
const after = B.status()
console.log('[done]', JSON.stringify(done), '| status after close:', JSON.stringify(after))
if (after.open) {
  console.error('[done] 關掉了但 status() 還說開著')
  process.exit(1)
}
B.takeSearchBudget()
B.takeSearchBudget()
await B.closeSession()
const reset = B.takeSearchBudget()
console.log('[budget] after closeSession:', JSON.stringify(reset))
if (!reset.ok) process.exit(1)

fs.rmSync(shotDir, { recursive: true, force: true })
console.log('live: 全過', Date.now() - t0, 'ms')
