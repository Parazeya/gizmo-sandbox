// Smoke test over every Gizmo API the simulator relies on. Each test hits a
// real endpoint, checks the response shape and cleans up after itself: voids the
// invoice, cancels the reservation, logs out. One result looks like
// {group, name, ok: true|false|'skip', ms, detail}.
import { gapi, data, model } from './gizmo.js'
import { config } from './config.js'
import { sqlPing, sqlEnabled } from './sql.js'

const t = (group, name, fn) => ({ group, name, fn })

const TESTS = [
  // Reference data
  t('Справочники', 'hosts.getHosts', async () => {
    const rows = data(await gapi.v3.hosts.getHosts({ paginationLimit: -1, isDeleted: false }))
    if (!rows.length) throw new Error('пустой список хостов')
    if (rows[0].id == null || !rows[0].name) throw new Error('нет полей id/name')
    return `${rows.length} хостов, консолей: ${rows.filter(h => h.maximumUsers != null).length}`
  }),
  t('Справочники', 'userGroups.getUserGroups', async () => {
    const rows = data(await gapi.v3.userGroups.getUserGroups({ paginationLimit: -1 }))
    if (!rows.length) throw new Error('нет групп пользователей')
    return rows.map(g => g.name).join(', ')
  }),
  t('Справочники', 'users.getUsers', async () => {
    const rows = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }))
    const bots = rows.filter(u => u.username?.startsWith(config.botPrefix))
    if (!rows.length) throw new Error('нет пользователей')
    return `${rows.length} всего, ботов: ${bots.length}`
  }),
  t('Справочники', 'paymentMethods.getPaymentMethods', async () => {
    const rows = data(await gapi.v3.paymentMethods.getPaymentMethods({ paginationLimit: -1 }))
    if (!rows.find(p => p.id === -1)) throw new Error('нет метода Cash (-1)')
    return rows.map(p => `${p.id}:${p.name}`).join(' ')
  }),
  t('Справочники', 'products.getProducts', async () => {
    const rows = data(await gapi.v3.products.getProducts({ paginationLimit: -1, isDeleted: false }))
    const bar = rows.filter(p => !p.timeProduct && p.productType !== 1)
    const time = rows.filter(p => p.timeProduct || p.productType === 1)
    if (!bar.length || !time.length) throw new Error(`бар ${bar.length} / время ${time.length}`)
    return `бар ${bar.length}, время ${time.length}`
  }),
  t('Справочники', 'applications + executables', async () => {
    const apps = data(await gapi.v3.applications.getApplications({ paginationLimit: -1 }))
    const exes = data(await gapi.v3.applicationExecutables.getApplicationExecutables({ paginationLimit: -1 }))
    if (!apps.length) throw new Error('нет приложений')
    if (!exes.length) throw new Error('нет executables (AppStat не сможет писаться)')
    return `${apps.length} приложений, ${exes.length} exe`
  }),
  t('Справочники', 'assets.getAssets', async () => {
    const rows = data(await gapi.v3.assets.getAssets({ paginationLimit: -1, branchId: config.branchId }))
    return `${rows.length} ассетов`
  }),

  // Sessions
  t('Сессии', 'userSessions.getUserSessions', async () => {
    const rows = data(await gapi.v3.userSessions.getUserSessions({ paginationLimit: -1 }))
    const live = rows.filter(s => ((s.state ?? 0) & 1) === 1)
    return `${rows.length} записей, живых: ${live.length}`
  }),
  t('Сессии', 'login + logout (свободный слот)', async () => {
    const sess = data(await gapi.v3.userSessions.getUserSessions({ paginationLimit: -1 }))
    const live = sess.filter(s => ((s.state ?? 0) & 1) === 1)
    const busyHosts = new Set(live.map(s => s.hostId))
    const liveUsers = new Set(live.map(s => s.userId))
    const hosts = data(await gapi.v3.hosts.getHosts({ paginationLimit: -1, isDeleted: false }))
    const freeHost = hosts.find(h => !busyHosts.has(h.id) && h.maximumUsers == null)
    const users = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }))
    const freeBot = users.find(u => u.username?.startsWith(config.botPrefix) && !liveUsers.has(u.id))
    if (!freeHost || !freeBot) return { skip: 'нет свободного хоста/бота' }
    const r = await gapi.v3.users.postUsersByUserIdLoginByHostId(freeBot.id, freeHost.id)
    const code = r?.result?.loginResult
    if (code === 65536) return { skip: 'аншлаг: нет слотов лицензии' }
    if (code === 16384) return { skip: 'у тест-бота нет времени' }
    if (code !== 0) throw new Error(`loginResult=${code}`)
    await gapi.v3.users.postUsersByUserIdLogout(freeBot.id)
    return `${freeBot.username} → ${freeHost.name}: вход/выход ок`
  }),

  // Money
  t('Деньги', 'carts: депозит 1₽ (нал)', async () => {
    const users = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }))
    const bot = users.find(u => u.username?.startsWith(config.botPrefix))
    if (!bot) return { skip: 'нет ботов' }
    const cartId = (await gapi.v3.carts.postCarts({}))?.result?.id
    if (!cartId) throw new Error('корзина не создалась')
    await gapi.v3.carts.postCartsByIdEntriesUsersByUserIdDeposit(cartId, bot.id, { amount: 1 })
    await gapi.v3.carts.postCartsByIdPayments(cartId, { paymentMethodId: -1, amount: 1 })
    await gapi.v3.carts.postCartsByIdAccept(cartId, { invoice: true, autoComplete: true })
    return `депозит 1₽ боту ${bot.username} проведён`
  }),
  t('Деньги', 'продажа + invoice + VOID (самоочистка)', async () => {
    const users = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }))
    const bot = users.find(u => u.username?.startsWith(config.botPrefix))
    const products = data(await gapi.v3.products.getProducts({ paginationLimit: -1, isDeleted: false }))
    const prod = products.find(p => !p.timeProduct && p.productType !== 1 && Number(p.price) > 0)
    if (!bot || !prod) return { skip: 'нет бота/товара' }
    const cartId = (await gapi.v3.carts.postCarts({}))?.result?.id
    await gapi.v3.carts.postCartsByIdEntriesUsersByUserId(cartId, bot.id, { productId: prod.id, quantity: 1 })
    const st = model(await gapi.v3.carts.getCartsByIdState(cartId))
    await gapi.v3.carts.postCartsByIdPayments(cartId, { paymentMethodId: -1, amount: Number(st?.total ?? 0) })
    const acc = await gapi.v3.carts.postCartsByIdAccept(cartId, { invoice: true, autoComplete: true })
    const invoiceId = acc?.result?.orders?.[0]?.invoices?.[0]?.invoiceId
      ?? data(await gapi.v3.invoices.getInvoices({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false }))[0]?.id
    if (!invoiceId) throw new Error('invoice не найден после продажи')
    const v = await gapi.v3.invoices.putInvoicesByIdVoid(invoiceId, { refundPaymentMethodId: -1 })
    if (v?.isError) throw new Error('void не прошёл')
    return `«${prod.name}» продан и аннулирован (invoice #${invoiceId})`
  }),
  t('Деньги', 'registerTransactions: внесение/чтение', async () => {
    const r = await gapi.v3.registerTransactions.postRegisterTransactions({ type: 1, amount: 1, note: 'api-test' })
    const id = r?.result?.id
    if (!id) throw new Error('транзакция не создана (смена закрыта?)')
    const back = model(await gapi.v3.registerTransactions.getRegisterTransactionsById(id))
    if (Number(back?.amount) !== 1) throw new Error('прочитанная сумма не совпала')
    return `касса: транзакция #${id} записана в смену #${back.shiftId}`
  }),

  // Orders and reservations
  t('Заказы', 'productOrders.getProductOrdersActive', async () => {
    const rows = data(await gapi.v3.productOrders.getProductOrdersActive({ paginationLimit: -1 }))
    return `в очереди: ${rows.length}`
  }),
  t('Брони', 'создать + отменить бронь (самоочистка)', async () => {
    const users = data(await gapi.v3.users.getUsers({ paginationLimit: -1 }))
    const bot = users.find(u => u.username?.startsWith(config.botPrefix))
    const hosts = data(await gapi.v3.hosts.getHosts({ paginationLimit: -1, isDeleted: false }))
    const host = hosts.find(h => h.maximumUsers == null)
    if (!bot || !host) return { skip: 'нет бота/хоста' }
    const res = await gapi.v3.reservations.postReservations({
      date: new Date(Date.now() + 26 * 3600_000).toISOString(),
      duration: 60, branchId: config.branchId, userId: bot.id,
      hosts: [{ hostId: host.id, slot: 0 }], contactPhone: '79990000000', note: 'api-test',
    })
    const id = res?.result?.id
    if (!id) throw new Error('бронь не создалась')
    await gapi.v3.reservations.putReservationsByIdCancel(id, {})
    const back = model(await gapi.v3.reservations.getReservationsById(id))
    if (Number(back?.status) !== 1) throw new Error(`статус после отмены: ${back?.status} (ждали 1)`)
    return `бронь #${id} создана и отменена (статус 1)`
  }),

  // Shift and reports
  t('Смена', 'shifts: активная смена', async () => {
    const rows = data(await gapi.v3.shifts.getShifts({ isActive: true, paginationLimit: 1, paginationIsAsc: false }))
    if (!rows.length) throw new Error('нет активной смены — кассовые операции невозможны')
    return `смена #${rows[0].id}, оператор ${rows[0].operatorId}`
  }),
  t('Отчёты', 'reports.getReportsOverview', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const r = await gapi.v3.reports.getReportsOverview({ dateFrom: `${day} 00:00:00`, dateTo: `${day} 23:59:59` })
    if (!r?.result) throw new Error('пустой result')
    return `выручка за сегодня: ${r.result.totalRevenue ?? '—'}`
  }),
  t('Отчёты', 'reports.getReportsProducts', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const r = await gapi.v3.reports.getReportsProducts({ dateFrom: `${day} 00:00:00`, dateTo: `${day} 23:59:59`, hideUnused: true })
    const rows = r?.result?.products ?? []
    return `позиций в отчёте: ${rows.length}`
  }),
  t('Отчёты', 'reports.getReportsApplications', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const r = await gapi.v3.reports.getReportsApplications({ dateFrom: `${day} 00:00:00`, dateTo: `${day} 23:59:59` })
    const rows = r?.result?.applications ?? r?.result ?? []
    const top = (Array.isArray(rows) ? rows : []).filter(a => a.totalSeconds > 0)
    return `приложений с временем: ${top.length}`
  }),

  // SQL
  t('SQL', 'прямое подключение (AppStat)', async () => {
    if (!sqlEnabled()) return { skip: 'SQL выключен (нет пароля)' }
    const ok = await sqlPing()
    if (!ok) throw new Error('SELECT 1 не прошёл')
    return 'соединение и запрос ок'
  }),
]

let lastResults = null

export function getLastResults() { return lastResults }

export async function runApiTests() {
  const results = []
  for (const test of TESTS) {
    const started = Date.now()
    try {
      const out = await test.fn()
      if (out && typeof out === 'object' && out.skip) {
        results.push({ group: test.group, name: test.name, ok: 'skip', ms: Date.now() - started, detail: out.skip })
      } else {
        results.push({ group: test.group, name: test.name, ok: true, ms: Date.now() - started, detail: String(out ?? 'ок') })
      }
    } catch (err) {
      results.push({
        group: test.group, name: test.name, ok: false, ms: Date.now() - started,
        detail: err?.response?.data?.message ?? err?.message ?? String(err),
      })
    }
  }
  lastResults = { at: Date.now(), results }
  return lastResults
}
