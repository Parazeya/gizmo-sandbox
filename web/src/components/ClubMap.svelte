<script>
  import { onMount } from 'svelte'
  import { createScene } from '../lib/scene.js'
  import { sim } from '../lib/sim.svelte.js'

  let cvEl = $state(null)
  let scene = null
  let fed = 0

  onMount(() => {
    scene = createScene(cvEl)
    fed = sim.feed.length // историю ленты не проигрываем — только новые события
    if (sim.state) scene.setState(sim.state)
    scene.fitCam()
    return () => { scene.destroy(); scene = null }
  })

  $effect(() => {
    if (scene && sim.state) scene.setState(sim.state)
  })
  $effect(() => {
    const len = sim.feed.length
    if (!scene) return
    if (len < fed) fed = len // лента пересоздана (реконнект SSE) — не проигрывать историю
    while (fed < len) scene.handleEvent(sim.feed[fed++].msg)
  })
</script>

<div class="wrap">
  <span class="hint">колесо — зум · тяни — перемещение · двойной клик — вписать</span>
  <canvas bind:this={cvEl}></canvas>
</div>

<style>
  .wrap { height: 100%; background: #07090d; border: 1px solid var(--line); border-radius: 12px;
    padding: 8px; position: relative; }
  .hint { position: absolute; top: 12px; left: 16px; z-index: 2; color: var(--dim); font-size: 11px; opacity: .7; pointer-events: none; }
  canvas { width: 100%; height: 100%; display: block; border-radius: 6px; cursor: grab; touch-action: none; }
</style>
