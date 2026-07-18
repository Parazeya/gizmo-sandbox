// Обёртки над gizmovsky: операторский клиент + пользовательские клиенты
// (bearer-токены ботов для user-корзин — заказы с заметкой, как в PWA).
import { GizmoSDK } from 'gizmovsky'
import { config } from './config.js'

const mkOperatorSdk = () => new GizmoSDK({
  ip: config.gizmo.ip,
  port: config.gizmo.port,
  ssl: config.gizmo.ssl,
  username: config.gizmo.username,
  password: config.gizmo.password,
})

// let + live-binding: reconnectGizmo() пересоздаёт клиент после смены доступов
// в мастере/настройках, и все импортёры сразу видят новый (без перезапуска).
export let gapi = mkOperatorSdk()

export function reconnectGizmo() {
  gapi = mkOperatorSdk()
  userTokens.clear()
}

// Gizmo местами отдаёт {Type, Model}-обёртку и PascalCase-ключи — разворачиваем
// и нормализуем в camelCase (тот же приём, что gizmo-api.js в GGBOOK_DB_API).
function unwrap(item) {
  const m = item?.Model ?? item?.model ?? item
  if (!m || typeof m !== 'object' || Array.isArray(m)) return m
  const out = {}
  for (const [k, v] of Object.entries(m)) {
    out[k.charAt(0).toLowerCase() + k.slice(1)] = v
  }
  return out
}

export function data(res) {
  const r = res?.result
  const rows = Array.isArray(r) ? r : (r?.data ?? [])
  return rows.map(unwrap)
}

export function model(res) {
  const r = res?.result
  return r ? unwrap(r) : null
}

const userTokens = new Map() // username → bearer

/** SDK от имени игрока (user-эндпоинты /api/user/v3/...). */
export async function userApi(username, password) {
  let token = userTokens.get(username)
  if (!token) {
    const res = await gapi.v3.auth.getUserAuthAccesstoken({ username, password })
    token = res?.result?.token
    if (!token) throw new Error(`нет токена для ${username}`)
    userTokens.set(username, token)
  }
  return new GizmoSDK({
    ip: config.gizmo.ip,
    port: config.gizmo.port,
    ssl: config.gizmo.ssl,
    bearerToken: token,
  })
}

export function dropUserToken(username) {
  userTokens.delete(username)
}
