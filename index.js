// Gizmo Sandbox: a living club on a test Gizmo server.
//
//   node index.js --players 8 --tick 10 --speed 1
//
// Bots behave like actual visitors: a session runs 30 min to 4 hours, a bar
// order lands maybe twice an hour, sometimes they top up, take a headset, book
// a seat for the evening. The operator bot drives the queue (accepted, cooked,
// paid, delivered), sells at the register and keeps the shift open.
// --speed 4 makes club time run 4x faster, handy for a demo.
// Ctrl+C is a soft stop: assets go back, everybody logs out.

import { config } from './src/config.js'
import { gapi } from './src/gizmo.js'
import { loadWorld, resetWorld, world, seatedBots, isPresentToday } from './src/world.js'
import { updateConfig } from './src/config.js'
import * as actions from './src/actions.js'
import { closeSql, sqlEnabled } from './src/sql.js'
import { startUI, broadcast, broadcastEvent } from './src/ui.js'
import { health, healthSnapshot, startHealth, stopHealth, whenOnline, noteFailure, forceCheck } from './src/health.js'

const ts = () => new Date().toLocaleTimeString('ru-RU')

// One feed for both consumers: stdout and the browser.
const feed = []
const stats = { arrive: 0, order: 0, delivered: 0, sale: 0, deposit: 0, buyTime: 0, reserve: 0, appSession: 0, leave: 0, newcomer: 0, group: 0, tournament: 0 }
const STAT_BY_EMOJI = { '🪑': 'arrive', '🍔': 'order', '✅': 'delivered', '🧾': 'sale', '💵': 'deposit', '⏱': 'buyTime', '📅': 'reserve', '🎮': 'appSession', '🚪': 'leave', '📝': 'newcomer', '👥': 'group', '🏆': 'tournament' }

const log = (msg) => {
  console.log(`[${ts()}] ${msg}`)
  const key = STAT_BY_EMOJI[[...msg][0]]
  if (key) stats[key]++
  const line = { t: ts(), msg }
  feed.push(line)
  if (feed.length > 200) feed.shift()
  broadcast(line)                 // unnamed SSE, the old embedded pages
  broadcastEvent('feed', line)    // svelte frontend
}

// real ms -> club minutes
const clubMin = (ms) => Math.max(0, Math.round((ms * config.speed) / 60_000))

let paused = false

async function uiAction(name) {
  if (name === 'pause') { paused = true; log('⏸ симуляция на паузе (из веб-интерфейса)'); return true }
  if (name === 'resume') { paused = false; log('▶ симуляция продолжается'); return true }
  if (health.frozen) throw new Error('нет связи с клубом — симуляция заморожена')
  if (!ACTIONS[name]) throw new Error(`нет события «${name}»`)
  const done = await ACTIONS[name](log, true)   // force=true: skip cooldowns, tell why if it refuses
  broadcastEvent('state', uiState())
  if (!done) log(`🤷 форс-событие «${name}» не сработало (нет подходящих ботов/хостов или кулдаун)`)
  return done
}

function uiState() {
  const dateKey = new Date().toISOString().slice(0, 10)
  const hostName = new Map(world.hosts.map(h => [h.id, h.name]))
  const assetName = new Map(world.assets.map(a => [a.id, a.typeName]))
  return {
    speed: config.speed,
    tickSeconds: config.tickSeconds,
    paused,
    health: healthSnapshot(),
    layoutSeed: config.worldGen ?? 1,   // map layout
    revenue: world.revenue,
    shift: actions.getShiftInfo(),
    stats,
    bots: world.bots.map(b => ({
      name: b.persona.name,
      trait: b.persona.trait,
      username: b.username,
      present: isPresentToday(b, dateKey),
      hostName: b.hostId ? hostName.get(b.hostId) ?? null : null,
      sittingMin: b.sessionSince ? clubMin(Date.now() - b.sessionSince) : 0,
      leftMin: b.plannedUntil ? clubMin(b.plannedUntil - Date.now()) : 0,
      assets: [...b.assets].map(id => assetName.get(id) ?? `#${id}`),
    })),
    hosts: world.hosts.map(h => {
      const sitters = world.bots.filter(b => b.hostId === h.id).map(b => b.persona.name)
      return {
        name: h.name, type: h.type ?? 'pc', maxUsers: h.maxUsers ?? 1,
        sitters, busyBy: sitters[0] ?? null,
      }
    }),
    orders: world.ordersQueue.map(o => ({
      id: o.id, status: o.status,
      ageMin: clubMin(Date.now() - new Date(o.createdTime).getTime()),
      // the map needs to know who the waiter walks to
      username: world.bots.find(b => b.userId === o.userId)?.username ?? null,
    })),
  }
}

function weightedPick() {
  const entries = Object.entries(config.weights)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  let roll = Math.random() * total
  for (const [name, w] of entries) {
    roll -= w
    if (roll <= 0) return name
  }
  return entries[0][0]
}

