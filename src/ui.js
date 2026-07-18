// The simulator web server. The primary UI is the built Svelte app (web/dist);
// this file serves it and exposes the JSON/SSE API:
// GET  /api/state   — world snapshot (JSON)
// GET  /api/config  — current config; POST — apply live + save to sim.config.json
// GET  /events      — SSE event stream (the same lines as in the console)
import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config, updateConfig } from './config.js'
import { runApiTests, getLastResults } from './apitests.js'
import { runFullScan, runMutationScan, listReports, readReport, diffReports, listScanHosts, listSpecs, diffSpecFiles, saveSpecUpload, deleteReportFile, clearReports } from './apicatalog.js'
import { gapi, data, reconnectGizmo } from './gizmo.js'
import { sqlPing, sqlEnabled, sqlReconnect } from './sql.js'
import { loadOpenApiSpec } from './apicatalog.js'

// The built Svelte frontend (web/dist). If it isn't built (`npm run build` in
// web/) — the legacy embedded pages (PAGE/PAGE_CLUB) are served as a fallback.
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist')
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2',
}
function serveDist(pathname, res) {
  if (!existsSync(path.join(DIST, 'index.html'))) return false
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1)
  let file = path.join(DIST, rel)
  if (!file.startsWith(DIST)) return false
  if (!existsSync(file)) file = path.join(DIST, 'index.html') // SPA fallback
  try {
    const body = readFileSync(file)
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
    return true
  } catch { return false }
}

const clients = new Set()

export function broadcast(line) {
  // Backward compatibility: an unnamed feed event (legacy fallback pages)
  const payload = `data: ${JSON.stringify(line)}\n\n`
  for (const res of clients) res.write(payload)
}

/** Typed SSE event: state / metric / feed — push instead of polling. */
export function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

export function startUI({ port, getState, getFeed, getHistory, onConfig, onAction, onWorldReset }, log) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(getState()))
      return
    }
    if (url.pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify(getHistory?.() ?? []))
      return
    }
    // ♻ Tear down the test world and generate a new one (bots, personas, rooms)
    if (url.pathname === '/api/world/reset' && req.method === 'POST') {
      Promise.resolve(onWorldReset?.())
        .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r ?? { ok: false })) })
        .catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: err.message })) })
      return
    }
    // Setup wizard: connectivity check for Gizmo and SQL
    if (url.pathname === '/api/setup/check') {
      ;(async () => {
        const out = { gizmo: null, sql: null }
        try {
          const hosts = data(await gapi.v3.hosts.getHosts({ paginationLimit: 1 }))
          // server version — from the OpenAPI document (not critical if unavailable)
          let ver = null
          try { ver = (await loadOpenApiSpec())?.info?.version ?? null } catch { /* old builds without /openapi */ }
          ver = ver ? String(ver).replace(/^v/i, '') : null
          const verNote = ver
            ? `Gizmo v${ver}${ver.startsWith('3') ? '' : ' — проверялось на v3.x, возможны расхождения'}`
            : 'версия не определена (нет /openapi/v3.json)'
          out.gizmo = { ok: true, detail: `связь есть · ${verNote} · хосты: ${hosts.length ? 'есть' : '0'}` }
        } catch (err) { out.gizmo = { ok: false, detail: err?.message ?? 'нет связи' } }
        if (!sqlEnabled()) out.sql = { ok: 'skip', detail: 'SQL выключен (пароль не задан) — «поиграл в приложение» будет пропускаться' }
        else {
          try { await sqlPing(); out.sql = { ok: true, detail: 'SQL доступен' } }
          catch (err) { out.sql = { ok: false, detail: err?.message ?? 'нет связи' } }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out))
      })()
      return
    }
    if (url.pathname === '/api/tests/run' && req.method === 'POST') {
      runApiTests()
        .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r)) })
        .catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) })
      return
    }
    if (url.pathname === '/api/tests/last') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(getLastResults()))
      return
    }
    if (url.pathname === '/api/tests/full/run' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let opts = {}
        try { opts = body ? JSON.parse(body) : {} } catch { /* empty body — ok */ }
        runFullScan(opts)
          .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r)) })
          .catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) })
      })
      return
    }
    // Mutation scan: create→update→delete only on our own entities
    if (url.pathname === '/api/tests/mutations/run' && req.method === 'POST') {
      runMutationScan()
        .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r)) })
        .catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) })
      return
    }
    // Report cleanup: delete one file or all scan reports at once
    if (url.pathname === '/api/tests/reports/delete' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const r = deleteReportFile(JSON.parse(body).file)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r))
        } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }
    if (url.pathname === '/api/tests/reports/clear' && req.method === 'POST') {
      try {
        const r = clearReports()
        log(`🗑 удалено отчётов сканов: ${r.deleted}`)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r))
      } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      return
    }
    // Saved version API docs + manual comparison of two docs
    if (url.pathname === '/api/tests/specs' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(listSpecs()))
      return
    }
    if (url.pathname === '/api/tests/specdiff') {
      diffSpecFiles(url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? '')
        .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r)) })
        .catch((err) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) })
      return
    }
    if (url.pathname === '/api/tests/specs/upload' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try {
          const { name, content } = JSON.parse(body)
          const r = saveSpecUpload(name, content)
          log(`📄 загружен API-док ${r.file} (${r.endpoints} путей)`)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r))
        } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      })
      return
    }
    // Hosts for the scan selector; ?probe=1 — check Gizmo client connectivity
    if (url.pathname === '/api/tests/hosts') {
      listScanHosts(url.searchParams.get('probe') === '1')
        .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(r)) })
        .catch((err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) })
      return
    }
    if (url.pathname === '/api/tests/reports') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(listReports()))
      return
    }
    if (url.pathname === '/api/tests/report') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(readReport(url.searchParams.get('file') ?? '')))
      } catch (err) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      return
    }
    if (url.pathname === '/api/tests/diff') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(diffReports(url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? '')))
      } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })) }
      return
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        try {
          const { name } = JSON.parse(body)
          const done = await onAction?.(name)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, done: done !== false }))
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: err?.response?.data?.message ?? err.message }))
        }
      })
      return
    }
    if (url.pathname === '/api/config') {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          try {
            const patch = JSON.parse(body)
            updateConfig(patch)
            // Credentials changed — recreate the clients immediately, no restart
            if (patch.gizmo) reconnectGizmo()
            if (patch.sql) sqlReconnect().catch(() => {})
            onConfig?.()
            log('⚙ конфиг обновлён из веб-интерфейса (сохранён в sim.config.json)')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: err.message }))
          }
        })
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(config))
      return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      // Full snapshot on connect — afterwards only incremental pushes
      // (state in full, metric — one history point, feed — a feed line).
      res.write(`event: init\ndata: ${JSON.stringify({
        state: getState(),
        history: getHistory?.() ?? [],
        feed: getFeed(),
      })}\n\n`)
      // For the legacy embedded pages — feed history as unnamed events
      for (const line of getFeed()) res.write(`data: ${JSON.stringify(line)}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    // Svelte frontend (web/dist), if built
    if (serveDist(url.pathname, res)) return
    // Fallback: legacy embedded pages
    if (url.pathname === '/club') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE_CLUB.replace('</body>', REPORTS_WIDGET + '</body>'))
      return
    }
    if (url.pathname === '/reports') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE_REPORTS)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(PAGE.replace('</body>', REPORTS_WIDGET + '</body>'))
  })
  server.listen(port, () => log(`🖥 веб-интерфейс: http://localhost:${port}`))
  return server
}

