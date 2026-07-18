// Shared simulator state — NO polling: a single SSE channel (/events).
// On connect the server sends an `init` snapshot (state + history + feed),
// then only incremental pushes: `state` (2s), `metric` (1 point/s),
// `feed` (a feed line). EventSource reconnects on a dropped connection,
// and `init` on reconnect restores the whole state.

export const sim = $state({
  state: null,     // world snapshot
  history: [],     // metric points for the charts
  feed: [],        // live feed lines {t, msg}
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
