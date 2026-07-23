// Everything the bots and the operator do. Errors are swallowed by the caller,
// one failed action must not take the loop down. The realism knobs are the habit
// cooldowns and the planned session length, see config.session / config.habits.
import { gapi, userApi, model, data } from './gizmo.js'
import { world, freeBots, seatedBots, freeHosts, hostOccupancy, pick, isPresentToday, createBot } from './world.js'
import { config } from './config.js'
import { insertAppStat, sqlEnabled } from './sql.js'

// how a bot shows up in the log: name, tag, login
const who = (bot) => {
  const nick = bot.persona?.nick ? ` «${bot.persona.nick}»` : ''
  return `${bot.persona?.name ?? ''}${nick} (${bot.username})`
}

// Daily rhythm: dead at night, packed in the evening. The multiplier keys off
// the real wall clock, speed compresses life inside a day, not the day itself.
function hourFactor() {
  const h = new Date().getHours()
  if (h >= 17 || h === 0) return 1     // evening — peak
  if (h >= 12) return 0.8              // afternoon
  if (h >= 7) return 0.5               // morning
  return 0.25                          // deep night
}

const ORDER_COMMENTS = [
  'Принесите, пожалуйста, побыстрее!',
  'Без сахара',
  'Со льдом, если можно',
  'К компьютеру не несите — заберу на стойке',
  'Можно вместе с чеком?',
  'Погорячее, если можно',
  'Я за PC у окна, в наушниках — помашите',
  'Как в прошлый раз, вы помните',
  'Сдачу оставьте себе :)',
  'Только не как вчера, пожалуйста',
  'Разогрейте посильнее',
  '', '', '', '', '', '', '', // most often without a comment
]

const DEPOSIT_AMOUNTS = [100, 200, 300, 500, 1000]

// club minutes -> real ms, acceleration included
const mins = (m) => (m * 60_000) / config.speed
const randBetween = ([a, b]) => a + Math.random() * (b - a)
const cooldownOk = (ts, range) => !ts || Date.now() - ts > mins(randBetween(range))

// Sessions

const todayKey = () => new Date().toISOString().slice(0, 10)

// Real people sit on the stand too, so free hosts come from Gizmo's live
// sessions rather than our local state. Counting seats, not hosts: a console
// holds maximumUsers of them.
async function actuallyFreeHosts() {
  const sessRes = await gapi.v3.userSessions.getUserSessions({ paginationLimit: -1 }).catch(() => null)
  const liveCnt = new Map()
  for (const s of data(sessRes)) {
    if (((s.state ?? 0) & 1) !== 1) continue
    liveCnt.set(s.hostId, (liveCnt.get(s.hostId) ?? 0) + 1)
  }
  return freeHosts().filter(h => (liveCnt.get(h.id) ?? 0) < (h.maxUsers ?? 1))
}

// AppStat.HostId has an FK to HostComputer, so a console id blows up on
// FK_AppStat_HostComputer_HostId. PC sitters only.
const seatedAtPc = () => seatedBots().filter(b =>
  world.hosts.find(h => h.id === b.hostId)?.type !== 'endpoint')

/** Sit a bot down at a host, shared by arrive and groupArrive. */
async function seatBot(bot, host, log) {
  let res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  // 16384 = no play time left. Top up at the counter (cash + cheapest package)
  // and try again, same as a live visitor would.
  if (res?.result?.loginResult === 16384) {
    await topUpTime(bot, log)
    res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  }
  // 65536 = out of license slots, or this bot has a paused session stuck
  // somewhere. One logout+retry heals the stuck case; if it doesn't, the club is
  // genuinely full and the bot leaves quietly. Money has nothing to do with it,
  // a 3000₽ balance gets the same 65536.
  if (res?.result?.loginResult === 65536) {
    await gapi.v3.users.postUsersByUserIdLogout(bot.userId).catch(() => {})
    res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  }
  if (res?.result?.loginResult === 65536) {
    log(`🤷 ${who(bot)} не попал за хост — свободных мест по лицензии нет (аншлаг), ушёл домой`)
    return false
  }
  if (res?.result?.loginResult === 256) {
    // somebody grabbed the seat first, try again later
    log(`🤷 ${who(bot)} хотел сесть за ${host.name}, но место уже заняли`)
    return false
  }
  if (res?.result?.loginResult !== 0) throw new Error(`loginResult=${res?.result?.loginResult}`)
  // grinders sit longer than drop-ins
  const planned = randBetween(bot.persona?.session ?? [config.session.minMinutes, config.session.maxMinutes])
  bot.hostId = host.id
  bot.sessionSince = Date.now()
  bot.plannedUntil = Date.now() + mins(planned)
  return Math.round(planned)
}

