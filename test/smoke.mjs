/**
 * 煙霧測試：不碰瀏覽器、不碰真的 DSH，只用假的 ctx 確認
 *   1. 插件能載入、apply 不炸
 *   2. 兩條路由都註冊了
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

const { default: plugin, DEFAULTS, readConfig } = await import('../lib/index.js')

const routes = []
const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

plugin.apply(ctx)

assert.equal(plugin.name, 'dsh-go-work')
assert.equal(routes.length, 2)
assert.ok(routes.some((r) => r.path === '/dsh-go-work/api/config'))

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

const getRoute = routes.find((r) => r.kind === 'get')
const postRoute = routes.find((r) => r.kind === 'post')

// 1) 沒設定檔時回預設值
{
  const res = makeRes()
  await getRoute.handler({ headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json.config, DEFAULTS)
  assert.ok(res.json.configPath.endsWith('go-work.config.json'))
}

// 2) 寫入
{
  const res = makeRes()
  const req = Readable.from([
    Buffer.from(JSON.stringify({ maxClicks: 7, domainList: [' bilibili.com ', ''] })),
  ])
  req.headers = {}
  await postRoute.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.json.config.maxClicks, 7)
  assert.deepEqual(res.json.config.domainList, ['bilibili.com'])
}

// 3) 讀回來（檔案確實落盤）
{
  const saved = readConfig()
  assert.equal(saved.maxClicks, 7)
  assert.equal(saved.enabled, true)
}

// 4) 外站 Origin 擋掉
{
  const res = makeRes()
  await getRoute.handler({ headers: { origin: 'https://evil.example' } }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.json.ok, false)
}

// 5) 本機 Origin 放行
{
  const res = makeRes()
  await getRoute.handler({ headers: { origin: 'http://127.0.0.1:19387' } }, res)
  assert.equal(res.statusCode, 200)
}

// 6) 壞掉的 body 不會讓行程炸
{
  const res = makeRes()
  const req = Readable.from([Buffer.from('{ not json')])
  req.headers = {}
  await postRoute.handler(req, res)
  assert.equal(res.statusCode, 500)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('smoke: 6 項全過')
