// Конфигурация симулятора. Источники по приоритету (выше — сильнее):
//   1) аргументы CLI (--players 8 --tick 5 --speed 6 --ui 5555)
//   2) переменные окружения (GIZMO_*, SQL_*, SIM_*)
//   3) sim.config.json в корне проекта (создаётся при первом запуске — заполняйте его)
//   4) дефолты тестового стенда ниже
// Веб-интерфейс правит конфиг живьём и сохраняет обратно в sim.config.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sim.config.json')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const DEFAULTS = {
  // Подключение к ТЕСТОВОМУ серверу Gizmo — заполняется в мастере первого
  // запуска (или в sim.config.json / переменных окружения GIZMO_*).
  gizmo: {
    ip: '127.0.0.1',
    port: 80,
    ssl: false,
    username: 'admin',
    password: '',
  },
  branchId: 1,

  // SQL нужен ТОЛЬКО для симуляции запусков приложений (AppStat пишет клиент
  // Gizmo, API для записи нет). Пустой пароль — событие просто выключено.
  sql: {
    host: '127.0.0.1',
    port: 1433,
    database: 'Gizmo',
    user: 'sa',
    password: null,
  },

  // Сколько виртуальных игроков и как часто тикает симуляция.
  players: 8,
  // Потолок «базы» игроков: событие «регистрация нового» растит её до этого числа.
  maxPlayers: 40,
  // Целевая занятость: не сажаем новых, если сидит столько. Держите ниже
  // лимита одновременных сессий лицензии Gizmo (на стенде ~35), иначе логины
  // упираются в 65536 и в клубе нет ротации.
  maxSeated: 32,
  tickSeconds: 10,
  // Ускорение времени (2 = «час клуба» проходит за 30 минут реального
  // времени). Влияет на длительность сессий и кулдауны привычек.
  speed: 1,
  // Порт веб-интерфейса (дашборд мира); 0 — выключить.
  uiPort: 5555,

  // Префикс логинов ботов (создаются сами при первом запуске).
  botPrefix: 'sim_bot_',
  botPassword: 'sim12345',

  // Первый запуск: пока false — UI показывает мастер настройки.
  setupDone: false,
  // Режим по умолчанию после мастера: 'sim' (симулятор) или 'api' (тесты API).
  uiMode: 'sim',
  // Тема интерфейса: 'plain' | 'terraria' | 'doom'.
  uiTheme: 'plain',
  // Акцентный цвет темы Doom: 'green' (ядовитый, дефолт) | 'white' | 'red' | 'blue' | 'cyan'.
  uiAccent: 'green',
  // Язык веб-интерфейса: 'ru' | 'en' (выбирается в мастере и кнопкой в шапке).
  uiLang: 'ru',
  // Поколение мира: растёт при «снести и сгенерировать заново» — меняет
  // персоны ботов и планировку комнат на карте.
  worldGen: 1,

  // ── Реализм ──────────────────────────────────────────────────────────────
  session: {
    minMinutes: 30,   // игровая сессия: 30 минут…
    maxMinutes: 240,  // …до 4 часов, планируется при посадке
    earlyLeaveChance: 0.05, // редкий ранний уход (за тик, после 20 минут)
  },
  habits: {
    orderCooldownMin: [20, 45],    // заказ на бар — не чаще раза в 20–45 мин
    depositCooldownMin: [40, 90],  // пополнение — редкое событие
    assetCooldownMin: [25, 60],    // взять/вернуть ассет
  },
  operator: {
    orderPrepMinutes: [1, 4],      // «готовка» заказа до выдачи
    saleCooldownMin: [10, 25],     // продажа на кассе прохожему
    shiftHours: 8,                 // длительность смены (потом пересменка)
  },

  // Вероятности событий на каждом тике (веса; сессии/заказы дополнительно
  // ограничены кулдаунами выше, так что спама не будет).
  weights: {
    arrive: 20,        // свободный бот садится за свободный хост
    groupArrive: 5,    // компания (2–3) приходит вместе, садится рядом
    tournament: 1,     // стихийный мини-турнир среди сидящих
    order: 10,         // сидящий бот заказывает на бар (с комментарием)
    buyTime: 5,        // докупить пакет времени
    deposit: 6,        // пополнение на стойке
    reserve: 2,        // бронь на вечер
    asset: 6,          // взять/вернуть ассет
    appSession: 8,     // «поиграл в приложение» (SQL AppStat)
    operatorSale: 6,   // оператор продал на кассе
    life: 12,          // «жизнь» — действия вне Gizmo, просто в консоль
    newcomer: 2,       // регистрация нового игрока (до maxPlayers)
    registerCash: 2,   // касса: размен/инкассация (отчёт смены Gizmo)
    voidSale: 1,       // аннулирование ошибочного чека (отчёт Voids)
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

// 3) файл
if (existsSync(CONFIG_PATH)) {
  try {
    deepMerge(config, JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch (err) {
    console.error(`⚠ sim.config.json не читается (${err.message}) — работаю на дефолтах`)
  }
}

// 2) окружение
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

/** Сохранить текущий конфиг в sim.config.json (весь, читаемо). */
export function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}

/** Применить патч (вложенный объект) живьём и сохранить в файл. */
export function updateConfig(patch) {
  deepMerge(config, patch)
  saveConfig()
  return config
}

// Файла ещё нет — создаём с текущими значениями, чтобы было что заполнять.
if (!existsSync(CONFIG_PATH)) saveConfig()