export async function arrive(log) {
  if (Math.random() > hourFactor()) return false // at night almost nobody comes
  // keep occupancy below the license limit — otherwise 65536 and no rotation
  if (seatedBots().length >= (config.maxSeated ?? 32)) return false
  // only those who came in today
  const bot = pick(freeBots().filter(b => isPresentToday(b, todayKey())))
  if (!bot) return false
  const free = await actuallyFreeHosts()
  if (!free.length) return false
  // a loner sometimes drops onto a console couch, more likely where somebody is
  // already playing ("oh, FIFA, deal me in")
  const occ = hostOccupancy()
  const couches = free.filter(h => (h.maxUsers ?? 1) > 1)
  let host = null
  if (couches.length && Math.random() < 0.3) {
    host = couches.find(h => (occ.get(h.id) ?? 0) > 0) ?? pick(couches)
  }
  host ??= pick(free)
  const planned = await seatBot(bot, host, log)
  if (planned === false) return false
  const joined = (h) => (h.maxUsers ?? 1) > 1 && (occ.get(h.id) ?? 0) > 0
  log(`🪑 ${who(bot)} ${joined(host) ? `подсел на диван ${host.name} к остальным` : `сел за ${host.name} (№${host.number})`} — планирует ~${planned} мин`)
  return true
}

/** Two or three friends walk in together and take neighbouring hosts. */
export async function groupArrive(log, force = false) {
  if (!force && Math.random() > hourFactor()) return false
  if (seatedBots().length + 2 > (config.maxSeated ?? 32)) {
    if (force) log(`🤷 компания не зашла: в клубе аншлаг (${seatedBots().length}/${config.maxSeated ?? 32} мест занято)`)
    return false
  }
  const candidates = freeBots().filter(b => isPresentToday(b, todayKey()))
  if (candidates.length < 2) return false
  const size = Math.min(candidates.length, 2 + (Math.random() < 0.4 ? 1 : 0))
  const group = candidates.sort(() => Math.random() - 0.5).slice(0, size)

  const free = (await actuallyFreeHosts()).sort((a, b) => a.number - b.number)
  if (!free.length) return false

  // Groups head for a console. Count free seats (capacity minus sitters), not
  // capacity, or a group never joins a half-occupied couch.
  const occ = hostOccupancy()
  const console_ = free.find(h =>
    (h.maxUsers ?? 1) > 1 && (h.maxUsers - (occ.get(h.id) ?? 0)) >= size)
  let hosts = null
  if (console_ && Math.random() < 0.65) {
    hosts = Array(size).fill(console_)
  } else {
    // otherwise a window of neighbouring free PCs, or whatever is left
    const pcs = free.filter(h => (h.maxUsers ?? 1) === 1)
    if (pcs.length >= size) {
      for (let i = 0; i + size <= pcs.length; i++) {
        const win = pcs.slice(i, i + size)
        if (win[size - 1].number - win[0].number === size - 1) { hosts = win; break }
      }
      hosts ??= pcs.slice(0, size)
    } else if (console_) {
      hosts = Array(size).fill(console_)
    } else return false
  }

  const seated = []
  for (let i = 0; i < group.length; i++) {
    const planned = await seatBot(group[i], hosts[i], log).catch(() => false)
    if (planned !== false) seated.push(group[i])
  }
  if (seated.length < 2) return seated.length === 1 // a single seating is an event too
  const names = seated.map(b => who(b))
  const onConsole = hosts[0] === hosts[1]
  const hostNames = onConsole
    ? hosts[0].name
    : seated.map(b => world.hosts.find(h => h.id === b.hostId)?.name).join(', ')
  log(`👥 ${names.slice(0, -1).join(', ')} и ${names.at(-1)} пришли вместе — ${onConsole ? `рубятся на консоли ${hostNames}` : `сели рядом (${hostNames})`}`)
  return true
}

