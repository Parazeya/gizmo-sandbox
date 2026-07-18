// Bot and operator actions. All errors are caught from the outside (one failed
// action doesn't crash the loop). Realism comes from habit cooldowns and the
// planned session length — see config.session / config.habits.
import { gapi, userApi, model, data } from './gizmo.js'
import { world, freeBots, seatedBots, freeHosts, hostOccupancy, pick, isPresentToday, createBot } from './world.js'
import { config } from './config.js'
import { insertAppStat, sqlEnabled } from './sql.js'

// Bot label in the log: persona name (+ gamer tag) + login.
const who = (bot) => {
  const nick = bot.persona?.nick ? ` «${bot.persona.nick}»` : ''
  return `${bot.persona?.name ?? ''}${nick} (${bot.username})`
}

// Daily rhythm: the club empties at night, evening is rush hour. Arrival-chance
// multiplier by the REAL machine hour (speed accelerates life within the day,
// not the day itself).
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

// "Club time" minutes → real milliseconds, factoring in the acceleration.
const mins = (m) => (m * 60_000) / config.speed
const randBetween = ([a, b]) => a + Math.random() * (b - a)
const cooldownOk = (ts, range) => !ts || Date.now() - ts > mins(randBetween(range))

// ── Sessions ────────────────────────────────────────────────────────────────

const todayKey = () => new Date().toISOString().slice(0, 10)

// Hosts can be occupied by NON-bots too (real sessions on the stand) — we check
// against Gizmo's live sessions, not just local state. We count SEATS: a console
// has maximumUsers, so it's a counter rather than a Set.
async function actuallyFreeHosts() {
  const sessRes = await gapi.v3.userSessions.getUserSessions({ paginationLimit: -1 }).catch(() => null)
  const liveCnt = new Map()
  for (const s of data(sessRes)) {
    if (((s.state ?? 0) & 1) !== 1) continue
    liveCnt.set(s.hostId, (liveCnt.get(s.hostId) ?? 0) + 1)
  }
  return freeHosts().filter(h => (liveCnt.get(h.id) ?? 0) < (h.maxUsers ?? 1))
}

// AppStat.HostId has an FK to HostComputer — consoles (endpoints) CANNOT be
// written there (FK_AppStat_HostComputer_HostId fails). PC sitters only.
const seatedAtPc = () => seatedBots().filter(b =>
  world.hosts.find(h => h.id === b.hostId)?.type !== 'endpoint')

