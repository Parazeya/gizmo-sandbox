// «Мир» симуляции: боты, хосты, товары, ассеты, приложения. Всё создаётся
// или подгружается при старте; недостающие сущности сеются автоматически.
import { gapi, data, model } from './gizmo.js'
import { config } from './config.js'

export const world = {
  bots: [],       // { userId, username, hostId|null, sessionSince, assets: Set }
  hosts: [],      // { id, number, name }
  barProducts: [],   // не-time товары
  timeProducts: [],  // пакеты времени
  assets: [],     // { id, number, typeName }
  apps: [],       // { id, title, exeId } — для AppStat
  ordersQueue: [],// активные заказы (обновляет sweepOrders) — для веб-интерфейса
  nextBotIndex: 1,// следующий номер для «регистрации» нового игрока
  revenue: 0,     // «касса» за сеанс симуляции (депозиты + продажи + заказы)
}

const FIRST = [
  'Артём', 'Дэн', 'Кира', 'Макс', 'Лера', 'Тоха', 'Соня', 'Глеб', 'Ника', 'Влад',
  'Юля', 'Стас', 'Аня', 'Кеша', 'Рома', 'Майя', 'Егор', 'Лиза', 'Тима', 'Оля',
  'Витя', 'Настя', 'Гоша', 'Даша', 'Лёха', 'Полина', 'Санёк', 'Ксюша', 'Димон', 'Алиса',
  'Женя', 'Марк', 'Ира', 'Костя', 'Таня', 'Паша', 'Света', 'Никита', 'Вика', 'Серёга',
  'Богдан', 'Милана', 'Артур', 'Диана', 'Илья', 'Кристина', 'Матвей', 'Алёна', 'Тёма', 'Варя',
  'Славик', 'Регина', 'Федя', 'Злата', 'Лёва', 'Эля', 'Гриша', 'Мила', 'Захар', 'Уля',
  'Андрей', 'Боря', 'Вадим', 'Галя', 'Дима', 'Ева', 'Жора', 'Зоя', 'Игорь', 'Катя',
  'Лёша', 'Марина', 'Назар', 'Оксана', 'Петя', 'Руслан', 'Софа', 'Тимур', 'Фарид', 'Элина',
  'Юра', 'Яна', 'Вероника', 'Арсений', 'Лада', 'Виталя', 'Савва', 'Инга', 'Валера', 'Люба',
  'Герман', 'Ася', 'Родион', 'Клим', 'Осип', 'Влада', 'Демид', 'Стеша', 'Платон', 'Дуня',
  'Мирон', 'Люся', 'Тихон', 'Ада', 'Сева', 'Рая', 'Лукас', 'Тося', 'Нонна', 'Кирилл',
  'Маша', 'Толик', 'Надя', 'Олег', 'Рита', 'Саша', 'Ульяна', 'Филя', 'Зина', 'Ролан',
]

// Игровые ники — их носят задроты и стримеры (и иногда остальные).
const NICKS = [
  'ShadowFox', 'NoScope777', 'CyberVolk', 'PingLord', 'Kefir2000', 'MamkinTank',
  'Zloy_Bober', 'FrostByte', 'Medved_GG', 'DedInside', 'TurboYozh', 'NightOwl',
  'KotVSapogah', 'SuslikPRO', 'ChikiBriki', 'ZmeyGorynych', 'Batya1337', 'Cheburek',
  'KosmoKot', 'Ogurchik', 'PelmenX', 'HolodOS', 'Bublik', 'MrakoBes', 'Krabik',
  'GromoZeka', 'Pchelka', 'BlinChik', 'SinyayaLisa', 'Vjuh', 'ShturmanJoe', 'LapkaMira',
  'xX_Reaper_Xx', 'StalkerDjo', 'BorschPRO', 'KvasHunter', 'Murzik228', 'TapokSmerti',
  'ValenokX', 'SgushenkaGG',
]

// ── Персоны: у каждого бота свой характер ─────────────────────────────────────
const CHARACTERS = [
  { trait: 'задрот',      presence: 0.9,  session: [120, 240], chatty: 0.2, spender: 0.4 },
  { trait: 'казуал',      presence: 0.5,  session: [45, 120],  chatty: 0.4, spender: 0.5 },
  { trait: 'гурман',      presence: 0.6,  session: [60, 180],  chatty: 0.7, spender: 0.9 },
  { trait: 'молчун',      presence: 0.7,  session: [90, 210],  chatty: 0.05, spender: 0.3 },
  { trait: 'залётный',    presence: 0.3,  session: [30, 90],   chatty: 0.5, spender: 0.6 },
  { trait: 'стример',     presence: 0.75, session: [150, 240], chatty: 0.6, spender: 0.7 },
]