/** A spontaneous mini-tournament: several seated players compete in one game.
 *  force (web UI button) — no cooldown and with a clear refusal reason. */
let lastTournamentAt = null
export async function tournament(log, force = false) {
  if (!force && !cooldownOk(lastTournamentAt, [90, 180])) return false
  // PCs only, AppStat won't take a console hostId
  const seated = seatedAtPc()
  const app = pick(world.apps)
  if (seated.length < 4 || !app) {
    if (force) log(`🤷 турнир не собрался: за ПК сидят ${seated.length} (нужно ≥4)${app ? '' : ', нет приложений'}`)
    return false
  }
  const players = seated.sort(() => Math.random() - 0.5).slice(0, 4)
  lastTournamentAt = Date.now()
  const minutes = 30 + Math.floor(Math.random() * 45)
  if (sqlEnabled()) {
    for (const p of players) {
      await insertAppStat({
        appId: app.id, appExeId: app.exeId, hostId: p.hostId, userId: p.userId,
        spanSeconds: minutes * 60, branchId: config.branchId,
      }).catch(() => {})
    }
  }
  const names = players.map(p => p.persona.name)
  log(`🏆 стихийный турнир по «${app.title}»: ${names.slice(0, -1).join(', ')} и ${names.at(-1)} рубились ~${minutes} мин, победил ${pick(names)}`)
  return true
}

async function botLeave(bot, log, reason) {
  for (const assetId of [...bot.assets]) {
    await gapi.v3.users.putUsersAssetsByAssetIdCheckin(assetId).catch(() => {})
    bot.assets.delete(assetId)
  }
  await gapi.v3.users.postUsersByUserIdLogout(bot.userId)
  const host = world.hosts.find(h => h.id === bot.hostId)
  const playedMin = Math.round((Date.now() - bot.sessionSince) / mins(1))
  bot.hostId = null
  bot.sessionSince = null
  bot.plannedUntil = null
  log(`🚪 ${who(bot)} ушёл с ${host?.name ?? '?'} (${reason}, отсидел ~${playedMin} мин)`)
}

// "Life": nothing reaches Gizmo here, it only makes the feed feel populated.
const LIFE_SEATED = [
  'потягивается и хрустит пальцами',
  'орёт на тиммейтов в дискорде',
  'вышел покурить — на хосте AFK',
  'отошёл в туалет — сейчас вернётся',
  'листает мемы на телефоне между катками',
  'жалуется соседу на пинг',
  'снял наушники и разминает шею',
  'фоткает свой киллстрик на телефон',
  'спорит с соседом, кто платит за пиццу',
  'кричит «изи катка» на весь зал',
  'тильтует после слитой катки — стучит по столу',
  'показывает соседу клип со своим хайлайтом',
  'заказал бы ещё колу, но денег жалко',
  'переключился на ютуб «на 5 минут» (прошло 40)',
  'протирает очки футболкой',
  'зевает так, что слышно на кассе',
  'хвастается новым рангом в дискорде',
  'ищет зарядку для телефона по всему залу',
  'обещает себе «последняя и домой» (третий раз)',
  'гладит клубного кота — тот запрыгнул на стол',
  'спрашивает соседа «а ты чё сюда пришёл, у тебя же дома комп?»',
  'записывает голосовое на 2 минуты, весь зал в курсе его дел',
]
const LIFE_AWAY = [
  'сегодня отсыпается после вчерашнего',
  'пишет в чате клуба «я сегодня буду?» — сам не знает',
  'смотрит стрим дома и завидует тем, кто в клубе',
  'застрял на работе, мечтает о катке',
  'обещал себе перерыв от игр… посмотрим',
  'сидит на паре и рисует стратегии в тетради',
  'мама сказала «сначала уроки» — спорить бесполезно',
  'копит на новую мышку, дома грустит',
  'у него сегодня свидание — клуб подождёт',
  'проспал будильник, придёт к вечеру (может быть)',
  'смотрит расписание турниров и мечтает о призовых',
]
const LIFE_OPERATOR = [
  '🧹 оператор протирает столы и собирает стаканы',
  '☕ оператор заварил себе кофе — минутка тишины',
  '🔧 оператор перетыкает наушники на PC — «у вас звук пропал? сейчас»',
  '📦 оператору привезли коробку снеков — раскладывает по полкам',
  '🎵 оператор сменил плейлист в зале',
  '🖥 оператор прошёлся по залу — проверяет, у всех ли всё ок',
  '🧊 оператор досыпал лёд в холодильник',
  '📋 оператор пересчитывает кассу — сходится, ура',
  '🐈 оператор налил коту воды — тот сделал вид, что не просил',
  '💡 оператор поменял перегоревшую лампочку над баром',
  '📞 оператор отвечает на звонок: «да, места есть, приходите»',
]