const PAGE = /* html */ `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gizmo Sandbox</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#21262d; --text:#e6edf3; --dim:#8b949e;
          --green:#3fb950; --amber:#d29922; --blue:#58a6ff; --red:#f85149; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.45 system-ui,'Segoe UI',sans-serif; padding:16px; }
  header { display:flex; flex-wrap:wrap; gap:10px 18px; align-items:baseline; margin-bottom:14px; }
  header h1 { font-size:18px; }
  header .meta { color:var(--dim); font-size:13px; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
  .chip { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:6px 12px; font-size:13px; }
  .chip b { color:var(--blue); }
  .grid { display:grid; grid-template-columns:1.2fr 1fr; gap:14px; }
  @media (max-width:1100px){ .grid{ grid-template-columns:1fr; } }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin-bottom:10px; }
  .hosts { display:grid; grid-template-columns:repeat(auto-fill,minmax(86px,1fr)); gap:6px; }
  .host { border:1px solid var(--line); border-radius:8px; padding:6px 8px; min-height:52px; background:#0d1117; }
  .host .n { font-size:11px; color:var(--dim); }
  .host.busy { border-color:var(--green); background:rgba(63,185,80,.08); }
  .host.busy .who { color:var(--green); font-weight:600; font-size:12px; }
  .bots { display:flex; flex-direction:column; gap:8px; }
  .bot { display:flex; gap:10px; align-items:center; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  .bot .ava { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center;
              background:var(--line); font-size:16px; flex:none; }
  .bot .name { font-weight:600; }
  .bot .trait { color:var(--dim); font-size:12px; }
  .bot .st { margin-left:auto; text-align:right; font-size:12px; color:var(--dim); white-space:nowrap; }
  .bot.seated .st { color:var(--green); }
  .bot.away { opacity:.55; }
  .orders .o { display:flex; gap:8px; align-items:center; padding:5px 0; border-bottom:1px solid var(--line); font-size:13px; }
  .orders .o:last-child { border-bottom:0; }
  .badge { border-radius:20px; padding:1px 9px; font-size:11px; font-weight:600; }
  .badge.new { background:rgba(210,153,34,.15); color:var(--amber); }
  .badge.cook { background:rgba(88,166,255,.15); color:var(--blue); }
  #feed { height:420px; overflow-y:auto; font:12.5px/1.6 ui-monospace,Consolas,monospace; }
  #feed div { padding:1px 0; border-bottom:1px dashed rgba(48,54,61,.5); }
  #feed .t { color:var(--dim); margin-right:8px; }
  .empty { color:var(--dim); font-size:13px; padding:6px 0; }
  footer { margin-top:12px; color:var(--dim); font-size:12px; }
  .btn { background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:8px;
         padding:6px 14px; font-size:13px; cursor:pointer; }
  .btn:hover { border-color:var(--blue); }
  .btn.primary { background:rgba(88,166,255,.15); border-color:var(--blue); color:var(--blue); font-weight:600; }
  #settings { display:none; margin-bottom:14px; }
  #settings.open { display:block; }
  #settings .groups { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:12px; }
  .cfg-group { border:1px solid var(--line); border-radius:8px; padding:10px; }
  .cfg-group h3 { font-size:12px; color:var(--dim); text-transform:uppercase; letter-spacing:.05em; margin-bottom:8px; }
  .cfg-row { display:flex; align-items:center; gap:8px; padding:3px 0; font-size:13px; }
  .cfg-row label { flex:1; color:var(--text); }
  .cfg-row .restart { color:var(--amber); font-size:11px; }
  .cfg-row input { background:#0d1117; border:1px solid var(--line); color:var(--text); border-radius:6px;
                   padding:4px 8px; width:86px; font:inherit; }
  .cfg-row input.wide { width:150px; }
  .cfg-row input:focus { outline:none; border-color:var(--blue); }
  #cfgmsg { font-size:13px; margin-left:10px; }
</style></head><body>
<header>
  <h1>🎮 Gizmo Sandbox</h1>
  <span class="meta" id="meta">подключение…</span>
  <span style="margin-left:auto; display:flex; gap:6px; flex-wrap:wrap">
    <a class="btn" href="/club" style="text-decoration:none">🕹 Вид сверху</a>
    <button class="btn" id="repToggle">📊 Отчёты</button>
    <button class="btn" id="pausebtn">⏸ Пауза</button>
    <button class="btn" data-act="arrive">🪑 Посадить</button>
    <button class="btn" data-act="groupArrive">👥 Компания</button>
    <button class="btn" data-act="newcomer">📝 Новый игрок</button>
    <button class="btn" data-act="order">🍔 Заказ</button>
    <button class="btn" data-act="tournament">🏆 Турнир</button>
    <button class="btn" id="cfgbtn">⚙ Настройки</button>
  </span>
</header>
<div class="panel" id="settings">
  <h2>Настройки симуляции <span style="color:var(--amber);text-transform:none;letter-spacing:0">· жёлтые — применятся после перезапуска, остальные действуют сразу</span></h2>
  <div class="groups" id="cfggroups"></div>
  <div style="margin-top:12px">
    <button class="btn primary" id="cfgsave">Сохранить (sim.config.json)</button>
    <span id="cfgmsg"></span>
  </div>
</div>
<div class="chips" id="chips"></div>
<div class="grid">
  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="panel"><h2>Хосты</h2><div class="hosts" id="hosts"></div></div>
    <div class="panel"><h2>Живая лента</h2><div id="feed"></div></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:14px">
    <div class="panel"><h2>Игроки</h2><div class="bots" id="bots"></div></div>
    <div class="panel orders"><h2>Очередь заказов</h2><div id="orders"></div></div>
  </div>
</div>
<footer>Симулятор живого клуба · только тестовый стенд</footer>
<script>
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const EMO = { 'задрот':'🎧','казуал':'🙂','гурман':'🍕','молчун':'🤐','залётный':'🌪','стример':'📹' }

async function refresh() {
  try {
    const s = await fetch('/api/state').then(r => r.json())
    $('meta').textContent = 'скорость ×' + s.speed + ' · тик ' + s.tickSeconds + 'с · смена ' +
      (s.shift.id ? '#' + s.shift.id : '—') + ' · в клубе ' + s.bots.filter(b => b.hostName).length + ' из ' + s.bots.length +
      (s.paused ? ' · ⏸ ПАУЗА' : '')
    $('pausebtn').textContent = s.paused ? '▶ Продолжить' : '⏸ Пауза'
    $('pausebtn').dataset.state = s.paused ? 'paused' : ''

    $('chips').innerHTML = [
      ['💰 касса за сеанс', s.revenue],
      ['🪑 посадок', s.stats.arrive], ['👥 компаний', s.stats.group], ['🍔 заказов', s.stats.order],
      ['✅ выдано', s.stats.delivered], ['🧾 продаж на кассе', s.stats.sale], ['💵 пополнений', s.stats.deposit],
      ['⏱ пакетов времени', s.stats.buyTime], ['📅 броней', s.stats.reserve], ['🎮 игр', s.stats.appSession],
      ['🏆 турниров', s.stats.tournament], ['🚪 уходов', s.stats.leave], ['📝 регистраций', s.stats.newcomer],
    ].map(([k, v]) => '<span class="chip">' + k + ': <b>' + (v ?? 0) + '</b></span>').join('')

    $('hosts').innerHTML = s.hosts.map(h => {
      const who = (h.sitters ?? (h.busyBy ? [h.busyBy] : [])).join(', ')
      const cap = h.maxUsers > 1 ? ' <span style="color:var(--dim)">' + (h.sitters?.length ?? 0) + '/' + h.maxUsers + '</span>' : ''
      return '<div class="host' + (who ? ' busy' : '') + '"><div class="n">' + esc(h.name) + cap + '</div>' +
        (who ? '<div class="who">' + esc(who) + '</div>' : '') + '</div>'
    }).join('')

    $('bots').innerHTML = s.bots.map(b => {
      const cls = b.hostName ? 'seated' : (b.present ? '' : 'away')
      const st = b.hostName
        ? '🪑 ' + esc(b.hostName) + '<br>сидит ' + b.sittingMin + ' мин · ещё ~' + b.leftMin
        : (b.present ? '☕ в клубе, не за хостом' : '🏠 сегодня не придёт')
      const assets = b.assets.length ? '<br>🎧 ' + b.assets.map(esc).join(', ') : ''
      return '<div class="bot ' + cls + '"><div class="ava">' + (EMO[b.trait] ?? '🙂') + '</div>' +
        '<div><div class="name">' + esc(b.name) + ' <span class="trait">(' + esc(b.username) + ' · ' + esc(b.trait) + ')</span></div>' +
        '<div class="trait">' + st + assets + '</div></div></div>'
    }).join('')

    $('orders').innerHTML = s.orders.length
      ? s.orders.map(o => '<div class="o"><span class="badge ' + (o.status === 0 ? 'new' : 'cook') + '">' +
          (o.status === 0 ? 'новый' : 'готовится') + '</span> #' + o.id + ' <span style="color:var(--dim)">' + esc(o.ageMin) + ' мин назад</span></div>').join('')
      : '<div class="empty">очередь пуста — оператор всё разгрёб 👌</div>'
  } catch { $('meta').textContent = 'симулятор недоступен…' }
}
refresh(); setInterval(refresh, 2000)

// ── Настройки ────────────────────────────────────────────────────────────────
// ⟳ в подписи — параметр применится после перезапуска симулятора.
const CFG_SCHEMA = [
  ['Подключение Gizmo ⟳', [
    ['gizmo.ip', 'IP', 'wide'], ['gizmo.port', 'Порт'], ['gizmo.username', 'Логин'],
    ['gizmo.password', 'Пароль', 'wide'], ['branchId', 'Бренч'],
  ]],
  ['SQL для AppStat ⟳', [
    ['sql.host', 'Хост', 'wide'], ['sql.port', 'Порт'], ['sql.database', 'База'],
    ['sql.user', 'Логин'], ['sql.password', 'Пароль', 'wide'],
  ]],
  ['Симуляция', [
    ['players', 'Ботов на старте ⟳'], ['maxPlayers', 'Максимум игроков'],
    ['tickSeconds', 'Тик, сек'], ['speed', 'Ускорение ×'], ['uiPort', 'Порт веб-интерфейса ⟳'],
  ]],
  ['Сессии (минуты клуба)', [
    ['session.minMinutes', 'Минимум'], ['session.maxMinutes', 'Максимум'],
    ['session.earlyLeaveChance', 'Шанс раннего ухода'],
  ]],
  ['Кулдауны привычек, мин', [
    ['habits.orderCooldownMin.0', 'Заказ бара: от'], ['habits.orderCooldownMin.1', 'Заказ бара: до'],
    ['habits.depositCooldownMin.0', 'Пополнение: от'], ['habits.depositCooldownMin.1', 'Пополнение: до'],
    ['habits.assetCooldownMin.0', 'Ассеты: от'], ['habits.assetCooldownMin.1', 'Ассеты: до'],
  ]],
  ['Оператор', [
    ['operator.orderPrepMinutes.0', 'Готовка заказа: от'], ['operator.orderPrepMinutes.1', 'Готовка заказа: до'],
    ['operator.saleCooldownMin.0', 'Продажа на кассе: от'], ['operator.saleCooldownMin.1', 'Продажа на кассе: до'],
    ['operator.shiftHours', 'Смена, часов'],
  ]],
  ['Веса событий (за тик)', [
    ['weights.arrive', '🪑 Посадка'], ['weights.groupArrive', '👥 Компания'], ['weights.order', '🍔 Заказ бара'],
    ['weights.buyTime', '⏱ Пакет времени'], ['weights.deposit', '💵 Пополнение'], ['weights.reserve', '📅 Бронь'],
    ['weights.asset', '🎧 Ассет'], ['weights.appSession', '🎮 Игра (SQL)'], ['weights.operatorSale', '🧾 Касса'],
    ['weights.life', '💬 Жизнь'], ['weights.newcomer', '📝 Новый игрок'], ['weights.tournament', '🏆 Турнир'],
  ]],
]

let cfgData = null
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o)
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v }

async function openSettings() {
  cfgData = await fetch('/api/config').then(r => r.json())
  $('cfggroups').innerHTML = CFG_SCHEMA.map(([title, items]) =>
    '<div class="cfg-group"><h3>' + esc(title) + '</h3>' + items.map(([path, label, cls]) => {
      const val = getPath(cfgData, path)
      return '<div class="cfg-row"><label>' + esc(label) + '</label>' +
        '<input class="' + (cls ?? '') + '" data-path="' + path + '" value="' + esc(val ?? '') + '"></div>'
    }).join('') + '</div>').join('')
  $('settings').classList.add('open')
}

$('cfgbtn').onclick = () => $('settings').classList.contains('open')
  ? $('settings').classList.remove('open')
  : openSettings()

// Пауза и форс-события.
const act = (name) => fetch('/api/action', { method: 'POST', body: JSON.stringify({ name }) }).then(() => refresh())
$('pausebtn').onclick = () => act($('pausebtn').dataset.state === 'paused' ? 'resume' : 'pause')
for (const b of document.querySelectorAll('[data-act]')) b.onclick = () => act(b.dataset.act)

$('cfgsave').onclick = async () => {
  for (const input of document.querySelectorAll('#cfggroups input')) {
    const path = input.dataset.path
    const old = getPath(cfgData, path)
    const raw = input.value.trim()
    // Тип берём из текущего значения; пустая строка для null-полей остаётся null.
    const val = (typeof old === 'number') ? Number(raw)
      : (old === null && raw === '') ? null
      : raw
    if (typeof old === 'number' && Number.isNaN(val)) continue
    setPath(cfgData, path, val)
  }
  const r = await fetch('/api/config', { method: 'POST', body: JSON.stringify(cfgData) }).then(r => r.json())
  $('cfgmsg').textContent = r.ok ? '✓ сохранено — параметры с ⟳ применятся после перезапуска' : '✗ ' + (r.error ?? 'ошибка')
  $('cfgmsg').style.color = r.ok ? 'var(--green)' : 'var(--red)'
  setTimeout(() => { $('cfgmsg').textContent = '' }, 6000)
}

const feed = $('feed')
new EventSource('/events').onmessage = (e) => {
  const { t, msg } = JSON.parse(e.data)
  const row = document.createElement('div')
  row.innerHTML = '<span class="t">' + esc(t) + '</span>' + esc(msg)
  feed.appendChild(row)
  while (feed.children.length > 250) feed.removeChild(feed.firstChild)
  feed.scrollTop = feed.scrollHeight
}
</script></body></html>`

