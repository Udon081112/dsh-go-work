/**
 * dsh-go-work —— 宿主半邊
 *
 * 只做兩件事（順序就是風險順序，先做最不容易壞的）：
 *   1. 註冊 5 支瀏覽器工具（gw_goto / gw_read / gw_act / gw_shot / gw_done）—— 這是本體
 *   2. 給設定頁用的一條 HTTP 路由 `/dsh-go-work/api/config`（GET 讀、POST 寫）
 * 另加一條 `/ping` 純診斷（唯讀，回 apply 走到哪一步、tools 註冊結果）。
 *
 * /web 指令已拿掉：主人說「指令不重要，保住本體就好」。
 * 歷史教訓（dsh-host-webserver/lib/index.js:177-184）：
 *   `register(route)` 的 kind 只認 'exact' 與 'prefix'，其他字串會掉進 prefixes 表，
 *   而 prefixes 表是按 **path** 去重的 —— 同一個 path 的 GET 與 POST 必定相撞，
 *   撞了會 throw，而 throw 會讓整個 apply 判死（工具、指令一起沒）。
 *   所以：全部 exact、GET/POST 合併一條、每條路由各自 try/catch。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTools } from './tools.js'
import { closeSession } from './browser.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_PATH = path.join(DSH_HOME, 'go-work.config.json')
const DIAG_PATH = path.join(DSH_HOME, 'go-work.diag.json')
const API = '/dsh-go-work/api'

/* DSH 的 console 外面看不到，把 apply 的每一步落盤。
   出問題時先看 ~/.dsh/go-work.diag.json：phase 停在哪一段，就是哪裡炸的。 */
const DIAG = {
  attempt: 0,
  phase: 'import',
  at: null,
  pid: null,
  ppid: null,
  processType: null,
  fiberState: null,
  fiber: null,
  hasTools: null,
  hasWebServer: null,
  hasUserQuestions: null,
  tools: [],
  toolErrors: [],
  routes: [],
  error: null,
}

function flushDiag() {
  try {
    DIAG.at = new Date().toISOString()
    fs.writeFileSync(DIAG_PATH, `${JSON.stringify(DIAG, null, 2)}\n`, 'utf8')
  } catch {}
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const DEFAULTS = {
  enabled: true,
  // clean = 另外開一個乾淨的 Chrome profile；current = 借用本機現有登入態（慎用）
  chromeProfile: 'clean',
  // off / blocklist / allowlist
  domainPolicy: 'off',
  domainList: [],
  guardPassword: true,
  guardPayment: true,
  maxClicks: 200,
  maxMinutes: 30,
  // onDemand / interval / off
  shotMode: 'onDemand',
  shotIntervalSec: 5,
  shotDir: path.join(DSH_HOME, 'im', 'screenshot'),
  tools: { goto: true, read: true, act: true, shot: true, done: true },
}

function pick(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'tools') continue
    if (raw[key] !== undefined) cfg[key] = raw[key]
  }
  cfg.tools = { ...DEFAULTS.tools }
  if (raw.tools && typeof raw.tools === 'object') {
    for (const key of Object.keys(DEFAULTS.tools)) {
      if (typeof raw.tools[key] === 'boolean') cfg.tools[key] = raw.tools[key]
    }
  }
  cfg.domainList = Array.isArray(cfg.domainList)
    ? cfg.domainList.map((d) => String(d).trim()).filter(Boolean)
    : []
  return cfg
}

