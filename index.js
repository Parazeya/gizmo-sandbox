// Living club simulator for a test Gizmo server (Gizmo Sandbox).
//
//   node index.js --players 8 --tick 10 --speed 1
//
// The bot players are as close to real ones as possible: they sit for 30 min –
// 4 hours, order at the bar at most once every half hour, occasionally top up
// their balance, check out assets, make reservations. The bot operator works
// the order queue (accepted → cooked → paid → delivered), sells at the register
// and runs the shift. --speed 4 accelerates "club time" 4x (for a demo).
//
// Ctrl+C — soft stop: bots return their assets and leave the hosts.

import { config } from './src/config.js'
import { gapi } from './src/gizmo.js'
import { loadWorld, resetWorld, world, seatedBots, isPresentToday } from './src/world.js'
import { updateConfig } from './src/config.js'
import * as actions from './src/actions.js'
import { closeSql, disableSql, sqlEnabled } from './src/sql.js'
import { startUI, broadcast, broadcastEvent } from './src/ui.js'

const ts = () => new Date().toLocaleTimeString('ru-RU')

// Feed and counters — for the console and the web UI at the same time.
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
  broadcast(line)                 // legacy embedded pages (unnamed SSE)
  broadcastEvent('feed', line)    // Svelte frontend
}

// "Club time" minutes from real milliseconds.
const clubMin = (ms) => Math.max(0, Math.round((ms * config.speed) / 60_000))

let paused = false

// Force events and pause from the web UI.
async function uiAction(name) {
  if (name === 'pause') { paused = true; log('⏸ симуляция на паузе (из веб-интерфейса)'); return true }
  if (name === 'resume') { paused = false; log('▶ симуляция продолжается'); return true }
  if (!ACTIONS[name]) throw new Error(`нет события «${name}»`)
  // force=true: the web UI buttons ignore cooldowns and log the refusal reason
  const done = await ACTIONS[name](log, true)
  broadcastEvent('state', uiState())  // instant push after a force action
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
    layoutSeed: config.worldGen ?? 1,   // room layout on the map
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
      // for the delivery animation on the map: whom to bring the order to
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

async function tick() {
  if (stopping || paused) return

  // Operator and "time": every tick — planned departures, order queue, shift.
  await actions.sweepDay(log).catch(() => {})
  await actions.sweepSessions(log).catch(() => {})
  await actions.sweepOrders(log).catch(() => {})
  await actions.sweepShift(log).catch(() => {})

  // Plus one random event.
  const name = weightedPick()
  try {
    await ACTIONS[name](log)
  } catch (err) {
    const msg = err?.response?.data?.message ?? err.message
    if (name === 'appSession') disableSql(msg, log)
    else log(`⚠ ${name}: ${msg}`)
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  console.log('\nОстанавливаюсь: боты возвращают ассеты и расходятся…')
  for (const bot of seatedBots()) {
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

await loadWorld(log)
await actions.ensureShift(log)

// Metric history for the live reports: one point per second, last 15 minutes.
// Kept on the server so the charts are filled the moment the page opens.
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
  // Push instead of polling: one point (~100 bytes) instead of downloading the
  // whole history (~80 KB) every second by every open browser.
  broadcastEvent('metric', history[history.length - 1])
}, 1000)

// World snapshot — also pushed (the client polls nothing)
setInterval(() => { if (world.hosts.length) broadcastEvent('state', uiState()) }, 2000)

let timer = null
const startTicker = () => {
  if (timer) clearInterval(timer)
  timer = setInterval(tick, config.tickSeconds * 1000)
}

if (config.uiPort) {
  startUI({
    port: config.uiPort,
    getState: uiState,
    getFeed: () => feed,
    getHistory: () => history,
    // Config changed from the web UI: apply the tick immediately.
    onConfig: startTicker,
    onAction: uiAction,
    // ♻ Tear down the world and regenerate it (UI button)
    onWorldReset: async () => {
      const wasPaused = paused
      paused = true
      try { await resetWorld(log, updateConfig) } finally { paused = wasPaused }
      broadcastEvent('state', uiState())
      return { ok: true, worldGen: config.worldGen, bots: world.bots.length }
    },
  }, log)
}
log(`симуляция запущена — сидят за хостами: ${seatedBots().length} из ${world.bots.length} ботов`)

startTicker()
tick()
