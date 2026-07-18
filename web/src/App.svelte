<script>
  import { Tabs } from 'bits-ui'
  import { sim, startSim, action, fetchConfig, saveConfig } from './lib/sim.svelte.js'
  import { t, i18n, setLang } from './lib/i18n.svelte.js'
  import Dashboard from './components/Dashboard.svelte'
  import ClubMap from './components/ClubMap.svelte'
  import ApiTests from './components/ApiTests.svelte'
  import ReportsPanel from './components/ReportsPanel.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import ForceMenu from './components/ForceMenu.svelte'
  import SetupWizard from './components/SetupWizard.svelte'

  startSim()

  let tab = $state('dash')
  let reportsOpen = $state(false)
  let settingsOpen = $state(false)
  let theme = $state('plain')
  let accent = $state('green')
  let wizard = $state(false)
  let resettingWorld = $state(false)

  // тема и мастер первого запуска — из конфига
  fetchConfig().then((c) => {
    theme = c.uiTheme ?? 'plain'
    accent = c.uiAccent ?? 'green'
    setLang(c.uiLang ?? 'ru')
    wizard = !c.setupDone
    if (c.setupDone && c.uiMode === 'api') tab = 'tests'
  }).catch(() => {})
  async function toggleLang() {
    setLang(i18n.lang === 'ru' ? 'en' : 'ru')
    await saveConfig({ uiLang: i18n.lang }).catch(() => {})
  }
  $effect(() => { document.documentElement.dataset.theme = theme })
  $effect(() => { document.documentElement.dataset.accent = accent })

  const THEME_ORDER = ['plain', 'terraria', 'doom']
  const THEME_NAMES = { plain: () => t('Обычный'), terraria: () => 'Terraria', doom: () => 'Doom' }
  // акценты Doom Eternal: ядовитый зелёный по умолчанию, но меняется как в игре
  const ACCENTS = [
    ['green', '#c8e400'], ['white', '#ececec'], ['red', '#ff3b2f'], ['blue', '#4a6dff'], ['cyan', '#35d5e5'],
  ]
  async function cycleTheme() {
    theme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length]
    await saveConfig({ uiTheme: theme }).catch(() => {})
  }
  async function pickAccent(a) {
    accent = a
    await saveConfig({ uiAccent: a }).catch(() => {})
  }

  async function worldReset() {
    if (!confirm(t('♻ Снести тестовый мир и сгенерировать новый?\nВсе боты будут ПОЛНОСТЬЮ удалены со стенда, персоны и планировка комнат станут другими.'))) return
    resettingWorld = true
    await fetch('/api/world/reset', { method: 'POST' }).then((r) => r.json()).catch(() => null)
    resettingWorld = false
  }

  const s = $derived(sim.state)
  const meta = $derived(
    s
      ? `${t('скорость')} ×${s.speed} · ${t('тик')} ${s.tickSeconds}${i18n.lang === 'en' ? 's' : 'с'} · ${t('смена')} ${s.shift?.id ? '#' + s.shift.id : '—'} · ` +
        `${t('в клубе')} ${s.bots.filter((b) => b.hostName).length} ${t('из')} ${s.bots.length}` +
        (s.paused ? ` · ⏸ ${t('ПАУЗА')}` : '')
      : t('подключение…'),
  )

  async function togglePause() {
    await action(s?.paused ? 'resume' : 'pause')
  }
</script>

<div class="app">
  <header>
    <h1>🎮 Gizmo Sandbox</h1>
    <span class="meta">{meta}</span>

    <Tabs.Root bind:value={tab}>
      <Tabs.List class="tabs">
        <Tabs.Trigger value="dash" class="tab">{t('Дашборд')}</Tabs.Trigger>
        <Tabs.Trigger value="map" class="tab">{t('🕹 Вид сверху')}</Tabs.Trigger>
        <Tabs.Trigger value="tests" class="tab">{t('🧪 Тесты API')}</Tabs.Trigger>
      </Tabs.List>
    </Tabs.Root>

    <span class="actions">
      <ForceMenu />
      <button class="btn" class:on={reportsOpen} onclick={() => (reportsOpen = !reportsOpen)}>{t('📊 Отчёты')}</button>
      <button class="btn" onclick={togglePause}>{s?.paused ? t('▶ Продолжить') : t('⏸ Пауза')}</button>
      <button class="btn" onclick={toggleLang} title="Language">🌐 {i18n.lang.toUpperCase()}</button>
      <button class="btn" onclick={cycleTheme} title={t('Сменить тему интерфейса')}>🎨 {THEME_NAMES[theme]()}</button>
      {#if theme === 'doom'}
        <span class="accents" title="Акцентный цвет Doom">
          {#each ACCENTS as [id, color]}
            <button class="acc" class:on={accent === id} style="--c:{color}" onclick={() => pickAccent(id)} aria-label={id}></button>
          {/each}
        </span>
      {/if}
      <button class="btn" onclick={worldReset} disabled={resettingWorld}>
        {resettingWorld ? t('⏳ Генерирую…') : t('♻ Мир')}
      </button>
      <button class="btn" onclick={() => (settingsOpen = true)}>{t('⚙ Настройки')}</button>
    </span>
  </header>

  <main>
    {#if tab === 'dash'}
      <Dashboard />
    {:else if tab === 'map'}
      <ClubMap />
    {:else}
      <ApiTests />
    {/if}
  </main>
</div>

<ReportsPanel bind:open={reportsOpen} />
<SettingsDialog bind:open={settingsOpen} />
{#if wizard}
  <SetupWizard onDone={(r) => { wizard = false; theme = r.uiTheme; accent = r.uiAccent ?? 'green'; tab = r.uiMode === 'api' ? 'tests' : 'dash' }} />
{/if}

<style>
  .app { height: 100%; display: flex; flex-direction: column; padding: 14px 16px; gap: 12px; }
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 18px; }
  .meta { color: var(--dim); font-size: 13px; }
  .actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
  main { flex: 1; min-height: 0; overflow: auto; }

  :global(.tabs) { display: inline-flex; gap: 4px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 9px; padding: 3px; }
  :global(.tab) { background: transparent; border: none; color: var(--dim); border-radius: 7px;
    padding: 5px 14px; font-size: 13px; cursor: pointer; }
  :global(.tab:hover) { color: var(--text); }
  .accents { display: inline-flex; gap: 5px; align-items: center; padding: 0 2px; }
  .acc { width: 18px; height: 18px; border-radius: 3px; cursor: pointer; background: var(--c);
    border: 2px solid transparent; clip-path: polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%);
    opacity: 0.55; transition: opacity .15s; padding: 0; }
  .acc:hover { opacity: 0.85; }
  .acc.on { opacity: 1; box-shadow: 0 0 10px var(--c); }
  :global(.tab[data-state='active']) { background: rgba(88, 166, 255, 0.14); color: var(--blue); font-weight: 600; }
</style>