// ── /club — pixel top-down view: hall, bots walk/play, event bubbles ────────
const PAGE_CLUB = /* html */ `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Клуб — вид сверху</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#21262d; --text:#e6edf3; --dim:#8b949e; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.4 system-ui,'Segoe UI',sans-serif; padding:14px; }
  header { display:flex; gap:14px; align-items:baseline; margin-bottom:10px; flex-wrap:wrap; }
  header h1 { font-size:17px; }
  header .meta { color:var(--dim); font-size:13px; }
  a.btn { margin-left:auto; background:var(--panel); border:1px solid var(--line); color:var(--text);
          border-radius:8px; padding:6px 14px; font-size:13px; text-decoration:none; }
  a.btn:hover { border-color:#58a6ff; }
  #wrap { background:#07090d; border:1px solid var(--line); border-radius:12px; padding:8px; }
  canvas { width:100%; height:calc(100vh - 104px); display:block; border-radius:6px; cursor:grab; touch-action:none; }
</style></head><body>
<header>
  <h1>🕹 Клуб — вид сверху</h1>
  <span class="meta" id="meta">подключение…</span>
  <span class="meta" style="opacity:.6">колесо — зум · тяни — перемещение · двойной клик — вписать</span>
  <button class="btn" id="repToggle" style="margin-left:auto; cursor:pointer">📊 Отчёты</button>
  <a class="btn" href="/" style="margin-left:0">← Дашборд</a>
</header>
<div id="wrap"><canvas id="cv"></canvas></div>
<script>
const cv = document.getElementById('cv'), ctx = cv.getContext('2d')
const T = 16
const TRAITC = { 'задрот':'#4a90d9', 'казуал':'#3fb950', 'гурман':'#e0823d', 'молчун':'#78828c', 'залётный':'#d2b322', 'стример':'#e85aad' }
const HAIRS = ['#2b2019','#5b3a21','#c9a15a','#1c1c22','#7a2e1d','#4b4e57','#8a5db0','#a03b2a','#3a5a8c']
const PANTS = ['#2f5aa8','#20242e','#5b3a21','#3a3f4a','#43356b','#2c463c']  // джинсы/штаны
const hsh = (s) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

let built = false, desks = [], deskByName = new Map()
let actors = new Map(), banners = [], opBubble = null, stateData = null, inited = false
let afkHostNames = new Set()      // хосты, у которых игрок вышел покурить (AFK)
const DOOR = { x: 508, y: 588 }   // проём во входной стене
const BAR = { x: 130, y: 490 }   // куда встают клиенты ПЕРЕД стойкой (сверху)
const OP = { x: 178, y: 538 }    // оператор ЗА стойкой (ниже, у полок)
const WORLD_H = 664              // высота сцены с учётом улицы-курилки снизу
const SMOKE = { y: 632 }         // курилка на улице (ниже входной стены)
const WC = { x: 332, y: 505 }    // туалет — внутри, слева от входа
const smokeSpot = (u) => ({ x: 424 + (hsh(u + 'smk') % 5) * 34, y: SMOKE.y })
// Все состояния «человек отошёл» — на его хосте показываем AFK.
const AWAY_STATES = new Set(['tosmoke', 'tosmoke2', 'smoking', 'fromsmoke', 'fromsmoke2', 'towc', 'inwc', 'fromwc'])

function classify(name) {
  if (/vip/i.test(name)) return 'vip'
  if (/boot/i.test(name)) return 'boot'
  return 'pc'
}
const num = (name) => Number((String(name).match(/\\d+/) || [999])[0])

function buildLayout(hosts) {
  desks = []; deskByName = new Map()
  const pcs = hosts.filter(h => classify(h.name) === 'pc').sort((a, b) => num(a.name) - num(b.name))
  const vips = hosts.filter(h => classify(h.name) === 'vip').sort((a, b) => num(a.name) - num(b.name))
  const boots = hosts.filter(h => classify(h.name) === 'boot').sort((a, b) => num(a.name) - num(b.name))
  const add = (h, tx, ty, zone) => {
    const x = tx * T, y = ty * T
    // Место — ниже стола: персонаж сидит ПЕРЕД монитором (лицом к камере).
    const d = { name: h.name, x, y, zone, seat: { x: x + 18, y: y + 44 } }
    desks.push(d); deskByName.set(h.name, d)
  }
  const cons = hosts.filter(h => (h.maxUsers ?? 1) > 1 || h.type === 'endpoint')
    .sort((a, b) => num(a.name) - num(b.name))
  const consSet = new Set(cons.map(h => h.name))
  pcs.filter(h => !consSet.has(h.name)).forEach((h, i) => add(h, 3 + (i % 6) * 5, 4 + Math.floor(i / 6) * 5, 'pc'))
  // Шаг 5 тайлов: имя сидящего (y+56) не должно наезжать на подпись следующего
  // ряда (y_next−9) — при шаге 4 они совпадали («Тоха» поверх «BOOT 4»).
  vips.forEach((h, i) => add(h, 37 + (i % 2) * 12, 3 + Math.floor(i / 2) * 5, 'vip'))
  boots.forEach((h, i) => add(h, 37 + (i % 2) * 12, 18 + Math.floor(i / 2) * 5, 'boot'))
  // Консоли: ТВ + диван на несколько мест (слоты вдоль дивана)
  cons.forEach((h, i) => {
    const tx = 36 + (i % 2) * 13, ty = 30
    const x = tx * T, y = ty * T
    const seats = []
    const cap = Math.min(4, h.maxUsers ?? 4)
    for (let s = 0; s < cap; s++) seats.push({ x: x + 10 + s * 15, y: y + 44 })
    const d = { name: h.name, x, y, zone: 'cons', seat: seats[0], seats, slots: {}, cap }
    desks.push(d); deskByName.set(h.name, d)
  })
  built = true
}

// Слот на диване: у каждого сидящего своё место, освобождается при уходе.
function seatFor(desk, u) {
  if (!desk.seats) return desk.seat
  if (desk.slots[u] == null) {
    const used = new Set(Object.values(desk.slots))
    let idx = 0
    while (used.has(idx) && idx < desk.seats.length - 1) idx++
    desk.slots[u] = idx
  }
  return desk.seats[desk.slots[u]]
}
function freeSlots(u, exceptDesk) {
  for (const d of desks) if (d.slots && d !== exceptDesk) delete d.slots[u]
}

function mkActor(u, bot, atSeat, seat) {
  return {
    u, name: bot.name, trait: bot.trait,
    x: atSeat ? seat.x : DOOR.x, y: atSeat ? seat.y : DOOR.y,
    st: atSeat ? 'sit' : 'walkin', target: seat, seat,
    bubble: null,
    hair: HAIRS[hsh(u) % HAIRS.length],
    shirt: TRAITC[bot.trait] || '#4a90d9',
    pants: PANTS[hsh(u + 'p') % PANTS.length],
    hairStyle: hsh(u + 'h') % 4,
  }
}

async function poll() {
  try {
    const s = await fetch('/api/state').then(r => r.json())
    stateData = s
    if (!built && s.hosts.length) buildLayout(s.hosts)
    if (!built) return
    const seatedU = new Set()
    for (const b of s.bots) {
      if (!b.hostName) continue
      const desk = deskByName.get(b.hostName)
      if (!desk) continue
      seatedU.add(b.username)
      freeSlots(b.username, desk)
      const seat = seatFor(desk, b.username)
      const a = actors.get(b.username)
      if (!a) {
        const na = mkActor(b.username, b, !inited, seat)
        na.couch = desk.zone === 'cons'  // на диване кресло не рисуем
        na.hostName = b.hostName
        actors.set(b.username, na)
      } else {
        a.couch = desk.zone === 'cons'
        a.hostName = b.hostName
        // не сбрасываем цель, если человек вышел покурить (SMOKE_STATES)
        if (a.seat !== seat && (a.st === 'sit' || a.st === 'walkin')) {
          a.seat = seat; a.target = seat; if (a.st === 'sit') a.st = 'walkin'
        }
      }
    }
    for (const [u, a] of actors) {
      // не выгоняем тех, кто у бара или отошёл (курилка/туалет) — пусть завершат
      if (!seatedU.has(u) && a.st !== 'walkout' && a.st !== 'tobar' && a.st !== 'atbar'
          && a.st !== 'back' && !AWAY_STATES.has(a.st)) {
        a.st = 'walkout'; a.target = DOOR
      }
    }
    inited = true
    document.getElementById('meta').textContent =
      'в клубе ' + s.bots.filter(b => b.hostName).length + ' из ' + s.bots.length +
      ' · касса ' + Math.round(s.revenue) + ' · заказов в очереди ' + s.orders.length + (s.paused ? ' · ⏸ ПАУЗА' : '')
  } catch {}
}
poll(); setInterval(poll, 2500)

// ── События → облачка ────────────────────────────────────────────────────────
const short = (msg) => {
  const parts = msg.split(') ')
  let tail = parts.length > 1 ? parts.slice(1).join(') ') : msg
  const em = Array.from(msg)[0]
  tail = tail.replace(/\\s*—.*$/, '').replace(/\\s*\\(комментарий.*$/, '')
  if (tail.length > 46) tail = tail.slice(0, 45) + '…'
  return em + ' ' + tail
}
new EventSource('/events').onmessage = (e) => {
  const { msg } = JSON.parse(e.data)
  const em = Array.from(msg)[0]
  if ('🏆🌅📝🕐⚙⏸▶'.includes(em)) { banners.push({ text: msg.length > 90 ? msg.slice(0, 89) + '…' : msg, until: Date.now() + 6000 }); return }
  const mu = msg.match(/\\((sim_bot_\\d+)\\)/)
  if (mu && actors.has(mu[1])) {
    const a = actors.get(mu[1])
    a.bubble = { text: short(msg), until: Date.now() + 6000 }
    if (em === '🍔' && a.st === 'sit') { a.st = 'tobar'; a.target = { x: BAR.x + (hsh(a.u) % 60), y: BAR.y } }
    // «вышел покурить» — реально идёт на улицу через вход (хост остаётся занят/AFK)
    else if (/покурить/.test(msg) && a.st === 'sit') {
      a.st = 'tosmoke'; a.target = DOOR; a.smokeSpot = smokeSpot(a.u)
    }
    // «в туалет» — отходит в WC внутри клуба и возвращается
    else if (/туалет/.test(msg) && a.st === 'sit') {
      a.st = 'towc'; a.target = { x: WC.x + (hsh(a.u) % 12) - 6, y: WC.y }
    }
    else if (/телефон|мемы/.test(msg)) a.phoneUntil = Date.now() + 6000  // подсветка телефона
    return
  }
  if (msg.includes('оператор') || '💸✅👨‍🍳🧾🚫⚠'.includes(em)) {
    opBubble = { text: msg.length > 52 ? msg.slice(0, 51) + '…' : msg, until: Date.now() + 5000 }
  }
}

// ── Отрисовка ────────────────────────────────────────────────────────────────
// ── Terraria-стиль: обводка + затенение ─────────────────────────────────────
const OUTLINE = '#0a0c10'
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16)
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt }
  else { const f = 1 + amt; r *= f; g *= f; b *= f }
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'
}
// Прямоугольник с тёмной обводкой (как тайл в Террарии)
function outlineRect(x, y, w, h, color) {
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h)
}

// Экран «в игре»: не рандомные блёстки, а анимированная сцена — небо/земля,
// бегущий персонаж, редкие вспышки-выстрелы + мягкое пульсирующее свечение.
const SCENE = [
  { sky: '#122438', ground: '#1e3a24', accent: '#54d17a' },  // лес
  { sky: '#241a2e', ground: '#3a2340', accent: '#c56ae0' },  // ночь
  { sky: '#2a1815', ground: '#3a241a', accent: '#e08a3a' },  // пустыня
  { sky: '#101c2e', ground: '#20303e', accent: '#5aa8e0' },  // море
]
function drawScreen(x, y, w, h, seed, t) {
  const sc = SCENE[seed % SCENE.length]
  const gy = Math.round(h * 0.62)
  // Обрезаем всё содержимое строго по прямоугольнику экрана — иначе холмы,
  // герой и вспышки «вылезают» за рамку монитора.
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
  ctx.fillStyle = sc.sky; ctx.fillRect(x, y, w, gy)
  ctx.fillStyle = sc.ground; ctx.fillRect(x, y + gy, w, h - gy)
  ctx.fillStyle = shade(sc.ground, 0.15); ctx.fillRect(x, y + gy, w, 1)
  // параллакс-холмы (скроллятся)
  const off = Math.floor((t / 40 + seed * 7)) % (w + 8)
  ctx.fillStyle = shade(sc.sky, 0.12)
  for (let i = -1; i < w / 10 + 1; i++) {
    const hx = x + ((i * 10 - off % 10) )
    ctx.fillRect(hx, y + gy - 3, 6, 3)
  }
  // бегущий персонаж-пиксель (прыжки)
  const px = x + 3 + Math.floor((t / 55 + seed) % (w - 6))
  const jump = Math.max(0, Math.sin(t / 130 + seed) * 4) | 0
  ctx.fillStyle = sc.accent; ctx.fillRect(px, y + gy - 4 - jump, 3, 4)
  // враги навстречу
  const ex = x + w - 4 - Math.floor((t / 70 + seed * 3) % (w - 6))
  ctx.fillStyle = '#f0563f'; ctx.fillRect(ex, y + gy - 3, 3, 3)
  // редкая вспышка-выстрел
  if ((Math.floor(t / 90) + seed) % 5 === 0) {
    ctx.fillStyle = '#fff6c0'; ctx.fillRect(px + 3, y + gy - 3 - jump, Math.min(ex - px - 3, w), 1)
  }
  // HUD-полоска
  ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(x + 1, y + 1, w - 2, 2)
  ctx.fillStyle = sc.accent; ctx.fillRect(x + 1, y + 1, Math.max(2, (w - 2) * (0.4 + 0.5 * Math.abs(Math.sin(t / 700 + seed)))), 2)
  // мягкое свечение экрана (пульс)
  const glow = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin(t / 380 + seed))
  ctx.fillStyle = 'rgba(150,200,255,' + glow.toFixed(3) + ')'; ctx.fillRect(x, y, w, h)
  ctx.restore()
}

// Ореол свечения вокруг включённого экрана (в тёмном зале)
function screenHalo(x, y, w, h, t, seed) {
  const a = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(t / 380 + seed))
  const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 2, x + w / 2, y + h / 2, w)
  g.addColorStop(0, 'rgba(120,180,255,' + (a * 2).toFixed(3) + ')')
  g.addColorStop(1, 'rgba(120,180,255,0)')
  ctx.fillStyle = g; ctx.fillRect(x - w / 2, y - h / 2, w * 2, h * 2)
}

function drawFridge(x, y) {
  outlineRect(x, y, 32, 42, '#c4c9d0')                          // корпус
  ctx.fillStyle = '#dde1e7'; ctx.fillRect(x + 1, y + 1, 30, 4)  // блик сверху
  ctx.fillStyle = '#9aa1ab'; ctx.fillRect(x, y + 20, 32, 2)     // шов между дверями
  ctx.fillStyle = '#5f656e'; ctx.fillRect(x + 26, y + 6, 3, 10) // ручки
  ctx.fillRect(x + 26, y + 25, 3, 12)
  ctx.fillStyle = '#8b9099'; ctx.fillRect(x + 26, y + 6, 1, 10); ctx.fillRect(x + 26, y + 25, 1, 12)
  // стеклянная витрина снизу с едой/напитками
  outlineRect(x + 4, y + 24, 18, 14, '#16222e')
  const food = ['#e0823d', '#3fb950', '#f0c674', '#e85aad', '#58a6ff']
  for (let i = 0; i < 5; i++) { ctx.fillStyle = food[i]; ctx.fillRect(x + 6 + (i % 3) * 5, y + 27 + (i > 2 ? 5 : 0), 4, 4) }
}

// Задний бар: стеллаж с бутылками + два холодильника
function drawBackBar() {
  const by = 556
  // стеллаж со стеклянными полками
  outlineRect(16, by, 150, 32, '#3a2c1c')
  ctx.fillStyle = '#4d3a25'; ctx.fillRect(18, by + 2, 146, 3)
  ctx.fillStyle = 'rgba(90,120,140,.25)'; ctx.fillRect(18, by + 13, 146, 3)   // стеклянная полка
  ctx.fillStyle = 'rgba(90,120,140,.25)'; ctx.fillRect(18, by + 26, 146, 3)
  const bcol = ['#3fb950', '#e0823d', '#58a6ff', '#e85aad', '#d2b322', '#f85149', '#2dd4bf', '#8b5cf6']
  for (let i = 0; i < 16; i++) {
    const c = bcol[i % bcol.length]
    const row = i < 8 ? by + 6 : by + 19
    const bx = 22 + (i % 8) * 18
    ctx.fillStyle = OUTLINE; ctx.fillRect(bx - 1, row - 3, 6, 11)
    ctx.fillStyle = c; ctx.fillRect(bx, row, 4, 7)                 // бутылка
    ctx.fillStyle = shade(c, 0.35); ctx.fillRect(bx, row, 1, 7)   // блик
    ctx.fillStyle = '#6b5335'; ctx.fillRect(bx + 1, row - 2, 2, 2) // горлышко
  }
  drawFridge(188, by - 4)
  drawFridge(232, by - 4)
  // микроволновка / кофемашина на тумбе
  outlineRect(280, by + 6, 30, 22, '#2b3038')
  ctx.fillStyle = '#161a20'; ctx.fillRect(283, by + 9, 18, 12)
  ctx.fillStyle = '#3fb950'; ctx.fillRect(303, by + 10, 4, 2)
  ctx.fillStyle = '#d29922'; ctx.fillRect(303, by + 14, 4, 6)
}

// Дымок над курящим (пиксельные клубы, поднимаются и тают)
function drawSmoke(x, y, t) {
  for (let i = 0; i < 3; i++) {
    const ph = (t / 1000 + i * 0.34) % 1
    const px = x + Math.sin(t / 500 + i * 2) * 3
    const py = y - ph * 22
    const a = (1 - ph) * 0.45
    const r = 2 + ph * 3
    ctx.fillStyle = 'rgba(205,210,215,' + a.toFixed(3) + ')'
    ctx.fillRect(Math.round(px - r / 2), Math.round(py - r / 2), Math.round(r), Math.round(r))
  }
}

// Клубный кот — бродит по залу, иногда замирает
let cat = { x: 260, y: 300, tx: 260, ty: 300, next: 0, dir: 1, moving: false }
function updateCat(t, dt) {
  if (t > cat.next) {
    cat.tx = 40 + Math.random() * 440
    cat.ty = 70 + Math.random() * 380
    cat.next = t + 3500 + Math.random() * 5000
  }
  const dx = cat.tx - cat.x, dy = cat.ty - cat.y, d = Math.hypot(dx, dy)
  if (d > 2) { cat.x += dx / d * 0.045 * dt; cat.y += dy / d * 0.045 * dt; cat.dir = dx < 0 ? -1 : 1; cat.moving = true }
  else cat.moving = false
}
function drawCat(t) {
  const x = Math.round(cat.x), y = Math.round(cat.y), d = cat.dir
  const b = '#42474f'
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x - 6, y, 13, 2)
  // хвост качается
  const tw = Math.round(Math.sin(t / 300) * 2)
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - d * 8 - 1, y - 7 + tw, 4, 6)
  ctx.fillStyle = b; ctx.fillRect(x - d * 8, y - 6 + tw, 2, 4)
  // тело
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 6, y - 6, 12, 6)
  ctx.fillStyle = b; ctx.fillRect(x - 5, y - 5, 10, 4)
  ctx.fillStyle = shade(b, 0.2); ctx.fillRect(x - 5, y - 5, 10, 1)
  // лапки
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 4, y - 1, 2, 3); ctx.fillRect(x + 2, y - 1, 2, 3)
  // голова по направлению
  const hx = x + d * 5
  ctx.fillStyle = OUTLINE; ctx.fillRect(hx - 3, y - 9, 7, 7)
  ctx.fillStyle = b; ctx.fillRect(hx - 2, y - 8, 5, 5)
  ctx.fillStyle = OUTLINE; ctx.fillRect(hx - 2, y - 11, 2, 2); ctx.fillRect(hx + 1, y - 11, 2, 2)  // ушки
  ctx.fillStyle = b; ctx.fillRect(hx - 2, y - 10, 1, 1); ctx.fillRect(hx + 2, y - 10, 1, 1)
  ctx.fillStyle = '#8fe36a'; ctx.fillRect(hx + (d > 0 ? 1 : 0), y - 6, 1, 1)  // глаз
}

function drawPlant(x, y) {
  outlineRect(x - 4, y, 8, 9, '#8a5a2b')                 // горшок
  ctx.fillStyle = '#a06a34'; ctx.fillRect(x - 4, y, 8, 2)
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 7, y - 12, 14, 13)
  ctx.fillStyle = '#2f7d3a'; ctx.fillRect(x - 6, y - 11, 12, 12) // листва
  ctx.fillStyle = '#3f9a4a'; ctx.fillRect(x - 4, y - 9, 5, 5)
  ctx.fillStyle = '#276634'; ctx.fillRect(x + 1, y - 4, 4, 4)
}

function drawClock(cx, cy) {
  ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(cx, cy, 10, 0, 7); ctx.fill()
  ctx.fillStyle = '#e8eaed'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 7); ctx.fill()
  const now = new Date()
  const hA = ((now.getHours() % 12) / 12) * Math.PI * 2 - Math.PI / 2 + (now.getMinutes() / 60) * (Math.PI / 6)
  const mA = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2
  ctx.strokeStyle = '#2a2f38'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(hA) * 4.5, cy + Math.sin(hA) * 4.5); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(mA) * 7, cy + Math.sin(mA) * 7); ctx.stroke()
  ctx.fillStyle = '#c04040'; ctx.fillRect(cx - 1, cy - 1, 2, 2)
}

// Улица за входом: тротуар, лавочка, урна-пепельница, фонарь со светом, куст
function drawOutdoor(t) {
  ctx.fillStyle = '#090b0f'; ctx.fillRect(0, 600, 1024, 64)          // ночная улица
  ctx.fillStyle = '#171a20'; ctx.fillRect(360, 600, 320, 60)         // тротуар
  for (let x = 360; x < 680; x += 20) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, 600, 1, 60) }
  // свет фонаря (тёплый круг на тротуаре)
  const g = ctx.createRadialGradient(650, 626, 4, 650, 626, 70)
  g.addColorStop(0, 'rgba(255,220,140,.22)'); g.addColorStop(1, 'rgba(255,220,140,0)')
  ctx.fillStyle = g; ctx.fillRect(580, 600, 140, 64)
  // столб фонаря
  ctx.fillStyle = '#2a2f38'; ctx.fillRect(648, 604, 4, 22)
  outlineRect(642, 600, 16, 6, '#d9b45a'); ctx.fillStyle = '#fff3c0'; ctx.fillRect(644, 601, 12, 3)
  // лавочка
  outlineRect(384, 636, 60, 6, '#5b3a21'); ctx.fillStyle = '#6d4a29'; ctx.fillRect(384, 636, 60, 2)
  outlineRect(388, 642, 4, 8, '#3a2416'); outlineRect(436, 642, 4, 8, '#3a2416')
  outlineRect(384, 628, 60, 3, '#4a3020')  // спинка
  // урна-пепельница
  outlineRect(560, 632, 10, 14, '#3a3f47'); ctx.fillStyle = '#20242c'; ctx.fillRect(562, 634, 6, 2)
  // куст
  ctx.fillStyle = OUTLINE; ctx.fillRect(486, 632, 20, 14); ctx.fillStyle = '#25602f'; ctx.fillRect(487, 633, 18, 12)
  ctx.fillStyle = '#317a3c'; ctx.fillRect(490, 635, 6, 5); ctx.fillStyle = '#276634'; ctx.fillRect(498, 638, 5, 4)
  // подпись
  ctx.fillStyle = 'rgba(139,148,158,.55)'; ctx.font = 'bold 10px monospace'; ctx.fillText('🚬 КУРИЛКА', 384, 616)
}

// Туалет — маленькая комнатка внутри слева от входа
function drawWC() {
  outlineRect(WC.x - 26, WC.y - 30, 52, 44, '#1c222a')            // стены/пол комнаты
  ctx.fillStyle = '#232b34'
  for (let yy = WC.y - 28; yy < WC.y + 12; yy += 8) for (let xx = WC.x - 24; xx < WC.x + 24; xx += 8)
    if ((xx + yy) % 16 === 0) ctx.fillRect(xx, yy, 8, 8)
  // кабинки
  outlineRect(WC.x - 22, WC.y - 24, 18, 22, '#2f3944')
  outlineRect(WC.x + 4, WC.y - 24, 18, 22, '#2f3944')
  ctx.fillStyle = '#c8ccd2'; ctx.fillRect(WC.x - 18, WC.y - 20, 10, 12); ctx.fillRect(WC.x + 8, WC.y - 20, 10, 12) // унитазы
  ctx.fillStyle = 'rgba(139,148,158,.6)'; ctx.font = 'bold 10px monospace'; ctx.fillText('WC', WC.x - 8, WC.y - 34)
}

// Торговый автомат: светящаяся витрина с банками, работает и ночью
function drawVending(x, y, t) {
  const pulse = 0.25 + 0.08 * Math.sin(t / 600)
  const g = ctx.createRadialGradient(x + 13, y + 20, 4, x + 13, y + 20, 42)
  g.addColorStop(0, 'rgba(120,200,255,' + pulse.toFixed(3) + ')'); g.addColorStop(1, 'rgba(120,200,255,0)')
  ctx.fillStyle = g; ctx.fillRect(x - 28, y - 20, 82, 84)
  outlineRect(x, y, 26, 44, '#1f3a5c')                                  // корпус
  ctx.fillStyle = '#2c4f7c'; ctx.fillRect(x, y, 26, 3)
  outlineRect(x + 3, y + 5, 15, 28, '#0e1c2e')                          // витрина
  const cans = ['#f85149', '#3fb950', '#d29922', '#e85aad', '#58a6ff', '#2dd4bf']
  for (let i = 0; i < 6; i++) { ctx.fillStyle = cans[i]; ctx.fillRect(x + 5 + (i % 2) * 6, y + 8 + Math.floor(i / 2) * 8, 4, 6) }
  ctx.fillStyle = 'rgba(160,220,255,.18)'; ctx.fillRect(x + 3, y + 5, 15, 28)  // стекло
  ctx.fillStyle = '#11151b'; ctx.fillRect(x + 20, y + 8, 4, 12)               // панель
  ctx.fillStyle = '#3fb950'; ctx.fillRect(x + 21, y + 9, 2, 2)
  ctx.fillStyle = '#0b0f14'; ctx.fillRect(x + 4, y + 36, 18, 5)               // лоток выдачи
}

function drawProps(t) {
  // неоновая вывеска над залом
  ctx.textAlign = 'center'; ctx.font = 'bold 15px system-ui'
  ctx.shadowColor = '#58a6ff'; ctx.shadowBlur = 10
  ctx.fillStyle = '#7cc0ff'; ctx.fillText('GIZMO', 250, 46)
  ctx.shadowBlur = 0; ctx.textAlign = 'left'
  // торговый автомат у стены зала
  drawVending(494, 320, t)
  // растения по углам зала
  drawPlant(505, 60); drawPlant(30, 470); drawPlant(505, 250)
  // часы на верхней стене
  drawClock(430, 40)
  // коврик у входа
  outlineRect(478, 560, 64, 24, '#3a2c40'); ctx.fillStyle = '#4a3a52'; ctx.fillRect(482, 564, 56, 16)
  ctx.fillStyle = '#5c4a66'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillText('WELCOME', 510, 574); ctx.textAlign = 'left'
  // постеры на верхней стене
  const pcol = ['#f85149', '#3fb950', '#d29922']
  for (let i = 0; i < 3; i++) { outlineRect(60 + i * 34, 10, 24, 16, '#11151b'); ctx.fillStyle = pcol[i]; ctx.fillRect(63 + i * 34, 13, 18, 6); ctx.fillStyle = '#586170'; ctx.fillRect(63 + i * 34, 20, 18, 3) }
  drawWC()
}

function drawFloor(t) {
  for (let ty = 0; ty < 38; ty++) for (let tx = 0; tx < 64; tx++) {
    let c = (tx + ty) % 2 ? '#14161c' : '#171a21'
    if (tx >= 33 && ty >= 2 && ty <= 15) c = (tx + ty) % 2 ? '#1a1526' : '#1d1729'   // VIP
    if (tx >= 33 && ty >= 17 && ty <= 26) c = (tx + ty) % 2 ? '#0f1b18' : '#121f1b'  // BOOT
    if (tx >= 33 && ty >= 27) c = (tx + ty) % 2 ? '#211318' : '#24151b'              // КОНСОЛИ
    if (ty >= 30 && tx <= 20) c = (tx + ty) % 2 ? '#221a12' : '#251d14'              // бар
    ctx.fillStyle = c; ctx.fillRect(tx * T, ty * T, T, T)
  }
  // стены
  ctx.fillStyle = '#2a3038'
  ctx.fillRect(0, 0, 1024, 6); ctx.fillRect(0, 0, 6, 600); ctx.fillRect(1018, 0, 6, 600); ctx.fillRect(0, 594, 1024, 6)
  ctx.fillRect(526, 6, 5, 554)   // стена VIP/BOOT/КОНСОЛИ (внизу проход)
  ctx.fillRect(531, 268, 490, 5) // перегородка VIP|BOOT
  ctx.fillRect(531, 428, 490, 5) // перегородка BOOT|КОНСОЛИ
  // дверь
  ctx.fillStyle = '#0d1117'; ctx.fillRect(488, 590, 44, 10)
  ctx.fillStyle = '#d29922'; ctx.fillRect(488, 588, 44, 3)
  // подписи зон — лёгкий неон в цвет зоны
  ctx.font = 'bold 11px monospace'
  const neon = (txt, x, y, color) => {
    ctx.shadowColor = color; ctx.shadowBlur = 7
    ctx.fillStyle = color; ctx.fillText(txt, x, y)
    ctx.shadowBlur = 0
  }
  neon('ЗАЛ', 16, 24, 'rgba(139,168,198,.8)')
  neon('VIP', 544, 24, 'rgba(190,140,235,.85)')
  neon('BOOTCAMP', 544, 292, 'rgba(110,205,140,.8)')
  neon('КОНСОЛИ', 544, 452, 'rgba(235,130,150,.8)')
  neon('БАР', 14, 486, 'rgba(224,164,80,.85)')
  ctx.fillStyle = 'rgba(139,148,158,.5)'; ctx.fillText('ВХОД →', 430, 585)
  drawOutdoor(t)   // улица-курилка снизу
  drawProps(t)     // растения, часы, вывеска, постеры, коврик, туалет
  // задний бар (полки/холодильники) — рисуем ПЕРЕД оператором, он встаёт спереди
  drawBackBar()
  // барная стойка (клиенты подходят сверху, оператор — снизу за ней)
  outlineRect(20, 500, 310, 15, '#3a2c1c')
  ctx.fillStyle = '#5a4529'; ctx.fillRect(20, 500, 310, 3)          // столешница-блик
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(20, 512, 310, 3)  // тень нижнего края
  for (let i = 0; i < 310; i += 26) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(20 + i, 503, 1, 9) } // доски
  // заказы на столешнице (со стороны клиентов, сверху)
  const q = stateData ? stateData.orders.length : 0
  for (let i = 0; i < Math.min(q, 11); i++) {
    const ox = 30 + i * 26
    ctx.fillStyle = OUTLINE; ctx.fillRect(ox - 1, 490, 12, 10)
    ctx.fillStyle = i % 2 ? '#d29922' : '#e0823d'; ctx.fillRect(ox, 491, 10, 8)
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(ox, 491, 10, 2)
  }
}

function drawDesk(d, t) {
  const host = stateData ? stateData.hosts.find(h => h.name === d.name) : null
  const on = host ? host.busyBy : null
  if (d.zone === 'cons') { // консоль: большой ТВ + приставка + диван
    if (on) screenHalo(d.x, d.y - 8, 64, 22, t, hsh(d.name) % 7)
    outlineRect(d.x - 4, d.y - 12, 72, 30, '#242932')            // корпус ТВ
    ctx.fillStyle = '#333a46'; ctx.fillRect(d.x - 4, d.y - 12, 72, 2) // блик рамки
    outlineRect(d.x, d.y - 8, 64, 22, '#0a0d12')                      // экран
    if (on) drawScreen(d.x, d.y - 8, 64, 22, hsh(d.name) % 97, t)
    if (on && afkHostNames.has(d.name)) drawAfk(d.x, d.y - 8, 64, 22, t)
    outlineRect(d.x + 24, d.y + 20, 16, 5, '#1a1f27')            // приставка
    ctx.fillStyle = '#3fb950'; ctx.fillRect(d.x + 26, d.y + 22, 3, 1)
    // диван со спинкой и подлокотниками
    outlineRect(d.x - 2, d.y + 34, 68, 18, '#5a2e35')
    ctx.fillStyle = '#6d3941'; ctx.fillRect(d.x - 2, d.y + 34, 68, 5)
    ctx.fillStyle = shade('#5a2e35', -0.3); ctx.fillRect(d.x - 2, d.y + 49, 68, 3)
    outlineRect(d.x - 6, d.y + 34, 5, 18, '#4a252b'); outlineRect(d.x + 65, d.y + 34, 5, 18, '#4a252b')
    ctx.fillStyle = 'rgba(160,170,180,.75)'; ctx.font = 'bold 9px monospace'
    const cap = host && host.maxUsers > 1 ? ' ' + (host.sitters?.length ?? 0) + '/' + host.maxUsers : ''
    ctx.fillText(d.name + cap, d.x, d.y - 17)
    return
  }
  // монитор на ножке (обведённый, с бликом рамки)
  if (on) screenHalo(d.x + 6, d.y - 4, 24, 15, t, hsh(d.name) % 7)
  ctx.fillStyle = '#151920'; ctx.fillRect(d.x + 14, d.y + 11, 8, 4)  // ножка
  outlineRect(d.x + 4, d.y - 6, 28, 19, '#242932')
  ctx.fillStyle = '#333a46'; ctx.fillRect(d.x + 4, d.y - 6, 28, 2)    // блик рамки
  outlineRect(d.x + 6, d.y - 4, 24, 15, '#0a0d12')
  if (on) drawScreen(d.x + 6, d.y - 4, 24, 15, hsh(d.name) % 97, t)
  if (on && afkHostNames.has(d.name)) drawAfk(d.x + 6, d.y - 4, 24, 15, t)
  // стол
  const deskC = d.zone === 'vip' ? '#3d3450' : d.zone === 'boot' ? '#2c463c' : '#333a45'
  outlineRect(d.x, d.y + 14, 36, 12, deskC)
  ctx.fillStyle = shade(deskC, 0.18); ctx.fillRect(d.x, d.y + 14, 36, 2)   // блик столешницы
  ctx.fillStyle = shade(deskC, -0.3); ctx.fillRect(d.x, d.y + 24, 36, 2)   // тень
  // клавиатура и мышь
  outlineRect(d.x + 8, d.y + 17, 14, 5, '#232830')
  ctx.fillStyle = '#4b5563'
  for (let k = 0; k < 5; k++) ctx.fillRect(d.x + 9 + k * 2.6, d.y + 18, 2, 2)
  outlineRect(d.x + 26, d.y + 18, 3, 4, '#232830')
  // имя хоста над монитором
  ctx.fillStyle = 'rgba(160,170,180,.75)'; ctx.font = 'bold 9px monospace'
  ctx.fillText(d.name, d.x + 4, d.y - 9)
}

// Затемняем экран + значок «пауза» и мигающий AFK: игрок отошёл, хост занят.
function drawAfk(x, y, w, h, t) {
  ctx.fillStyle = 'rgba(6,8,12,.55)'; ctx.fillRect(x, y, w, h)
  const cx = x + w / 2, cy = y + h / 2 - 1
  ctx.fillStyle = '#d29922'; ctx.fillRect(cx - 3, cy - 3, 2, 6); ctx.fillRect(cx + 1, cy - 3, 2, 6)  // пауза
  if (Math.floor(t / 500) % 2) {
    ctx.fillStyle = '#f0c674'; ctx.font = 'bold 6px monospace'; ctx.textAlign = 'center'
    ctx.fillText('AFK', cx, y + h - 2); ctx.textAlign = 'left'
  }
}

// Причёска: аккуратная «шапка» по верху головы. БЕЗ боковых прядей вдоль лица —
// иначе голова выглядит как шлем/ушанка. Бока головы (кожа) остаются открытыми.
function drawHair(cx, fy, col, style) {
  const top = fy - 33            // верх головы
  const put = (ox, oy, w, h) => {
    ctx.fillStyle = OUTLINE; ctx.fillRect(cx + ox - 1, oy - 1, w + 2, h + 2)
    ctx.fillStyle = col; ctx.fillRect(cx + ox, oy, w, h)
  }
  if (style === 0) {            // короткая шапочка + лёгкая чёлка
    put(-5, top, 10, 4)
    ctx.fillStyle = col; ctx.fillRect(cx - 4, top + 4, 2, 1); ctx.fillRect(cx + 2, top + 4, 2, 1)
  } else if (style === 1) {     // причёска на пробор
    put(-5, top, 10, 4)
    ctx.fillStyle = shade(col, -0.35); ctx.fillRect(cx, top, 1, 4)
  } else if (style === 2) {     // короткий ёжик/спайки сверху
    ctx.fillStyle = OUTLINE
    for (let i = 0; i < 4; i++) ctx.fillRect(cx - 4 + i * 2 - 1, top - 3, 4, 5)
    ctx.fillStyle = col
    for (let i = 0; i < 4; i++) ctx.fillRect(cx - 4 + i * 2, top - 2, 2, 5)
    put(-5, top + 1, 10, 3)
  } else {                      // подлиннее: объём сверху + тонкие пряди у краёв
    put(-5, top - 1, 10, 5)
    ctx.fillStyle = col; ctx.fillRect(cx - 6, top + 3, 1, 5); ctx.fillRect(cx + 5, top + 3, 1, 5)
  }
  ctx.fillStyle = shade(col, 0.34); ctx.fillRect(cx - 4, top + 1, 6, 1)  // блик
}

function drawPerson(a, t) {
  const sit = a.st === 'sit'
  const walk = !sit && a.st !== 'atbar'
  const isOp = a.name === 'оператор'
  const x = Math.round(a.x), y = Math.round(a.y)
  const skin = '#e8b088', skinSh = shade(skin, -0.2)
  const pants = a.pants || '#20242e'
  const hairStyle = a.hairStyle ?? 0
  const bob = walk && Math.floor(t / 150) % 2 ? 1 : 0
  const yy = y - bob

  if (sit && !a.couch) { // компактная спинка офисного кресла (не «трон», не на диване)
    outlineRect(x - 7, yy - 22, 14, 18, '#252a34')
    ctx.fillStyle = '#333a48'; ctx.fillRect(x - 7, yy - 22, 14, 2)
  }
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - 7, y - 1, 14, 3) // тень

  // Части тела: обводка-проход, затем заливка. Голова отделена короткой шеей.
  const swing = walk ? (Math.floor(t / 150) % 2 ? 1 : -1) : 0
  const armC = shade(a.shirt, -0.24)
  const parts = [
    { x: x - 5 + (swing < 0 ? -1 : 0), y: yy - 12, w: 4, h: 10, c: pants },  // левая нога
    { x: x + 1 + (swing > 0 ? 1 : 0), y: yy - 12, w: 4, h: 10, c: pants },   // правая нога
    { x: x - 8, y: yy - 21, w: 3, h: 8, c: armC },                          // левая рука
    { x: x + 5, y: yy - 21, w: 3, h: 8, c: armC },                          // правая рука
    { x: x - 6, y: yy - 22, w: 12, h: 10, c: a.shirt },                     // торс
    { x: x - 1, y: yy - 24, w: 3, h: 2, c: skin },                          // шея (короткая)
    { x: x - 5, y: yy - 33, w: 10, h: 9, c: skin },                         // голова
  ]
  ctx.fillStyle = OUTLINE
  for (const p of parts) ctx.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2)
  for (const p of parts) { ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.w, p.h) }

  // ботинки
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 6, yy - 3, 5, 3); ctx.fillRect(x + 1, yy - 3, 5, 3)
  ctx.fillStyle = '#2b2f38'; ctx.fillRect(x - 6, yy - 3, 5, 1); ctx.fillRect(x + 1, yy - 3, 5, 1)
  // штаны: тень между ног + боковой блик
  ctx.fillStyle = shade(pants, -0.32); ctx.fillRect(x - 1, yy - 12, 2, 10)
  ctx.fillStyle = shade(pants, 0.2); ctx.fillRect(x - 5, yy - 12, 1, 9)
  // ремень
  ctx.fillStyle = '#1c2029'; ctx.fillRect(x - 6, yy - 13, 12, 2)
  ctx.fillStyle = '#b0873a'; ctx.fillRect(x - 1, yy - 13, 2, 2)
  // рубашка: блик сверху, тень снизу, центральная складка
  ctx.fillStyle = shade(a.shirt, 0.26); ctx.fillRect(x - 6, yy - 22, 12, 2)
  ctx.fillStyle = shade(a.shirt, -0.26); ctx.fillRect(x - 6, yy - 13, 12, 1)
  ctx.fillStyle = shade(a.shirt, -0.15); ctx.fillRect(x, yy - 21, 1, 8)
  // воротник у шеи
  ctx.fillStyle = shade(a.shirt, -0.3); ctx.fillRect(x - 3, yy - 22, 6, 1)
  // фартук бармена у оператора
  if (isOp) {
    ctx.fillStyle = '#e6e8ec'; ctx.fillRect(x - 4, yy - 19, 8, 8)
    ctx.fillStyle = '#c9ccd2'; ctx.fillRect(x - 4, yy - 19, 8, 1)
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 5, yy - 19, 1, 8); ctx.fillRect(x + 4, yy - 19, 1, 8)
  }
  // кисти рук
  ctx.fillStyle = skin; ctx.fillRect(x - 8, yy - 14, 3, 3); ctx.fillRect(x + 5, yy - 14, 3, 3)
  ctx.fillStyle = OUTLINE; ctx.fillRect(x - 8, yy - 11, 3, 1); ctx.fillRect(x + 5, yy - 11, 3, 1)
  // телефон в руке (когда «листает мемы»): корпус + светящийся экран
  if (a.phoneUntil && Date.now() < a.phoneUntil) {
    ctx.fillStyle = OUTLINE; ctx.fillRect(x + 4, yy - 17, 5, 7)
    ctx.fillStyle = ['#58a6ff', '#3fb950', '#e85aad'][Math.floor(t / 400) % 3]; ctx.fillRect(x + 5, yy - 16, 3, 5)
  }
  // лицо: тень щеки, крупные глаза, брови, рот
  ctx.fillStyle = skinSh; ctx.fillRect(x + 3, yy - 33, 2, 9)
  ctx.fillStyle = '#f6f6f6'; ctx.fillRect(x - 4, yy - 28, 3, 3); ctx.fillRect(x + 1, yy - 28, 3, 3)
  ctx.fillStyle = '#2a5a8c'; ctx.fillRect(x - 3, yy - 27, 2, 2); ctx.fillRect(x + 2, yy - 27, 2, 2)
  ctx.fillStyle = '#0f2c46'; ctx.fillRect(x - 3, yy - 27, 1, 1); ctx.fillRect(x + 2, yy - 27, 1, 1)
  ctx.fillStyle = shade(a.hair, -0.2); ctx.fillRect(x - 4, yy - 29, 3, 1); ctx.fillRect(x + 1, yy - 29, 3, 1) // брови
  ctx.fillStyle = skinSh; ctx.fillRect(x - 1, yy - 25, 3, 1)  // рот
  // волосы
  drawHair(x, yy, a.hair, hairStyle)

  // наушники у задротов/стримеров — на макушке, дужка сверху (не по бокам лица)
  if (a.trait === 'задрот' || a.trait === 'стример') {
    ctx.fillStyle = OUTLINE
    ctx.fillRect(x - 7, yy - 31, 2, 6); ctx.fillRect(x + 5, yy - 31, 2, 6); ctx.fillRect(x - 6, yy - 37, 12, 2)
    ctx.fillStyle = '#3a414d'; ctx.fillRect(x - 7, yy - 30, 1, 4); ctx.fillRect(x + 6, yy - 30, 1, 4)
    if (a.trait === 'стример') { ctx.fillStyle = '#f85149'; ctx.fillRect(x + 5, yy - 26, 3, 2) } // микрофон
  }

  // имя с тёмной обводкой (читаемо на любом фоне)
  ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineJoin = 'round'
  ctx.strokeText(a.name, x, y + 12)
  ctx.fillStyle = '#c2c9d2'; ctx.fillText(a.name, x, y + 12)
  ctx.textAlign = 'left'
}

function drawBubble(x, y, text, until, t) {
  const life = until - t
  if (life <= 0) return false
  const alpha = Math.min(1, life / 700)
  ctx.font = '10px system-ui'
  const lines = []
  let s = text
  while (s.length > 26) { lines.push(s.slice(0, 26)); s = s.slice(26) }
  lines.push(s)
  const w = Math.min(180, Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) + 12)
  const h = lines.length * 12 + 8
  let bx = Math.max(8, Math.min(1024 - w - 8, x - w / 2)), by = y - 26 - h
  if (by < 8) by = 8
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#f3f4f6'; ctx.fillRect(bx, by, w, h)
  ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x + 4, by + h); ctx.lineTo(x, by + h + 5); ctx.fill()
  ctx.fillStyle = '#111'
  lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + 13 + i * 12))
  ctx.globalAlpha = 1
  return true
}

// ── Камера: вписать в экран, пан тягой, зум колесом ─────────────────────────
const dpr = window.devicePixelRatio || 1
let cam = { z: 1, x: 0, y: 0 }
function resize() {
  cv.width = Math.max(100, cv.clientWidth) * dpr
  cv.height = Math.max(100, cv.clientHeight) * dpr
}
function fitCam() {
  resize()
  const z = Math.min(cv.clientWidth / 1024, cv.clientHeight / WORLD_H) * 0.98
  cam = { z, x: (cv.clientWidth - 1024 * z) / 2, y: (cv.clientHeight - WORLD_H * z) / 2 }
}
window.addEventListener('resize', fitCam)
fitCam()
let drag = null
cv.addEventListener('pointerdown', (e) => {
  drag = { mx: e.clientX, my: e.clientY, cx: cam.x, cy: cam.y }
  cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'
})
cv.addEventListener('pointermove', (e) => {
  if (drag) { cam.x = drag.cx + (e.clientX - drag.mx); cam.y = drag.cy + (e.clientY - drag.my) }
})
cv.addEventListener('pointerup', () => { drag = null; cv.style.cursor = 'grab' })
cv.addEventListener('wheel', (e) => {
  e.preventDefault()
  const r = cv.getBoundingClientRect()
  const mx = e.clientX - r.left, my = e.clientY - r.top
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const nz = Math.min(4, Math.max(0.35, cam.z * k))
  cam.x = mx - (mx - cam.x) * (nz / cam.z)
  cam.y = my - (my - cam.y) * (nz / cam.z)
  cam.z = nz
}, { passive: false })
cv.addEventListener('dblclick', fitCam)

let last = performance.now()
function frame(t) {
  const dt = Math.min(50, t - last); last = t
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#07090d'; ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight)
  ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y)
  if (!built) { ctx.fillStyle = '#8b949e'; ctx.font = '13px system-ui'; ctx.fillText('Ждём данные симулятора…', 420, 290); requestAnimationFrame(frame); return }

  // хосты, чьи игроки отошли (курилка/туалет) — показываем на них AFK
  afkHostNames = new Set()
  for (const [, a] of actors) if (AWAY_STATES.has(a.st) && a.hostName) afkHostNames.add(a.hostName)

  drawFloor(t)
  for (const d of desks) drawDesk(d, t)

  // клубный кот бродит по залу
  updateCat(t, dt); drawCat(t)

  // оператор
  drawPerson({ x: OP.x, y: OP.y, name: 'оператор', shirt: '#c74848', hair: '#2b2019', st: 'atbar', u: 'op' }, t)

  const now0 = Date.now()
  const speed = 0.11 * dt // ~110 px/с
  const toDelete = []
  const stationary = (st) => st === 'sit' || st === 'atbar' || st === 'smoking' || st === 'inwc'
  for (const [u, a] of actors) {
    if (!stationary(a.st)) {
      const dx = a.target.x - a.x, dy = a.target.y - a.y
      const dist = Math.hypot(dx, dy)
      if (dist < 3) {
        if (a.st === 'walkin') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
        else if (a.st === 'walkout') { toDelete.push(u); continue }
        else if (a.st === 'tobar') { a.st = 'atbar'; a.barUntil = now0 + 2600 }
        else if (a.st === 'back') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
        else if (a.st === 'tosmoke') { a.st = 'tosmoke2'; a.target = a.smokeSpot }        // вышел за дверь → к курилке
        else if (a.st === 'tosmoke2') { a.st = 'smoking'; a.smokeUntil = now0 + 8000 + (hsh(u) % 6000) }
        else if (a.st === 'fromsmoke') { a.st = 'fromsmoke2'; a.target = a.seat }         // назад через дверь → на место
        else if (a.st === 'fromsmoke2') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
        else if (a.st === 'towc') { a.st = 'inwc'; a.wcUntil = now0 + 4000 + (hsh(u) % 3000) }
        else if (a.st === 'fromwc') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
      } else { a.x += dx / dist * speed; a.y += dy / dist * speed }
    } else if (a.st === 'atbar' && now0 > a.barUntil) {
      a.st = 'back'; a.target = a.seat
    } else if (a.st === 'smoking' && now0 > a.smokeUntil) {
      a.st = 'fromsmoke'; a.target = DOOR
    } else if (a.st === 'inwc' && now0 > a.wcUntil) {
      a.st = 'fromwc'; a.target = a.seat
    }
    if (a.st === 'smoking') drawSmoke(a.x, a.y - 30, t)  // дымок над курящим
    if (a.st === 'inwc') continue                         // в туалете — не рисуем (он «внутри»)
    drawPerson(a, t)
  }
  for (const u of toDelete) { actors.delete(u); freeSlots(u, null) }
  // облачка — поверх всех
  const now = Date.now()
  for (const [, a] of actors) {
    if (a.bubble && !drawBubble(a.x, a.y - 20, a.bubble.text, a.bubble.until, now)) a.bubble = null
  }
  if (opBubble && !drawBubble(OP.x, OP.y - 20, opBubble.text, opBubble.until, now)) opBubble = null
  // баннеры — в экранных координатах, не зависят от камеры
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  banners = banners.filter(b => b.until > now)
  banners.slice(0, 2).forEach((b, i) => {
    ctx.font = 'bold 12px system-ui'
    const w = ctx.measureText(b.text).width + 24
    const bx = (cv.clientWidth - w) / 2, by = 14 + i * 28
    ctx.fillStyle = 'rgba(13,17,23,.92)'; ctx.fillRect(bx, by, w, 22)
    ctx.strokeStyle = '#d29922'; ctx.strokeRect(bx + .5, by + .5, w - 1, 21)
    ctx.fillStyle = '#e6edf3'; ctx.fillText(b.text, bx + 12, by + 15)
  })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
</script></body></html>`

