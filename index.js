// Симулятор живого клуба для тестового Gizmo-сервера GGBook.
//
//   node index.js --players 8 --tick 10 --speed 1
//
// Боты-игроки максимально похожи на реальных: садятся на 30 минут – 4 часа,
// заказывают на бар не чаще раза в полчаса, изредка пополняют баланс, берут
// ассеты, бронируют. Бот-оператор разгребает очередь заказов (принял →
// приготовил → оплатил → выдал), продаёт на кассе и ведёт смену.
// --speed 4 ускоряет «клубное время» в 4 раза (для демо).
//
// Ctrl+C — мягкая остановка: боты возвращают ассеты и уходят с хостов.

import { config } from './src/config.js'
import { gapi } from './src/gizmo.js'
import { loadWorld, resetWorld, world, seatedBots, isPresentToday } from './src/world.js'
import { updateConfig } from './src/config.js'
import * as actions from './src/actions.js'
import { closeSql, disableSql, sqlEnabled } from './src/sql.js'
import { startUI, broadcast, broadcastEvent } from './src/ui.js'

const ts = () => new Date().toLocaleTimeString('ru-RU')

// Лента и счётчики — для консоли и веб-интерфейса одновременно.
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
  broadcast(line)                 // старые встроенные страницы (безымянное SSE)
  broadcastEvent('feed', line)    // Svelte-фронт
}

// Минуты «клубного времени» из миллисекунд реальных.
const clubMin = (ms) => Math.max(0, Math.round((ms * config.speed) / 60_000))

let paused = false

// Форс-события и пауза из веб-интерфейса.
async function uiAction(name) {
  if (name === 'pause') { paused = true; log('⏸ симуляция на паузе (из веб-интерфейса)'); return true }
  if (name === 'resume') { paused = false; log('▶ симуляция продолжается'); return true }
  if (!ACTIONS[name]) throw new Error(`нет события «${name}»`)
  // force=true: кнопки веб-интерфейса игнорируют кулдауны и логируют причину отказа
  const done = await ACTIONS[name](log, true)
  broadcastEvent('state', uiState())  // мгновенный пуш после форс-действия
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
    layoutSeed: config.worldGen ?? 1,   // планировка комнат на карте
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
      // для анимации выдачи на карте: кому нести заказ
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

  // Оператор и «время»: каждый тик — уходы по плану, очередь заказов, смена.
  await actions.sweepDay(log).catch(() => {})
  await actions.sweepSessions(log).catch(() => {})
  await actions.sweepOrders(log).catch(() => {})
  await actions.sweepShift(log).catch(() => {})

  // Плюс одно случайное событие.
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
console.log('  GGBook Club Simulator')
console.log(`  Gizmo: ${config.gizmo.ip}:${config.gizmo.port} · бренч ${config.branchId}`)
console.log(`  Игроков: ${config.players} · тик: ${config.tickSeconds}с · скорость ×${config.speed} · SQL(AppStat): ${sqlEnabled() ? 'вкл' : 'выкл'}`)
console.log('══════════════════════════════════════════════')

await loadWorld(log)
await actions.ensureShift(log)

// История метрик для живых отчётов: точка раз в секунду, последние 15 минут.
// Держится на сервере, чтобы графики были заполнены сразу при открытии страницы.
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
  // Push вместо поллинга: одна точка (~100 байт) вместо скачивания всей
  // истории (~80 КБ) каждую секунду каждым открытым браузером.
  broadcastEvent('metric', history[history.length - 1])
}, 1000)

// Снапшот мира — тоже пушем (клиент ничего не опрашивает)
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
    // Конфиг поменяли из веб-интерфейса: тик применяем сразу же.
    onConfig: startTicker,
    onAction: uiAction,
    // ♻ Снести мир и сгенерировать заново (кнопка в UI)
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