// Детерминированный «рандом» от строки — чтобы посещаемость на конкретный
// день была стабильной (перезапуск симулятора не меняет, кто сегодня пришёл).
export function hashChance(str) {
  let h = 2166136261
  for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) }
  return ((h >>> 0) % 1000) / 1000
}

export function makePersona(index) {
  // Соль поколения мира: после «снести и сгенерировать заново» те же логины
  // получают других персонажей (имена/характеры/ники перемешиваются).
  const shift = ((config.worldGen ?? 1) - 1) * 17
  const i = index + shift
  const character = CHARACTERS[i % CHARACTERS.length]
  const name = FIRST[i % FIRST.length]
  const wantsNick = ['задрот', 'стример'].includes(character.trait) || hashChance(`nick${name}${i}`) < 0.3
  return {
    name,
    nick: wantsNick ? NICKS[(i * 3) % NICKS.length] : null,
    ...character,
  }
}

/** Пришёл ли бот сегодня: у каждого — свой шанс, бросок стабилен в рамках дня.
 *  В выходные народу больше — шанс прихода подрастает. */
export function isPresentToday(bot, dateKey) {
  const weekday = new Date(dateKey).getDay()
  const boost = (weekday === 0 || weekday === 6) ? 1.25 : 1
  return hashChance(bot.username + dateKey) < Math.min(0.97, bot.persona.presence * boost)
}

// Группа пользователей по умолчанию и следующий свободный номер sim_bot_NN —
// нужны и при старте, и для «регистрации» новых игроков по ходу симуляции.
let defaultUserGroupId = null

/** Создать (или подхватить существующего) бота sim_bot_<i> и вернуть объект бота. */
export async function createBot(i, log, existingUser = null) {
  const username = `${config.botPrefix}${String(i).padStart(2, '0')}`
  const persona = makePersona(i - 1)
  let user = existingUser
  if (!user) {
    const res = await gapi.v3.users.postUsers({
      username,
      password: config.botPassword,
      userGroupId: defaultUserGroupId,
      firstName: persona.name,
      lastName: 'Симуляция',
    })
    user = { id: res?.result?.id, username }
    log?.(`создан бот ${username} (id ${user.id})`)
  }
  return {
    userId: user.id, username,
    persona,
    hostId: null, sessionSince: null, plannedUntil: null, assets: new Set(),
  }
}

// Консоли (endpoint-хосты): на одну садятся несколько человек (maximumUsers).
// ВАЖНО (живьём): хост БЕЗ группы не пускает никого (loginResult 32).
async function seedConsoles(log) {
  const existing = data(await gapi.v3.hosts.getHosts({ paginationLimit: -1, isDeleted: false }))
  const groups = data(await gapi.v3.hostGroups.getHostGroups({ paginationLimit: -1 }))
  const epGroupId = (groups.find(g => /endpoint|консол/i.test(g.name ?? '')) ?? groups[0])?.id
  const CONSOLES = ['PS5 1', 'PS5 2']
  let maxNum = Math.max(0, ...existing.map(h => h.number ?? 0))
  for (const name of CONSOLES) {
    const have = existing.find(h => h.name === name)
    if (have) {
      // Ремонт: группа обязательна, иначе консоль никого не пускает.
      if (!have.hostGroupId) {
        await gapi.v3.hosts.putHosts({
          id: have.id, hostType: 1, hostGroupId: epGroupId, number: have.number, name,
          isOutOfOrder: false, isLocked: false, isDeleted: false,
          hostEndpoint: { maximumUsers: have.maximumUsers ?? 4 },
        }).catch(() => {})
      }
      continue
    }
    const res = await gapi.v3.hosts.postHosts({
      hostType: 1, hostGroupId: epGroupId, number: ++maxNum, name,
      hostEndpoint: { maximumUsers: 4 },
    }).catch(() => null)
    if (res?.result?.id) log(`создана консоль ${name} (id ${res.result.id}, мест: 4)`)
  }
}

