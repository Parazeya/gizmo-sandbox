<script>
  // Мастер первого запуска: подключение (с проверкой связи) → режим → тема.
  // Показывается, пока в конфиге setupDone !== true.
  import { fetchConfig, saveConfig } from '../lib/sim.svelte.js'
  import { t, i18n, setLang } from '../lib/i18n.svelte.js'

  let { onDone } = $props()

  let step = $state(1)
  let cfg = $state(null)
  let check = $state(null)
  let checking = $state(false)
  let testConfirmed = $state(false)   // «я понимаю, что это тестовый сервер»
  let uiMode = $state('sim')
  let uiTheme = $state('plain')
  let uiAccent = $state('green')
  let saving = $state(false)

  fetchConfig().then((c) => { cfg = c; uiMode = c.uiMode ?? 'sim'; uiTheme = c.uiTheme ?? 'plain'; uiAccent = c.uiAccent ?? 'green' })

  const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o)
  const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v }
  function onInput(path, raw) {
    const old = getPath(cfg, path)
    const val = typeof old === 'number' ? Number(raw) : old === null && raw === '' ? null : raw
    if (typeof old === 'number' && Number.isNaN(val)) return
    setPath(cfg, path, val)
  }

  async function doCheck() {
    checking = true
    // сохраняем креды перед проверкой — сервер проверяет своим клиентом
    await saveConfig($state.snapshot(cfg))
    check = await fetch('/api/setup/check').then((r) => r.json()).catch(() => null)
    checking = false
  }

  async function finish() {
    saving = true
    await saveConfig({ ...$state.snapshot(cfg), setupDone: true, uiMode, uiTheme, uiAccent, uiLang: i18n.lang })
    saving = false
    onDone?.({ uiMode, uiTheme, uiAccent })
  }

  const FIELDS = [
    ['gizmo.ip', 'Gizmo IP'], ['gizmo.port', 'Порт'], ['gizmo.username', 'Логин'], ['gizmo.password', 'Пароль'],
    ['branchId', 'Бренч'], ['sql.password', 'SQL пароль (опц.)'],
  ]
  const MODES = [
    { id: 'sim', icon: '🎮', title: 'Симулятор клуба', desc: 'Живой клуб: боты играют, заказывают, оператор ведёт смену. Активность видна в админке и отчётах.' },
    { id: 'api', icon: '🧪', title: 'Тестировать API Gizmo V3', desc: 'Сценарные тесты и полный скан всех эндпоинтов из OpenAPI-дока с отчётами между версиями.' },
  ]
  const THEMES = [
    { id: 'plain', title: 'Обычный', colors: ['#0d1117', '#161b22', '#58a6ff'] },
    { id: 'terraria', title: 'Terraria', colors: ['#2b3a1e', '#5d4228', '#6abe30'] },
    { id: 'doom', title: 'Doom Eternal', colors: ['#0b0d04', '#1a1e0a', '#c8e400'] },
  ]
  const ACCENTS = [
    ['green', '#c8e400'], ['white', '#ececec'], ['red', '#ff3b2f'], ['blue', '#4a6dff'], ['cyan', '#35d5e5'],
  ]
  const stIcon = (ok) => (ok === true ? '✅' : ok === 'skip' ? '⚠️' : '❌')
</script>