/** Seat a bot at a host (shared arrive/groupArrive mechanic). true = seated. */
async function seatBot(bot, host, log) {
  let res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  // 16384 = the user has no play time: we realistically top up at the counter
  // (cash deposit + cheapest package) and try again.
  if (res?.result?.loginResult === 16384) {
    await topUpTime(bot, log)
    res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  }
  // 65536 = no free Gizmo LICENSE SLOTS (the club is full) or the bot has a
  // hung paused session. We try one logout+retry (heals a stuck session); if
  // that doesn't help, there are no license seats and the bot softly leaves.
  // Money is irrelevant here (verified live: a 3000₽ balance still gives 65536).
  if (res?.result?.loginResult === 65536) {
    await gapi.v3.users.postUsersByUserIdLogout(bot.userId).catch(() => {})
    res = await gapi.v3.users.postUsersByUserIdLoginByHostId(bot.userId, host.id)
  }
  if (res?.result?.loginResult === 65536) {
    log(`🤷 ${who(bot)} не попал за хост — свободных мест по лицензии нет (аншлаг), ушёл домой`)
    return false
  }
  if (res?.result?.loginResult === 256) {
    // Race: the seat was just taken — the bot simply didn't sit, tries later.
    log(`🤷 ${who(bot)} хотел сесть за ${host.name}, но место уже заняли`)
    return false
  }
  if (res?.result?.loginResult !== 0) throw new Error(`loginResult=${res?.result?.loginResult}`)
  // Duration comes from the persona's character (a grinder sits longer than a drop-in).
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
  // Only those who are "in the club today" arrive (see persona and day).
  const bot = pick(freeBots().filter(b => isPresentToday(b, todayKey())))
  if (!bot) return false
  const free = await actuallyFreeHosts()
  if (!free.length) return false
  // A loner sometimes joins a console couch — especially where someone is
  // already playing (realistic: "oh, guys are on FIFA, I'm in").
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

/** A group of friends (2–3) arrives together and sits at adjacent hosts. */
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

  // A group prefers a console: it matters to count FREE SEATS (capacity minus
  // sitters), not just maxUsers — otherwise a group would never join a
  // half-occupied couch.
  const occ = hostOccupancy()
  const console_ = free.find(h =>
    (h.maxUsers ?? 1) > 1 && (h.maxUsers - (occ.get(h.id) ?? 0)) >= size)
  let hosts = null
  if (console_ && Math.random() < 0.65) {
    hosts = Array(size).fill(console_)
  } else {
    // Otherwise — a window of adjacent (by number) free PCs, or any.
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
  // PCs only: participants' AppStat can't be written with a console hostId (FK)
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

// ── "Life": actions outside Gizmo — just to make the bots feel alive ─────────
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
  // Sometimes it's the operator behind the counter who "lives", not a player.
  if (Math.random() < 0.2) {
    log(pick(LIFE_OPERATOR))
    return true
  }
  const dateKey = todayKey()
  const seated = seatedBots()
  const away = world.bots.filter(b => !b.hostId && !isPresentToday(b, dateKey))
  // The persona's chattiness affects whether its "life" makes it into the log.
  const candidates = [...seated, ...away].filter(b => Math.random() < (b.persona?.chatty ?? 0.3))
  const bot = pick(candidates)
  if (!bot) return false
  const line = bot.hostId ? pick(LIFE_SEATED) : pick(LIFE_AWAY)
  log(`💬 ${who(bot)} ${line}`)
  return true
}

/** New player registration: the club is alive, the base grows (up to maxPlayers). */
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

/** Day change: whoever is "off today" leaves the club, attendance is logged. */
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

/** Every tick: bots whose plan expired leave; occasionally someone leaves early. */
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

// ── Money and purchases ─────────────────────────────────────────────────────

// How a client pays at the counter: roughly evenly cash and card.
// (-1 Cash, -2 Credit Card — standard Gizmo methods, verified on the stand)
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
  // Only those in the club today top up; big spenders put in more.
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
    // Chatty ones comment on the order more often, silent ones almost never.
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

// Deposit + the cheapest time package — "paying at the counter before playing".
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

// ── Reservations, assets, applications ──────────────────────────────────────

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
    // The slot is already taken by another reservation — normal, the bot isn't upset.
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
    // The asset is already checked out (e.g. handed out by an operator outside the sim).
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

// ── Operator ────────────────────────────────────────────────────────────────

let lastOperatorSaleAt = null

/** Register sale: a player who walked up to the counter buys for cash. */
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

// ── Register discipline: visible in the Gizmo shift report (Pay In/Pay Out) ──
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

// The operator made a mistake on a receipt — voids the last invoice (Gizmo Voids report)
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
 * Every tick: the operator works the order queue — accepts an order and, after
 * the "cooking time", pays and delivers it. Payment: the client's preferred
 * method; if the deposit didn't work (DepositException — empty balance), the
 * client "pays cash at the counter". An order that still can't be paid is
 * cancelled after three attempts — as a live operator would do.
 */
const orderPayFails = new Map() // orderId → number of failed completion attempts
const orderAccepted = new Set() // orders already accepted for work (so "accepted" is logged once)

// Gizmo order lifecycle (verified on v3.0.81): the detail status is
//   4 = new/pending → (process=accept) → (pay the balance) → 3 = paid
//   → (delivered) → (complete) → 1 = completed and LEAVES the active list.
// The /active list gives its own summary status (0=new,1=cooking) — usable ONLY
// for displaying the queue, NOT for control: we finish via explicit steps.
// An empty order (total 0 — e.g. a fake test product) can't be completed → cancel.
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
 * Shifts: without an open shift Gizmo blocks ALL register operations
 * (ShiftException). Opening is only via the v2 endpoint
 * POST /api/v2.0/operators/current/shift/start (works on the same port),
 * closing is v3 putShiftsByIdEnd. The shift change is counted from the moment
 * the simulator saw/opened the shift (the real startTime on the stand can be
 * days old — we must not close it right at startup).
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