export async function lifeEvent(log) {
  // sometimes it's the operator behind the counter, not a player
  if (Math.random() < 0.2) {
    log(pick(LIFE_OPERATOR))
    return true
  }
  const dateKey = todayKey()
  const seated = seatedBots()
  const away = world.bots.filter(b => !b.hostId && !isPresentToday(b, dateKey))
  // the quiet ones rarely make it into the log
  const candidates = [...seated, ...away].filter(b => Math.random() < (b.persona?.chatty ?? 0.3))
  const bot = pick(candidates)
  if (!bot) return false
  const line = bot.hostId ? pick(LIFE_SEATED) : pick(LIFE_AWAY)
  log(`💬 ${who(bot)} ${line}`)
  return true
}

/** A new player registers: the base grows up to maxPlayers. */
export async function newcomer(log, force = false) {
  if (world.bots.length >= (config.maxPlayers ?? 40)) {
    if (force) log(`🤷 новых игроков не будет: база ${world.bots.length}/${config.maxPlayers ?? 40} — подними «Максимум игроков» в ⚙ Настройках`)
    return false
  }
  const bot = await createBot(world.nextBotIndex, null)
  world.nextBotIndex++
  world.bots.push(bot)
  log(`📝 в клубе новый игрок: ${who(bot)} — ${bot.persona.trait}, оформили карту на стойке`)
  return true
}

/** Day change: everyone who is off today goes home. */
let lastDateKey = todayKey()
export async function sweepDay(log) {
  const dateKey = todayKey()
  if (dateKey === lastDateKey) return
  lastDateKey = dateKey
  const present = world.bots.filter(b => isPresentToday(b, dateKey))
  log(`🌅 новый день: сегодня в клуб собираются ${present.map(b => b.persona.name).join(', ') || 'никто'}`)
  for (const bot of seatedBots()) {
    if (!isPresentToday(bot, dateKey)) await botLeave(bot, log, 'домой, день закончился').catch(() => {})
  }
}

/** Every tick: expired plans go home, and once in a while somebody bails early. */
export async function sweepSessions(log) {
  for (const bot of seatedBots()) {
    if (Date.now() >= bot.plannedUntil) {
      await botLeave(bot, log, 'наигрался').catch(() => {})
    } else if (
      Date.now() - bot.sessionSince > mins(20) &&
      Math.random() < config.session.earlyLeaveChance / Math.max(1, seatedBots().length)
    ) {
      await botLeave(bot, log, 'дела').catch(() => {})
    }
  }
}

// Money

// Roughly half cash, half card. -1 Cash and -2 Credit Card are the standard
// Gizmo methods, checked on the stand.
const pickPay = () => (Math.random() < 0.5 ? { id: -1, label: 'наличные' } : { id: -2, label: 'карта' })

async function cashDeposit(userId, amount, payId = -1) {
  const cartId = (await gapi.v3.carts.postCarts({}))?.result?.id
  if (!cartId) throw new Error('cart_failed')
  try {
    await gapi.v3.carts.postCartsByIdEntriesUsersByUserIdDeposit(cartId, userId, { amount })
    await gapi.v3.carts.postCartsByIdPayments(cartId, { paymentMethodId: payId, amount })
    await gapi.v3.carts.postCartsByIdAccept(cartId, { invoice: true, autoComplete: true })
    world.revenue += amount
  } catch (err) {
    await gapi.v3.carts.deleteCartsById(cartId).catch(() => {})
    throw err
  }
}

