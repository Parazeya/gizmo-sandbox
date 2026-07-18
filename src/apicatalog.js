// Полный скан Gizmo V3 API для проверки стабильности между версиями Gizmo.
//
// Каталог эндпоинтов берётся из ЖИВОГО OpenAPI-документа самого сервера
// (GET /openapi/v3.json — тот же «Download OpenAPI Document» из Scalar-доки),
// поэтому всегда соответствует установленной версии. Фолбэк — парсинг SDK.
//
// Прогон безопасный: GET-эндпоинты вызываются реально (by-id — с подстановкой
// живых id со стенда), мутации (POST/PUT/DELETE) только каталогизируются —
// их покрывают сценарные тесты. Отчёт сохраняется в apitest-reports/*.json;
// diff двух отчётов показывает added / removed / changed эндпоинты.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gapi, data } from './gizmo.js'
import { config } from './config.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SDK_V3 = path.join(ROOT, '..', 'node_modules', 'gizmovsky', 'src', 'v3')
const REPORTS_DIR = path.join(ROOT, '..', 'apitest-reports')

// ── Каталог из OpenAPI-документа сервера ────────────────────────────────────
export async function loadOpenApiSpec() {
  const auth = Buffer.from(`${config.gizmo.username}:${config.gizmo.password}`).toString('base64')
  const url = `http://${config.gizmo.ip}:${config.gizmo.port}/openapi/v3.json`
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } })
  if (!res.ok) throw new Error(`openapi/v3.json → HTTP ${res.status}`)
  return res.json()
}

function catalogFromSpec(spec) {
  const endpoints = []
  for (const [p, verbs] of Object.entries(spec.paths ?? {})) {
    for (const [verb, op] of Object.entries(verbs)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(verb)) continue
      const params = op.parameters ?? []
      endpoints.push({
        module: op.tags?.[0] ?? p.split('/')[3] ?? '?',
        method: op.operationId ?? `${verb} ${p}`,
        verb: verb.toUpperCase(),
        path: p,
        pathParams: [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
        requiredQuery: params.filter((x) => x.in === 'query' && x.required).map((x) => x.name),
        allQuery: params.filter((x) => x.in === 'query').map((x) => x.name),
        userScope: p.startsWith('/api/user/'),
      })
    }
  }
  return endpoints
}