// ── /reports — живые графики как биржевой тикер: лента непрерывно ползёт ─────
// влево (rAF, 60fps), новые точки дописываются справа, у правого края —
// «ценник» текущего значения. Данные — /api/history (точка раз в секунду).
const PAGE_REPORTS = /* html */ `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Отчёты — живые графики</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#21262d; --text:#e6edf3; --dim:#8b949e;
          --green:#3fb950; --amber:#d29922; --blue:#58a6ff; --red:#f85149; --pink:#e85aad; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--text); font:14px/1.45 system-ui,'Segoe UI',sans-serif; padding:16px; }
  header { display:flex; gap:12px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
  header h1 { font-size:18px; }
  header .meta { color:var(--dim); font-size:13px; }
  .btn { background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:8px;
         padding:6px 14px; font-size:13px; cursor:pointer; text-decoration:none; }
  .btn:hover { border-color:var(--blue); }
  .btn.on { border-color:var(--blue); color:var(--blue); background:rgba(88,166,255,.12); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(460px,1fr)); gap:14px; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px; }
  .panel h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); }
  .panel .now { font-size:20px; font-weight:800; margin:2px 0 8px; }
  .legend { display:flex; gap:12px; font-size:11.5px; color:var(--dim); margin-bottom:6px; flex-wrap:wrap; }
  .legend i { display:inline-block; width:10px; height:3px; border-radius:2px; margin-right:5px; vertical-align:middle; }
  canvas { width:100%; height:190px; display:block; }
</style></head><body>
<header>
  <h1>📊 Отчёты — реальное время</h1>
  <span class="meta" id="meta">лента ползёт как на бирже · точка раз в секунду</span>
  <span style="margin-left:auto; display:flex; gap:6px">
    <button class="btn rng" data-m="1">1 мин</button>
    <button class="btn rng on" data-m="5">5 мин</button>
    <button class="btn rng" data-m="15">15 мин</button>
    <a class="btn" href="/club">🕹 Вид сверху</a>
    <a class="btn" href="/">← Дашборд</a>
  </span>
</header>
<div class="grid">
  <div class="panel">
    <h2>Занятость клуба</h2>
    <div class="now" id="now-seated" style="color:var(--green)">—</div>
    <canvas id="c-seated"></canvas>
  </div>
  <div class="panel">
    <h2>Касса за сеанс</h2>
    <div class="now" id="now-revenue" style="color:var(--amber)">—</div>
    <canvas id="c-revenue"></canvas>
  </div>
  <div class="panel">
    <h2>Очередь заказов бара</h2>
    <div class="now" id="now-queue" style="color:var(--blue)">—</div>
    <canvas id="c-queue"></canvas>
  </div>
  <div class="panel">
    <h2>Сервис (всего за сеанс)</h2>
    <div class="legend">
      <span><i style="background:var(--green)"></i>выдано заказов</span>
      <span><i style="background:var(--pink)"></i>продажи на кассе</span>
      <span><i style="background:var(--blue)"></i>пополнения</span>
    </div>
    <canvas id="c-service"></canvas>
  </div>
</div>
<script>
const dpr = window.devicePixelRatio || 1
let rangeMin = 5
let hist = []

for (const b of document.querySelectorAll('.rng')) b.onclick = () => {
  document.querySelectorAll('.rng').forEach(x => x.classList.remove('on'))
  b.classList.add('on'); rangeMin = Number(b.dataset.m)
}

const fmtT = (ms) => {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
}
const nice = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'к' : String(Math.round(v))

// Биржевой график: X-ось привязана к «сейчас» — лента непрерывно скользит
// влево; последняя цена тянется горизонтально до правого края и подписана
// «ценником»; сетка по круглым интервалам времени едет вместе с лентой.
function drawChart(cv, series, opts) {
  const w = cv.clientWidth, h = cv.clientHeight
  if (cv.width !== Math.round(w * dpr)) { cv.width = w * dpr; cv.height = h * dpr }
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const now = Date.now()
  const t1 = now, t0 = now - rangeMin * 60000
  const pts = []
  for (const p of hist) if (p.t >= t0 - 2000) pts.push(p)
  const padL = 38, padR = 56, padT = 6, padB = 18
  const iw = w - padL - padR, ih = h - padT - padB
  if (pts.length < 2) {
    ctx.fillStyle = '#8b949e'; ctx.font = '12px system-ui'
    ctx.fillText('Копим данные…', w / 2 - 44, h / 2)
    return
  }

  let vMax = 1
  for (const s of series) for (const p of pts) vMax = Math.max(vMax, p[s.key] ?? 0)
  vMax = Math.max((opts && opts.min) || 0, vMax) * 1.18

  const X = (t) => padL + iw * (t - t0) / (t1 - t0)
  const Y = (v) => padT + ih - ih * (v / vMax)

  // горизонтальная сетка + подписи Y
  ctx.font = '10px system-ui'; ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const y = padT + ih - (ih * i / 4)
    ctx.strokeStyle = 'rgba(139,148,158,.10)'; ctx.beginPath()
    ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke()
    ctx.fillStyle = '#66707c'; ctx.fillText(nice(vMax * i / 4), padL - 5, y + 3)
  }
  // вертикальная сетка по круглым интервалам — едет влево вместе с лентой
  const stepMs = rangeMin === 1 ? 15000 : rangeMin === 5 ? 60000 : 180000
  ctx.textAlign = 'center'
  for (let tt = Math.ceil(t0 / stepMs) * stepMs; tt <= t1; tt += stepMs) {
    const x = X(tt)
    if (x < padL || x > w - padR) continue
    ctx.strokeStyle = 'rgba(139,148,158,.08)'; ctx.beginPath()
    ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke()
    ctx.fillStyle = '#66707c'; ctx.fillText(fmtT(tt).slice(0, 5), x, h - 5)
  }
  ctx.textAlign = 'left'

  // обрезка по области графика — линии не вылезают при скролле
  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, iw, ih); ctx.clip()

  for (const s of series) {
    const lastV = pts[pts.length - 1][s.key] ?? 0
    // путь: точки + последняя цена тянется до «сейчас» (правый край)
    const path = () => {
      ctx.beginPath()
      ctx.moveTo(X(pts[0].t), Y(pts[0][s.key] ?? 0))
      for (const p of pts) ctx.lineTo(X(p.t), Y(p[s.key] ?? 0))
      ctx.lineTo(X(t1), Y(lastV))
    }
    if (s.fill) {
      path()
      ctx.lineTo(X(t1), padT + ih); ctx.lineTo(X(pts[0].t), padT + ih); ctx.closePath()
      const g = ctx.createLinearGradient(0, padT, 0, padT + ih)
      g.addColorStop(0, s.color + '4d'); g.addColorStop(1, s.color + '05')
      ctx.fillStyle = g; ctx.fill()
    }
    path()
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke()
  }
  ctx.restore()

  // ценники текущих значений у правого края + пульс-точка (поверх clip)
  series.forEach((s, si) => {
    const lastV = pts[pts.length - 1][s.key] ?? 0
    const y = Math.max(padT + 7, Math.min(padT + ih - 7, Y(lastV)))
    // пунктир текущей цены
    ctx.strokeStyle = s.color + '55'; ctx.setLineDash([3, 4]); ctx.beginPath()
    ctx.moveTo(padL, Y(lastV)); ctx.lineTo(w - padR, Y(lastV)); ctx.stroke(); ctx.setLineDash([])
    // пульсирующая точка на конце ленты
    const pulse = 2.2 + Math.sin(now / 240 + si) * 1.1
    ctx.fillStyle = s.color + '44'; ctx.beginPath(); ctx.arc(w - padR, Y(lastV), pulse + 3, 0, 7); ctx.fill()
    ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(w - padR, Y(lastV), 2.6, 0, 7); ctx.fill()
    // ценник
    ctx.font = 'bold 10px system-ui'
    const label = nice(lastV)
    const bw = ctx.measureText(label).width + 10
    ctx.fillStyle = s.color; ctx.fillRect(w - padR + 4, y - 8, bw, 15)
    ctx.fillStyle = '#0d1117'; ctx.fillText(label, w - padR + 9, y + 3)
  })
}

function drawAll() {
  if (hist.length) {
    const last = hist[hist.length - 1]
    document.getElementById('now-seated').textContent = last.seated + ' из ' + last.bots + ' за хостами'
    document.getElementById('now-revenue').textContent = last.revenue.toLocaleString('ru-RU') + ' ₽'
    document.getElementById('now-queue').textContent = last.queue + ' в очереди'
    document.getElementById('meta').textContent = 'лента ползёт как на бирже · точек: ' + hist.length + ' · ' + fmtT(last.t)
    drawChart(document.getElementById('c-seated'),  [{ key: 'seated', color: '#3fb950', fill: true }], {})
    drawChart(document.getElementById('c-revenue'), [{ key: 'revenue', color: '#d29922', fill: true }], {})
    drawChart(document.getElementById('c-queue'),   [{ key: 'queue', color: '#58a6ff', fill: true }], { min: 4 })
    drawChart(document.getElementById('c-service'), [
      { key: 'delivered', color: '#3fb950' },
      { key: 'sale', color: '#e85aad' },
      { key: 'deposit', color: '#58a6ff' },
    ], {})
  }
  requestAnimationFrame(drawAll)
}
requestAnimationFrame(drawAll)

async function poll() {
  try { hist = await fetch('/api/history').then(r => r.json()) } catch {}
}
poll(); setInterval(poll, 1000)
</script></body></html>`

