<script>
  // Немодальная выдвижная панель: отчёты в реальном времени поверх любого вида,
  // страница под ней остаётся полностью интерактивной.
  import { fly } from 'svelte/transition'
  import { t } from '../lib/i18n.svelte.js'
  import { sim } from '../lib/sim.svelte.js'
  import { drawChart } from '../lib/charts.js'

  let { open = $bindable(false) } = $props()
  let range = $state(5)
  let c1 = $state(null), c2 = $state(null), c3 = $state(null), c4 = $state(null)

  const last = $derived(sim.history.at(-1) ?? null)

  $effect(() => {
    if (!open) return
    let raf
    const loop = () => {
      if (sim.history.length && c1) {
        drawChart(c1, sim.history, [{ k: 'seated', c: '#3fb950', f: true }], range, 0)
        drawChart(c2, sim.history, [{ k: 'revenue', c: '#d29922', f: true }], range, 0)
        drawChart(c3, sim.history, [{ k: 'queue', c: '#58a6ff', f: true }], range, 4)
        drawChart(c4, sim.history, [
          { k: 'delivered', c: '#3fb950' },
          { k: 'sale', c: '#e85aad' },
          { k: 'deposit', c: '#58a6ff' },
        ], range, 0)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  })

  function onKey(e) {
    if (e.key === 'Escape' && open) open = false
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <aside transition:fly={{ x: 480, duration: 220 }}>
    <div class="head">
      <b>{t('📊 Отчёты')} · {t('реальное время')}</b>
      {#if last}<span class="m">{new Date(last.t).toLocaleTimeString('ru-RU')}</span>{/if}
      <button class="x" onclick={() => (open = false)} title="Закрыть">×</button>
    </div>
    <div class="rng">
      {#each [1, 5, 15] as m}
        <button class="btn" class:on={range === m} onclick={() => (range = m)}>{m} {t('мин')}</button>
      {/each}
    </div>

    <div class="card">
      <h4>{t('Занятость клуба')}</h4>
      <div class="v" style="color:var(--green)">{last ? `${last.seated} из ${last.bots} за хостами` : '—'}</div>
      <canvas bind:this={c1}></canvas>
    </div>
    <div class="card">
      <h4>{t('Касса за сеанс')}</h4>
      <div class="v" style="color:var(--amber)">{last ? last.revenue.toLocaleString('ru-RU') + ' ₽' : '—'}</div>
      <canvas bind:this={c2}></canvas>
    </div>
    <div class="card">
      <h4>{t('Очередь заказов бара')}</h4>
      <div class="v" style="color:var(--blue)">{last ? last.queue + ' в очереди' : '—'}</div>
      <canvas bind:this={c3}></canvas>
    </div>
    <div class="card">
      <h4>{t('Сервис (всего за сеанс)')}</h4>
      <div class="lg">
        <span><i style="background:var(--green)"></i>выдано</span>
        <span><i style="background:var(--pink)"></i>касса</span>
        <span><i style="background:var(--blue)"></i>пополнения</span>
      </div>
      <canvas bind:this={c4}></canvas>
    </div>
  </aside>
{/if}

<style>
  /* Ниже шапки: кнопки хедера остаются кликабельными при открытой панели */
  aside { position: fixed; top: 56px; right: 0; width: 480px; max-width: 96vw; height: calc(100vh - 56px);
    z-index: 90; background: rgba(13, 17, 23, 0.97); border-left: 1px solid var(--line);
    border-top: 1px solid var(--line); border-top-left-radius: 12px;
    box-shadow: -18px 0 50px rgba(0, 0, 0, 0.55); padding: 14px; overflow-y: auto; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .head b { font-size: 14px; }
  .head .m { color: var(--dim); font-size: 11px; margin-left: auto; }
  .x { background: none; border: none; color: var(--dim); font-size: 20px; cursor: pointer; line-height: 1; }
  .x:hover { color: var(--text); }
  .rng { display: flex; gap: 6px; margin-bottom: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
  .card h4 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--dim); margin: 0; }
  .card .v { font-size: 16px; font-weight: 800; margin: 2px 0 6px; }
  .card canvas { width: 100%; height: 120px; display: block; }
  .lg { display: flex; gap: 10px; font-size: 10.5px; color: var(--dim); margin: 4px 0 6px; flex-wrap: wrap; }
  .lg i { display: inline-block; width: 9px; height: 3px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
</style>
