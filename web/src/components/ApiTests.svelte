<script>
  import { t, i18n } from '../lib/i18n.svelte.js'
  // Вкладка тестов: сценарии (реальные вызовы, за собой убирают), полный скан
  // V3 по живому OpenAPI-доку с сохранением отчёта и сравнение отчётов между
  // версиями Gizmo.
  let running = $state(false)
  let report = $state(null)          // сценарные тесты
  let scanning = $state(false)
  let scan = $state(null)            // полный скан
  let reports = $state([])           // сохранённые отчёты
  let diffA = $state(''), diffB = $state('')
  let diff = $state(null)
  let showOkModules = $state(false)
  let selected = $state(null)        // строка, раскрытая в инспекторе запроса
  let specs = $state([])             // сохранённые API-доки версий (spec_*.json)
  let specA = $state('current'), specB = $state('')
  let sdiff = $state(null)
  let specDiffing = $state(false)

  fetch('/api/tests/last').then((r) => r.json()).then((r) => { if (r) report = r }).catch(() => {})
  const loadReports = () => fetch('/api/tests/reports').then((r) => r.json()).then((r) => (reports = r)).catch(() => {})
  const loadSpecs = () => fetch('/api/tests/specs').then((r) => r.json()).then((r) => (specs = r)).catch(() => {})
  loadReports(); loadSpecs()

  async function runSpecDiff() {
    specDiffing = true
    sdiff = await fetch(`/api/tests/specdiff?a=${encodeURIComponent(specA)}&b=${encodeURIComponent(specB)}`).then((r) => r.json()).catch(() => null)
    specDiffing = false
  }
  async function uploadSpec(e) {
    const f = e.currentTarget.files?.[0]
    if (!f) return
    const content = await f.text()
    const r = await fetch('/api/tests/specs/upload', { method: 'POST', body: JSON.stringify({ name: f.name, content }) }).then((r) => r.json()).catch(() => null)
    if (r?.error) alert(t('Не удалось загрузить:') + ' ' + r.error)
    e.currentTarget.value = ''
    loadSpecs()
  }
  async function delFile(file) {
    if (!confirm(t('Удалить') + ` ${file}?`)) return
    await fetch('/api/tests/reports/delete', { method: 'POST', body: JSON.stringify({ file }) }).catch(() => {})
    loadReports(); loadSpecs()
  }
  async function clearAllReports() {
    if (!confirm(t('Удалить ВСЕ сохранённые отчёты сканов? (API-доки spec_*.json останутся)'))) return
    await fetch('/api/tests/reports/clear', { method: 'POST' }).catch(() => {})
    diff = null; loadReports()
  }

  async function run() {
    running = true
    try { report = await fetch('/api/tests/run', { method: 'POST' }).then((r) => r.json()) } catch {}
    running = false
  }
  async function runScan() {
    scanning = true
    selected = null
    try {
      // хост для host-API сканер находит сам (первый с живым Gizmo-клиентом)
      scan = await fetch('/api/tests/full/run', { method: 'POST', body: '{}' }).then((r) => r.json())
      loadReports()
    } catch {}
    scanning = false
  }

  let mut = $state(null)             // скан мутаций (create→update→delete)
  let mutating = $state(false)
  async function runMut() {
    if (!confirm('🧨 Скан мутаций создаст в КАЖДОМ подходящем модуле тестовую запись (api_mut_*), обновит и удалит её.\nЧужие данные не трогаются, но на сервере будут реальные операции записи. Продолжить?')) return
    mutating = true
    selected = null
    try { mut = await fetch('/api/tests/mutations/run', { method: 'POST' }).then((r) => r.json()) } catch {}
    mutating = false
  }
  const mutModules = $derived.by(() => {
    if (!mut?.results) return []
    const map = new Map()
    for (const r of mut.results) {
      if (!map.has(r.module)) map.set(r.module, { module: r.module, rows: [], bad: 0 })
      const m = map.get(r.module)
      m.rows.push(r)
      if (r.status !== 'ok' && r.status !== 'skip') m.bad++
    }
    return [...map.values()].sort((a, b) => b.bad - a.bad || a.module.localeCompare(b.module))
  })
  const stepIcon = (s) => (s === 'create' ? '➕' : s === 'update' ? '✏️' : '🗑')
  async function runDiff() {
    if (!diffA || !diffB) return
    diff = await fetch(`/api/tests/diff?a=${encodeURIComponent(diffA)}&b=${encodeURIComponent(diffB)}`).then((r) => r.json()).catch(() => null)
  }
  async function openReport(file) {
    scan = await fetch(`/api/tests/report?file=${encodeURIComponent(file)}`).then((r) => r.json()).catch(() => null)
  }

  const results = $derived(report?.results ?? [])
  const groups = $derived([...new Set(results.map((r) => r.group))])
  const passed = $derived(results.filter((r) => r.ok === true).length)
  const failed = $derived(results.filter((r) => r.ok === false).length)
  const skipped = $derived(results.filter((r) => r.ok === 'skip').length)
  const icon = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '⊘')

  const scanModules = $derived.by(() => {
    if (!scan?.results) return []
    const map = new Map()
    for (const r of scan.results) {
      if (!map.has(r.module)) map.set(r.module, { module: r.module, total: 0, ok: 0, bad: [], deps: [], skips: [], rows: [], mut: 0, other: 0 })
      const m = map.get(r.module)
      m.total++; m.rows.push(r)
      if (r.status === 'ok') m.ok++
      else if (r.status === 'fail' || r.status === 'http-4xx' || r.status === 'auth') m.bad.push(r)
      else if (r.status === 'dep') m.deps.push(r)
      else if (r.status === 'skip') m.skips.push(r)
      else if (r.status === 'mutation') m.mut++
      else m.other++   // user-scope / needs-params / stream — не вызывались
    }
    return [...map.values()].sort((a, b) => b.bad.length - a.bad.length || b.deps.length - a.deps.length || b.skips.length - a.skips.length || a.module.localeCompare(b.module))
  })
  const stClass = (s) => (s === 'ok' ? 'ok' : s === 'fail' ? 'bad' : s === 'http-4xx' || s === 'auth' ? 'warn' : s === 'dep' ? 'dep' : 'mut')
  const stIcon = (s) => (s === 'ok' ? '✓' : s === 'fail' ? '✗' : s === 'dep' ? '◌' : s === 'stream' ? '≋' : s === 'skip' ? '⊘' : '!')
  const fmtDate = (ms) => new Date(ms).toLocaleString(i18n.lang === 'en' ? 'en-GB' : 'ru-RU')
  const prettyBody = (b) => {
    if (b == null) return '—'
    try { return JSON.stringify(JSON.parse(b), null, 2) } catch { return String(b) }
  }
  const toggleRow = (r) => { selected = selected === r ? null : r }
