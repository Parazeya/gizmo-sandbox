// Общее состояние симулятора — БЕЗ поллинга: один SSE-канал (/events).
// При подключении сервер шлёт снапшот `init` (state + история + лента),
// дальше только инкрементальные пуши: `state` (2с), `metric` (1 точка/с),
// `feed` (строка ленты). Обрыв связи EventSource переподключает сам,
// init при реконнекте восстанавливает всё состояние.

export const sim = $state({
  state: null,     // снапшот мира
  history: [],     // точки метрик для графиков
  feed: [],        // строки живой ленты {t, msg}
  connected: false,
})

export async function action(name) {
  const r = await fetch('/api/action', { method: 'POST', body: JSON.stringify({ name }) })
    .then((r) => r.json()).catch(() => ({ ok: false }))
  return r
}

export async function fetchConfig() {
  return fetch('/api/config').then((r) => r.json())
}

export async function saveConfig(cfg) {
  return fetch('/api/config', { method: 'POST', body: JSON.stringify(cfg) }).then((r) => r.json())
}

let started = false
export function startSim() {
  if (started) return
  started = true
  const es = new EventSource('/events')
  es.addEventListener('init', (e) => {
    const d = JSON.parse(e.data)
    sim.state = d.state
    sim.history = d.history
    sim.feed = d.feed
    sim.connected = true
  })
  es.addEventListener('state', (e) => {
    sim.state = JSON.parse(e.data)
    sim.connected = true
  })
  es.addEventListener('metric', (e) => {
    sim.history.push(JSON.parse(e.data))
    if (sim.history.length > 900) sim.history.shift()
  })
  es.addEventListener('feed', (e) => {
    sim.feed.push(JSON.parse(e.data))
    if (sim.feed.length > 250) sim.feed.shift()
  })
  es.onerror = () => { sim.connected = false }
}
