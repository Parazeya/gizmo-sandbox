<script>
  // Форс-события — выпадающее меню (bits-ui DropdownMenu)
  import { DropdownMenu } from 'bits-ui'
  import { action } from '../lib/sim.svelte.js'

  const ITEMS = [
    ['arrive', '🪑 Посадить игрока'],
    ['groupArrive', '👥 Компания'],
    ['newcomer', '📝 Новый игрок'],
    ['order', '🍔 Заказ бара'],
    ['tournament', '🏆 Турнир'],
    ['deposit', '💵 Пополнение'],
    ['operatorSale', '🧾 Продажа на кассе'],
    ['life', '💬 Жизнь'],
  ]
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="btn">⚡ События ▾</DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content class="dd" sideOffset={6} align="end">
      {#each ITEMS as [name, label]}
        <DropdownMenu.Item class="dd-item" onSelect={() => action(name)}>{label}</DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<style>
  :global(.dd) { z-index: 100; background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 5px; min-width: 200px; box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
    font-size: 13px; color: var(--text); }
  :global(.dd-item) { padding: 7px 10px; border-radius: 7px; cursor: pointer; outline: none; }
  :global(.dd-item:hover), :global(.dd-item[data-highlighted]) { background: rgba(88, 166, 255, 0.12); color: var(--blue); }
</style>