export async function deposit(log) {
  // only today's visitors top up, spenders put in more
  const bot = pick(world.bots.filter(b =>
    isPresentToday(b, todayKey()) && cooldownOk(b.lastDepositAt, config.habits.depositCooldownMin)))
  if (!bot) return false
  const spender = bot.persona?.spender ?? 0.5
  const amount = pick(DEPOSIT_AMOUNTS.slice(0, Math.max(2, Math.round(spender * DEPOSIT_AMOUNTS.length))))
  const pm = pickPay()
  await cashDeposit(bot.userId, amount, pm.id)
  bot.lastDepositAt = Date.now()
  log(`💵 ${who(bot)} пополнил баланс на ${amount} (${pm.label})`)
  return true
}

export async function orderBar(log) {
  const bot = pick(seatedBots().filter(b => cooldownOk(b.lastOrderAt, config.habits.orderCooldownMin)))
  const product = pick(world.barProducts)
  if (!bot || !product) return false

  const uapi = await userApi(bot.username, config.botPassword)
  const cartId = (await uapi.v3.carts.postUserCarts({}))?.result?.id
  if (!cartId) throw new Error('user_cart_failed')
  try {
    await uapi.v3.carts.postUserCartsByIdEntries(cartId, { productId: product.id, quantity: 1 })
    const state = model(await uapi.v3.carts.getUserCartsByIdState(cartId))
    if (Number(state?.total ?? 0) > 0) {
      await uapi.v3.carts.postUserCartsByIdPaymentmethod(cartId, { paymentMethodId: -3 })
    }
    // chatty ones leave a comment, the silent ones almost never do
    const note = Math.random() < (bot.persona?.chatty ?? 0.3)
      ? pick(ORDER_COMMENTS.filter(Boolean))
      : ''
    await uapi.v3.carts.postUserCartsByIdAccept(cartId, note ? { note } : {})
    bot.lastOrderAt = Date.now()
    log(`🍔 ${who(bot)} заказал «${product.name}»${note ? ` (комментарий: ${note})` : ''}`)
  } catch (err) {
    await uapi.v3.carts.deleteUserCartsById(cartId).catch(() => {})
    throw err
  }
  return true
}

export async function buyTime(log) {
  const bot = pick(world.bots.filter(b =>
    isPresentToday(b, todayKey()) && cooldownOk(b.lastBuyTimeAt, config.habits.depositCooldownMin)))
  const product = pick(world.timeProducts.filter(p => Number(p.price) > 0))
  if (!bot || !product) return false
  const bal = model(await gapi.v3.users.getUsersByIdBalance(bot.userId))
  if (Number(bal?.balance ?? 0) < Number(product.price)) return false

  const cartId = (await gapi.v3.carts.postCarts({}))?.result?.id
  try {
    await gapi.v3.carts.postCartsByIdEntriesUsersByUserId(cartId, bot.userId, { productId: product.id, quantity: 1 })
    await gapi.v3.carts.postCartsByIdAccept(cartId, { invoice: true, autoComplete: true })
  } catch (err) {
    await gapi.v3.carts.deleteCartsById(cartId).catch(() => {})
    throw err
  }
  bot.lastBuyTimeAt = Date.now()
  log(`⏱ ${who(bot)} купил пакет «${product.name}» за ${product.price}`)
  return true
}

// deposit + cheapest time package, i.e. paying at the counter before playing
async function topUpTime(bot, log) {
  const product = world.timeProducts
    .filter(p => Number(p.price) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price))[0]
  if (!product) throw new Error('нет платных пакетов времени')

  const amount = Math.max(100, Math.ceil(Number(product.price) / 100) * 100)
  const pm = pickPay()
  await cashDeposit(bot.userId, amount, pm.id)
  const buyCart = (await gapi.v3.carts.postCarts({}))?.result?.id
  await gapi.v3.carts.postCartsByIdEntriesUsersByUserId(buyCart, bot.userId, { productId: product.id, quantity: 1 })
  await gapi.v3.carts.postCartsByIdAccept(buyCart, { invoice: true, autoComplete: true })
  log(`💳 ${who(bot)} оплатил на стойке «${product.name}» (депозит ${amount}, ${pm.label})`)
}