export async function loadWorld(log) {
  // 1. Хосты (+ консоли-endpoints: сеются при первом запуске)
  await seedConsoles(log)
  const hostsRes = await gapi.v3.hosts.getHosts({ paginationLimit: -1, isDeleted: false, branchId: config.branchId })
  world.hosts = data(hostsRes).map(h => ({
    id: h.id, number: h.number, name: h.name,
    type: h.maximumUsers != null || /^ps|xbox|switch/i.test(h.name ?? '') ? 'endpoint' : 'pc',
    maxUsers: h.maximumUsers ?? 1,
  }))
  const cons = world.hosts.filter(h => h.type === 'endpoint')
  log(`хостов: ${world.hosts.length}${cons.length ? ` (консолей: ${cons.length})` : ''}`)

  // 2. Боты — создаём недостающих sim_bot_NN (в первой группе пользователей)
  const groupsRes = await gapi.v3.userGroups.getUserGroups({ paginationLimit: -1 })
  defaultUserGroupId = data(groupsRes)[0]?.id
  if (!defaultUserGroupId) throw new Error('на сервере нет ни одной группы пользователей')

  const usersRes = await gapi.v3.users.getUsers({ paginationLimit: -1 })
  const byUsername = new Map(data(usersRes).map(u => [u.username, u]))

  // Подхватываем и ботов с номерами выше config.players (зарегистрировались
  // в прошлых запусках) — взаимодействие идёт со всей «базой», не с одними и теми же.
  const botIndexes = new Set()
  for (let i = 1; i <= config.players; i++) botIndexes.add(i)
  for (const name of byUsername.keys()) {
    const m = name.match(new RegExp(`^${config.botPrefix}(\\d+)$`))
    if (m) botIndexes.add(Number(m[1]))
  }
  for (const i of [...botIndexes].sort((a, b) => a - b)) {
    world.bots.push(await createBot(i, log, byUsername.get(`${config.botPrefix}${String(i).padStart(2, '0')}`)))
  }
  world.nextBotIndex = Math.max(...botIndexes) + 1

  // Кто-то из ботов мог остаться сидеть с прошлого запуска — подхватываем
  // и назначаем план досидеть (иначе plannedUntil=null → мгновенный уход).
  const minsMs = (m) => (m * 60_000) / config.speed
  const sessRes = await gapi.v3.userSessions.getUserSessions({ paginationLimit: -1 })
  for (const s of data(sessRes)) {
    if (((s.state ?? 0) & 1) !== 1) continue
    const bot = world.bots.find(b => b.userId === s.userId)
    if (!bot) continue
    const [lo, hi] = bot.persona.session
    // «Не его день» — досиживает недолго и уходит.
    const left = isPresentToday(bot, new Date().toISOString().slice(0, 10))
      ? lo + Math.random() * (hi - lo)
      : 5 + Math.random() * 15
    bot.hostId = s.hostId
    bot.sessionSince = Date.now()
    bot.plannedUntil = Date.now() + minsMs(left)
  }

  // И ассеты на руках с прошлого запуска.
  const activeAssets = await gapi.v3.assetTransactions.getAssetTransactions({ isActive: true, paginationLimit: -1 })
  for (const t of data(activeAssets)) {
    const bot = world.bots.find(b => b.userId === t.userId)
    if (bot) bot.assets.add(t.assetId)
  }

  // 3. Товары — если бар-каталог тощий, сеем настоящий (группы + позиции)
  await seedBarCatalog(log)
  const productsRes = await gapi.v3.products.getProducts({ paginationLimit: -1, isDeleted: false })
  const products = data(productsRes).filter(p => !p.disallowClientOrder)
  world.barProducts = products.filter(p => !p.timeProduct && p.productType !== 1)
  world.timeProducts = products.filter(p => p.timeProduct || p.productType === 1)
  log(`товаров: бар ${world.barProducts.length}, время ${world.timeProducts.length}`)

  // 4. Ассеты
  const assetsRes = await gapi.v3.assets.getAssets({ paginationLimit: -1, branchId: config.branchId })
  const typesRes = await gapi.v3.assetTypes.getAssetTypes({ paginationLimit: -1 })
  const typeName = new Map(data(typesRes).map(t => [t.id, t.name]))
  world.assets = data(assetsRes).filter(a => a.isEnabled !== false)
    .map(a => ({ id: a.id, number: a.number, typeName: typeName.get(a.assetTypeId) ?? `Тип ${a.assetTypeId}` }))
  log(`ассетов: ${world.assets.length}`)

  // 5. Приложения (для AppStat) — сеем каталог, если пусто.
  // У приложения обязательна категория (FK) — берём «Games» или первую.
  const APPS = ['Counter-Strike 2', 'Dota 2', 'Fortnite', 'Valorant', 'World of Tanks', 'GTA V', 'Apex Legends']
  const appsRes = await gapi.v3.applications.getApplications({ paginationLimit: -1 })
  let apps = data(appsRes)
  if (!apps.length) {
    const catsRes = await gapi.v3.applicationCategories.getApplicationCategories({ paginationLimit: -1 }).catch(() => null)
    const cats = data(catsRes)
    const catId = (cats.find(c => /game/i.test(c.name ?? '')) ?? cats[0])?.id
    for (const title of APPS) {
      const res = await gapi.v3.applications.postApplications({ title, applicationCategoryId: catId }).catch(() => null)
      if (res?.result?.id) apps.push({ id: res.result.id, title })
    }
    log(`создано приложений: ${apps.length}`)
  }

  // AppStat.AppExeId — NOT NULL: каждому приложению нужен исполняемый файл.
  const exesRes = await gapi.v3.applicationExecutables.getApplicationExecutables({ paginationLimit: -1 }).catch(() => null)
  const exeByApp = new Map()
  for (const e of data(exesRes)) if (!exeByApp.has(e.applicationId)) exeByApp.set(e.applicationId, e.id)
  for (const a of apps) {
    if (exeByApp.has(a.id)) continue
    const res = await gapi.v3.applicationExecutables.postApplicationExecutables({
      applicationId: a.id,
      caption: `${a.title}.exe`,
      executablePath: `C:\\Games\\${(a.title ?? 'game').replace(/[^\w]+/g, '')}\\game.exe`,
      accessible: true,
    }).catch(() => null)
    if (res?.result?.id) exeByApp.set(a.id, res.result.id)
  }
  world.apps = apps
    .map(a => ({ id: a.id, title: a.title, exeId: exeByApp.get(a.id) }))
    .filter(a => a.exeId)
  log(`приложений с exe (для AppStat): ${world.apps.length}`)
}

