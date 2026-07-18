<script>
  // Настройки симуляции — модальный диалог (bits-ui Dialog).
  // ⟳ в подписи — параметр применится после перезапуска симулятора.
  import { Dialog } from 'bits-ui'
  import { fetchConfig, saveConfig } from '../lib/sim.svelte.js'

  let { open = $bindable(false) } = $props()

  const SCHEMA = [
    ['Подключение Gizmo ⟳', [
      ['gizmo.ip', 'IP', true], ['gizmo.port', 'Порт'], ['gizmo.username', 'Логин'],
      ['gizmo.password', 'Пароль', true], ['branchId', 'Бренч'],
    ]],
    ['SQL для AppStat ⟳', [
      ['sql.host', 'Хост', true], ['sql.port', 'Порт'], ['sql.database', 'База'],
      ['sql.user', 'Логин'], ['sql.password', 'Пароль', true],
    ]],
    ['Симуляция', [
      ['players', 'Ботов на старте ⟳'], ['maxPlayers', 'Максимум игроков'],
      ['maxSeated', 'Максимум сидящих (лицензия)'],
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
      ['operator.orderPrepMinutes.0', 'Готовка: от'], ['operator.orderPrepMinutes.1', 'Готовка: до'],
      ['operator.saleCooldownMin.0', 'Касса: от'], ['operator.saleCooldownMin.1', 'Касса: до'],
      ['operator.shiftHours', 'Смена, часов'],
    ]],
    ['Веса событий (за тик)', [
      ['weights.arrive', '🪑 Посадка'], ['weights.groupArrive', '👥 Компания'], ['weights.order', '🍔 Заказ'],
      ['weights.buyTime', '⏱ Пакет времени'], ['weights.deposit', '💵 Пополнение'], ['weights.reserve', '📅 Бронь'],
      ['weights.asset', '🎧 Ассет'], ['weights.appSession', '🎮 Игра (SQL)'], ['weights.operatorSale', '🧾 Касса'],
      ['weights.life', '💬 Жизнь'], ['weights.newcomer', '📝 Новый игрок'], ['weights.tournament', '🏆 Турнир'],
    ]],
  ]

  let cfg = $state(null)
  let msg = $state('')

  const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o)
  const setPath = (o, p, v) => {
    const ks = p.split('.'); const last = ks.pop()
    ks.reduce((a, k) => a[k], o)[last] = v
  }

  $effect(() => {
    if (open) { msg = ''; fetchConfig().then((c) => (cfg = c)) }
  })

  function onInput(path, raw) {
    const old = getPath(cfg, path)
    const val = typeof old === 'number' ? Number(raw) : old === null && raw === '' ? null : raw
    if (typeof old === 'number' && Number.isNaN(val)) return
    setPath(cfg, path, val)
  }

  async function save() {
    const r = await saveConfig($state.snapshot(cfg))
    msg = r.ok ? '✓ сохранено — параметры с ⟳ применятся после перезапуска' : '✗ ' + (r.error ?? 'ошибка')
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="dlg-overlay" />
    <Dialog.Content class="dlg">
      <div class="dlg-head">
        <Dialog.Title class="dlg-title">⚙ Настройки симуляции</Dialog.Title>
        <Dialog.Close class="dlg-x">×</Dialog.Close>
      </div>
      <p class="hint">жёлтые ⟳ — применятся после перезапуска, остальные действуют сразу</p>

      {#if !cfg}
        <p class="hint">Загрузка…</p>
      {:else}
        <div class="groups">
          {#each SCHEMA as [title, items]}
            <div class="group">
              <h3>{title}</h3>
              {#each items as [path, label, wide]}
                <label class="row">
                  <span>{label}</span>
                  <input
                    class:wide
                    value={getPath(cfg, path) ?? ''}
                    onchange={(e) => onInput(path, e.currentTarget.value.trim())}
                  />
                </label>
              {/each}
            </div>
          {/each}
        </div>
        <div class="foot">
          <button class="btn primary" onclick={save}>Сохранить (sim.config.json)</button>
          <span class="msg" class:ok={msg.startsWith('✓')}>{msg}</span>
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.dlg-overlay) { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 95; }
  :global(.dlg) { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 96;
    width: min(1060px, 94vw); max-height: 88vh; overflow-y: auto;
    background: var(--bg); border: 1px solid var(--line); border-radius: 14px; padding: 18px;
    color: var(--text); font-size: 13px; box-shadow: 0 30px 90px rgba(0, 0, 0, 0.6); }
  .dlg-head { display: flex; align-items: center; }
  :global(.dlg-title) { font-size: 15px; font-weight: 700; }
  :global(.dlg-x) { margin-left: auto; background: none; border: none; color: var(--dim); font-size: 22px; cursor: pointer; }
  :global(.dlg-x:hover) { color: var(--text); }
  .hint { color: var(--amber); font-size: 12px; margin: 6px 0 12px; }
  .groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; }
  .group { border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .group h3 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .row span { flex: 1; }
  .row input { background: var(--bg); border: 1px solid var(--line); color: var(--text); border-radius: 6px;
    padding: 4px 8px; width: 86px; font: inherit; }
  .row input.wide { width: 150px; }
  .row input:focus { outline: none; border-color: var(--blue); }
  .foot { margin-top: 14px; display: flex; align-items: center; gap: 10px; }
  .msg { font-size: 13px; color: var(--red); }
  .msg.ok { color: var(--green); }
</style>
