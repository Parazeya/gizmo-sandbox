// Simulator configuration. Sources by priority (higher wins):
//   1) CLI arguments (--players 8 --tick 5 --speed 6 --ui 5555)
//   2) environment variables (GIZMO_*, SQL_*, SIM_*)
//   3) sim.config.json in the project root (created on first run — fill it in)
//   4) the test-stand defaults below
// The web UI edits the config live and writes it back to sim.config.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim.config.json')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DEFAULTS = {
  // Connection to the TEST Gizmo server — filled in via the setup wizard
  // (or sim.config.json / GIZMO_* environment variables).
  gizmo: {
    ip: '127.0.0.1',
    port: 80,
    ssl: false,
    username: 'admin',
    password: '',
  },
  branchId: 1,

  // SQL is needed ONLY to simulate application launches (AppStat is written by
  // the Gizmo client, there is no API for it). Empty password — event disabled.
  sql: {
    host: '127.0.0.1',
    port: 1433,
    database: 'Gizmo',
    user: 'sa',
    password: null,
  },

  // How many virtual players and how often the simulation ticks.
  players: 8,
  // Player-base cap: the "new registration" event grows it up to this number.
  maxPlayers: 40,
  // Target occupancy: don't seat new players once this many are seated. Keep it
  // below the Gizmo license concurrent-session limit (~35 on the stand), or
  // logins hit code 65536 and the club has no rotation.
  maxSeated: 32,
  tickSeconds: 10,
  // Time acceleration (2 = one "club hour" passes in 30 real minutes). Affects
  // session lengths and habit cooldowns.
  speed: 1,
  // Web UI port (world dashboard); 0 disables it.
  uiPort: 5555,

  // Bot login prefix (bots are created automatically on first run).
  botPrefix: 'sim_bot_',
  botPassword: 'sim12345',

  // First run: while false the UI shows the setup wizard.
  setupDone: false,
  // Default mode after the wizard: 'sim' (simulator) or 'api' (API tests).
  uiMode: 'sim',
  // UI theme: 'plain' | 'terraria' | 'doom'.
  uiTheme: 'plain',
  // Doom theme accent color: 'green' (toxic, default) | 'white' | 'red' | 'blue' | 'cyan'.
  uiAccent: 'green',
  // Web UI language: 'ru' | 'en' (chosen in the wizard and via the header button).
  uiLang: 'ru',
  // World generation: grows on "tear down and regenerate" — changes the bots'
  // personas and the room layout on the map.
  worldGen: 1,

  // ── Realism ──────────────────────────────────────────────────────────────
  session: {
    minMinutes: 30,   // play session: from 30 minutes…
    maxMinutes: 240,  // …up to 4 hours, planned on seating
    earlyLeaveChance: 0.05, // rare early leave (per tick, after 20 minutes)
  },
  habits: {
    orderCooldownMin: [20, 45],    // bar order — at most once every 20–45 min
    depositCooldownMin: [40, 90],  // top-up — a rare event
    assetCooldownMin: [25, 60],    // check an asset out/in
  },
  operator: {
    orderPrepMinutes: [1, 4],      // order "cooking" time before delivery
    saleCooldownMin: [10, 25],     // register sale to a passer-by
    shiftHours: 8,                 // shift length (then a shift change)
  },

  // Per-tick event probabilities (weights; sessions/orders are additionally
  // limited by the cooldowns above, so there is no spam).
  weights: {
    arrive: 20,        // a free bot takes a free host
    groupArrive: 5,    // a group (2–3) arrives together and sits nearby
    tournament: 1,     // a spontaneous mini-tournament among the seated players
    order: 10,         // a seated bot orders at the bar (with a comment)
    buyTime: 5,        // buy more time package
    deposit: 6,        // top-up at the counter
    reserve: 2,        // an evening reservation
    asset: 6,          // check an asset out/in
    appSession: 8,     // "played an application" (SQL AppStat)
    operatorSale: 6,   // the operator sold at the register
    life: 12,          // "life" — actions outside Gizmo, console only
    newcomer: 2,       // a new player registration (up to maxPlayers)
    registerCash: 2,   // register: change/collection (Gizmo shift report)
    voidSale: 1,       // void of a mistaken invoice (Voids report)
  },
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over ?? {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) deepMerge(base[k], v)
    else if (v !== undefined) base[k] = v
  }
  return base
}

export const config = structuredClone(DEFAULTS)

// 3) file
if (existsSync(CONFIG_PATH)) {
  try {
    deepMerge(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch (err) {
    console.error(`⚠ sim.config.json is unreadable (${err.message}) — running on defaults`)
  }
}

// 2) environment
const env = process.env
if (env.GIZMO_HOST) config.gizmo.ip = env.GIZMO_HOST
if (env.GIZMO_PORT) config.gizmo.port = Number(env.GIZMO_PORT)
if (env.GIZMO_SSL) config.gizmo.ssl = env.GIZMO_SSL === 'true'
if (env.GIZMO_USER) config.gizmo.username = env.GIZMO_USER
if (env.GIZMO_PASS) config.gizmo.password = env.GIZMO_PASS
if (env.BRANCH_ID) config.branchId = Number(env.BRANCH_ID)
if (env.SQL_HOST) config.sql.host = env.SQL_HOST
if (env.SQL_PORT) config.sql.port = Number(env.SQL_PORT)
if (env.SQL_DB) config.sql.database = env.SQL_DB
if (env.SQL_USER) config.sql.user = env.SQL_USER
if (env.SQL_PASS) config.sql.password = env.SQL_PASS
if (env.SIM_PLAYERS) config.players = Number(env.SIM_PLAYERS)
if (env.SIM_TICK) config.tickSeconds = Number(env.SIM_TICK)
if (env.SIM_SPEED) config.speed = Number(env.SIM_SPEED)
if (env.SIM_UI_PORT) config.uiPort = Number(env.SIM_UI_PORT)

// 1) CLI
config.players = Number(arg('players', config.players))
config.tickSeconds = Number(arg('tick', config.tickSeconds))
config.speed = Number(arg('speed', config.speed))
config.uiPort = Number(arg('ui', config.uiPort))

/** Save the current config to sim.config.json (whole file, human-readable). */
export function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/** Apply a patch (nested object) live and save it to the file. */
export function updateConfig(patch) {
  deepMerge(config, patch)
  saveConfig()
  return config
}

// No file yet — create it with the current values so there is something to fill in.
if (!existsSync(CONFIG_PATH)) saveConfig()