// Reservations, assets, applications

export async function reserve(log) {
  const bot = pick(world.bots)
  const host = pick(freeHosts())
  if (!bot || !host) return false
  const inHours = 2 + Math.floor(Math.random() * 8)
  const date = new Date(Date.now() + inHours * 3600_000)
  let res
  try {
    res = await gapi.v3.reservations.postReservations({
      date: date.toISOString(),
      duration: pick([60, 90, 120, 180]),
      branchId: config.branchId,
      userId: bot.userId,
      hosts: [{ hostId: host.id, slot: 0 }],
      contactPhone: '7999' + String(1000000 + Math.floor(Math.random() * 8999999)),
      note: pick(['Днюха, приготовьте место', 'Приду с другом', '', '']),
    })
  } catch (err) {
    // slot already booked, nobody gets upset about it
    if (/HostReservationException/.test(err?.response?.data?.message ?? err.message ?? '')) {
      log(`🤷 ${who(bot)} хотел забронировать ${host.name}, но слот занят`)
      return false
    }
    throw err
  }
  log(`📅 ${who(bot)} забронировал ${host.name} через ${inHours} ч (ПИН ${res?.result?.pin ?? '—'})`)
  return true
}

export async function assetFlow(log) {
  const bot = pick(seatedBots().filter(b => cooldownOk(b.lastAssetAt, config.habits.assetCooldownMin)))
  if (!bot) return false
  if (bot.assets.size && Math.random() < 0.5) {
    const assetId = pick([...bot.assets])
    await gapi.v3.users.putUsersAssetsByAssetIdCheckin(assetId)
    bot.assets.delete(assetId)
    bot.lastAssetAt = Date.now()
    const asset = world.assets.find(a => a.id === assetId)
    log(`🎧 ${who(bot)} вернул «${asset?.typeName ?? assetId}»`)
    return true
  }
  const heldIds = new Set(world.bots.flatMap(b => [...b.assets]))
  const asset = pick(world.assets.filter(a => !heldIds.has(a.id)))
  if (!asset) return false
  let res
  try {
    res = await gapi.v3.users.putUsersByUserIdAssetsByAssetIdCheckout(bot.userId, asset.id)
  } catch (err) {
    // already checked out, probably handed over by a live operator
    if (/AssetException/.test(err?.response?.data?.message ?? err.message ?? '')) {
      log(`🤷 ${who(bot)} хотел взять «${asset.typeName}» №${asset.number}, но его уже разобрали`)
      return false
    }
    throw err
  }
  if (res?.isError) return false
  bot.assets.add(asset.id)
  bot.lastAssetAt = Date.now()
  log(`🎧 ${who(bot)} взял «${asset.typeName}» №${asset.number}`)
  return true
}

export async function appSession(log) {
  if (!sqlEnabled()) return false
  const bot = pick(seatedAtPc())
  const app = pick(world.apps)
  if (!bot || !app) return false
  const minutes = 10 + Math.floor(Math.random() * 80)
  await insertAppStat({
    appId: app.id,
    appExeId: app.exeId,
    hostId: bot.hostId,
    userId: bot.userId,
    spanSeconds: minutes * 60,
    branchId: config.branchId,
  })
  log(`🎮 ${who(bot)} поиграл в «${app.title}» ${minutes} мин`)
  return true
}

// Operator

let lastOperatorSaleAt = null

/** Somebody walks up to the counter and buys for cash. */
export async function operatorSale(log) {
  if (!cooldownOk(lastOperatorSaleAt, config.operator.saleCooldownMin)) return false
  const bot = pick(world.bots.filter(b => isPresentToday(b, todayKey())))
  const product = pick(world.barProducts)
  if (!bot || !product) return false

  const cartId = (await gapi.v3.carts.postCarts({}))?.result?.id
  try {
    await gapi.v3.carts.postCartsByIdEntriesUsersByUserId(cartId, bot.userId, { productId: product.id, quantity: 1 })
    const state = model(await gapi.v3.carts.getCartsByIdState(cartId))
    const total = Number(state?.total ?? 0)
    const pm = pickPay()
    if (total > 0) await gapi.v3.carts.postCartsByIdPayments(cartId, { paymentMethodId: pm.id, amount: total })
    await gapi.v3.carts.postCartsByIdAccept(cartId, { invoice: true, autoComplete: true })
    world.revenue += total
    lastOperatorSaleAt = Date.now()
    log(`🧾 оператор продал на кассе «${product.name}» (${who(bot)}, ${pm.label})`)
  } catch (err) {
    await gapi.v3.carts.deleteCartsById(cartId).catch(() => {})
    throw err
  }
  return true
}

