// Прямой SQL — ТОЛЬКО для AppStat («поиграл в приложение»): клиентского
// API записи запусков у Gizmo нет, эти строки пишет только клиент на хосте.
// Без SQL_PASS событие appSession просто выключено.
import { config } from './config.js'

let pool = null
let disabled = !config.sql.password

export function sqlEnabled() {
  return !disabled
}

async function getPool() {
  if (pool) return pool
  const mssql = await import('mssql')
  pool = await mssql.default.connect({
    server: config.sql.host,
    port: config.sql.port,
    database: config.sql.database,
    user: config.sql.user,
    password: config.sql.password,
    options: { encrypt: false, trustServerCertificate: true },
  })
  return pool
}

export async function insertAppStat({ appId, appExeId, hostId, userId, spanSeconds, branchId }) {
  const p = await getPool()
  // AppExeId — NOT NULL: exe-строки сеет world.js через API (applicationExecutables).
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

/** Пинг для API-тестов: SELECT 1. */
export async function sqlPing() {
  const p = await getPool()
  const r = await p.request().query('SELECT 1 AS ok')
  return Number(r?.recordset?.[0]?.ok) === 1
}

export async function closeSql() {
  if (pool) await pool.close().catch(() => {})
}

export function disableSql(reason, log) {
  if (!disabled) {
    disabled = true
    log?.(`⚠ SQL выключен: ${reason} — событие «поиграл в приложение» пропускается`)
  }
}

/** Пересоздать подключение после смены конфига (мастер настройки / ⚙ Настройки). */
export async function sqlReconnect() {
  if (pool) { await pool.close().catch(() => {}); pool = null }
  disabled = !config.sql.password
}