// Фолбэк: каталог из исходников SDK (если openapi недоступен).
// Исходники входят в npm-пакет gizmovsky (files: src); если их всё же нет —
// возвращаем пусто, скан честно скажет «каталог недоступен».
function catalogFromSdk() {
  const endpoints = []
  if (!existsSync(SDK_V3)) return endpoints
  for (const file of readdirSync(SDK_V3).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
    const src = readFileSync(path.join(SDK_V3, file), 'utf8')
    let method = null
    for (const line of src.split('\n')) {
      const mSig = line.match(/^\s{2}(\w+)\(/)
      if (mSig) method = mSig[1]
      const mUrl = line.match(/const url = `([^`]+)`/)
      if (mUrl && method) { endpoints.push({ module: file.replace('.ts', ''), method, path: mUrl[1].replace(/\$\{(\w+)\}/g, '{$1}'), verb: null, pathParams: [...mUrl[1].matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]), requiredQuery: [], userScope: false }); continue }
      const mReq = line.match(/client\.request\('(\w+)'/)
      if (mReq && endpoints.length && endpoints[endpoints.length - 1].verb === null) endpoints[endpoints.length - 1].verb = mReq[1].toUpperCase()
    }
  }
  return endpoints.filter((e) => e.verb)
}

// ── Живые id со стенда для подстановки path-параметров ──────────────────────
async function collectSamples() {
  const s = {}
  const safe = async (fn) => { try { return await fn() } catch { return null } }
  const first = (r) => data(r)[0]?.id
  s.hostId = await safe(async () => first(await gapi.v3.hosts.getHosts({ paginationLimit: 1 })))
  s.userId = await safe(async () => first(await gapi.v3.users.getUsers({ paginationLimit: 1 })))
  // Продукты — по ТИПАМ: обычный / пакет времени (1) / бандл (2). Эндпоинты вида
  // /products/time/{id}/... принимают ТОЛЬКО продукт своего типа — иначе not found.
  await safe(async () => {
    const prods = data(await gapi.v3.products.getProducts({ paginationLimit: 100 }))
    s.productId = prods[0]?.id ?? null
    s.timeProductId = prods.find((p) => p.productType === 1)?.id ?? null
    s.bundleProductId = prods.find((p) => p.productType === 2)?.id ?? null
    // товар с ВКЛЮЧЁННЫМ остатком — только такой валиден для /productstocks/*
    s.stockProductId = prods.find((p) => p.enableStock)?.id ?? null
  })
  s.stockId = await safe(async () => first(await gapi.v3.stocks.getStocks({ paginationLimit: 1 })))
  s.applicationGroupId = await safe(async () => first(await gapi.v3.applicationGroups.getApplicationGroups({ paginationLimit: 1 })))
  s.feedId = await safe(async () => first(await gapi.v3.feeds.getFeeds({ paginationLimit: 1 })))
  s.newsId = await safe(async () => first(await gapi.v3.news.getNews({ paginationLimit: 1 })))
  // заметки пользователей: перебираем первых пользователей, пока не найдём заметку
  s.userNoteUserId = null; s.userNoteId = null
  await safe(async () => {
    const users = data(await gapi.v3.users.getUsers({ paginationLimit: 15 }))
    for (const u of users) {
      const notes = data(await gapi.v3.users.getUsersByIdNotes(u.id, { paginationLimit: 1 }))
      if (notes[0]?.id != null) { s.userNoteUserId = u.id; s.userNoteId = notes[0].id; break }
    }
  })
  s.userGroupId = await safe(async () => first(await gapi.v3.userGroups.getUserGroups({ paginationLimit: 1 })))
  s.hostGroupId = await safe(async () => first(await gapi.v3.hostGroups.getHostGroups({ paginationLimit: 1 })))
  s.applicationId = await safe(async () => first(await gapi.v3.applications.getApplications({ paginationLimit: 1 })))
  s.assetId = await safe(async () => first(await gapi.v3.assets.getAssets({ paginationLimit: 1 })))
  s.assetTypeId = await safe(async () => first(await gapi.v3.assetTypes.getAssetTypes({ paginationLimit: 1 })))
  s.invoiceId = await safe(async () => first(await gapi.v3.invoices.getInvoices({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false })))
  s.paymentId = await safe(async () => first(await gapi.v3.payments.getPayments({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false })))
  s.shiftId = await safe(async () => first(await gapi.v3.shifts.getShifts({ paginationLimit: 1, paginationIsAsc: false })))
  s.reservationId = await safe(async () => first(await gapi.v3.reservations.getReservations({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false })))
  s.productGroupId = await safe(async () => first(await gapi.v3.productGroups.getProductGroups({ paginationLimit: 1 })))
  s.orderId = await safe(async () => data(await gapi.v3.productOrders.getProductOrders({ paginationLimit: 1, paginationSortBy: 'Id', paginationIsAsc: false }))[0]?.orderId)
  s.registerId = await safe(async () => first(await gapi.v3.registers.getRegisters({ paginationLimit: 1 })))
  s.operatorId = await safe(async () => first(await gapi.v3.operators.getOperators({ paginationLimit: 1 })))
  s.branchId = config.branchId
  // живые токены оператора — для auth/accesstoken/refresh (Token+RefreshToken)
  await safe(async () => {
    const r = await gapi.v3.hosts.client.request('get', '/api/v3/auth/accesstoken', {},
      { Username: config.gizmo.username, Password: config.gizmo.password })
    s.token = r?.result?.token ?? null
    s.refreshToken = r?.result?.refreshToken ?? null
  })
  return s
}

// ── Фикстуры: недостающие сущности СОЗДАЁМ — это и есть тест функционала
// «создать → прочитать». Всё именуется api_scan_* и переиспользуется на
// следующих сканах (collectSamples найдёт их по типу). Исключение — хосты:
// им нужен ЖИВОЙ Gizmo-клиент, их не сэмулировать.
async function ensureFixtures(samples) {
  const created = []
  const safe = async (fn) => { try { return await fn() } catch { return null } }
  const idOf = (r) => r?.result?.id ?? (typeof r?.result === 'number' ? r.result : null)

  const needProduct = samples.stockProductId == null || samples.bundleProductId == null
  if (needProduct && samples.productGroupId == null) {
    const r = await safe(() => gapi.v3.productGroups.postProductGroups({ name: 'api_scan_group' }))
    if (idOf(r)) { samples.productGroupId = idOf(r); created.push('группа товаров') }
  }
  if (samples.stockProductId == null && samples.productGroupId != null) {
    const r = await safe(() => gapi.v3.products.postProducts({
      productType: 0, productGroupId: samples.productGroupId, name: 'api_scan_stock',
      price: 1, purchaseOptions: 0, enableStock: true, disallowClientOrder: true,
    }))
    if (idOf(r)) { samples.stockProductId = idOf(r); created.push('товар с остатком') }
  }
  if (samples.bundleProductId == null && samples.productGroupId != null) {
    const r = await safe(() => gapi.v3.products.postProducts({
      // disallowClientOrder — чтобы боты не заказали тест-товар (иначе $0-заказ виснет)
      productType: 2, productGroupId: samples.productGroupId, name: 'api_scan_bundle',
      price: 1, purchaseOptions: 0, bundle: {}, disallowClientOrder: true,
    }))
    if (idOf(r)) { samples.bundleProductId = idOf(r); created.push('bundle-продукт') }
  }
  // внутри бандла должен лежать хотя бы один товар — иначе userprices «not found»
  if (samples.bundleProductId != null && samples.productId != null) {
    const rows = await safe(async () => data(await gapi.v3.products.getProductsBundleByIdBundledproducts(samples.bundleProductId)))
    samples.bundledProductId = rows?.[0]?.id ?? null
    if (samples.bundledProductId == null) {
      const r = await safe(() => gapi.v3.products.postProductsBundleByIdBundledproducts(samples.bundleProductId, {
        productId: samples.productId, quantity: 1,
      }))
      if (idOf(r)) { samples.bundledProductId = idOf(r); created.push('товар внутри бандла') }
    }
  }
  if (samples.feedId == null) {
    const r = await safe(() => gapi.v3.feeds.postFeeds({ title: 'api_scan_feed', url: 'https://example.com/rss.xml', maximum: 5 }))
    if (idOf(r)) { samples.feedId = idOf(r); created.push('фид') }
  }
  if (samples.newsId == null) {
    const r = await safe(() => gapi.v3.news.postNews({ title: 'api_scan_news', data: 'создано сканером API для проверки эндпоинтов' }))
    if (idOf(r)) { samples.newsId = idOf(r); created.push('новость') }
  }
  if (samples.userNoteId == null && samples.userId != null) {
    const r = await safe(() => gapi.v3.users.postUsersByIdNotes(samples.userId, { text: 'api_scan_note', severity: 0 }))
    if (idOf(r)) { samples.userNoteUserId = samples.userId; samples.userNoteId = idOf(r); created.push('заметка пользователя') }
  }
  if (samples.reservationId == null && samples.userId != null && samples.hostId != null) {
    const date = new Date(Date.now() + 86400000); date.setHours(12, 0, 0, 0)
    const r = await safe(() => gapi.v3.reservations.postReservations({
      date: date.toISOString(), duration: 60, branchId: config.branchId,
      userId: samples.userId, hosts: [{ hostId: samples.hostId, slot: 0 }],
      contactPhone: '79990000000', note: 'api_scan_reservation',
    }))
    if (idOf(r)) { samples.reservationId = idOf(r); created.push('бронирование') }
  }
  return created
}

// ── Хосты для host-зависимых API (hostcomputers/*): подключён ли Gizmo-клиент ──
// Списочного /hostcomputers нет (404) — единственный способ узнать «онлайн ли
// хост» это дёрнуть лёгкий passthrough-запрос и посмотреть, ответит ли клиент.
export async function listScanHosts(probe = false) {
  const hosts = data(await gapi.v3.hosts.getHosts({ paginationLimit: 100 }))
  const out = hosts.filter((h) => !h.isDeleted).map((h) => ({ id: h.id, name: h.name, connected: null }))
  if (probe) {
    const client = gapi.v3.hosts.client
    const one = async (h) => {
      try {
        await Promise.race([
          client.request('get', `/api/v3/hostcomputers/${h.id}/cpu/usage`),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ])
        h.connected = true
      } catch { h.connected = false }
    }
    let i = 0
    const worker = async () => { while (i < out.length) await one(out[i++]) }
    await Promise.all(Array.from({ length: 8 }, worker))
  }
  return out
}

// Каким сэмплом заполнять {id} в зависимости от модуля/пути
const MODULE_ID = {
  Hosts: 'hostId', Users: 'userId', Products: 'productId', UserGroups: 'userGroupId',
  HostGroups: 'hostGroupId', Applications: 'applicationId', Assets: 'assetId',
  AssetTypes: 'assetTypeId', Invoices: 'invoiceId', Payments: 'paymentId',
  Shifts: 'shiftId', Registers: 'registerId', Reservations: 'reservationId',
  ProductOrders: 'orderId', ProductGroups: 'productGroupId', Operators: 'operatorId',
  Branches: 'branchId',
}
// Типизированные {id}: срабатывают ТОЛЬКО когда {id} стоит сразу после сегмента
// (products/time/{id} — да; applicationgroups/applications/{id} — это id приложения).
// Если нужной сущности на сервере нет — НЕ подставляем «что попало», а честно
// говорим «создайте её» (без фолбэка: чужой id даст ложный not found).
const PATH_PRIME = [
  [/products\/bundle\/\{/i, 'bundleProductId', 'bundle-продукт'],
  [/products\/time\/\{/i, 'timeProductId', 'продукт «пакет времени»'],
  [/applicationgroups\/\{/i, 'applicationGroupId', 'группа приложений'],
  [/feeds\/\{/i, 'feedId', 'фид'],
  [/news\/\{/i, 'newsId', 'новость'],
]
const PATH_HINTS = [
  [/usergroups/i, 'userGroupId'], [/hostgroups/i, 'hostGroupId'],
  [/users/i, 'userId'], [/productgroups/i, 'productGroupId'], [/productorders/i, 'orderId'],
  [/products/i, 'productId'], [/applicationgroups/i, 'applicationGroupId'],
  [/applications/i, 'applicationId'], [/assettypes/i, 'assetTypeId'],
  [/assets/i, 'assetId'], [/invoices/i, 'invoiceId'], [/payments/i, 'paymentId'],
  [/shifts/i, 'shiftId'], [/registers/i, 'registerId'], [/reservations/i, 'reservationId'],
  [/operators/i, 'operatorId'], [/branch/i, 'branchId'], [/hosts/i, 'hostId'],
  [/feeds/i, 'feedId'], [/news/i, 'newsId'],
]

// → {url} либо {missing: 'чего не хватает'}
function substitutePath(ep, samples) {
  // заметка привязана к КОНКРЕТНОМУ пользователю: подставляем согласованную пару
  if (/users\/\{id\}\/notes\/\{userNoteId\}/i.test(ep.path)) {
    if (samples.userNoteId == null) return { missing: 'заметка пользователя (добавьте любому пользователю заметку)' }
    return { url: ep.path.replace('{id}', String(samples.userNoteUserId)).replace('{userNoteId}', String(samples.userNoteId)) }
  }
  let p = ep.path
  for (const name of ep.pathParams) {
    // /productstocks/* принимает только товар с включённым остатком (enableStock)
    if (name === 'productId' && /^\/api\/v3\/productstocks\//i.test(ep.path)) {
      if (samples.stockProductId == null) return { missing: 'товар с включённым остатком (галка enableStock)' }
      p = p.replace('{productId}', String(samples.stockProductId))
      continue
    }
    let val = samples[name]
    if (val == null && name === 'id') {
      const prime = PATH_PRIME.find(([re]) => re.test(ep.path))
      if (prime) {
        val = samples[prime[1]]
        if (val == null) return { missing: prime[2] }
      } else {
        // сегмент прямо перед {id} — самый надёжный признак типа сущности:
        // applicationgroups/applications/{id} — это id ПРИЛОЖЕНИЯ, не группы
        const seg = ep.path.match(/([a-z]+)\/\{id\}/i)?.[1]
        if (seg) { const h = PATH_HINTS.find(([re]) => re.test(seg)); if (h) val = samples[h[1]] }
        if (val == null) val = samples[MODULE_ID[ep.module]]
        if (val == null) { const hint = PATH_HINTS.find(([re]) => re.test(ep.path)); val = hint ? samples[hint[1]] : null }
      }
    } else if (val == null) {
      const hint = PATH_HINTS.find(([re]) => re.test(ep.path))
      val = hint ? samples[hint[1]] : null
    }
    if (val == null) return { missing: `{${name}}` }
    p = p.replace(`{${name}}`, String(val))
  }
  return { url: p }
}

const shapeOf = (body) => {
  const r = body?.result ?? body
  if (Array.isArray(r)) return ['[array]']
  if (r && typeof r === 'object') return Object.keys(r).sort().slice(0, 20)
  return [typeof r]
}

async function gizmoVersion(spec) {
  // точный билд (3.0.81) — из /system/version; info.version спеки даёт лишь «v3.0»
  try {
    const r = await gapi.v3.hosts.client.request('get', '/api/v3/system/version')
    if (r?.result) return String(r.result)
  } catch { /* старые сборки */ }
  return spec?.info?.version ?? 'unknown'
}

// ── Диф самих OpenAPI-доков между версиями Gizmo ────────────────────────────
// Спека каждой версии сохраняется рядом с отчётами (spec_<версия>.json);
// diffSpecs находит добавленные/удалённые/изменённые эндпоинты С ДЕТАЛЯМИ:
// параметры (и их обязательность), поля тела запроса и ответа 200.
const specFileFor = (ver) => `spec_${String(ver).replace(/[^\w.]/g, '_')}.json`

function derefSchema(spec, schema) {
  let s = schema
  for (let i = 0; i < 6 && s && (s.$ref || s.allOf); i++) {
    if (s.$ref) s = spec?.components?.schemas?.[s.$ref.split('/').pop()]
    else s = s.allOf[0]
  }
  return s ?? {}
}
function schemaKeys(spec, schema, depth = 0) {
  const s = derefSchema(spec, schema)
  if (depth < 3 && (s.type === 'array' || s.items)) return schemaKeys(spec, s.items, depth + 1).map((k) => '[]' + k)
  return Object.keys(s.properties ?? {}).map((k) => '.' + k)
}
function opSummary(spec, op) {
  return {
    params: (op.parameters ?? []).map((x) => `${x.name}${x.required ? '*' : ''}`),
    body: schemaKeys(spec, op.requestBody?.content?.['application/json']?.schema),
    resp: schemaKeys(spec, op.responses?.['200']?.content?.['application/json']?.schema),
  }
}
function flattenSpec(spec) {
  const map = new Map()
  for (const [p, verbs] of Object.entries(spec?.paths ?? {}))
    for (const [verb, op] of Object.entries(verbs))
      if (['get', 'post', 'put', 'delete', 'patch'].includes(verb)) map.set(`${verb.toUpperCase()} ${p}`, op)
  return map
}
function diffSpecObjects(sa, sb, labelA, labelB) {
  const ma = flattenSpec(sa), mb = flattenSpec(sb)
  const added = [], removed = [], changed = []
  for (const [key, op] of mb) if (!ma.has(key)) added.push({ key, ...opSummary(sb, op) })
  for (const [key, op] of ma) if (!mb.has(key)) removed.push({ key, ...opSummary(sa, op) })
  const cmp = (la, lb, label, details) => {
    for (const x of lb) if (!la.includes(x)) details.push(`+ ${label}: ${x}`)
    for (const x of la) if (!lb.includes(x)) details.push(`− ${label}: ${x}`)
  }
  for (const [key, opA] of ma) {
    const opB = mb.get(key)
    if (!opB) continue
    const a = opSummary(sa, opA), b = opSummary(sb, opB)
    const details = []
    cmp(a.params, b.params, 'параметр', details)
    cmp(a.body, b.body, 'поле тела запроса', details)
    cmp(a.resp, b.resp, 'поле ответа', details)
    if (details.length) changed.push({ key, details })
  }
  return { a: labelA, b: labelB, added, removed, changed }
}

export function diffSpecs(verA, verB) {
  const fa = path.join(REPORTS_DIR, specFileFor(verA)), fb = path.join(REPORTS_DIR, specFileFor(verB))
  if (!existsSync(fa) || !existsSync(fb)) return null
  return diffSpecObjects(JSON.parse(readFileSync(fa, 'utf8')), JSON.parse(readFileSync(fb, 'utf8')), String(verA), String(verB))
}

// ── Ручное сравнение доков: сохранённые spec_*.json и «текущая версия» с сервера ──
export function listSpecs() {
  if (!existsSync(REPORTS_DIR)) return []
  return readdirSync(REPORTS_DIR).filter((f) => f.startsWith('spec_') && f.endsWith('.json')).sort().map((file) => {
    try {
      const s = JSON.parse(readFileSync(path.join(REPORTS_DIR, file), 'utf8'))
      return { file, version: s.info?.version ?? '?', endpoints: Object.keys(s.paths ?? {}).length }
    } catch { return { file, broken: true } }
  })
}

export async function diffSpecFiles(a, b) {
  const load = async (x) => {
    if (x === 'current') {
      const spec = await loadOpenApiSpec()
      return { spec, label: `текущая с сервера (${await gizmoVersion(spec)})` }
    }
    const file = path.basename(String(x))
    return { spec: JSON.parse(readFileSync(path.join(REPORTS_DIR, file), 'utf8')), label: file }
  }
  const A = await load(a), B = await load(b)
  return diffSpecObjects(A.spec, B.spec, A.label, B.label)
}

// ── Скан МУТАЦИЙ: create → update → delete ТОЛЬКО над своими сущностями ─────
// Тело POST генерируется из requestBody-схемы OpenAPI; созданная запись
// обновляется PUT'ом и удаляется. Чужие данные не трогаются. Системные модули
// (кассы, смены, платежи, сессии...) в блок-листе — их покрывают сценарные тесты.
const MUT_BLOCK = new Set([
  'Shifts', 'ShiftCounts', 'Registers', 'RegisterTransactions', 'Payments', 'InvoicePayments', 'Invoices',
  'DepositTransactions', 'DepositPayments', 'PointsTransactions', 'StockTransactions', 'AssetTransactions',
  'Sessions', 'UserSessions', 'Auth', 'Tokens', 'System', 'Options', 'PublicOptions', 'RemoteControl',
  'HostComputers', 'Verifications', 'VerificationComplete', 'Fiscalizations', 'Integrations', 'PaymentIntents',
  'Carts', 'ProductOrders', 'Logs', 'Reports', 'ReportPresets', 'ReportModules', 'Instance', 'PluginLibrary',
  'Mappings', 'Branches', 'ClientTasks', 'Tasks', 'Schedules', 'Notifications', 'Events', 'EventStream',
  'Operators', 'Users', 'Hosts', 'Files', 'FileImages', 'Registrations', 'Recoveries', 'Inventories', 'StockCounts',
])

function mutValue(name, prop, spec, samples, uniq, depth) {
  const t = Array.isArray(prop?.type) ? prop.type.find((x) => x !== 'null') : prop?.type
  if (prop?.enum) return prop.enum[0]
  if (prop?.$ref || t === 'object' || prop?.properties) return mutBody(spec, prop, samples, uniq, depth + 1)
  if (t === 'array') return []
  if (/name|title/i.test(name)) return uniq
  if (/id$/i.test(name)) { const k = name.charAt(0).toLowerCase() + name.slice(1); return samples[k] ?? 1 }
  if (/date|time/i.test(name)) return new Date().toISOString()
  if (/email/i.test(name)) return `${uniq}@example.com`
  if (/phone|mobile/i.test(name)) return '+79001234567'
  if (/password/i.test(name)) return 'Api_mut_123!'
  if (/url/i.test(name)) return 'https://example.com/x'
  // enum-подобные поля (типы/статусы/режимы) — 0; «value» уникальнее (пресеты
  // требуют unique value); остальные числа положительные (валидаторы «must be at least 1»)
  if (t === 'integer' || t === 'number') {
    if (/type$|status$|mode$|kind$|source$|direction$|options?$/i.test(name)) return 0
    if (/value$/i.test(name)) return 7
    return 1
  }
  if (t === 'boolean') return false
  return 'api_mut'
}
// Сложное поле: любой намёк на объект/ссылку/композицию (в спеке Gizmo часто
// без явного type). Для *id-правила важно НЕ путать Uid/Guid со строками.
const isComplexProp = (prop) => !!(prop?.$ref || prop?.allOf || prop?.oneOf || prop?.anyOf || prop?.properties ||
  prop?.type === 'object' || (Array.isArray(prop?.type) && prop.type.includes('object')) ||
  (prop?.type == null && prop?.enum == null && prop?.format == null))

function mutBody(spec, schema, samples, uniq, depth = 0) {
  const s = derefSchema(spec, schema)
  if (depth > 3 || !s.properties) return {}
  const out = {}
  const required = s.required ?? []
  for (const [k, prop] of Object.entries(s.properties)) {
    if (prop.readOnly) continue
    const t = Array.isArray(prop.type) ? prop.type.find((x) => x !== 'null') : prop.type
    // необязательные сложные поля не шлём (меньше шансов споткнуться о вложенную валидацию)
    if ((isComplexProp(prop) || t === 'array') && !required.includes(k)) { if (t === 'array') out[k] = []; continue }
    out[k] = mutValue(k, prop, spec, samples, uniq, depth)
  }
  return out
}

// Правка тела по validation-ошибкам сервера: он сам говорит, что не так —
// «could not be converted to X» (не тот тип / лишняя модель) или «required».
function mutFixFromErrors(body, errors, spec, samples, uniq) {
  let changed = false
  for (const e of errors ?? []) {
    const pn = String(e?.Error?.PropertyName ?? '').replace(/^\$\.?/, '')
    if (!pn) continue
    const msg = (e?.Error?.Messages ?? []).join(' ')
    // навигация по вложенному пути (model.signalGuid → body.model.signalGuid)
    const segs = pn.split('.').map((s) => s.split('[')[0]).filter(Boolean)
    let tgt = body
    for (let i = 0; i < segs.length - 1; i++) {
      if (typeof tgt[segs[i]] !== 'object' || tgt[segs[i]] == null) tgt[segs[i]] = {}
      tgt = tgt[segs[i]]
    }
    const leaf = segs[segs.length - 1]
    // «поле model обязательно» — Gizmo местами хочет обёртку {model:{...}}
    if (leaf === 'model' && /required/i.test(msg) && !('model' in body)) {
      body.model = { ...body }; changed = true; continue
    }
    if (/could not be converted to/i.test(msg)) {
      if (/Guid/i.test(msg)) { tgt[leaf] = '00000000-0000-0000-0000-000000000001'; changed = true }
      else if (/Byte\[\]/.test(msg)) { tgt[leaf] = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='; changed = true }
      else if (/System\.String/.test(msg)) { tgt[leaf] = 'api_mut'; changed = true }
      else if (/Int|Decimal|Double|Number/i.test(msg)) { tgt[leaf] = 1; changed = true }
      else if (/Boolean/i.test(msg)) { tgt[leaf] = false; changed = true }
      else { delete tgt[leaf]; changed = true }   // сложная модель — просто не шлём поле
    } else if (!(leaf in tgt)) { tgt[leaf] = mutValue(leaf, {}, spec, samples, uniq, 0); changed = true }
    else if (tgt[leaf] == null || tgt[leaf] === '') { tgt[leaf] = mutValue(leaf, {}, spec, samples, uniq, 0); changed = true }
  }
  return changed
}

export async function runMutationScan() {
  const spec = await loadOpenApiSpec()   // без OpenAPI мутации не сканируем
  const samples = await collectSamples()
  await ensureFixtures(samples)
  const flat = flattenSpec(spec)
  const catalog = catalogFromSpec(spec).filter((e) => !e.userScope)
  const client = gapi.v3.hosts.client
  const results = []

  const call = async (verb, url, body) => {
    const req = { verb, url: `${client.baseURL}${url}`, query: {}, headers: {
      Authorization: `Basic base64(${config.gizmo.username}:•••)`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body, null, 1) : null }
    const started = Date.now()
    try {
      const resp = await Promise.race([
        client.axios({ method: verb.toLowerCase(), url, data: body ?? {} }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 10000ms')), 10000)),
      ])
      return { status: 'ok', httpCode: resp.status, ms: Date.now() - started, detail: '', req,
        res: { code: resp.status, headers: pickHeaders(resp.headers), body: truncBody(resp.data) },
        _data: resp.data }
    } catch (err) {
      const code = err?.response?.status ?? null
      const msg = (err?.response?.data?.message ?? err.message ?? '').slice(0, 200)
      const status = DEP_RE.test(msg) ? 'dep' : code === 401 || code === 403 ? 'auth' : code && code < 500 ? 'http-4xx' : 'fail'
      return { status, httpCode: code, ms: Date.now() - started, detail: msg, req,
        res: err?.response ? { code, headers: pickHeaders(err.response.headers), body: truncBody(err.response.data) }
          : { code: null, headers: {}, body: String(err.message ?? err) },
        _errors: err?.response?.data?.errors }
    }
  }

  // модули с парой POST(создать) + DELETE(по id) — жизненный цикл на своих данных
  const modules = new Map()
  for (const e of catalog) { if (!modules.has(e.module)) modules.set(e.module, []); modules.get(e.module).push(e) }
  const jobs = []
  for (const [module, eps] of modules) {
    if (MUT_BLOCK.has(module)) continue
    const create = eps.find((e) => e.verb === 'POST' && e.pathParams.length === 0 &&
      !/(exists|search|import|export|move|copy|pack)/i.test(e.path))
    if (!create) continue
    const del = eps.find((e) => e.verb === 'DELETE' && e.pathParams.length === 1 &&
      e.path.startsWith(create.path + '/{'))
    if (!del) continue
    const update = eps.find((e) => e.verb === 'PUT' && e.path === create.path && e.pathParams.length === 0)
    jobs.push({ module, create, del, update })
  }

  let ji = 0
  const worker = async () => {
    while (ji < jobs.length) {
      const { module, create, del, update } = jobs[ji++]
      const uniq = 'api_mut_' + Math.random().toString(36).slice(2, 7)
      const schema = flat.get(`POST ${create.path}`)?.requestBody?.content?.['application/json']?.schema
      let body = mutBody(spec, schema, samples, uniq)
      let r1 = await call('POST', create.path, body)
      // до 6 правок тела по подсказкам сервера из validation-ответа
      for (let att = 0; att < 6 && r1.status === 'http-4xx' && r1.httpCode === 400 && Array.isArray(r1._errors); att++) {
        if (!mutFixFromErrors(body, r1._errors, spec, samples, uniq)) break
        r1 = await call('POST', create.path, body)
      }
      const id = r1._data?.result?.id ?? (typeof r1._data?.result === 'number' ? r1._data.result : null)
      results.push({ module, step: 'create', verb: 'POST', path: create.path, ...r1, _data: undefined, _errors: undefined })
      if (id != null) {
        if (update) {
          const r2 = await call('PUT', update.path, { ...body, id })
          results.push({ module, step: 'update', verb: 'PUT', path: update.path, ...r2, _data: undefined, _errors: undefined })
        }
        const delUrl = del.path.replace(/\{\w+\}/, String(id))
        const r3 = await call('DELETE', delUrl, null)
        if (r3.status !== 'ok') r3.detail = `⚠ созданная запись ${uniq} (#${id}) НЕ удалилась: ` + r3.detail
        results.push({ module, step: 'delete', verb: 'DELETE', path: del.path, ...r3, _data: undefined, _errors: undefined })
      } else {
        results.push({ module, step: 'delete', verb: 'DELETE', path: del.path, status: 'skip', httpCode: null,
          ms: 0, detail: 'создание не удалось — update/delete пропущены', req: null, res: null })
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))

  const count = (st) => results.filter((r) => r.status === st).length
  const report = {
    at: Date.now(), gizmoVersion: await gizmoVersion(spec), kind: 'mutations',
    modules: jobs.length, total: results.length,
    ok: count('ok'), fail: count('fail'), http4xx: count('http-4xx'), dep: count('dep'),
    auth: count('auth'), skipped: count('skip'),
    results,
  }
  mkdirSync(REPORTS_DIR, { recursive: true })
  const fname = `mut_${String(report.gizmoVersion).replace(/[^\w.]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  writeFileSync(path.join(REPORTS_DIR, fname), JSON.stringify(report, null, 1))
  report.file = fname
  return report
}

/** Удаление отчётов/доков: file — имя в apitest-reports (без путей). */
export function deleteReportFile(file) {
  const base = path.basename(String(file))
  if (!/^(v.+|spec_.+|mut_.+)\.json$/.test(base)) throw new Error('можно удалять только отчёты, spec_*.json и mut_*.json')
  const p = path.join(REPORTS_DIR, base)
  if (!existsSync(p)) throw new Error('файл не найден: ' + base)
  unlinkSync(p)
  return { deleted: base }
}
/** Очистить все отчёты сканов (сохранённые API-доки spec_* не трогаем). */
export function clearReports() {
  if (!existsSync(REPORTS_DIR)) return { deleted: 0 }
  let n = 0
  for (const f of readdirSync(REPORTS_DIR)) {
    if (/^(v|mut_).+\.json$/.test(f) && !f.startsWith('spec_')) { unlinkSync(path.join(REPORTS_DIR, f)); n++ }
  }
  return { deleted: n }
}

/** Сохранить вручную загруженный OpenAPI-док (скачанный из Scalar другой версии). */
export function saveSpecUpload(name, content) {
  const spec = JSON.parse(content)
  if (!spec.paths) throw new Error('это не OpenAPI-док: нет поля paths')
  const ver = spec.info?.version ?? String(name ?? 'uploaded').replace(/\.json$/i, '')
  const file = specFileFor(ver)
  mkdirSync(REPORTS_DIR, { recursive: true })
  writeFileSync(path.join(REPORTS_DIR, file), JSON.stringify(spec))
  return { file, version: ver, endpoints: Object.keys(spec.paths).length }
}

// Автозаполнение ОБЯЗАТЕЛЬНЫХ query-параметров: без них Gizmo отвечает
// «One or more validation errors» — это не баг API, а незаполненная зависимость.
// Эвристика значения по ИМЕНИ параметра — используется и для required-query из
// OpenAPI, и для повторной попытки по именам полей из тела 400-ответа.
function guessValue(q, samples, day) {
  if (/datefrom/i.test(q)) return `${day} 00:00:00`
  if (/dateto/i.test(q)) return `${day} 23:59:59`
  if (/date|time$/i.test(q)) return `${day} 12:00:00`
  if (/username|login/i.test(q)) return config.gizmo.username
  if (/password/i.test(q)) return config.gizmo.password
  if (/smartcard|barcode|rfid|serial/i.test(q)) return '0000'
  if (/refreshtoken/i.test(q)) return samples.refreshToken ?? '1'
  if (/^token$/i.test(q.split('.').pop())) return samples.token ?? '1'
  if (/sortby/i.test(q)) return 'Id'
  if (/country/i.test(q)) return 'RU'
  if (/phone|mobile/i.test(q)) return '+79001234567'
  if (/name|text|search|pattern|email|title|source|path/i.test(q)) return 'scan_probe'
  if (/duration|minutes|count|limit|number|slots|amount|rating|type/i.test(q)) return 1
  // любой *Id — сперва РЕАЛЬНЫЙ образец с сервера (HostId→samples.hostId,
  // InvoiceId→samples.invoiceId, ShiftId→samples.shiftId…), 1 — последний резерв
  if (/id$/i.test(q)) {
    const key = q.split('.').pop()
    return samples[key.charAt(0).toLowerCase() + key.slice(1)] ?? 1
  }
  return '1'
}

function fillQuery(ep, samples, day) {
  // пагинация — та, что ОБЪЯВЛЕНА у эндпоинта: часть ручек page-based
  // (PageSize/PageNumber), и с курсорным Limit падают SqlDateTime overflow
  const pageBased = (ep.allQuery ?? []).includes('Pagination.PageSize') && !(ep.allQuery ?? []).includes('Pagination.Limit')
  const query = pageBased ? { 'Pagination.PageSize': 1, 'Pagination.PageNumber': 1 } : { 'Pagination.Limit': 1 }
  for (const q of ep.requiredQuery) query[q] = guessValue(q, samples, day)
  // Объявленные DateFrom/DateTo заполняем ВСЕГДА: без них часть ручек берёт
  // DateTime.MinValue и падает 500 «SqlDateTime overflow» (payments/transactions)
  if ((ep.allQuery ?? []).includes('DateFrom') && !query.DateFrom) {
    query.DateFrom = `${day} 00:00:00`; query.DateTo = `${day} 23:59:59`
  }
  if (/reports/i.test(ep.path)) {
    if (!query.DateFrom) { query.DateFrom = `${day} 00:00:00`; query.DateTo = `${day} 23:59:59` }
    // Отчёты падают 500 без энтити-параметров, хотя спека помечает их optional
    // (Scalar: /reports/product требует ProductId) — заполняем ВСЕ *Id живыми id.
    for (const q of ep.allQuery ?? []) {
      if (!(q in query) && /id$/i.test(q)) query[q] = guessValue(q, samples, day)
    }
  }
  // Брони смотрят в БУДУЩЕЕ: прошедшая/пустая дата → HostReservationException InvalidDate
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  if (/reservations\/availability/i.test(ep.path))
    Object.assign(query, { Start: `${tomorrow} 12:00:00`, Duration: 60, BranchId: samples.branchId ?? 1 })
  if (/reservations\/offer/i.test(ep.path))
    Object.assign(query, { Date: `${tomorrow} 12:00:00`, Duration: 60, UserId: samples.userId ?? 1 })
  return query
}

// Ошибки-«зависимости»: API работает, но на сервере нет нужного состояния
// (хост без Gizmo-клиента, отсутствующая сущность и т.п.) — НЕ баги эндпоинта.
const DEP_RE = /not connected|not found|does not exist|no such|was thrown/i

const pickHeaders = (h) => {
  const out = {}
  for (const k of ['content-type', 'content-length', 'server', 'date', 'www-authenticate']) if (h?.[k]) out[k] = String(h[k])
  return out
}
const truncBody = (data) => {
  if (data == null) return null
  const s = typeof data === 'string' ? data : JSON.stringify(data)
  return s.length > 4000 ? s.slice(0, 4000) + `\n… (обрезано, всего ${s.length} символов)` : s
}

// ── Полный прогон ───────────────────────────────────────────────────────────
export async function runFullScan(opts = {}) {
  let spec = null, source = 'openapi'
  let catalog
  try { spec = await loadOpenApiSpec(); catalog = catalogFromSpec(spec) }
  catch { source = 'sdk-fallback'; catalog = catalogFromSdk() }

  const samples = await collectSamples()
  const fixtures = await ensureFixtures(samples)
  const client = gapi.v3.hosts.client
  // Хост для hostcomputers/* и remotecontrol: нужен ПОДКЛЮЧЁННЫЙ Gizmo-клиент.
  // Сканер сам пробует все хосты и берёт первый живой; никого — «пропуск» с причиной.
  let hostState = { ok: false, name: null, reason: 'подключённых хостов не найдено (Gizmo-клиент нигде не запущен)' }
  try {
    const hosts = await listScanHosts(true)
    const online = opts.hostId
      ? hosts.find((h) => h.id === Number(opts.hostId) && h.connected)
      : hosts.find((h) => h.connected)
    if (online) {
      samples.hostId = online.id
      hostState = { ok: true, name: online.name, reason: null }
    } else if (opts.hostId) {
      hostState = { ok: false, name: null, reason: `хост #${opts.hostId} офлайн — Gizmo-клиент на нём не запущен` }
    }
  } catch { /* hostState остаётся «не найдено» */ }
  const day = new Date().toISOString().slice(0, 10)
  const results = new Array(catalog.length)

  const CALL_TIMEOUT = 8000
  const withTimeout = (p) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${CALL_TIMEOUT}ms`)), CALL_TIMEOUT)),
  ])

  // Заголовки запроса — как их реально шлёт клиент (пароль маскируем)
  const reqHeaders = () => ({
    Authorization: `Basic base64(${config.gizmo.username}:•••)`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
  })

  async function scanOne(ep) {
    const rec = { module: ep.module, method: ep.method, verb: ep.verb, path: ep.path }
    if (ep.verb !== 'GET') return { ...rec, status: 'mutation', httpCode: null, ms: 0, shape: null,
      detail: 'мутация — сканер не вызывает (см. сценарные тесты)' }
    if (ep.userScope) return { ...rec, status: 'user-scope', httpCode: null, ms: 0, shape: null,
      detail: 'юзерский эндпоинт (bearer-токен игрока) — вне оператора' }
    if (/\/stream$/i.test(ep.path)) return { ...rec, status: 'stream', httpCode: null, ms: 0, shape: null,
      detail: 'потоковый эндпоинт (SSE/stream) — обычным GET не сканируется' }
    // passthrough-запросы к Gizmo-клиенту хоста: без живого клиента бессмысленны
    // (hostcomputers/* и удалённое управление хостом)
    if (/^\/api\/v3\/(hostcomputers|remotecontrol\/hosts)\//i.test(ep.path) && !hostState.ok)
      return { ...rec, status: 'skip', httpCode: null, ms: 0, shape: null, detail: `пропуск: ${hostState.reason}` }
    const sub = substitutePath(ep, samples)
    if (sub.missing) return { ...rec, status: 'needs-params', httpCode: null, ms: 0, shape: null,
      detail: sub.missing.startsWith('{')
        ? `нет образца для ${sub.missing} — на сервере нет ни одной записи этого модуля`
        : `на сервере нет сущности: ${sub.missing} — создайте её и повторите скан` }
    const url = sub.url
    const query = fillQuery(ep, samples, day)

    const attempt = async (q) => {
      const req = { verb: 'GET', url: `${client.baseURL}${url}`, query: q, headers: reqHeaders(), body: null }
      const started = Date.now()
      try {
        // axios напрямую: нужны статус/заголовки/тело ответа для инспектора
        const resp = await withTimeout(client.axios({ method: 'get', url, params: q }))
        return { ...rec, status: 'ok', httpCode: resp.status, ms: Date.now() - started,
          shape: shapeOf(resp.data), detail: '', req,
          res: { code: resp.status, headers: pickHeaders(resp.headers), body: truncBody(resp.data) } }
      } catch (err) {
        const code = err?.response?.status ?? err?.response?.data?.httpStatusCode ?? null
        const msg = (err?.response?.data?.message ?? err.message ?? '').slice(0, 200)
        const status = DEP_RE.test(msg) ? 'dep'
          : code === 401 || code === 403 ? 'auth'
          : code && code < 500 ? 'http-4xx' : 'fail'
        return { ...rec, status, httpCode: code, ms: Date.now() - started, shape: null, detail: msg, req,
          res: err?.response
            ? { code, headers: pickHeaders(err.response.headers), body: truncBody(err.response.data) }
            : { code: null, headers: {}, body: String(err.message ?? err) },
          _errors: err?.response?.data?.errors }
      }
    }

    let out = await attempt(query)
    // OpenAPI-спека часто НЕ помечает обязательные query — но Gizmo в теле 400
    // сам называет недостающие поля: либо массив [{Error:{PropertyName}}], либо
    // ASP.NET-словарь {Field:[...]}. Дозаполняем их эвристикой и повторяем раз.
    if (out.status === 'http-4xx' && out.httpCode === 400 && out._errors) {
      const names = []
      if (Array.isArray(out._errors)) {
        for (const e of out._errors) {
          const pn = e?.Error?.PropertyName ?? e?.error?.propertyName ?? e?.PropertyName ?? e?.propertyName
          if (pn) names.push(String(pn))
        }
      } else if (typeof out._errors === 'object') names.push(...Object.keys(out._errors))
      const q2 = { ...query }
      let learned = false
      for (const key of names) {
        // параметр шлём ПОЛНЫМ именем (Pagination.SortBy), значение — по хвосту
        if (!(key in q2)) { q2[key] = guessValue(key.split('.').pop(), samples, day); learned = true }
      }
      if (learned) {
        const retry = await attempt(q2)
        if (retry.status === 'ok') retry.detail = 'параметры выведены из validation-ответа: ' +
          Object.keys(q2).filter((k) => !(k in query)).join(', ')
        out = retry
      }
    }
    // Часть эндпоинтов не принимает сортировку по Id — кандидатов берём из
    // СХЕМЫ возвращаемой модели в OpenAPI (имя типа сервер называет в ошибке).
    const ms = out.status === 'fail' && out.detail.match(/Order by column .+ is not supported for return type '(\w+)'/i)
    if (ms) {
      const props = Object.keys(spec?.components?.schemas?.[ms[1]]?.properties ?? {})
      const cands = [...props.filter((p) => !/date|time/i.test(p)), ...props.filter((p) => /date|time/i.test(p))].slice(0, 6)
      for (const c of cands) {
        const cap = c.charAt(0).toUpperCase() + c.slice(1)
        const retry = await attempt({ ...(out.req?.query ?? query), 'Pagination.SortBy': cap })
        if (retry.status === 'ok') { retry.detail = 'сортировка подобрана по схеме модели: ' + cap; out = retry; break }
      }
    }
    // «Specified entity Id 0, type X not found» — сервер взял дефолтный 0,
    // потому что нужный query-параметр (XId) вообще не был передан: добавляем.
    const m0 = out.status === 'dep' && out.detail.match(/entity Id 0, type (?:[\w.]+\.)?(\w+) not found/i)
    if (m0) {
      const base = m0[1].replace(/(Model|Member)$/, '')   // BranchModel→Branch, UserMember→User
      const sample = samples[base.charAt(0).toLowerCase() + base.slice(1) + 'Id']
      if (sample != null) {
        const retry = await attempt({ ...(out.req?.query ?? query), [`${base}Id`]: sample })
        if (retry.status === 'ok') retry.detail = `параметр ${base}Id подобран по типу сущности из ошибки`
        else retry.detail = `после подстановки ${base}Id=${sample}: ${retry.detail}`
        out = retry
      }
    }
    // Аннотации ПОДТВЕРЖДЁННЫХ серверных багов — в отчёте видно причину и обход
    if (out.detail) {
      if (/^\/api\/v3\/productstocks\/\{productId\}$/.test(ep.path) && /ShiftException/.test(out.detail)) {
        out.status = 'fail'
        out.detail += ' — баг сервера: вариант БЕЗ склада всегда кидает NotStock, хотя список /productstocks и /productstocks/{id}/stock/{stockId} работают (проверено)'
      }
      if (ep.path === '/api/v3/options' && /Parameter 'type'/.test(out.detail)) {
        out.detail += ' — недокументированный обязательный optionsType не принимает ни одно известное имя; рабочий путь — секции /options/business, /options/general и т.д.'
      }
    }
    delete out._errors
    return out
  }

  // Пул из 8 воркеров: сотни эндпоинтов сканируются за десятки секунд,
  // зависший вызов обрубается таймаутом и помечается fail.
  let next = 0
  async function worker() {
    while (next < catalog.length) {
      const i = next++
      results[i] = await scanOne(catalog[i])
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))

  const count = (st) => results.filter((r) => r.status === st).length
  const ver = await gizmoVersion(spec)
  // сохраняем API-док ЭТОЙ версии (spec_3.0.81.json) — база для дифа доков
  mkdirSync(REPORTS_DIR, { recursive: true })
  if (spec && !existsSync(path.join(REPORTS_DIR, specFileFor(ver))))
    writeFileSync(path.join(REPORTS_DIR, specFileFor(ver)), JSON.stringify(spec))
  const report = {
    at: Date.now(),
    gizmoVersion: ver,
    source,
    host: `${config.gizmo.ip}:${config.gizmo.port}`,
    scanHostId: opts.hostId ?? null,
    scanHostOnline: hostState.ok,
    scanHostName: hostState.name ?? null,
    scanHostNote: hostState.reason,
    fixtures,
    total: results.length,
    ok: count('ok'), fail: count('fail'), http4xx: count('http-4xx'), dep: count('dep'),
    mutation: count('mutation'), needsParams: count('needs-params'), userScope: count('user-scope'),
    stream: count('stream'), auth: count('auth'), skipped: count('skip'),
    results,
  }

  mkdirSync(REPORTS_DIR, { recursive: true })
  const fname = `v${String(report.gizmoVersion).replace(/[^\w.]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  writeFileSync(path.join(REPORTS_DIR, fname), JSON.stringify(report, null, 1))
  report.file = fname
  return report
}

// ── Сохранённые отчёты и diff между версиями ────────────────────────────────
export function listReports() {
  if (!existsSync(REPORTS_DIR)) return []
  return readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('spec_')).sort().reverse().map((file) => {
    try {
      const r = JSON.parse(readFileSync(path.join(REPORTS_DIR, file), 'utf8'))
      return { file, at: r.at, gizmoVersion: r.gizmoVersion, total: r.total, ok: r.ok, fail: r.fail }
    } catch { return { file, broken: true } }
  })
}