// Register discipline, shows up in the Gizmo shift report as Pay In / Pay Out.
let lastRegisterCashAt = null
export async function registerCash(log, force = false) {
  if (!force && !cooldownOk(lastRegisterCashAt, [120, 300])) return false
  const isPayout = Math.random() < 0.5
  const amount = isPayout ? 500 + Math.floor(Math.random() * 20) * 100 : 100 + Math.floor(Math.random() * 9) * 100
  await gapi.v3.registerTransactions.postRegisterTransactions({
    type: isPayout ? 2 : 1, amount,
    note: isPayout ? 'Инкассация' : 'Размен',
  })
  lastRegisterCashAt = Date.now()
  log(isPayout
    ? `🏦 оператор провёл инкассацию — изъял ${amount} из кассы`
    : `🏦 оператор внёс размен в кассу: ${amount}`)
  return true
}

// operator punched the wrong thing and voids the last invoice (Voids report)
let lastVoidAt = null
export async function voidSale(log, force = false) {
  if (!force && !cooldownOk(lastVoidAt, [180, 360])) return false
  const inv = data(await gapi.v3.invoices.getInvoices({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false }).catch(() => null))[0]
  if (!inv || inv.isVoided) return false
  await gapi.v3.invoices.putInvoicesByIdVoid(inv.id, { refundPaymentMethodId: -1 })
  lastVoidAt = Date.now()
  log(`↩️ оператор аннулировал чек #${inv.id} — пробил по ошибке, возврат наличными`)
  return true
}

/**
 * The operator working the queue: accept an order, wait out the cooking time,
 * pay and hand it over. Payment goes through the client's preferred method; on
 * DepositException (empty balance) they pay cash at the counter instead. After
 * three failed attempts the order is cancelled, same as a live operator would.
 */
const orderPayFails = new Map() // orderId → number of failed completion attempts
const orderAccepted = new Set() // orders already accepted for work (so "accepted" is logged once)