// Настоящий бар-каталог: напитки, снеки, еда (по образу реального клуба).
async function seedBarCatalog(log) {
  const existing = data(await gapi.v3.products.getProducts({ paginationLimit: -1, isDeleted: false }))
  const barCount = existing.filter(p => !p.timeProduct && p.productType !== 1).length

  const CATALOG = [
    { group: 'Напитки', items: [
      ['Coca-Cola 0.5', 120, 12], ['Red Bull 0.25', 180, 18], ['Вода 0.5', 60, 6],
      ['Кофе американо', 140, 14], ['Чай чёрный', 90, 9],
    ]},
    { group: 'Снеки', items: [
      ['Чипсы Lays', 130, 13], ['Сникерс', 90, 9], ['Попкорн', 150, 15], ['M&Ms', 110, 11],
    ]},
    { group: 'Еда', items: [
      ['Пицца Пепперони', 450, 45], ['Лапша WOK', 320, 32], ['Хот-дог', 180, 18], ['Бургер', 280, 28],
    ]},
  ]

  const groupsRes = data(await gapi.v3.productGroups.getProductGroups({ paginationLimit: -1 }))
  const groupByName = new Map(groupsRes.map(g => [g.name, g.id]))
  const existingNames = new Set(existing.map(p => p.name))

  // ВАЖНО (выяснено живьём): товар, созданный через API, продаётся только после
  // трёх шагов: 1) разрешающие записи disallowedusergroups {isDisallowed:false}
  // (иначе UserGroupRestricted), 2) включение на бренчах postProductsByIdBranches
  // [{branchId, isEnabled:true}] (иначе BranchRestricted), 3) «touch» putProducts —
  // без него Gizmo держит старые ограничения в кэше и касса всё равно кидает 400.
  const userGroups = data(await gapi.v3.userGroups.getUserGroups({ paginationLimit: -1 }))
  async function makeSellable(productId) {
    const rows = data(await gapi.v3.products.getProductsByIdDisallowedusergroups(productId).catch(() => null))
    const covered = new Set(rows.map(r => r.userGroupId))
    for (const ug of userGroups) {
      if (covered.has(ug.id)) continue
      await gapi.v3.products.postProductsByIdDisallowedusergroups(productId, {
        userGroupId: ug.id, isDisallowed: false,
      }).catch(() => {})
    }
    const branches = data(await gapi.v3.products.getProductsByIdBranches(productId).catch(() => null))
    const toEnable = branches.filter(b => b.isEnabled !== true).map(b => ({ branchId: b.branchId, isEnabled: true }))
    if (toEnable.length) await gapi.v3.products.postProductsByIdBranches(productId, toEnable).catch(() => {})
    const p = model(await gapi.v3.products.getProductsById(productId).catch(() => null))
    if (p) await gapi.v3.products.putProducts({ ...p }).catch(() => {})
  }

  let created = 0
  if (barCount < 5) {
    for (const { group, items } of CATALOG) {
      let groupId = groupByName.get(group)
      if (!groupId) {
        const res = await gapi.v3.productGroups.postProductGroups({ name: group }).catch(() => null)
        groupId = res?.result?.id
        if (!groupId) continue
        groupByName.set(group, groupId)
      }
      for (const [name, price, points] of items) {
        if (existingNames.has(name)) continue
        const res = await gapi.v3.products.postProducts({
          productType: 0,
          productGroupId: groupId,
          name,
          price,
          points,           // баллы за покупку
          purchaseOptions: 0,
        }).catch(() => null)
        if (res?.result?.id) {
          await makeSellable(res.result.id)
          created++
        }
      }
    }
    if (created) log(`насеян бар-каталог: +${created} товаров (Напитки/Снеки/Еда)`)
  }

  // Ремонт ранее насеянных: одна idempotent-проходка (группы+бренчи+touch).
  let repaired = 0
  for (const p of existing) {
    if (p.timeProduct || p.productType === 1) continue
    const rows = data(await gapi.v3.products.getProductsByIdDisallowedusergroups(p.id).catch(() => null))
    const branches = data(await gapi.v3.products.getProductsByIdBranches(p.id).catch(() => null))
    const branchOk = branches.some(b => b.branchId === config.branchId && b.isEnabled === true)
    if (!rows.length || !branchOk) { await makeSellable(p.id); repaired++ }
  }
  if (repaired) log(`починены продажи (группы/бренчи) у ${repaired} товаров`)
}