</script>

<div class="wrap">
  {#snippet resRow(r, pre)}
    <div class="row clickable" class:active={selected === r} role="button" tabindex="0"
      onclick={() => toggleRow(r)}
      onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggleRow(r))}>
      <span class="st {stClass(r.status)}">{stIcon(r.status)}</span>
      <span class="name mono">{pre ?? ''}{r.verb} {r.path}</span>
      <span class="ms">{r.httpCode ?? ''} {r.ms ? r.ms + 'мс' : ''}</span>
      <span class="detail">{r.detail}</span>
    </div>
    {#if selected === r}
      <div class="inspect">
        {#if r.req}
          <div class="ih">{t('→ Запрос')}</div>
          <div class="ikv"><b>{r.req.verb}</b> <span class="mono sel-all">{r.req.url}</span></div>
          {#if r.req.query && Object.keys(r.req.query).length}
            <div class="ih2">{t('Query-параметры')}</div>
            {#each Object.entries(r.req.query) as [k, v]}<div class="ikv mono">{k} = {v}</div>{/each}
          {/if}
          <div class="ih2">{t('Заголовки запроса')}</div>
          {#each Object.entries(r.req.headers ?? {}) as [k, v]}<div class="ikv mono">{k}: {v}</div>{/each}
          <div class="ih2">{t('Тело запроса')}</div>
          <pre class="ibody">{r.req.body ?? t('— (без тела)')}</pre>
          <div class="ih">{t('← Ответ')} {r.res?.code ?? '—'} · {r.ms} ms</div>
          <div class="ih2">{t('Заголовки ответа')}</div>
          {#each Object.entries(r.res?.headers ?? {}) as [k, v]}<div class="ikv mono">{k}: {v}</div>{/each}
          <div class="ih2">{t('Тело ответа')}</div>
          <pre class="ibody">{prettyBody(r.res?.body)}</pre>
        {:else}
          <div class="dim">{t('Вызов не выполнялся:')} {r.detail}</div>
        {/if}
      </div>
    {/if}
  {/snippet}

  <!-- Сценарные тесты -->
  <div class="panel">
    <h2>{t('Сценарные тесты (реальные вызовы, самоочистка)')}</h2>
    <div class="bar">
      <button class="btn primary" onclick={run} disabled={running}>{running ? t('⏳ Прогоняю…') : t('▶ Запустить сценарии')}</button>
      {#if report}
        <span class="sum"><b class="ok">✓ {passed}</b> <b class="bad" class:zero={!failed}>✗ {failed}</b> <b class="warn">⊘ {skipped}</b> · {fmtDate(report.at)}</span>
      {/if}
    </div>
    {#if report}
      {#each groups as g}
        <div class="grp">{t(g)}</div>
        {#each results.filter((r) => r.group === g) as r}
          <div class="row" class:fail={r.ok === false} class:skip={r.ok === 'skip'}>
            <span class="st">{icon(r.ok)}</span><span class="name">{r.name}</span>
            <span class="ms">{r.ms} мс</span><span class="detail">{r.detail}</span>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <!-- Полный скан V3 -->
  <div class="panel">
    <h2>{t('Полный скан Gizmo V3 (каталог из OpenAPI-дока сервера)')}</h2>
    <div class="bar">
      <button class="btn primary" onclick={runScan} disabled={scanning}>{scanning ? t('⏳ Сканирую все эндпоинты…') : t('▶ Полный скан + сохранить отчёт')}</button>
    </div>
    {#if scan}
      <div class="sum" style="margin-bottom:6px">
        Gizmo <b>{scan.gizmoVersion}</b> · {t('всего')} {scan.total} ·
        <b class="ok">ok {scan.ok}</b> <b class="bad" class:zero={!scan.fail}>fail {scan.fail}</b>
        <b class="warn">4xx {scan.http4xx}</b> <b class="dep">◌ {t('зависимости')} {scan.dep ?? 0}</b>
        {#if scan.skipped}<b class="warn">⊘ {t('пропущено')} {scan.skipped}</b>{/if} ·
        {t('мутаций')} {scan.mutation} · {t('юзерских')} {scan.userScope ?? 0} · {t('без образца')} {scan.needsParams} · stream {scan.stream ?? 0}
      </div>
      {#if scan.fixtures?.length}
        <div class="dim" style="font-size:12px; margin-bottom:4px">🛠 {t('созданы недостающие фикстуры:')} {scan.fixtures.join(', ')}</div>
      {/if}
      {#if scan.scanHostOnline}
        <div class="dim" style="font-size:12px; margin-bottom:4px">🟢 {t('host-API проверены через подключённый хост')} «{scan.scanHostName}»</div>
      {:else if scan.scanHostNote}
        <div class="hostnote">⊘ {scan.scanHostNote}{scan.skipped ? ` — ${scan.skipped} ${t('host-эндпоинтов помечены пропуском')}` : ''}</div>
      {/if}
      <div class="dim" style="font-size:12px; margin-bottom:6px">
        {t('◌ «зависимость» = API работает, но нет нужного состояния на сервере (сущность не создана и т.п.). Клик по строке — полная информация о запросе и ответе.')}
      </div>
      <label class="tgl"><input type="checkbox" bind:checked={showOkModules} /> {t('показывать полностью зелёные модули')}</label>
      <div class="thead">
        <span></span><span>{t('Метод и путь')}</span><span class="ms">{t('Код · время')}</span><span>{t('Детали')}</span>
      </div>
      {#each scanModules as m}
        {#if m.bad.length || m.deps.length || m.skips.length || showOkModules}
          <div class="grp">{m.module} <span class="dim">— ✓ {m.ok} из {m.ok + m.bad.length + m.deps.length} {t('вызванных GET')}{m.bad.length ? ` · ${t('проблем:')} ${m.bad.length}` : ''}{m.deps.length ? ` · ${t('зависимостей:')} ${m.deps.length}` : ''}{m.skips.length ? ` · пропущено: ${m.skips.length} (${m.skips[0].detail.replace(/^пропуск: /, '')})` : ''}{m.mut ? ` · ${t('мутаций (не вызываются):')} ${m.mut}` : ''}{m.other ? ` · ${t('прочих:')} ${m.other}` : ''} · {t('всего в доке:')} {m.total}</span></div>
          {#each (m.bad.length || m.deps.length ? [...m.bad, ...m.deps, ...(showOkModules ? m.skips : [])] : m.skips.length && !showOkModules ? [] : m.rows.filter((r) => r.status === 'ok').slice(0, 3)) as r}
            {@render resRow(r)}
          {/each}
        {/if}
      {/each}
    {/if}
  </div>

  <!-- Скан мутаций (create → update → delete на своих данных) -->
  <div class="panel">
    <h2>{t('🧨 Скан мутаций (создать → изменить → удалить)')}</h2>
    <p class="dim" style="font-size:12.5px; margin-bottom:8px">
      {t('Для каждого модуля с парой POST+DELETE создаётся тестовая запись (тело — из схемы OpenAPI), обновляется PUT\'ом и удаляется. Чужие данные не трогаются; системные модули (кассы, смены, платежи, сессии, пользователи, хосты) исключены — их покрывают сценарные тесты.')}
    </p>
    <div class="bar">
      <button class="btn primary" onclick={runMut} disabled={mutating}>{mutating ? t('⏳ Гоняю циклы…') : t('🧨 Запустить скан мутаций')}</button>
      {#if mut && !mut.error}
        <span class="sum">
          Gizmo <b>{mut.gizmoVersion}</b> · {t('модулей')} {mut.modules} · {t('вызовов')} {mut.total} ·
          <b class="ok">ok {mut.ok}</b> <b class="bad" class:zero={!mut.fail}>fail {mut.fail}</b>
          <b class="warn">4xx {mut.http4xx}</b> <b class="dep">◌ {mut.dep}</b> · {t('пропущено')} {mut.skipped}
        </span>
      {/if}
    </div>
    {#if mut?.error}<div class="hostnote">⚠ {mut.error}</div>{/if}
    {#if mut && !mut.error}
      {#each mutModules as m}
        <div class="grp">{m.module}{m.bad ? ' — ' + t('проблем:') + ' ' + m.bad : ''}</div>
        {#each m.rows as r}
          {@render resRow(r, stepIcon(r.step) + ' ')}
        {/each}
      {/each}
    {/if}
  </div>

  <!-- Сравнение отчётов (версии Gizmo) -->
  <div class="panel">
    <h2>{t('Сравнение отчётов между версиями')}</h2>
    {#if reports.length}
      <div class="bar">
        <select bind:value={diffA} class="sel"><option value="">{t('— старый отчёт —')}</option>{#each reports as r}<option value={r.file}>{r.gizmoVersion} · {fmtDate(r.at)} (ok {r.ok}/{r.total})</option>{/each}</select>
        <span class="dim">→</span>
        <select bind:value={diffB} class="sel"><option value="">{t('— новый отчёт —')}</option>{#each reports as r}<option value={r.file}>{r.gizmoVersion} · {fmtDate(r.at)} (ok {r.ok}/{r.total})</option>{/each}</select>
        <button class="btn" onclick={runDiff} disabled={!diffA || !diffB}>{t('Сравнить')}</button>
        <span class="dim" style="margin-left:auto">{t('отчётов сохранено:')} {reports.length}</span>
      </div>
      {#if diff}
        <div class="sum" style="margin:8px 0">
          {diff.a.gizmoVersion} → {diff.b.gizmoVersion}:
          <b class="ok">+{diff.added.length} {t('новых')}</b> ·
          <b class="bad" class:zero={!diff.removed.length}>−{diff.removed.length} {t('удалённых')}</b> ·
          <b class="warn">~{diff.changed.length} {t('изменённых')}</b>
        </div>
        {#each diff.added as r}<div class="row"><span class="st ok">+</span><span class="name mono">{r.verb} {r.path}</span><span class="ms"></span><span class="detail">{r.module}</span></div>{/each}
        {#each diff.removed as r}<div class="row fail"><span class="st bad">−</span><span class="name mono">{r.verb} {r.path}</span><span class="ms"></span><span class="detail">{r.module}</span></div>{/each}
        {#each diff.changed as c}
          <div class="row"><span class="st warn">~</span><span class="name mono">{c.key}</span><span class="ms"></span>
            <span class="detail">{c.before.status}{c.before.httpCode ? ` (${c.before.httpCode})` : ''} → {c.after.status}{c.after.httpCode ? ` (${c.after.httpCode})` : ''}{JSON.stringify(c.before.shape) !== JSON.stringify(c.after.shape) ? ' · ' + t('форма ответа изменилась') : ''}</span>
          </div>
        {/each}
        {#if diff.specDiff}
          <div class="grp" style="margin-top:14px">{t('Изменения в API-документации')} ({diff.specDiff.a} → {diff.specDiff.b}):
            <span class="dim">+{diff.specDiff.added.length} · −{diff.specDiff.removed.length} · ~{diff.specDiff.changed.length}</span>
          </div>
          {#each diff.specDiff.added as e}
            <div class="row"><span class="st ok">+</span><span class="name mono">{e.key}</span><span class="ms"></span>
              <span class="detail">{t('параметры:')} {e.params.join(', ') || '—'}{e.body.length ? ` · ${t('тело:')} ${e.body.join(', ')}` : ''}{e.resp.length ? ` · ${t('ответ:')} ${e.resp.slice(0, 12).join(', ')}` : ''}</span>
            </div>
          {/each}
          {#each diff.specDiff.removed as e}
            <div class="row fail"><span class="st bad">−</span><span class="name mono">{e.key}</span><span class="ms"></span>
              <span class="detail">{t('параметры:')} {e.params.join(', ') || '—'}</span>
            </div>
          {/each}
          {#each diff.specDiff.changed as e}
            <div class="row"><span class="st warn">~</span><span class="name mono">{e.key}</span><span class="ms"></span>
              <span class="detail">{e.details.join(' · ')}</span>
            </div>
          {/each}
        {:else if diff.a.gizmoVersion !== diff.b.gizmoVersion}
          <div class="dim" style="font-size:12px; margin-top:8px">API-док одной из версий не сохранён (spec_*.json появляется при первом скане версии) — диф документации недоступен.</div>
        {/if}
      {/if}
      <div class="dim" style="margin-top:8px; font-size:12px">
        {t('Сохранённые отчёты:')}
        {#each reports.slice(0, 8) as r}
          <span class="rfile"><button class="lnk" onclick={() => openReport(r.file)}>{r.file}</button><button class="x" title="удалить" onclick={() => delFile(r.file)}>✕</button></span>
        {/each}
        <button class="lnk" style="color:var(--red)" onclick={clearAllReports}>{t('🗑 очистить все отчёты')}</button>
      </div>
    {:else}
      <p class="dim">{t('Сохранённых отчётов пока нет — запусти «Полный скан», отчёт сохранится автоматически. После обновления Gizmo запусти ещё раз и сравни.')}</p>
    {/if}
  </div>

  <!-- Сравнение API-доков (.json) вручную -->
  <div class="panel">
    <h2>{t('Сравнение API-доков (.json)')}</h2>
    <p class="dim" style="font-size:12.5px; margin-bottom:8px">
      Док каждой версии сохраняется при первом скане (spec_&lt;версия&gt;.json). Можно загрузить док другой версии вручную
      (Scalar → Download OpenAPI Document) и сравнить: новые/удалённые/изменённые эндпоинты с параметрами и полями.
    </p>
    <div class="bar">
      <select bind:value={specA} class="sel">
        <option value="current">{t('🌐 Текущая версия (с сервера)')}</option>
        {#each specs as sp}<option value={sp.file}>{sp.file} · {sp.endpoints} {t('путей')}</option>{/each}
      </select>
      <span class="dim">→</span>
      <select bind:value={specB} class="sel">
        <option value="">{t('— выбери док —')}</option>
        <option value="current">{t('🌐 Текущая версия (с сервера)')}</option>
        {#each specs as sp}<option value={sp.file}>{sp.file} · {sp.endpoints} {t('путей')}</option>{/each}
      </select>
      <button class="btn" onclick={runSpecDiff} disabled={!specA || !specB || specDiffing}>{specDiffing ? '⏳' : t('Сравнить доки')}</button>
      <label class="btn">{t('📄 Загрузить .json')}<input type="file" accept=".json,application/json" hidden onchange={uploadSpec} /></label>
    </div>
    {#if specs.length}
      <div class="dim" style="font-size:12px; margin-bottom:6px">
        {t('Сохранённые доки:')} {#each specs as sp}<span class="rfile">{sp.file}<button class="x" title="удалить" onclick={() => delFile(sp.file)}>✕</button></span>{/each}
      </div>
    {/if}
    {#if sdiff}
      {#if sdiff.error}
        <div class="hostnote">⚠ {sdiff.error}</div>
      {:else}
        <div class="sum" style="margin:8px 0">
          {sdiff.a} → {sdiff.b}:
          <b class="ok">+{sdiff.added.length} {t('новых')}</b> ·
          <b class="bad" class:zero={!sdiff.removed.length}>−{sdiff.removed.length} {t('удалённых')}</b> ·
          <b class="warn">~{sdiff.changed.length} {t('изменённых')}</b>
        </div>
        {#each sdiff.added as e}
          <div class="row"><span class="st ok">+</span><span class="name mono">{e.key}</span><span class="ms"></span>
            <span class="detail">{t('параметры:')} {e.params.join(', ') || '—'}{e.body.length ? ` · ${t('тело:')} ${e.body.join(', ')}` : ''}{e.resp.length ? ` · ${t('ответ:')} ${e.resp.slice(0, 12).join(', ')}` : ''}</span>
          </div>
        {/each}
        {#each sdiff.removed as e}
          <div class="row fail"><span class="st bad">−</span><span class="name mono">{e.key}</span><span class="ms"></span>
            <span class="detail">{t('параметры:')} {e.params.join(', ') || '—'}</span>
          </div>
        {/each}
        {#each sdiff.changed as e}
          <div class="row"><span class="st warn">~</span><span class="name mono">{e.key}</span><span class="ms"></span>
            <span class="detail">{e.details.join(' · ')}</span>
          </div>
        {/each}
        {#if !sdiff.added.length && !sdiff.removed.length && !sdiff.changed.length}
          <div class="dim" style="font-size:12.5px">{t('Различий нет — доки идентичны.')}</div>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: 14px; max-width: 1150px; }
  .bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .sum { font-size: 13px; color: var(--dim); display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .sum .ok, .st.ok { color: var(--green); }
  .sum .bad, .st.bad { color: var(--red); }
  .sum .bad.zero { color: var(--dim); }
  .sum .warn, .st.warn { color: var(--amber); }
  .sum .dep, .st.dep { color: #58a6ff; }
  .st.mut { color: var(--dim); }
  .dim { color: var(--dim); }
  .grp { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin: 10px 0 4px; }
  .row { display: grid; grid-template-columns: 20px minmax(220px, 420px) 70px 1fr; gap: 10px; align-items: baseline;
    padding: 4px 8px; border-radius: 7px; font-size: 12.5px; }
  .row:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
  .thead { display: grid; grid-template-columns: 20px minmax(220px, 420px) 70px 1fr; gap: 10px;
    padding: 4px 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); }
  .row.clickable { cursor: pointer; }
  .row > * { min-width: 0; }
  .row.clickable:hover { background: rgba(255, 255, 255, 0.05); }
  .row.clickable.active { background: rgba(88, 166, 255, 0.1); outline: 1px solid rgba(88, 166, 255, 0.35); }
  .inspect { margin: 2px 0 8px 30px; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px;
    background: rgba(0, 0, 0, 0.25); font-size: 12px; max-width: 980px; }
  .ih { font-weight: 700; color: var(--text); margin: 8px 0 4px; font-size: 12.5px; }
  .ih:first-child { margin-top: 0; }
  .ih2 { color: var(--dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; margin: 7px 0 2px; }
  .ikv { padding: 1px 0; word-break: break-all; }
  .ibody { background: rgba(0, 0, 0, 0.35); border: 1px solid var(--line); border-radius: 6px;
    padding: 8px 10px; margin: 3px 0; font: 11.5px ui-monospace, Consolas, monospace;
    white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
  .sel-all { user-select: all; }
  .hostnote { background: rgba(210, 153, 34, 0.1); border: 1px solid rgba(210, 153, 34, 0.45);
    border-radius: 8px; padding: 7px 12px; font-size: 12.5px; margin-bottom: 6px; }
  .row.fail { background: rgba(248, 81, 73, 0.08); }
  .st { font-weight: 900; color: var(--green); text-align: center; }
  .row.fail .st { color: var(--red); }
  .row.skip .st { color: var(--amber); }
  .name { font-weight: 600; word-break: break-all; }
  .mono { font: 12px ui-monospace, Consolas, monospace; font-weight: 500; }
  .ms { color: var(--dim); font-size: 11px; text-align: right; white-space: nowrap; }
  .detail { color: var(--dim); font: 11.5px ui-monospace, Consolas, monospace; word-break: break-word; }
  .row.fail .detail { color: #f0a8a3; }
  .sel { background: var(--panel); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 6px 10px; font-size: 12.5px; max-width: 320px; }
  .tgl { font-size: 12px; color: var(--dim); display: flex; gap: 6px; align-items: center; margin-bottom: 4px; cursor: pointer; }
  .lnk { background: none; border: none; color: var(--blue); cursor: pointer; font-size: 12px; text-decoration: underline; margin-right: 2px; }
  .rfile { display: inline-flex; align-items: center; gap: 1px; margin-right: 10px; }
  .x { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 11px; padding: 0 2px; }
  .x:hover { color: var(--red); }
</style>
