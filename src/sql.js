// Direct SQL, and only for AppStat. Gizmo has no client API for app launches,
// those rows are written by the host client itself. No SQL_PASS -> appSession
// is skipped; with a password health.js watches this connection too.
import { config } from './config.js'

let connecting = null   // the pending connect, not the pool: two events at once used to open two pools
let disabled = !config.sql.password

export function sqlEnabled() {
  return !disabled
}

async function getPool() {
  if (!connecting) {
    connecting = (async () => {
      const mssql = await import('mssql')
      return mssql.default.connect({
        server: config.sql.host,
        port: config.sql.port,
        database: config.sql.database,
        user: config.sql.user,
        password: config.sql.password,
        options: { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 8000,
        requestTimeout: 15000,
      })
    })().catch((err) => {
      connecting = null   // otherwise a single failed connect poisons the cache forever
      throw err
    })
  }
  return connecting
}

export async function insertAppStat({ appId, appExeId, hostId, userId, spanSeconds, branchId }) {
  const p = await getPool()
  // AppExeId is NOT NULL, exe rows are seeded by world.js (applicationExecutables)
  await p.request()
    .input('AppId', appId)
    .input('AppExeId', appExeId)
    .input('HostId', hostId)
    .input('UserId', userId)
    .input('Span', spanSeconds)
    .input('BranchId', branchId)
    .query(`INSERT INTO dbo.AppStat (AppId, AppExeId, HostId, UserId, Span, StartTime, BranchId)
            VALUES (@AppId, @AppExeId, @HostId, @UserId, @Span, DATEADD(SECOND, -@Span, GETDATE()), @BranchId)`)
}

export async function sqlPing() {
  const p = await getPool()
  const r = await p.request().query('SELECT 1 AS ok')
  return Number(r?.recordset?.[0]?.ok) === 1
}

export async function closeSql() {
  const p = connecting
  connecting = null
  if (p) await p.then((pool) => pool.close()).catch(() => {})
}

// Config changed (wizard, settings) or the watchdog saw the link go bad.
export async function sqlReconnect() {
  await closeSql()
  disabled = !config.sql.password
}
