// "Exchange-style" live charts: the tape continuously scrolls left (the X axis
// is anchored to "now"), the last price stretches to the right edge with a
// price tag and a pulsing dot.
const dpr = () => window.devicePixelRatio || 1

const fmtT = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
export const nice = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'к' : String(Math.round(v)))

/**
 * @param cv canvas
 * @param hist array of points {t, ...}
 * @param series [{k, c, f?}] — key, color, fill
 * @param rangeMin window in minutes
 * @param minMax minimum Y-axis ceiling
 */
export function drawChart(cv, hist, series, rangeMin, minMax = 0) {
  const D = dpr()
  const w = cv.clientWidth, h = cv.clientHeight
  if (!w) return
  if (cv.width !== Math.round(w * D)) { cv.width = w * D; cv.height = h * D }
  const ctx = cv.getContext('2d')
  ctx.setTransform(D, 0, 0, D, 0, 0)
  ctx.clearRect(0, 0, w, h)

  const now = Date.now(), t1 = now, t0 = now - rangeMin * 60000
  const pts = hist.filter((p) => p.t >= t0 - 2000)
  const padL = 34, padR = 50, padT = 5, padB = 15
  const iw = w - padL - padR, ih = h - padT - padB
  if (pts.length < 2) {
    ctx.fillStyle = '#8b949e'; ctx.font = '11px system-ui'
    ctx.fillText('Копим данные…', w / 2 - 42, h / 2)
    return
  }

  let vMax = 1
  for (const s of series) for (const p of pts) vMax = Math.max(vMax, p[s.k] ?? 0)
  vMax = Math.max(minMax, vMax) * 1.18

  const X = (t) => padL + (iw * (t - t0)) / (t1 - t0)
  const Y = (v) => padT + ih - (ih * v) / vMax

  // Y grid
  ctx.font = '9px system-ui'; ctx.textAlign = 'right'
  for (let i = 0; i <= 3; i++) {
    const y = padT + ih - (ih * i) / 3
    ctx.strokeStyle = 'rgba(139,148,158,.1)'
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke()
    ctx.fillStyle = '#66707c'; ctx.fillText(nice((vMax * i) / 3), padL - 4, y + 3)
  }
  // sliding time grid (round intervals)
  const step = rangeMin === 1 ? 15000 : rangeMin === 5 ? 60000 : 180000
  ctx.textAlign = 'center'
  for (let tt = Math.ceil(t0 / step) * step; tt <= t1; tt += step) {
    const x = X(tt)
    if (x < padL || x > w - padR) continue
    ctx.strokeStyle = 'rgba(139,148,158,.07)'
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke()
    ctx.fillStyle = '#66707c'; ctx.fillText(fmtT(tt).slice(0, 5), x, h - 3)
  }
  ctx.textAlign = 'left'

  ctx.save(); ctx.beginPath(); ctx.rect(padL, padT, iw, ih); ctx.clip()
  for (const s of series) {
    const lastV = pts[pts.length - 1][s.k] ?? 0
    const path = () => {
      ctx.beginPath()
      ctx.moveTo(X(pts[0].t), Y(pts[0][s.k] ?? 0))
      for (const p of pts) ctx.lineTo(X(p.t), Y(p[s.k] ?? 0))
      ctx.lineTo(X(t1), Y(lastV))
    }
    if (s.f) {
      path()
      ctx.lineTo(X(t1), padT + ih); ctx.lineTo(X(pts[0].t), padT + ih); ctx.closePath()
      const g = ctx.createLinearGradient(0, padT, 0, padT + ih)
      g.addColorStop(0, s.c + '4d'); g.addColorStop(1, s.c + '05')
      ctx.fillStyle = g; ctx.fill()
    }
    path()
    ctx.strokeStyle = s.c; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke()
  }
  ctx.restore()

  // price tags and pulse dots
  series.forEach((s, si) => {
    const lastV = pts[pts.length - 1][s.k] ?? 0
    const y = Math.max(padT + 7, Math.min(padT + ih - 7, Y(lastV)))
    ctx.strokeStyle = s.c + '55'; ctx.setLineDash([3, 4])
    ctx.beginPath(); ctx.moveTo(padL, Y(lastV)); ctx.lineTo(w - padR, Y(lastV)); ctx.stroke()
    ctx.setLineDash([])
    const pulse = 2 + Math.sin(now / 240 + si)
    ctx.fillStyle = s.c + '44'; ctx.beginPath(); ctx.arc(w - padR, Y(lastV), pulse + 2.5, 0, 7); ctx.fill()
    ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(w - padR, Y(lastV), 2.2, 0, 7); ctx.fill()
    ctx.font = 'bold 9px system-ui'
    const lb = nice(lastV), bw = ctx.measureText(lb).width + 8
    ctx.fillStyle = s.c; ctx.fillRect(w - padR + 4, y - 7, bw, 13)
    ctx.fillStyle = '#0d1117'; ctx.fillText(lb, w - padR + 8, y + 3)
  })
}
