/**
 * 煙霧測試：不碰瀏覽器、不碰真的 DSH，只用假的 ctx 確認
 *   1. 插件能載入、apply 不炸
 *   2. 三條路由（config get/post + status）＋五個工具都註冊了
 *   3. GET 回預設值
 *   4. POST 寫得進去、讀得回來
 *   5. 外站 Origin 會被擋（信任柵欄）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-work-'))
process.env.DSH_HOME = tmp

const { default: plugin, DEFAULTS, readConfig, writeConfig } = await import('../lib/index.js')

const routes = []
const tools = []
const commands = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => {}
    },
  },
  commands: {
    register(command) {
      commands.push(command)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

plugin.apply(ctx)

assert.equal(plugin.name, 'dsh-go-work')
assert.deepEqual(plugin.inject, ['webServer', 'tools', 'commands'])
assert.equal(routes.length, 3)
assert.ok(routes.some((r) => r.path === '/dsh-go-work/api/config'))
assert.ok(routes.some((r) => r.path === '/dsh-go-work/api/status'))

// /web 指令註冊了，而且形狀對
assert.equal(commands.length, 1)
assert.equal(commands[0].name, 'web')
assert.equal(typeof commands[0].handler, 'function')
assert.ok(commands[0].description.length > 10)

// 空參數要好好報錯，不要丟例外
const emptyReply = await commands[0].handler({ rawInput: '   ' })
assert.equal(emptyReply.kind, 'error')
assert.match(emptyReply.text, /\/web/)

// 五個工具都在，而且每個都有 name / description / parameters / execute
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  ['gw_act', 'gw_done', 'gw_goto', 'gw_read', 'gw_shot'],
)
for (const tool of tools) {
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 30, `${tool.name} 的 description 太短`)
  assert.equal(tool.parameters.type, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.body = text
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

const configGet = routes.find((r) => r.kind === 'get' && r.path.endsWith('/config'))
const configPost = routes.find((r) => r.kind === 'post')
const statusGet = routes.find((r) => r.kind === 'get' && r.path.endsWith('/status'))

// 1) 沒設定檔時回預設值
{
  const res = makeRes()
  await configGet.handler({ headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.config, DEFAULTS)
  assert.ok(res.json.configPath.endsWith('go-work.config.json'))
}

// 2) 預設截圖位置在 dsh/im/screenshot 底下
{
  assert.ok(DEFAULTS.shotDir.endsWith(path.join('im', 'screenshot')))
}

// 3) 寫入
{
  const res = makeRes()
  const req = Readable.from([
    Buffer.from(JSON.stringify({ maxClicks: 7, domainList: [' bilibili.com ', ''] })),
  ])
  req.headers = {}
  await configPost.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.config.maxClicks, 7)
  assert.deepEqual(res.json.config.domainList, ['bilibili.com'])
}

// 4) 讀回來（檔案確實落盤）
{
  const saved = readConfig()
  assert.equal(saved.maxClicks, 7)
  assert.equal(saved.enabled, true)
}

// 5) 外站 Origin 擋掉
{
  const res = makeRes()
  await configGet.handler({ headers: { origin: 'https://evil.example' } }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json.ok, false)
}

// 6) 本機 Origin 放行
{
  const res = makeRes()
  await configGet.handler({ headers: { origin: 'http://127.0.0.1:19387' } }, res)
  assert.equal(res.statusCode, 200)
}

// 7) 壞掉的 body 不會讓行程炸
{
  const res = makeRes()
  const req = Readable.from([Buffer.from('{ not json')])
  req.headers = {}
  await configPost.handler(req, res)
  assert.equal(res.statusCode, 500)
}

// 8) status 路由回「沒開」而不是炸
{
  const res = makeRes()
  await statusGet.handler({ headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.browser, { open: false })
}

// 9) 網域政策擋得住（純函式，不開瀏覽器）
{
  const { domainBlocked } = await import('../lib/browser.js')
  assert.equal(domainBlocked('https://bilibili.com/x', { domainPolicy: 'off', domainList: [] }), null)
  assert.match(
    domainBlocked('https://bilibili.com/x', { domainPolicy: 'blocklist', domainList: ['bilibili.com'] }),
    /黑名單/,
  )
  assert.match(
    domainBlocked('https://evil.com/x', { domainPolicy: 'allowlist', domainList: ['bilibili.com'] }),
    /不在白名單/,
  )
  assert.equal(
    domainBlocked('https://www.bilibili.com/x', { domainPolicy: 'allowlist', domainList: ['bilibili.com'] }),
    null,
  )
  assert.match(domainBlocked('https://x.com', { domainPolicy: 'allowlist', domainList: [] }), /空/ )
}

// 10) 工具被關掉時回清楚的錯誤，不會硬幹
{
  writeConfig({ enabled: false })
  const goto = tools.find((t) => t.name === 'gw_goto')
  const out = await goto.execute({ url: 'https://example.com' }, {})
  assert.equal(out.ok, false)
  assert.match(out.error, /關掉/)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`smoke: 10 組全過（${tools.length} 個工具、${routes.length} 條路由）`)