<div class="ovl">
  <div class="wiz">
    <div class="langs">
      <button class="lbtn" class:on={i18n.lang === 'ru'} onclick={() => setLang('ru')}>🇷🇺 Русский</button>
      <button class="lbtn" class:on={i18n.lang === 'en'} onclick={() => setLang('en')}>🇬🇧 English</button>
    </div>
    <h1>{t('👋 Первый запуск GGBook Club Simulator')}</h1>
    <div class="steps">
      {#each ['Подключение', 'Режим работы', 'Тема интерфейса'] as s, i}
        <span class="chip-step" class:on={step === i + 1} class:done={step > i + 1}>{i + 1}. {t(s)}</span>
      {/each}
    </div>

    {#if step === 1}
      {#if !cfg}
        <p class="dim">{t('Загрузка…')}</p>
      {:else}
        <div class="warn">
          ⚠️ <b>{t('Только тестовый сервер!')}</b> {t('Симулятор создаёт реальных пользователей, платежи, чеки и кассовые операции, а «♻ Мир» безвозвратно удаляет ботов. На боевом Gizmo это испортит отчёты и кассу.')}
        </div>
        <p class="dim">{t('Куда подключаемся. Всё можно поменять позже в ⚙ Настройках.')}</p>
        <div class="fields">
          {#each FIELDS as [path, label]}
            <label><span>{t(label)}</span>
              <input value={getPath(cfg, path) ?? ''} onchange={(e) => onInput(path, e.currentTarget.value.trim())} />
            </label>
          {/each}
        </div>
        <div class="row-btns">
          <button class="btn" onclick={doCheck} disabled={checking}>{checking ? t('⏳ Проверяю…') : t('🔌 Проверить связь')}</button>
          {#if check}
            <span class="chk">{stIcon(check.gizmo?.ok)} Gizmo: {check.gizmo?.detail}</span>
            <span class="chk">{stIcon(check.sql?.ok)} SQL: {check.sql?.detail}</span>
          {/if}
        </div>
        <label class="confirm">
          <input type="checkbox" bind:checked={testConfirmed} />
          <span>{t('Подтверждаю: это')} <b>{t('тестовый')}</b> {t('сервер Gizmo, данными на нём можно жертвовать')}</span>
        </label>
        <div class="foot">
          <button class="btn primary" onclick={() => (step = 2)} disabled={!check?.gizmo?.ok || !testConfirmed}>{t('Далее →')}</button>
          {#if check && !check.gizmo?.ok}<span class="dim">{t('нужна связь с Gizmo, проверь адрес и креды')}</span>
          {:else if check?.gizmo?.ok && !testConfirmed}<span class="dim">{t('отметь галочку про тестовый сервер')}</span>{/if}
        </div>
      {/if}
    {:else if step === 2}
      <p class="dim">{t('Что будем делать? Обе вкладки доступны всегда — это только стартовый экран.')}</p>
      <div class="cards">
        {#each MODES as m}
          <button class="card" class:on={uiMode === m.id} onclick={() => (uiMode = m.id)}>
            <span class="ic">{m.icon}</span>
            <b>{t(m.title)}</b>
            <span class="desc">{t(m.desc)}</span>
          </button>
        {/each}
      </div>
      <div class="foot">
        <button class="btn" onclick={() => (step = 1)}>{t('← Назад')}</button>
        <button class="btn primary" onclick={() => (step = 3)}>{t('Далее →')}</button>
      </div>
    {:else}
      <p class="dim">{t('Как будет выглядеть интерфейс (меняется в один клик кнопкой 🎨 в шапке).')}</p>
      <div class="cards">
        {#each THEMES as th}
          <button class="card" class:on={uiTheme === th.id} onclick={() => (uiTheme = th.id)}>
            <span class="swatches">{#each th.colors as c}<i style="background:{c}"></i>{/each}</span>
            <b>{th.id === 'plain' ? t('Обычный') : th.title}</b>
          </button>
        {/each}
      </div>
      {#if uiTheme === 'doom'}
        <div class="accent-row">
          <span class="dim" style="margin:0">{t('Акцентный цвет:')}</span>
          {#each ACCENTS as [id, color]}
            <button class="acc" class:on={uiAccent === id} style="--c:{color}" onclick={() => (uiAccent = id)} aria-label={id}></button>
          {/each}
        </div>
      {/if}
      <div class="foot">
        <button class="btn" onclick={() => (step = 2)}>{t('← Назад')}</button>
        <button class="btn primary" onclick={finish} disabled={saving}>{saving ? '⏳' : t('🚀 Поехали!')}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .ovl { position: fixed; inset: 0; z-index: 200; background: rgba(5, 8, 12, 0.92);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .wiz { width: min(760px, 96vw); background: var(--panel); border: 1px solid var(--line);
    border-radius: 16px; padding: 26px; box-shadow: 0 40px 120px rgba(0, 0, 0, 0.7); }
  h1 { font-size: 19px; margin-bottom: 14px; }
  .steps { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .chip-step { font-size: 12px; padding: 4px 12px; border-radius: 20px; border: 1px solid var(--line); color: var(--dim); }
  .chip-step.on { border-color: var(--blue); color: var(--blue); background: rgba(88, 166, 255, 0.1); }
  .chip-step.done { color: var(--green); border-color: var(--green); }
  .dim { color: var(--dim); font-size: 13px; margin-bottom: 12px; }
  .warn { background: rgba(248, 81, 73, 0.1); border: 1px solid rgba(248, 81, 73, 0.55);
    border-radius: 10px; padding: 10px 14px; font-size: 13px; line-height: 1.5; margin-bottom: 12px; }
  .confirm { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; margin: 4px 0 6px;
    cursor: pointer; line-height: 1.4; }
  .confirm input { margin-top: 2px; accent-color: var(--red); }
  .fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .fields label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); }
  .fields input { background: var(--bg); border: 1px solid var(--line); color: var(--text);
    border-radius: 8px; padding: 7px 10px; font: inherit; }
  .fields input:focus { outline: none; border-color: var(--blue); }
  .row-btns { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .chk { font-size: 12.5px; color: var(--dim); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .card { background: var(--bg); border: 2px solid var(--line); border-radius: 12px; padding: 16px;
    display: flex; flex-direction: column; gap: 8px; align-items: flex-start; cursor: pointer;
    color: var(--text); text-align: left; font: inherit; transition: border-color 0.15s; }
  .card:hover { border-color: var(--dim); }
  .card.on { border-color: var(--blue); background: rgba(88, 166, 255, 0.07); }
  .card .ic { font-size: 26px; }
  .card .desc { font-size: 12px; color: var(--dim); }
  .swatches { display: flex; gap: 4px; }
  .swatches i { width: 22px; height: 22px; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.15); }
  .foot { display: flex; gap: 10px; align-items: center; margin-top: 14px; }
  .langs { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 6px; }
  .lbtn { background: var(--bg); border: 1px solid var(--line); color: var(--dim); border-radius: 8px;
    padding: 4px 12px; font-size: 12.5px; cursor: pointer; }
  .lbtn.on { border-color: var(--blue); color: var(--blue); background: rgba(88, 166, 255, 0.1); }
  .accent-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .acc { width: 24px; height: 24px; border-radius: 4px; cursor: pointer; background: var(--c);
    border: 2px solid transparent; clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
    opacity: 0.55; transition: opacity .15s; padding: 0; }
  .acc:hover { opacity: 0.85; }
  .acc.on { opacity: 1; box-shadow: 0 0 10px var(--c); }
</style>
