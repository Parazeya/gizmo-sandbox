// gizmovsky wrappers: one operator client plus per-user clients (bots need their
// own bearer to put a note on a cart, same as the PWA does).
import { GizmoSDK } from 'gizmovsky'
import { config } from './config.js'

const mkOperatorSdk = () => new GizmoSDK({
  ip: config.gizmo.ip,
  port: config.gizmo.port,
  ssl: config.gizmo.ssl,
  username: config.gizmo.username,
  password: config.gizmo.password,
})

// let + live binding, so reconnectGizmo() after a credentials change in the
// wizard reaches every importer without a restart.
export let gapi = mkOperatorSdk()

export function reconnectGizmo() {
  gapi = mkOperatorSdk()
  userTokens.clear()
}

// Gizmo sometimes wraps a payload into {Type, Model} with PascalCase keys.
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

const userTokens = new Map() // username -> bearer

/** SDK acting as a player: /api/user/v3/... */
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
