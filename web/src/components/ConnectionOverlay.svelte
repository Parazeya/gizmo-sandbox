<script>
  // Экран ожидания связи. Пока Gizmo API и SQL не ответят, симулятор ничего не
  // делает — тут видно, что именно лежит и сколько до следующей проверки.
  import { sim, checkHealth } from '../lib/sim.svelte.js'
  import { t } from '../lib/i18n.svelte.js'

  const h = $derived(sim.health)
  const firstRun = $derived(!h?.everConnected)   // ещё ни разу не подключались — это ожидание, а не потеря

  // Обратный отсчёт: сервер присылает целое число секунд, между пушами тикаем сами.
  let left = $state(null)
  $effect(() => {
    left = h?.nextCheckSec ?? null
  })
  $effect(() => {
    const id = setInterval(() => { if (left > 0) left-- }, 1000)
    return () => clearInterval(id)
  })

  const rows = $derived([
    ['Gizmo API', h?.api],
    ['SQL (AppStat)', h?.sql],
  ])

  const mark = (ok) => (ok === true ? '🟢' : ok === 'skip' ? '⚪' : '🔴')

  let rechecking = $state(false)
  async function recheck() {
    rechecking = true
    await checkHealth()
    rechecking = false
  }
</script>

{#if h?.frozen}
  <div class="wall">
    <div class="card">
      <h2>{firstRun ? t('🔌 Жду связь с клубом') : t('❄ Связь с клубом потеряна')}</h2>

      <div class="rows">
        {#each rows as [name, st]}
          <div class="row">
            <span class="dot">{mark(st?.ok)}</span>
            <span class="name">{name}</span>
            <span class="detail" class:bad={st?.ok === false}>{st?.detail ?? t('проверяю…')}</span>
          </div>
        {/each}
      </div>

      <p class="note">
        {firstRun
          ? t('Симуляция не стартует, пока клуб не ответит.')
          : t('Симуляция заморожена и продолжится сама, как только связь вернётся.')}
        {#if !firstRun && h.downSec}<span class="dim"> {t('нет связи уже')} {h.downSec} {t('с')}</span>{/if}
      </p>

      <div class="foot">
        <span class="dim">
          {#if h.checking || rechecking}
            {t('проверяю…')}
          {:else if left != null}
            {t('следующая проверка через')} {left} {t('с')} · {t('попытка')} {h.attempt}
          {/if}
        </span>
        <button class="btn primary" onclick={recheck} disabled={h.checking || rechecking}>{t('⟳ Проверить сейчас')}</button>
      </div>

      <p class="hint">{t('Адрес, логин и пароль — в ⚙ Настройках (окно открывается поверх этого экрана).')}</p>
    </div>
  </div>
{/if}

<style>
  /* Ставим ниже мастера первого запуска (200) и выше настроек (96) — но клики
     сквозь фон пропускаем, чтобы можно было открыть ⚙ и починить креды. */
  .wall {
    position: fixed; inset: 0; z-index: 150; pointer-events: none;
    background: rgba(5, 8, 12, 0.72); backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    pointer-events: auto; width: min(560px, 100%);
    background: var(--panel); border: 1px solid var(--red); border-radius: 12px;
    padding: 18px 20px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
  }
  h2 { font-size: 16px; margin-bottom: 14px; }
  .rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
  .dot { font-size: 11px; }
  .name { min-width: 110px; }
  .detail { color: var(--dim); }
  .detail.bad { color: var(--red); }
  .note { font-size: 13px; margin-bottom: 14px; }
  .dim { color: var(--dim); }
  .foot { display: flex; align-items: center; gap: 12px; font-size: 12px; }
  .foot .btn { margin-left: auto; }
  .hint { color: var(--dim); font-size: 12px; margin-top: 10px; }
</style>
