// Config sources, strongest first: CLI args (--players 8 --tick 5 --speed 6
// --ui 5555), env (GIZMO_*, SQL_*, SIM_*), sim.config.json, defaults below.
// The web UI edits it live and writes sim.config.json back.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim.config.json')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DEFAULTS = {
  // TEST Gizmo server. Filled in by the setup wizard, sim.config.json or GIZMO_*.
  gizmo: {
    ip: '127.0.0.1',
    port: 80,
    ssl: false,
    username: 'admin',
    password: '',
  },
  branchId: 1,

  // SQL is only for app launches (AppStat has no API). No password, no event.
  sql: {
    host: '127.0.0.1',
    port: 1433,
    database: 'Gizmo',
    user: 'sa',
    password: null,
  },

  players: 8,
  maxPlayers: 40,   // the "new registration" event grows the base up to this
  // Stop seating at this many. Must stay under the license concurrent-session
  // limit (~35 on our stand), otherwise logins start returning 65536.
  maxSeated: 32,
  tickSeconds: 10,
  speed: 1,         // 2 = a club hour passes in 30 real minutes
  uiPort: 5555,     // 0 disables the web UI

  botPrefix: 'sim_bot_',
  botPassword: 'sim12345',

  setupDone: false, // while false the UI shows the setup wizard
  uiMode: 'sim',    // 'sim' | 'api' — which tab opens after the wizard
  uiTheme: 'plain', // 'plain' | 'terraria' | 'doom'
  uiAccent: 'green',// doom accent: green (toxic) | white | red | blue | cyan
  uiLang: 'ru',
  worldGen: 1,      // bumped by "tear down and regenerate": new personas, new layout

  session: {
    minMinutes: 30,
    maxMinutes: 240,          // planned when the bot sits down
    earlyLeaveChance: 0.05,   // per tick, only after 20 minutes
  },
  habits: {
    orderCooldownMin: [20, 45],
    depositCooldownMin: [40, 90],
    assetCooldownMin: [25, 60],
  },
  operator: {
    orderPrepMinutes: [1, 4],
    saleCooldownMin: [10, 25],
    shiftHours: 8,
  },

  // Weights, not probabilities. Cooldowns above still apply, so no spam.
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
    life: 12,          // flavor only: nothing leaves the console
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

// file
if (existsSync(CONFIG_PATH)) {
  try {
    deepMerge(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch (err) {
    console.error(`⚠ sim.config.json is unreadable (${err.message}) — running on defaults`)
  }
}

// env
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

// argv
config.players = Number(arg('players', config.players))
config.tickSeconds = Number(arg('tick', config.tickSeconds))
config.speed = Number(arg('speed', config.speed))
config.uiPort = Number(arg('ui', config.uiPort))

export function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/** Apply a nested patch live and persist it. */
export function updateConfig(patch) {
  deepMerge(config, patch)
  saveConfig()
  return config
}

// First run: drop a file with the defaults so there is something to fill in.
if (!existsSync(CONFIG_PATH)) saveConfig()