// ── Снести мир и сгенерировать заново ────────────────────────────────────────
// Полностью удаляет ботов со стенда (hard delete — логины освобождаются),
// отменяет их брони, возвращает ассеты, поднимает worldGen (новые персоны и
// планировка комнат) и пересоздаёт мир с нуля.
export async function resetWorld(log, updateConfig) {
  log('♻ сношу мир: разлогиниваю и удаляю всех ботов…')
  // выйти из-за хостов и вернуть ассеты
  for (const b of [...world.bots]) {
    for (const assetId of [...b.assets]) await gapi.v3.users.putUsersAssetsByAssetIdCheckin(assetId).catch(() => {})
    await gapi.v3.users.postUsersByUserIdLogout(b.userId).catch(() => {})
  }
  // отменить активные брони ботов
  const botIds = new Set(world.bots.map(b => b.userId))
  const resv = data(await gapi.v3.reservations.getReservations({ paginationLimit: -1 }).catch(() => null))
  for (const r of resv) {
    if (r.status === 0 && botIds.has(r.userId)) await gapi.v3.reservations.putReservationsByIdCancel(r.id, {}).catch(() => {})
  }
  // hard delete всех sim_bot_* (в т.ч. оставшихся с прошлых поколений)
  const users = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }).catch(() => null))
  let deleted = 0
  for (const u of users) {
    if (!u.username?.startsWith(config.botPrefix)) continue
    const ok = await gapi.v3.users.deleteUsersByIdHard(u.id).catch(() => null)
    if (ok && !ok.isError) deleted++
  }
  log(`♻ удалено пользователей: ${deleted}`)
  // новое поколение: другие персоны и планировка комнат
  updateConfig?.({ worldGen: (config.worldGen ?? 1) + 1 })
  world.bots = []
  world.nextBotIndex = 1
  world.revenue = 0
  world.ordersQueue = []
  await loadWorld(log)
  log(`♻ мир пересоздан: поколение ${config.worldGen}, ботов ${world.bots.length}`)
}

export const freeBots = () => world.bots.filter(b => !b.hostId)
export const seatedBots = () => world.bots.filter(b => b.hostId)
// Хост свободен, пока есть места: у ПК одно, у консоли maximumUsers.
export const hostOccupancy = () => {
  const cnt = new Map()
  for (const b of world.bots) if (b.hostId) cnt.set(b.hostId, (cnt.get(b.hostId) ?? 0) + 1)
  return cnt
}
export const freeHosts = () => {
  const cnt = hostOccupancy()
  return world.hosts.filter(h => (cnt.get(h.id) ?? 0) < (h.maxUsers ?? 1))
}
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
