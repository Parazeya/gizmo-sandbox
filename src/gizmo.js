// Wrappers around gizmovsky: an operator client + per-user clients
// (bot bearer tokens for user carts — orders with a note, like in the PWA).
import { GizmoSDK } from 'gizmovsky'
import { config } from './config.js'

const mkOperatorSdk = () => new GizmoSDK({
  ip: config.gizmo.ip,
  port: config.gizmo.port,
  ssl: config.gizmo.ssl,
  username: config.gizmo.username,
  password: config.gizmo.password,
})

// let + live binding: reconnectGizmo() recreates the client after credentials
// change in the wizard/settings, and every importer sees the new one (no restart).
export let gapi = mkOperatorSdk()

export function reconnectGizmo() {
  gapi = mkOperatorSdk()
  userTokens.clear()
}

// Gizmo sometimes returns a {Type, Model} wrapper with PascalCase keys — we
// unwrap it and normalize to camelCase (same approach as gizmo-api.js elsewhere).
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

/** SDK acting as a player (user endpoints /api/user/v3/...). */
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
