// Connection watchdog. The club hangs on two wires: the Gizmo API and, if a SQL
// password is set, the database AppStat goes into. Nothing starts before both
// answer, and losing one mid-run freezes the world instead of filling the feed
// with errors. Console and browser see the same picture (SSE `health`).
import { gapi, reconnectGizmo } from './gizmo.js'
import { sqlEnabled, sqlPing, sqlReconnect } from './sql.js'

const HEARTBEAT_SEC = 20
const BACKOFF_SEC = [5, 5, 10, 15, 20, 30, 60]
const PROBE_TIMEOUT_MS = 10_000

// "the wire is down" as opposed to "the request was wrong"
const LINK_ERROR = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|ESOCKET|socket hang up|Network Error|таймаут|timeout|connection is closed|connection lost|Failed to connect/i

export const health = {
  api: { ok: null, detail: '' },
  sql: { ok: null, detail: '' },  // ok === 'skip' when SQL is off
  frozen: true,                   // until the first check goes through
  checking: false,
  attempt: 0,
  lostAt: null,
  lastOkAt: null,
  nextCheckAt: null,
}

const reason = (err) => err?.response?.data?.message ?? err?.message ?? 'нет связи'
const backoff = () => BACKOFF_SEC[Math.min(health.attempt, BACKOFF_SEC.length - 1)]

export const isOnline = () => health.api.ok === true && health.sql.ok !== false

// nextCheckAt goes out as "in N seconds": no reason to make the browser trust
// our clock, it counts down on its own between pushes.
export function healthSnapshot() {
  return {
    api: { ...health.api },
    sql: { ...health.sql },
    frozen: health.frozen,
    checking: health.checking,
    attempt: health.attempt,
    everConnected: health.lastOkAt !== null,
    downSec: health.lostAt ? Math.round((Date.now() - health.lostAt) / 1000) : 0,
    nextCheckSec: health.nextCheckAt ? Math.max(0, Math.round((health.nextCheckAt - Date.now()) / 1000)) : null,
  }
}

let logLine = (msg) => console.log(msg)
let publish = () => {}
let timer = null
let running = null
const waiters = []

/** Start probing. onChange fires on every state change (that's the web push). */
export function startHealth({ log, onChange } = {}) {
  if (log) logLine = log
  if (onChange) publish = onChange
  check()
  return health
}

export function stopHealth() {
  clearTimeout(timer)
  timer = null
}

/** Resolves once the club is reachable, right away if it already is. */
export function whenOnline() {
  if (isOnline()) return Promise.resolve()
  return new Promise((resolve) => waiters.push(resolve))
}

export function forceCheck() {
  clearTimeout(timer)
  return check()
}

/** Something in the simulation failed: if it smells like a dropped link, check
 *  now rather than waiting for the next heartbeat. */
export function noteFailure(err) {
  const text = typeof err === 'string' ? err : reason(err)
  if (!LINK_ERROR.test(text)) return false
  if (!health.checking) forceCheck()
  return true
}

function withTimeout(promise, what) {
  let bomb
  const limit = new Promise((_, reject) => {
    bomb = setTimeout(() => reject(new Error(`таймаут ${PROBE_TIMEOUT_MS / 1000}с (${what})`)), PROBE_TIMEOUT_MS)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(bomb))
}

async function probeApi() {
  const started = Date.now()
  try {
    const res = await withTimeout(gapi.v3.hosts.getHosts({ paginationLimit: 1 }), 'Gizmo API')
    if (res?.isError) throw new Error(res.message ?? 'API ответил ошибкой')
    return { ok: true, detail: `отвечает (${Date.now() - started} мс)` }
  } catch (err) {
    reconnectGizmo()   // if Gizmo restarted the cached bearer is dead anyway
    return { ok: false, detail: reason(err) }
  }
}

async function probeSql() {
  if (!sqlEnabled()) {
    return { ok: 'skip', detail: 'выключен (пароль не задан) — «поиграл в приложение» пропускается' }
  }
  const started = Date.now()
  try {
    await withTimeout(sqlPing(), 'SQL')
    return { ok: true, detail: `отвечает (${Date.now() - started} мс)` }
  } catch (err) {
    await sqlReconnect().catch(() => {})  // a half-dead pool never comes back on its own
    return { ok: false, detail: reason(err) }
  }
}

async function check() {
  if (running) return running
  health.checking = true
  publish(healthSnapshot())

  running = (async () => {
    const [api, sql] = await Promise.all([probeApi(), probeSql()])
    health.api = api
    health.sql = sql
    health.checking = false

    const ok = isOnline()
    if (ok) {
      health.attempt = 0
      health.lastOkAt = Date.now()
      if (health.frozen) thaw()
    } else {
      health.attempt++
      freeze()
    }
    schedule(ok ? HEARTBEAT_SEC : backoff())
    return ok
  })()

  try {
    return await running
  } finally {
    running = null
  }
}

function schedule(sec) {
  clearTimeout(timer)
  health.nextCheckAt = Date.now() + sec * 1000
  timer = setTimeout(() => { check().catch(() => {}) }, sec * 1000)
  publish(healthSnapshot())
}

function freeze() {
  const broken = []
  if (health.api.ok !== true) broken.push(`Gizmo API — ${health.api.detail}`)
  if (health.sql.ok === false) broken.push(`SQL — ${health.sql.detail}`)
  const what = broken.join(' · ')
  const next = `следующая проверка через ${backoff()}с`

  if (health.lastOkAt === null) {
    // never connected: this is the startup wait, not a loss
    logLine(health.attempt === 1
      ? `🔌 нет связи с клубом: ${what} — жду, ${next}`
      : `⏳ связи по-прежнему нет (попытка ${health.attempt}): ${what} — ${next}`)
  } else if (!health.frozen) {
    health.lostAt = Date.now()
    logLine(`🔌 связь с клубом потеряна: ${what} — симуляция заморожена, ${next}`)
  } else {
    logLine(`⏳ связи всё ещё нет (попытка ${health.attempt}, ${Math.round((Date.now() - health.lostAt) / 1000)}с): ${what} — ${next}`)
  }
  health.frozen = true
}

function thaw() {
  health.frozen = false
  const parts = [`API ${health.api.detail}`]
  parts.push(health.sql.ok === 'skip' ? 'SQL выключен' : `SQL ${health.sql.detail}`)
  if (health.lostAt) {
    logLine(`🔌 связь восстановлена (не было ~${Math.round((Date.now() - health.lostAt) / 1000)}с): ${parts.join(' · ')} — продолжаем`)
    health.lostAt = null
  } else {
    logLine(`🔌 клуб на связи: ${parts.join(' · ')}`)
  }
  while (waiters.length) waiters.shift()()
}