export function readConfig() {
  try {
    return pick(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeConfig(patch) {
  const next = pick({ ...readConfig(), ...(patch || {}) })
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function reply(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 只放行同源／回環的請求。有 Origin 但不是本機 → 擋。 */
function rejectForeign(req) {
  const origin = req?.headers?.origin
  if (!origin) return false
  try {
    return !LOOPBACK.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

/** 取服務的兩條路：正常屬性受 fiber 狀態影響（inactive 時 throw），失敗就退回寬鬆查找。 */
function service(ctx, name) {
  try {
    const value = ctx[name]
    if (value) return value
  } catch {}
  try {
    return ctx.reflect.get(name, false)
  } catch {
    return undefined
  }
}

/**
 * 決策卡通道（ctx.userQuestions，core 的 `@deepseek-ai/dsh-user-questions`）。
 * 這是「chatbox 那個臨時決策」的後端：ask() 會把問題推給 client，停在原地等人答。
 * 包一層的理由：
 *   1. 服務可能不存在（tool-ask-user 被關掉）→ 回 undefined，工具自己退回文字候選；
 *   2. 沒有 UI provider 時 ask() 會一直掛著 → 加個時鐘，超時就放行。
 */
function makeAsk(userQuestions) {
  if (!userQuestions || typeof userQuestions.ask !== 'function') return undefined
  return async (questions, exec) => {
    const request = { questions }
    if (exec?.agent) request.agent = exec.agent
    if (exec?.signal) request.signal = exec.signal
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('主人 200 秒沒回應決策卡')), 200_000)
      if (typeof timer?.unref === 'function') timer.unref()
    })
    try {
      const result = await Promise.race([userQuestions.ask(request), timeout])
      return Array.isArray(result?.answers) ? result.answers : []
    } finally {
      clearTimeout(timer)
    }
  }
}

function describeFiber(ctx) {
  const out = {}
  try {
    const fiber = ctx.fiber
    out.uid = fiber?.uid ?? null
    out.state = fiber?.state ?? null
    out.plugin = fiber?.runtime?.name ?? null
    out.store = fiber?.store ? Object.keys(fiber.store) : null
    out.inject = fiber?.inject ? Object.keys(fiber.inject) : null
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}

function describeTools(impl) {
  const out = { available: !!impl }
  if (!impl || typeof impl.view !== 'function') return out
  try {
    const view = impl.view()
    const names = [...view.visible.keys()].sort()
    out.count = names.length
    out.gw = names.filter((name) => name.startsWith('gw_'))
    out.sample = names.slice(0, 25)
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}

function guard(fn) {
  return async (req, res) => {
    if (rejectForeign(req)) {
      reply(res, 403, { ok: false, error: 'forbidden origin' })
      return
    }
    try {
      await fn(req, res)
    } catch (err) {
      try {
        reply(res, 500, { ok: false, error: String(err?.message ?? err) })
      } catch {}
    }
  }
}

export default {
  name: 'dsh-go-work',
  inject: ['tools', 'webServer'],
  apply(ctx) {
    DIAG.attempt += 1
    DIAG.phase = 'start'
    DIAG.error = null
    DIAG.pid = process.pid
    DIAG.ppid = process.ppid
    DIAG.processType = process.type ?? 'node'
    DIAG.fiber = describeFiber(ctx)
    DIAG.fiberState = DIAG.fiber.state ?? null
    DIAG.tools = []
    DIAG.toolErrors = []
    DIAG.routes = []
    flushDiag()

    const disposers = []
    const tools = service(ctx, 'tools')
    const webServer = service(ctx, 'webServer')
    const userQuestions = service(ctx, 'userQuestions')
    DIAG.hasTools = !!tools
    DIAG.hasWebServer = !!webServer
    DIAG.hasUserQuestions = !!userQuestions

    /* ---- 本體：5 支瀏覽器工具。每支獨立 try/catch，一支撞名不拖累其他四支。 ---- */
    if (tools && typeof tools.register === 'function') {
      const ask = makeAsk(userQuestions)
      for (const tool of buildTools(readConfig, ask ? { ask } : {})) {
        try {
          disposers.push(tools.register(tool))
          DIAG.tools.push(tool?.name ?? '?')
        } catch (err) {
          DIAG.toolErrors.push({ name: tool?.name ?? '?', error: String(err?.message ?? err) })
        }
      }
    }
    DIAG.phase = 'tools'
    flushDiag()

    /* ---- 設定頁的兩條路由。kind 一律 'exact'，GET/POST 合併。 ---- */
    if (webServer && typeof webServer.register === 'function') {
      const routes = [
        {
          path: `${API}/config`,
          run: async (req, res) => {
            if (req.method === 'POST') {
              const patch = await readJsonBody(req)
              reply(res, 200, { ok: true, config: writeConfig(patch), configPath: CONFIG_PATH })
              return
            }
            reply(res, 200, { ok: true, config: readConfig(), configPath: CONFIG_PATH, defaults: DEFAULTS })
          },
        },
        {
          path: `${API}/ping`,
          run: async (req, res) => {
            reply(res, 200, {
              ok: true,
              pid: process.pid,
              phase: DIAG.phase,
              fiber: describeFiber(ctx),
              tools: describeTools(tools),
              diag: { ...DIAG, diagPath: DIAG_PATH },
            })
          },
        },
      ]
      for (const route of routes) {
        try {
          disposers.push(webServer.register({ kind: 'exact', path: route.path, handler: guard(route.run) }))
          DIAG.routes.push({ path: route.path, ok: true })
        } catch (err) {
          DIAG.routes.push({ path: route.path, ok: false, error: String(err?.message ?? err) })
        }
      }
    }
    DIAG.phase = 'ready'
    flushDiag()

    /* apply 回傳函式 = 卸載清理（不靠 ctx.effect）。 */
    return () => {
      closeSession().catch(() => {})
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {}
      }
    }
  },
}
