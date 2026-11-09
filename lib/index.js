/**
 * dsh-go-work —— 宿主半邊
 *
 * 三件事：
 *   1. 設定檔的讀寫（`~/.dsh/go-work.config.json`）
 *   2. 給設定頁用的 HTTP 路由（`/dsh-go-work/api/*`，全部過信任柵欄）
 *   3. 之後給 agent 用的瀏覽器工具（第二階段才長出來）
 *
 * 為什麼要自己寫柵欄：DSH 的 Web 端口是回環地址，但瀏覽器裡任何一個網頁
 * 都能向 127.0.0.1 發請求。不檢查 Origin，等於把你的設定開放給全網。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTools } from './tools.js'
import { status as browserStatus, closeSession, navigate, search } from './browser.js'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_PATH = path.join(DSH_HOME, 'go-work.config.json')
const API = '/dsh-go-work/api'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export const DEFAULTS = {
  enabled: true,
  // clean = 另外開一個乾淨的 Chrome profile（像「去玩吧」）
  // current = 直接借用本機現有的登入態（等於把自己交出去，慎用）
  chromeProfile: 'clean',
  // off / blocklist / allowlist
  domainPolicy: 'off',
  domainList: [],
  guardPassword: true,
  guardPayment: true,
  guardPublish: true,
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

function handler(fn) {
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

/* ---------------- /web 指令 ---------------- */

/**
 * `/web <網址或關鍵字>`：
 *   貼網址   → 直接開
 *   打關鍵字 → Google 搜一次，把前幾條列給主人挑
 *
 * 為什麼做成指令而不是工具：工具是給 agent 用的，這個是給主人用的。
 * 主人先在這裡挑好目的地，agent 就少掉「亂逛 → 猜 DOM → 繞三圈」那一段。
 */
async function handleWeb({ rawInput } = {}) {
  const cfg = readConfig();
  if (!cfg.enabled) {
    return { kind: 'error', text: '「AI瀏覽器」在設定裡被關掉了，先去打開。' };
  }

  const input = String(rawInput || '').trim();
  if (!input) {
    return {
      kind: 'error',
      text: '要在 /web 後面打東西：貼網址就直接開，打關鍵字就搜給你挑。例如 /web 井字棋 線上玩',
    };
  }

  const looksUrl = /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(input);
  if (looksUrl) {
    const url = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const r = await navigate(cfg, url);
    if (!r.ok) return { kind: 'error', text: r.error || '開不起來。' };
    return { kind: 'success', text: `開好了：${r.url}${r.title ? `\n標題：${r.title}` : ''}` };
  }

  const r = await search(cfg, input);
  if (!r.ok) return { kind: 'error', text: r.error || '搜尋失敗。' };
  const list = (r.results || []).slice(0, 5);
  if (list.length === 0) {
    return { kind: 'success', text: `找不到「${input}」。換個說法，或直接把網址貼進來。` };
  }
  const body = list.map((hit, i) => `${i + 1}. ${hit.title || '(無標題)'}\n   ${hit.url}`).join('\n');
  return {
    kind: 'success',
    text: `「${input}」前 ${list.length} 條：\n\n${body}\n\n挑一個貼給偶，偶直接開。`,
  };
}

export default {
  name: 'dsh-go-work',
  inject: ['webServer', 'tools', 'commands'],
  apply(ctx) {
    ctx.effect(
      () => {
        const disposers = []

        if (ctx.tools) {
          for (const tool of buildTools(readConfig)) {
            disposers.push(ctx.tools.register(tool))
          }
        }

        if (ctx.commands) {
          try {
            disposers.push(
              ctx.commands.register({
                name: 'web',
                description: '開瀏覽器：貼網址直接開，打關鍵字就搜前幾條給你挑（不花 AI 的輪次）',
                input: { hint: '網址或關鍵字' },
                handler: handleWeb,
              }),
            )
          } catch (err) {
            console.warn('[dsh-go-work] /web 註冊失敗：', err?.message ?? err)
          }
        }

        disposers.push(
          ctx.webServer.register({
            kind: 'get',
            path: `${API}/status`,
            handler: handler((req, res) => {
              reply(res, 200, { ok: true, browser: browserStatus() })
            }),
          }),
        )

        disposers.push(
          ctx.webServer.register({
            kind: 'get',
            path: `${API}/config`,
            handler: handler((req, res) => {
              reply(res, 200, {
                ok: true,
                config: readConfig(),
                configPath: CONFIG_PATH,
                defaults: DEFAULTS,
              })
            }),
          }),
        )

        disposers.push(
          ctx.webServer.register({
            kind: 'post',
            path: `${API}/config`,
            handler: handler(async (req, res) => {
              const patch = await readJsonBody(req)
              reply(res, 200, { ok: true, config: writeConfig(patch), configPath: CONFIG_PATH })
            }),
          }),
        )

        return () => {
          closeSession().catch(() => {})
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {}
          }
        }
      },
      'go-work: settings api',
    )
  },
}