// ── Встраиваемый виджет отчётов: выдвижная панель поверх любой страницы ──────
// Кнопка #repToggle (есть в шапке каждой страницы) открывает/закрывает панель;
// графики — те же «биржевые» ленты, рисуются только пока панель открыта.
// Весь код в IIFE с rep-префиксами — не конфликтует со скриптами страниц.
const REPORTS_WIDGET = /* html */ `
<style>
  #repPanel { position:fixed; top:0; right:-500px; width:480px; max-width:96vw; height:100vh; z-index:90;
    background:rgba(13,17,23,.97); border-left:1px solid #21262d; box-shadow:-18px 0 50px rgba(0,0,0,.55);
    transition:right .25s ease; padding:14px; overflow-y:auto; font:13px/1.4 system-ui,'Segoe UI',sans-serif; color:#e6edf3; }
  #repPanel.open { right:0; }
  .rep-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .rep-head b { font-size:14px; }
  .rep-head .m { color:#8b949e; font-size:11px; margin-left:auto; }
  #repClose { background:none; border:none; color:#8b949e; font-size:20px; cursor:pointer; line-height:1; }
  #repClose:hover { color:#e6edf3; }
  .rep-rng { display:flex; gap:6px; margin-bottom:12px; }
  .rep-rng button { background:#161b22; border:1px solid #21262d; color:#e6edf3; border-radius:7px;
    padding:4px 12px; font-size:12px; cursor:pointer; }
  .rep-rng button.on { border-color:#58a6ff; color:#58a6ff; background:rgba(88,166,255,.12); }
  .rep-card { background:#161b22; border:1px solid #21262d; border-radius:10px; padding:10px 12px; margin-bottom:10px; }
  .rep-card h4 { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; margin:0; }
  .rep-card .v { font-size:16px; font-weight:800; margin:2px 0 6px; }
  .rep-card canvas { width:100%; height:120px; display:block; }
  .rep-lg { display:flex; gap:10px; font-size:10.5px; color:#8b949e; margin:4px 0 6px; flex-wrap:wrap; }
  .rep-lg i { display:inline-block; width:9px; height:3px; border-radius:2px; margin-right:4px; vertical-align:middle; }
</style>
<div id="repPanel">
  <div class="rep-head">
    <b>📊 Отчёты · реальное время</b>
    <span class="m" id="repMeta"></span>
    <button id="repClose" title="Закрыть">×</button>
  </div>
  <div class="rep-rng">
    <button data-m="1">1 мин</button>
    <button data-m="5" class="on">5 мин</button>
    <button data-m="15">15 мин</button>
  </div>
  <div class="rep-card"><h4>Занятость клуба</h4><div class="v" id="repNowSeat" style="color:#3fb950">—</div><canvas id="repC1"></canvas></div>
  <div class="rep-card"><h4>Касса за сеанс</h4><div class="v" id="repNowRev" style="color:#d29922">—</div><canvas id="repC2"></canvas></div>
  <div class="rep-card"><h4>Очередь заказов бара</h4><div class="v" id="repNowQ" style="color:#58a6ff">—</div><canvas id="repC3"></canvas></div>
  <div class="rep-card"><h4>Сервис (всего за сеанс)</h4>
    <div class="rep-lg"><span><i style="background:#3fb950"></i>выдано</span><span><i style="background:#e85aad"></i>касса</span><span><i style="background:#58a6ff"></i>пополнения</span></div>
    <canvas id="repC4"></canvas></div>
</div>
<script>(function () {
  const P = document.getElementById('repPanel')
  const T = document.getElementById('repToggle')
  if (!P || !T) return
  const D = window.devicePixelRatio || 1
  let range = 5, hist = [], open = false, pollTimer = null

  const toggle = (v) => {
    open = v ?? !open
    P.classList.toggle('open', open)
    if (open) { poll(); pollTimer = setInterval(poll, 1000) }
    else if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }
  T.addEventListener('click', () => toggle())
  document.getElementById('repClose').addEventListener('click', () => toggle(false))
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(false) })
  for (const b of P.querySelectorAll('.rep-rng button')) b.onclick = () => {
    P.querySelectorAll('.rep-rng button').forEach(x => x.classList.remove('on'))
    b.classList.add('on'); range = Number(b.dataset.m)
  }

  async function poll() {
    try { hist = await fetch('/api/history').then(r => r.json()) } catch {}
  }

  const fmtT = (ms) => {
    const d = new Date(ms)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
  }
  const nice = (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'к' : String(Math.round(v))

  function chart(cv, series, minMax) {
    const w = cv.clientWidth, h = cv.clientHeight
    if (!w) return
    if (cv.width !== Math.round(w * D)) { cv.width = w * D; cv.height = h * D }
    const x2 = cv.getContext('2d')
    x2.setTransform(D, 0, 0, D, 0, 0)
    x2.clearRect(0, 0, w, h)
    const now = Date.now(), t1 = now, t0 = now - range * 60000
    const pts = hist.filter(p => p.t >= t0 - 2000)
    const padL = 32, padR = 46, padT = 4, padB = 14
    const iw = w - padL - padR, ih = h - padT - padB
    if (pts.length < 2) { x2.fillStyle = '#8b949e'; x2.font = '11px system-ui'; x2.fillText('Копим данные…', w / 2 - 40, h / 2); return }
    let vMax = 1
    for (const s of series) for (const p of pts) vMax = Math.max(vMax, p[s.k] ?? 0)
    vMax = Math.max(minMax || 0, vMax) * 1.18
    const X = (t) => padL + iw * (t - t0) / (t1 - t0)
    const Y = (v) => padT + ih - ih * (v / vMax)
    x2.font = '9px system-ui'; x2.textAlign = 'right'
    for (let i = 0; i <= 3; i++) {
      const y = padT + ih - ih * i / 3
      x2.strokeStyle = 'rgba(139,148,158,.1)'; x2.beginPath(); x2.moveTo(padL, y); x2.lineTo(w - padR, y); x2.stroke()
      x2.fillStyle = '#66707c'; x2.fillText(nice(vMax * i / 3), padL - 4, y + 3)
    }
    const step = range === 1 ? 15000 : range === 5 ? 60000 : 180000
    x2.textAlign = 'center'
    for (let tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
      const x = X(tt)
      if (x < padL || x > w - padR) continue
      x2.strokeStyle = 'rgba(139,148,158,.07)'; x2.beginPath(); x2.moveTo(x, padT); x2.lineTo(x, padT + ih); x2.stroke()
      x2.fillStyle = '#66707c'; x2.fillText(fmtT(tt).slice(0, 5), x, h - 3)
    }
    x2.textAlign = 'left'
    x2.save(); x2.beginPath(); x2.rect(padL, padT, iw, ih); x2.clip()
    for (const s of series) {
      const lastV = pts[pts.length - 1][s.k] ?? 0
      const path = () => {
        x2.beginPath(); x2.moveTo(X(pts[0].t), Y(pts[0][s.k] ?? 0))
        for (const p of pts) x2.lineTo(X(p.t), Y(p[s.k] ?? 0))
        x2.lineTo(X(t1), Y(lastV))
      }
      if (s.f) {
        path(); x2.lineTo(X(t1), padT + ih); x2.lineTo(X(pts[0].t), padT + ih); x2.closePath()
        const g = x2.createLinearGradient(0, padT, 0, padT + ih)
        g.addColorStop(0, s.c + '4d'); g.addColorStop(1, s.c + '05')
        x2.fillStyle = g; x2.fill()
      }
      path(); x2.strokeStyle = s.c; x2.lineWidth = 1.5; x2.lineJoin = 'round'; x2.stroke()
    }
    x2.restore()
    series.forEach((s, si) => {
      const lastV = pts[pts.length - 1][s.k] ?? 0
      const y = Math.max(padT + 7, Math.min(padT + ih - 7, Y(lastV)))
      x2.strokeStyle = s.c + '55'; x2.setLineDash([3, 4]); x2.beginPath()
      x2.moveTo(padL, Y(lastV)); x2.lineTo(w - padR, Y(lastV)); x2.stroke(); x2.setLineDash([])
      const pulse = 2 + Math.sin(now / 240 + si)
      x2.fillStyle = s.c + '44'; x2.beginPath(); x2.arc(w - padR, Y(lastV), pulse + 2.5, 0, 7); x2.fill()
      x2.fillStyle = s.c; x2.beginPath(); x2.arc(w - padR, Y(lastV), 2.2, 0, 7); x2.fill()
      x2.font = 'bold 9px system-ui'
      const lb = nice(lastV), bw = x2.measureText(lb).width + 8
      x2.fillStyle = s.c; x2.fillRect(w - padR + 4, y - 7, bw, 13)
      x2.fillStyle = '#0d1117'; x2.fillText(lb, w - padR + 8, y + 3)
    })
  }

  function frame() {
    if (open && hist.length) {
      const last = hist[hist.length - 1]
      document.getElementById('repNowSeat').textContent = last.seated + ' из ' + last.bots + ' за хостами'
      document.getElementById('repNowRev').textContent = last.revenue.toLocaleString('ru-RU') + ' ₽'
      document.getElementById('repNowQ').textContent = last.queue + ' в очереди'
      document.getElementById('repMeta').textContent = fmtT(last.t)
      chart(document.getElementById('repC1'), [{ k: 'seated', c: '#3fb950', f: true }], 0)
      chart(document.getElementById('repC2'), [{ k: 'revenue', c: '#d29922', f: true }], 0)
      chart(document.getElementById('repC3'), [{ k: 'queue', c: '#58a6ff', f: true }], 4)
      chart(document.getElementById('repC4'), [
        { k: 'delivered', c: '#3fb950' }, { k: 'sale', c: '#e85aad' }, { k: 'deposit', c: '#58a6ff' },
      ], 0)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()</script>`