export function readReport(file) {
  return JSON.parse(readFileSync(path.join(REPORTS_DIR, path.basename(file)), 'utf8'))
}

export function diffReports(fileA, fileB) {
  const a = readReport(fileA), b = readReport(fileB)
  const key = (r) => `${r.verb} ${r.path}`
  const mapA = new Map(a.results.map((r) => [key(r), r]))
  const mapB = new Map(b.results.map((r) => [key(r), r]))
  const added = [], removed = [], changed = []
  for (const [k, rb] of mapB) {
    const ra = mapA.get(k)
    if (!ra) { added.push(rb); continue }
    if (ra.status !== rb.status || ra.httpCode !== rb.httpCode ||
        JSON.stringify(ra.shape) !== JSON.stringify(rb.shape)) {
      changed.push({ key: k, module: rb.module,
        before: { status: ra.status, httpCode: ra.httpCode, shape: ra.shape },
        after: { status: rb.status, httpCode: rb.httpCode, shape: rb.shape } })
    }
  }
  for (const [k, ra] of mapA) if (!mapB.has(k)) removed.push(ra)
  return {
    a: { file: path.basename(fileA), gizmoVersion: a.gizmoVersion, at: a.at },
    b: { file: path.basename(fileB), gizmoVersion: b.gizmoVersion, at: b.at },
    // диф самих API-доков (spec_<версия>.json): параметры/тела/ответы
    specDiff: a.gizmoVersion !== b.gizmoVersion ? diffSpecs(a.gizmoVersion, b.gizmoVersion) : null,
    added, removed, changed,
  }
}