const ACTIONS = {
  arrive: actions.arrive,
  groupArrive: actions.groupArrive,
  tournament: actions.tournament,
  order: actions.orderBar,
  buyTime: actions.buyTime,
  deposit: actions.deposit,
  reserve: actions.reserve,
  asset: actions.assetFlow,
  appSession: actions.appSession,
  operatorSale: actions.operatorSale,
  life: actions.lifeEvent,
  newcomer: actions.newcomer,
  registerCash: actions.registerCash,
  voidSale: actions.voidSale,
}

let stopping = false
let worldReady = false

async function tick() {
  if (stopping || paused || health.frozen || !worldReady) return

  // the boring part every tick: departures, order queue, shift
  await actions.sweepDay(log).catch(noteFailure)
  await actions.sweepSessions(log).catch(noteFailure)
  await actions.sweepOrders(log).catch(noteFailure)
  await actions.sweepShift(log).catch(noteFailure)

  const name = weightedPick()
  try {
    await ACTIONS[name](log)
  } catch (err) {
    const msg = err?.response?.data?.message ?? err.message
    // a dead link is the watchdog's problem, the rest is just this event misfiring
    if (!noteFailure(msg)) log(`⚠ ${name}: ${msg}`)
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  stopHealth()
  console.log('\nОстанавливаюсь: боты возвращают ассеты и расходятся…')
  for (const bot of health.frozen ? [] : seatedBots()) {   // no link, nothing to log out of
    for (const assetId of [...bot.assets]) {
      await gapi.v3.users.putUsersAssetsByAssetIdCheckin(assetId).catch(() => {})
    }
    await gapi.v3.users.postUsersByUserIdLogout(bot.userId).catch(() => {})
    log(`🚪 ${bot.persona?.name ?? ''} (${bot.username}) ушёл`)
  }
  await closeSql()
  log('Клуб закрыт. Пока!')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log('══════════════════════════════════════════════')
console.log('  Gizmo Sandbox')
console.log(`  Gizmo: ${config.gizmo.ip}:${config.gizmo.port} · бренч ${config.branchId}`)
console.log(`  Игроков: ${config.players} · тик: ${config.tickSeconds}с · скорость ×${config.speed} · SQL(AppStat): ${sqlEnabled() ? 'вкл' : 'выкл'}`)
console.log('══════════════════════════════════════════════')

// Chart history: a point per second, 15 minutes deep. Lives here so a freshly
// opened page gets filled charts right away.
const history = []
setInterval(() => {
  if (!world.hosts.length) return
  history.push({
    t: Date.now(),
    seated: seatedBots().length,
    bots: world.bots.length,
    revenue: Math.round(world.revenue),
    queue: world.ordersQueue.length,
    delivered: stats.delivered,
    sale: stats.sale,
    deposit: stats.deposit,
    order: stats.order,
  })
  if (history.length > 900) history.shift()
  // push one point (~100 b) instead of every open tab re-downloading 80 KB a second
  broadcastEvent('metric', history[history.length - 1])
}, 1000)

setInterval(() => broadcastEvent('state', uiState()), 2000)

let timer = null
const startTicker = () => {
  if (timer) clearInterval(timer)
  timer = setInterval(tick, config.tickSeconds * 1000)
}

// The UI starts before the connection check on purpose: with the club down the
// browser should get the waiting screen, not a refused port.
if (config.uiPort) {
  startUI({
    port: config.uiPort,
    getState: uiState,
    getFeed: () => feed,
    getHistory: () => history,
    onConfig: () => { startTicker(); forceCheck() },
    onAction: uiAction,
    onHealthCheck: async () => { await forceCheck(); return healthSnapshot() },
    onWorldReset: async () => {
      if (health.frozen) throw new Error('нет связи с клубом — попробуй после восстановления')
      const wasPaused = paused
      paused = true
      try { await resetWorld(log, updateConfig) } finally { paused = wasPaused }
      broadcastEvent('state', uiState())
      return { ok: true, worldGen: config.worldGen, bots: world.bots.length }
    },
  }, log)
}

// Nothing is touched until the club answers.
startHealth({ log, onChange: (snap) => broadcastEvent('health', snap) })
await whenOnline()

// Loading can still blow up on an empty server (no user groups) or if the link
// dies mid-load, so retry instead of taking the process down.
for (;;) {
  try {
    await loadWorld(log)
    await actions.ensureShift(log)
    break
  } catch (err) {
    const msg = err?.response?.data?.message ?? err.message
    log(`⚠ мир не загрузился: ${msg}`)
    world.bots.length = 0   // loadWorld appends, drop the half-built one
    world.hosts.length = 0
    noteFailure(msg)
    await new Promise((r) => setTimeout(r, 10_000))
    await whenOnline()
  }
}
worldReady = true

log(`симуляция запущена — сидят за хостами: ${seatedBots().length} из ${world.bots.length} ботов`)

startTicker()
tick()
