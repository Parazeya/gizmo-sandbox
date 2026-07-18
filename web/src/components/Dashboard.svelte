<script>
  import { sim } from '../lib/sim.svelte.js'

  const s = $derived(sim.state)
  const TRAIT_EMO = { задрот: '🎧', казуал: '🙂', гурман: '🍕', молчун: '🤐', залётный: '🌪', стример: '📹' }

  const chips = $derived(
    s
      ? [
          ['💰 касса за сеанс', Math.round(s.revenue)],
          ['🪑 посадок', s.stats.arrive], ['👥 компаний', s.stats.group], ['🍔 заказов', s.stats.order],
          ['✅ выдано', s.stats.delivered], ['🧾 продаж на кассе', s.stats.sale], ['💵 пополнений', s.stats.deposit],
          ['⏱ пакетов времени', s.stats.buyTime], ['📅 броней', s.stats.reserve], ['🎮 игр', s.stats.appSession],
          ['🏆 турниров', s.stats.tournament], ['🚪 уходов', s.stats.leave], ['📝 регистраций', s.stats.newcomer],
        ]
      : [],
  )

  let feedEl = $state(null)
  // автоскролл ленты вниз при новых событиях
  $effect(() => {
    void sim.feed.length
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight
  })

  const botStatus = (b) =>
    b.hostName
      ? `🪑 ${b.hostName} · сидит ${b.sittingMin} мин · ещё ~${b.leftMin}`
      : b.present
        ? '☕ в клубе, не за хостом'
        : '🏠 сегодня не придёт'
</script>

{#if !s}
  <p class="empty">Подключение к симулятору…</p>
{:else}
  <div class="chips">
    {#each chips as [k, v]}<span class="chip">{k}: <b>{v ?? 0}</b></span>{/each}
  </div>

  <div class="grid">
    <div class="col">
      <div class="panel">
        <h2>Хосты</h2>
        <div class="hosts">
          {#each s.hosts as h (h.name)}
            {@const who = (h.sitters ?? []).join(', ')}
            <div class="host" class:busy={who}>
              <div class="n">
                {h.name}
                {#if h.maxUsers > 1}<span class="cap">{h.sitters?.length ?? 0}/{h.maxUsers}</span>{/if}
              </div>
              {#if who}<div class="who">{who}</div>{/if}
            </div>
          {/each}
        </div>
      </div>

      <div class="panel">
        <h2>Живая лента</h2>
        <div class="feed" bind:this={feedEl}>
          {#each sim.feed as line}
            <div><span class="t">{line.t}</span>{line.msg}</div>
          {/each}
        </div>
      </div>
    </div>

    <div class="col">
      <div class="panel">
        <h2>Игроки</h2>
        <div class="bots">
          {#each s.bots as b (b.username)}
            <div class="bot" class:seated={b.hostName} class:away={!b.present && !b.hostName}>
              <div class="ava">{TRAIT_EMO[b.trait] ?? '🙂'}</div>
              <div class="info">
                <div class="name">{b.name} <span class="trait">({b.username} · {b.trait})</span></div>
                <div class="trait">
                  {botStatus(b)}
                  {#if b.assets.length}<br />🎧 {b.assets.join(', ')}{/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      </div>

      <div class="panel">
        <h2>Очередь заказов</h2>
        {#if s.orders.length}
          {#each s.orders as o (o.id)}
            <div class="order">
              <span class="badge" class:cook={o.status === 1}>{o.status === 0 ? 'новый' : 'готовится'}</span>
              #{o.id} <span class="dim">{o.ageMin} мин назад</span>
            </div>
          {/each}
        {:else}
          <p class="empty">очередь пуста — оператор всё разгрёб 👌</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 14px; }
  @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }
  .col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

  .hosts { display: grid; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 6px; }
  .host { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; min-height: 52px; background: var(--bg); }
  .host .n { font-size: 11px; color: var(--dim); }
  .host .cap { color: var(--dim); }
  .host.busy { border-color: var(--busy, var(--green)); background: color-mix(in srgb, var(--busy, var(--green)) 8%, transparent); }
  .host.busy .who { color: var(--busy, var(--green)); font-weight: 600; font-size: 12px; }

  .bots { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; }
  .bot { display: flex; gap: 10px; align-items: center; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  .bot .ava { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--line); font-size: 16px; flex: none; }
  .bot .info { min-width: 0; }
  .bot .name { font-weight: 600; }
  .bot .trait { color: var(--dim); font-size: 12px; }
  .bot.seated .trait { color: var(--dim); }
  .bot.away { opacity: 0.55; }

  .feed { height: 420px; overflow-y: auto; font: 12.5px/1.6 ui-monospace, Consolas, monospace; }
  .feed div { padding: 1px 0; border-bottom: 1px dashed rgba(48, 54, 61, 0.5); }
  .feed .t { color: var(--dim); margin-right: 8px; }

  .order { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
  .order:last-child { border-bottom: 0; }
  .badge { border-radius: 20px; padding: 1px 9px; font-size: 11px; font-weight: 600;
    background: rgba(210, 153, 34, 0.15); color: var(--amber); }
  .badge.cook { background: rgba(88, 166, 255, 0.15); color: var(--blue); }
  .dim { color: var(--dim); }
  .empty { color: var(--dim); font-size: 13px; padding: 6px 0; }
</style>