// Order lifecycle as of v3.0.81, detail status:
//   4 new -> process (accept) -> pay -> 3 paid -> delivered -> complete ->
//   1 completed, and it drops off the active list.
// The /active list carries its own summary status (0 new, 1 cooking). Fine for
// drawing the queue, useless for driving it, hence the explicit steps below.
// A zero-total order (fake test product) can never complete, so cancel it.
export async function sweepOrders(log) {
  const res = await gapi.v3.productOrders.getProductOrdersActive({ paginationLimit: -1 }).catch(() => null)
  const orders = data(res)
  world.ordersQueue = orders.map(o => ({ id: o.orderId, status: o.status, createdTime: o.createdTime, userId: o.userId }))
  if (!orders.length) { orderPayFails.clear(); orderAccepted.clear(); return }

  const liveIds = new Set(orders.map(o => o.orderId))
  for (const id of orderAccepted) if (!liveIds.has(id)) orderAccepted.delete(id)

  const prepMs = mins(randBetween(config.operator.orderPrepMinutes))
  for (const o of orders) {
    const oid = o.orderId
    const age = Date.now() - new Date(o.createdTime).getTime()
    try {
      // Accept for work once, as soon as we see the order ("cooking").
      if (!orderAccepted.has(oid)) {
        await gapi.v3.productOrders.putProductOrdersByIdProcess(oid).catch(() => {})
        orderAccepted.add(oid)
        log(`👨‍🍳 оператор взял заказ #${oid} в работу`)
      }
      if (age < prepMs) continue // still cooking — wait

      const full = model(await gapi.v3.productOrders.getProductOrdersById(oid))
      const total = Number(full?.total ?? 0)
      const outstanding = Number(full?.outstanding ?? 0)

      // An empty order (no items / zero total) can't be completed — cancel it.
      if (total <= 0) {
        await gapi.v3.productOrders.putProductOrdersByIdCancel(oid).catch(() => {})
        orderPayFails.delete(oid); orderAccepted.delete(oid)
        log(`🚫 оператор отменил пустой заказ #${oid}`)
        continue
      }

      // Pay the balance: first from the player's deposit, if empty — cash/card.
      if (outstanding > 0) {
        const preferred = full?.preferredPaymentMethodId ?? -3
        try {
          await gapi.v3.productOrders.postProductOrdersByIdPayments(oid, {
            payments: [{ paymentMethodId: preferred, amount: outstanding }],
            disableReceiptPrinting: true,
          })
        } catch (err) {
          const msg = err?.response?.data?.message ?? err.message ?? ''
          if (!/DepositException/.test(msg) || preferred === -1) throw err
          const pm = pickPay()
          await gapi.v3.productOrders.postProductOrdersByIdPayments(oid, {
            payments: [{ paymentMethodId: pm.id, amount: outstanding }],
            disableReceiptPrinting: true,
          })
          log(`💸 заказ #${oid}: на балансе пусто — клиент заплатил (${pm.label})`)
        }
      }

      // Deliver the items and complete. We log "delivered" and count revenue ONLY
      // if complete actually succeeded (otherwise the order would stay in the queue).
      await gapi.v3.productOrders.putProductOrdersByIdDelivered(oid).catch(() => {})
      await gapi.v3.productOrders.putProductOrdersByIdComplete(oid)
      orderPayFails.delete(oid); orderAccepted.delete(oid)
      world.revenue += total
      log(`✅ оператор выдал заказ #${oid}`)
    } catch (err) {
      const fails = (orderPayFails.get(oid) ?? 0) + 1
      orderPayFails.set(oid, fails)
      if (fails >= 3) {
        await gapi.v3.productOrders.putProductOrdersByIdCancel(oid).catch(() => {})
        orderPayFails.delete(oid); orderAccepted.delete(oid)
        log(`🚫 оператор отменил заказ #${oid} — не удалось завершить ${fails} раза`)
      } else if (fails === 1) {
        log(`⚠ заказ #${oid}: ${err?.response?.data?.message ?? err.message}`)
      }
    }
  }
}

/**
 * Without an open shift Gizmo refuses every register operation with
 * ShiftException. Opening only works through v2
 * (POST /api/v2.0/operators/current/shift/start, same port), closing is v3
 * putShiftsByIdEnd. The shift clock starts when the simulator first sees the
 * shift: the real startTime on a stand can be days old and we would close it
 * two seconds after startup.
 */
let shiftTrackedSince = null
let currentShiftId = null

export const getShiftInfo = () => ({ id: currentShiftId, trackedSince: shiftTrackedSince })

async function startShift(log) {
  const res = await gapi.v2.operators.postOperatorsCurrentShiftStart({ registerId: 1, startCash: 0 })
  if (res?.isError) throw new Error(res.message ?? 'shift start failed')
  shiftTrackedSince = Date.now()
  currentShiftId = res?.result?.id ?? null
  log(`🕐 оператор открыл смену #${res?.result?.id}`)
  return res?.result?.id
}

export async function ensureShift(log) {
  const res = await gapi.v3.shifts.getShifts({ isActive: true, paginationLimit: -1 }).catch(() => null)
  const active = data(res)[0]
  if (active) {
    shiftTrackedSince = Date.now()
    currentShiftId = active.id
    log(`🕐 смена #${active.id} уже открыта (оператор ${active.operatorId})`)
  } else {
    await startShift(log)
  }
}

export async function sweepShift(log) {
  if (!shiftTrackedSince) return
  if (Date.now() - shiftTrackedSince < mins(config.operator.shiftHours * 60)) return
  const res = await gapi.v3.shifts.getShifts({ isActive: true, paginationLimit: -1 }).catch(() => null)
  const active = data(res)[0]
  if (active) {
    await gapi.v3.shifts.putShiftsByIdEnd(active.id, {})
    log(`🕐 пересменка: смена #${active.id} закрыта`)
  }
  await startShift(log)
}
