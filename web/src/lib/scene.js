// Пиксельная сцена клуба (вид сверху). АВТОПОРТ из src/ui.js PAGE_CLUB —
// логика 1:1, но данные приходят снаружи: setState(снапшот /api/state) и
// handleEvent(строка ленты). Камера: колесо-зум, драг-пан, dblclick — вписать.
export function createScene(cv) {

  const ctx = cv.getContext('2d')
  const T = 16
  // Тема сцены следует теме интерфейса: plain | terraria | doom.
  // В doom игроки — демоны, персонал — Doomguy; в terraria оператор — Гид.
  let TH = 'plain'
  const readTheme = () => { TH = document.documentElement.dataset.theme || 'plain' }
  const isStaff = (a) => a.u === 'op' || a.u === 'courier' || a.u === 'chef'
  const SKINS = ['#e8b088', '#d99e73', '#c68a5f', '#f0c09a', '#b87a52']   // тона кожи (Terraria)
  // Шкуры демонов классического Doom по типажу: имп, хелл-найт, пинки, спектр…
  const DEMONC = { 'задрот': '#a8623a', 'казуал': '#5a8a3a', 'гурман': '#c46a86', 'молчун': '#767a80', 'залётный': '#b08a4a', 'стример': '#b03a2a' }
  const TRAITC = { 'задрот':'#4a90d9', 'казуал':'#3fb950', 'гурман':'#e0823d', 'молчун':'#78828c', 'залётный':'#d2b322', 'стример':'#e85aad' }
  const HAIRS = ['#2b2019','#5b3a21','#c9a15a','#1c1c22','#7a2e1d','#4b4e57','#8a5db0','#a03b2a','#3a5a8c']
  const PANTS = ['#2f5aa8','#20242e','#5b3a21','#3a3f4a','#43356b','#2c463c']  // джинсы/штаны
  const hsh = (s) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) } return h >>> 0 }

  let built = false, desks = [], deskByName = new Map()
  let actors = new Map(), banners = [], opBubble = null, stateData = null, inited = false
  let afkHostNames = new Set()      // хосты, у которых игрок вышел покурить (AFK)
  const DOOR = { x: 508, y: 588 }   // проём во входной стене
  const BAR = { x: 130, y: 490 }   // куда встают клиенты ПЕРЕД стойкой (сверху)
  const OP = { x: 178, y: 538 }    // оператор ЗА стойкой (ниже, у полок)
  const WORLD_H = 664              // высота сцены с учётом улицы-курилки снизу
  const SMOKE = { y: 632 }         // курилка на улице (ниже входной стены)
  const WC = { x: 436, y: 562 }        // туалет — комнатка у нижней стены, правее кухни
  const KITCHEN = { x: 336, y: 476, w: 136, h: 54 }  // кухня — между баром и WC
  const PASS = { x: 333, y: 508 }      // окно выдачи кухня→бар (отсюда стартует курьер)
  const FOODC = ['#e0823d', '#3fb950', '#f0c674', '#e85aad', '#58a6ff', '#d29922']
  // Выдача заказов: очередь id из событий «✅ выдал заказ», курьер-официант
  let orderOwners = new Map()          // orderId → username (из state.orders)
  let deliveries = []
  let courier = null
  const smokeSpot = (u) => ({ x: 424 + (hsh(u + 'smk') % 5) * 34, y: SMOKE.y })
  // Все состояния «человек отошёл» — на его хосте показываем AFK.
  const AWAY_STATES = new Set(['tosmoke', 'tosmoke2', 'smoking', 'fromsmoke', 'fromsmoke2', 'towc', 'inwc', 'fromwc'])

  function classify(name) {
    if (/vip/i.test(name)) return 'vip'
    if (/boot/i.test(name)) return 'boot'
    return 'pc'
  }
  const num = (name) => Number((String(name).match(/\d+/) || [999])[0])

  let layoutSeed = 1   // поколение мира: другой seed → другая планировка комнат
  function buildLayout(hosts) {
    desks = []; deskByName = new Map()
    const pcs = hosts.filter(h => classify(h.name) === 'pc').sort((a, b) => num(a.name) - num(b.name))
    const vips = hosts.filter(h => classify(h.name) === 'vip').sort((a, b) => num(a.name) - num(b.name))
    const boots = hosts.filter(h => classify(h.name) === 'boot').sort((a, b) => num(a.name) - num(b.name))
    const add = (h, tx, ty, zone) => {
      const x = tx * T, y = ty * T
      // Место — ниже стола: персонаж сидит ПЕРЕД монитором (лицом к камере).
      const d = { name: h.name, x, y, zone, seat: { x: x + 18, y: y + 44 } }
      desks.push(d); deskByName.set(h.name, d)
    }
    const cons = hosts.filter(h => (h.maxUsers ?? 1) > 1 || h.type === 'endpoint')
      .sort((a, b) => num(a.name) - num(b.name))
    const consSet = new Set(cons.map(h => h.name))
    // Планировка зависит от поколения мира: число колонок в зале и то, какая
    // из комнат (VIP или BOOTCAMP) сверху — «новые комнаты» после пересоздания.
    const cols = 5 + (layoutSeed % 3)              // 5..7 колонок ПК
    const swapRight = layoutSeed % 2 === 1         // нечётное поколение — BOOT сверху
    pcs.filter(h => !consSet.has(h.name)).forEach((h, i) => add(h, 3 + (i % cols) * 5, 4 + Math.floor(i / cols) * 5, 'pc'))
    // Шаг 5 тайлов: имя сидящего (y+56) не должно наезжать на подпись следующего ряда
    const topRoom = swapRight ? boots : vips
    const botRoom = swapRight ? vips : boots
    topRoom.forEach((h, i) => add(h, 37 + (i % 2) * 12, 3 + Math.floor(i / 2) * 5, swapRight ? 'boot' : 'vip'))
    botRoom.forEach((h, i) => add(h, 37 + (i % 2) * 12, 18 + Math.floor(i / 2) * 5, swapRight ? 'vip' : 'boot'))
    // Консоли: ТВ + диван на несколько мест (слоты вдоль дивана)
    cons.forEach((h, i) => {
      const tx = 36 + (i % 2) * 13, ty = 30
      const x = tx * T, y = ty * T
      const seats = []
      const cap = Math.min(4, h.maxUsers ?? 4)
      for (let s = 0; s < cap; s++) seats.push({ x: x + 10 + s * 15, y: y + 44 })
      const d = { name: h.name, x, y, zone: 'cons', seat: seats[0], seats, slots: {}, cap }
      desks.push(d); deskByName.set(h.name, d)
    })
    built = true
  }

  // Слот на диване: у каждого сидящего своё место, освобождается при уходе.
  function seatFor(desk, u) {
    if (!desk.seats) return desk.seat
    if (desk.slots[u] == null) {
      const used = new Set(Object.values(desk.slots))
      let idx = 0
      while (used.has(idx) && idx < desk.seats.length - 1) idx++
      desk.slots[u] = idx
    }
    return desk.seats[desk.slots[u]]
  }
  function freeSlots(u, exceptDesk) {
    for (const d of desks) if (d.slots && d !== exceptDesk) delete d.slots[u]
  }

  function mkActor(u, bot, atSeat, seat) {
    return {
      u, name: bot.name, trait: bot.trait,
      x: atSeat ? seat.x : DOOR.x, y: atSeat ? seat.y : DOOR.y,
      st: atSeat ? 'sit' : 'walkin', target: seat, seat,
      bubble: null,
      hair: HAIRS[hsh(u) % HAIRS.length],
      shirt: TRAITC[bot.trait] || '#4a90d9',
      pants: PANTS[hsh(u + 'p') % PANTS.length],
      hairStyle: hsh(u + 'h') % 4,
    }
  }

  function setState(s) {
      stateData = s
      // Пересоздание мира: новый layoutSeed → перестраиваем комнаты и актёров
      if (s.layoutSeed && s.layoutSeed !== layoutSeed) {
        layoutSeed = s.layoutSeed
        built = false
        actors.clear()
      }
      if (!built && s.hosts.length) buildLayout(s.hosts)
      if (!built) return
      const seatedU = new Set()
      for (const b of s.bots) {
        if (!b.hostName) continue
        const desk = deskByName.get(b.hostName)
        if (!desk) continue
        seatedU.add(b.username)
        freeSlots(b.username, desk)
        const seat = seatFor(desk, b.username)
        const a = actors.get(b.username)
        if (!a) {
          const na = mkActor(b.username, b, !inited, seat)
          na.couch = desk.zone === 'cons'  // на диване кресло не рисуем
          na.hostName = b.hostName
          actors.set(b.username, na)
        } else {
          a.couch = desk.zone === 'cons'
          a.hostName = b.hostName
          // не сбрасываем цель, если человек вышел покурить (SMOKE_STATES)
          if (a.seat !== seat && (a.st === 'sit' || a.st === 'walkin')) {
            a.seat = seat; a.target = seat; if (a.st === 'sit') a.st = 'walkin'
          }
        }
      }
      for (const [u, a] of actors) {
        // не выгоняем тех, кто у бара или отошёл (курилка/туалет) — пусть завершат
        if (!seatedU.has(u) && a.st !== 'walkout' && a.st !== 'tobar' && a.st !== 'atbar'
            && a.st !== 'back' && !AWAY_STATES.has(a.st)) {
          a.st = 'walkout'; a.target = DOOR
        }
      }
      inited = true
      // кому какой заказ принадлежит — для анимации выдачи курьером
      for (const o of s.orders) if (o.username) orderOwners.set(o.id, o.username)
      if (orderOwners.size > 200) orderOwners = new Map([...orderOwners].slice(-80))
  }

  // ── События → облачка ────────────────────────────────────────────────────────
  const short = (msg) => {
    const parts = msg.split(') ')
    let tail = parts.length > 1 ? parts.slice(1).join(') ') : msg
    const em = Array.from(msg)[0]
    tail = tail.replace(/\s*—.*$/, '').replace(/\s*\(комментарий.*$/, '')
    if (tail.length > 46) tail = tail.slice(0, 45) + '…'
    return em + ' ' + tail
  }
  function handleEvent(msg) {
    const em = Array.from(msg)[0]
    if ('🏆🌅📝🕐⚙⏸▶'.includes(em)) { banners.push({ text: msg.length > 90 ? msg.slice(0, 89) + '…' : msg, until: Date.now() + 6000 }); return }
    // «✅ оператор выдал заказ #N» → анимация выдачи курьером
    if (em === '✅') {
      const mo = msg.match(/#(\d+)/)
      if (mo) deliveries.push(Number(mo[1]))
    }
    const mu = msg.match(/\((sim_bot_\d+)\)/)
    if (mu && actors.has(mu[1])) {
      const a = actors.get(mu[1])
      a.bubble = { text: short(msg), until: Date.now() + 6000 }
      if (em === '🍔' && a.st === 'sit') { a.st = 'tobar'; a.target = { x: BAR.x + (hsh(a.u) % 60), y: BAR.y } }
      // «вышел покурить» — реально идёт на улицу через вход (хост остаётся занят/AFK)
      else if (/покурить/.test(msg) && a.st === 'sit') {
        a.st = 'tosmoke'; a.target = DOOR; a.smokeSpot = smokeSpot(a.u)
      }
      // «в туалет» — отходит в WC внутри клуба и возвращается
      else if (/туалет/.test(msg) && a.st === 'sit') {
        a.st = 'towc'; a.target = { x: WC.x + (hsh(a.u) % 12) - 6, y: WC.y }
      }
      else if (/телефон|мемы/.test(msg)) a.phoneUntil = Date.now() + 6000  // подсветка телефона
      return
    }
    if (msg.includes('оператор') || '💸✅👨‍🍳🧾🚫⚠'.includes(em)) {
      opBubble = { text: msg.length > 52 ? msg.slice(0, 51) + '…' : msg, until: Date.now() + 5000 }
    }
  }

  // ── Отрисовка ────────────────────────────────────────────────────────────────
  // ── Terraria-стиль: обводка + затенение ─────────────────────────────────────
  const OUTLINE = '#0a0c10'
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16)
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt }
    else { const f = 1 + amt; r *= f; g *= f; b *= f }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'
  }
  // Прямоугольник с тёмной обводкой (как тайл в Террарии)
  function outlineRect(x, y, w, h, color) {
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 1, y - 1, w + 2, h + 2)
    ctx.fillStyle = color; ctx.fillRect(x, y, w, h)
  }

  // Экран «в игре»: не рандомные блёстки, а анимированная сцена — небо/земля,
  // бегущий персонаж, редкие вспышки-выстрелы + мягкое пульсирующее свечение.
  const SCENE = [
    { sky: '#122438', ground: '#1e3a24', accent: '#54d17a' },  // лес
    { sky: '#241a2e', ground: '#3a2340', accent: '#c56ae0' },  // ночь
    { sky: '#2a1815', ground: '#3a241a', accent: '#e08a3a' },  // пустыня
    { sky: '#101c2e', ground: '#20303e', accent: '#5aa8e0' },  // море
  ]
  // В теме Doom на мониторах — адские уровни (красное небо, лава, огонь)
  const SCENE_DOOM = [
    { sky: '#2a0f0a', ground: '#3a1410', accent: '#ff8a3c' },
    { sky: '#1c1210', ground: '#33201a', accent: '#ffd23c' },
    { sky: '#240a12', ground: '#361016', accent: '#ff5a5a' },
    { sky: '#141018', ground: '#241a26', accent: '#c56ae0' },
  ]
  function drawScreen(x, y, w, h, seed, t) {
    const list = TH === 'doom' ? SCENE_DOOM : SCENE
    const sc = list[seed % list.length]
    const gy = Math.round(h * 0.62)
    // Обрезаем всё содержимое строго по прямоугольнику экрана — иначе холмы,
    // герой и вспышки «вылезают» за рамку монитора.
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.fillStyle = sc.sky; ctx.fillRect(x, y, w, gy)
    ctx.fillStyle = sc.ground; ctx.fillRect(x, y + gy, w, h - gy)
    ctx.fillStyle = shade(sc.ground, 0.15); ctx.fillRect(x, y + gy, w, 1)
    // параллакс-холмы (скроллятся)
    const off = Math.floor((t / 40 + seed * 7)) % (w + 8)
    ctx.fillStyle = shade(sc.sky, 0.12)
    for (let i = -1; i < w / 10 + 1; i++) {
      const hx = x + ((i * 10 - off % 10) )
      ctx.fillRect(hx, y + gy - 3, 6, 3)
    }
    // бегущий персонаж-пиксель (прыжки)
    const px = x + 3 + Math.floor((t / 55 + seed) % (w - 6))
    const jump = Math.max(0, Math.sin(t / 130 + seed) * 4) | 0
    ctx.fillStyle = sc.accent; ctx.fillRect(px, y + gy - 4 - jump, 3, 4)
    // враги навстречу
    const ex = x + w - 4 - Math.floor((t / 70 + seed * 3) % (w - 6))
    ctx.fillStyle = '#f0563f'; ctx.fillRect(ex, y + gy - 3, 3, 3)
    // редкая вспышка-выстрел
    if ((Math.floor(t / 90) + seed) % 5 === 0) {
      ctx.fillStyle = '#fff6c0'; ctx.fillRect(px + 3, y + gy - 3 - jump, Math.min(ex - px - 3, w), 1)
    }
    // HUD-полоска
    ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(x + 1, y + 1, w - 2, 2)
    ctx.fillStyle = sc.accent; ctx.fillRect(x + 1, y + 1, Math.max(2, (w - 2) * (0.4 + 0.5 * Math.abs(Math.sin(t / 700 + seed)))), 2)
    // мягкое свечение экрана (пульс)
    const glow = 0.06 + 0.05 * (0.5 + 0.5 * Math.sin(t / 380 + seed))
    ctx.fillStyle = 'rgba(150,200,255,' + glow.toFixed(3) + ')'; ctx.fillRect(x, y, w, h)
    ctx.restore()
  }

  // Ореол свечения вокруг включённого экрана (в тёмном зале)
  function screenHalo(x, y, w, h, t, seed) {
    const a = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(t / 380 + seed))
    const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 2, x + w / 2, y + h / 2, w)
    g.addColorStop(0, 'rgba(120,180,255,' + (a * 2).toFixed(3) + ')')
    g.addColorStop(1, 'rgba(120,180,255,0)')
    ctx.fillStyle = g; ctx.fillRect(x - w / 2, y - h / 2, w * 2, h * 2)
  }

  function drawFridge(x, y) {
    outlineRect(x, y, 32, 42, '#c4c9d0')                          // корпус
    ctx.fillStyle = '#dde1e7'; ctx.fillRect(x + 1, y + 1, 30, 4)  // блик сверху
    ctx.fillStyle = '#9aa1ab'; ctx.fillRect(x, y + 20, 32, 2)     // шов между дверями
    ctx.fillStyle = '#5f656e'; ctx.fillRect(x + 26, y + 6, 3, 10) // ручки
    ctx.fillRect(x + 26, y + 25, 3, 12)
    ctx.fillStyle = '#8b9099'; ctx.fillRect(x + 26, y + 6, 1, 10); ctx.fillRect(x + 26, y + 25, 1, 12)
    // стеклянная витрина снизу с едой/напитками
    outlineRect(x + 4, y + 24, 18, 14, '#16222e')
    const food = ['#e0823d', '#3fb950', '#f0c674', '#e85aad', '#58a6ff']
    for (let i = 0; i < 5; i++) { ctx.fillStyle = food[i]; ctx.fillRect(x + 6 + (i % 3) * 5, y + 27 + (i > 2 ? 5 : 0), 4, 4) }
  }

  // Задний бар: стеллаж с бутылками + два холодильника
  function drawBackBar() {
    const by = 556
    // стеллаж со стеклянными полками
    outlineRect(16, by, 150, 32, '#3a2c1c')
    ctx.fillStyle = '#4d3a25'; ctx.fillRect(18, by + 2, 146, 3)
    ctx.fillStyle = 'rgba(90,120,140,.25)'; ctx.fillRect(18, by + 13, 146, 3)   // стеклянная полка
    ctx.fillStyle = 'rgba(90,120,140,.25)'; ctx.fillRect(18, by + 26, 146, 3)
    const bcol = ['#3fb950', '#e0823d', '#58a6ff', '#e85aad', '#d2b322', '#f85149', '#2dd4bf', '#8b5cf6']
    for (let i = 0; i < 16; i++) {
      const c = bcol[i % bcol.length]
      const row = i < 8 ? by + 6 : by + 19
      const bx = 22 + (i % 8) * 18
      ctx.fillStyle = OUTLINE; ctx.fillRect(bx - 1, row - 3, 6, 11)
      ctx.fillStyle = c; ctx.fillRect(bx, row, 4, 7)                 // бутылка
      ctx.fillStyle = shade(c, 0.35); ctx.fillRect(bx, row, 1, 7)   // блик
      ctx.fillStyle = '#6b5335'; ctx.fillRect(bx + 1, row - 2, 2, 2) // горлышко
    }
    drawFridge(188, by - 4)
    drawFridge(232, by - 4)
    // микроволновка / кофемашина на тумбе
    outlineRect(280, by + 6, 30, 22, '#2b3038')
    ctx.fillStyle = '#161a20'; ctx.fillRect(283, by + 9, 18, 12)
    ctx.fillStyle = '#3fb950'; ctx.fillRect(303, by + 10, 4, 2)
    ctx.fillStyle = '#d29922'; ctx.fillRect(303, by + 14, 4, 6)
  }

  // Дымок над курящим (пиксельные клубы, поднимаются и тают)
  function drawSmoke(x, y, t) {
    for (let i = 0; i < 3; i++) {
      const ph = (t / 1000 + i * 0.34) % 1
      const px = x + Math.sin(t / 500 + i * 2) * 3
      const py = y - ph * 22
      const a = (1 - ph) * 0.45
      const r = 2 + ph * 3
      ctx.fillStyle = 'rgba(205,210,215,' + a.toFixed(3) + ')'
      ctx.fillRect(Math.round(px - r / 2), Math.round(py - r / 2), Math.round(r), Math.round(r))
    }
  }

  // Клубный кот — бродит по залу, иногда замирает
  let cat = { x: 260, y: 300, tx: 260, ty: 300, next: 0, dir: 1, moving: false }
  function updateCat(t, dt) {
    if (t > cat.next) {
      cat.tx = 40 + Math.random() * 440
      cat.ty = 70 + Math.random() * 380
      cat.next = t + 3500 + Math.random() * 5000
    }
    const dx = cat.tx - cat.x, dy = cat.ty - cat.y, d = Math.hypot(dx, dy)
    if (d > 2) { cat.x += dx / d * 0.045 * dt; cat.y += dy / d * 0.045 * dt; cat.dir = dx < 0 ? -1 : 1; cat.moving = true }
    else cat.moving = false
  }
  function drawCat(t) {
    const x = Math.round(cat.x), y = Math.round(cat.y), d = cat.dir
    const b = TH === 'doom' ? '#7a2e1d' : '#42474f'   // в аду вместо кота — адский зверёк
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x - 6, y, 13, 2)
    // хвост качается
    const tw = Math.round(Math.sin(t / 300) * 2)
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - d * 8 - 1, y - 7 + tw, 4, 6)
    ctx.fillStyle = b; ctx.fillRect(x - d * 8, y - 6 + tw, 2, 4)
    // тело
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 6, y - 6, 12, 6)
    ctx.fillStyle = b; ctx.fillRect(x - 5, y - 5, 10, 4)
    ctx.fillStyle = shade(b, 0.2); ctx.fillRect(x - 5, y - 5, 10, 1)
    // лапки
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 4, y - 1, 2, 3); ctx.fillRect(x + 2, y - 1, 2, 3)
    // голова по направлению
    const hx = x + d * 5
    ctx.fillStyle = OUTLINE; ctx.fillRect(hx - 3, y - 9, 7, 7)
    ctx.fillStyle = b; ctx.fillRect(hx - 2, y - 8, 5, 5)
    ctx.fillStyle = OUTLINE; ctx.fillRect(hx - 2, y - 11, 2, 2); ctx.fillRect(hx + 1, y - 11, 2, 2)  // ушки
    ctx.fillStyle = b; ctx.fillRect(hx - 2, y - 10, 1, 1); ctx.fillRect(hx + 2, y - 10, 1, 1)
    ctx.fillStyle = '#8fe36a'; ctx.fillRect(hx + (d > 0 ? 1 : 0), y - 6, 1, 1)  // глаз
  }

  function drawPlant(x, y) {
    outlineRect(x - 4, y, 8, 9, '#8a5a2b')                 // горшок
    ctx.fillStyle = '#a06a34'; ctx.fillRect(x - 4, y, 8, 2)
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 7, y - 12, 14, 13)
    ctx.fillStyle = '#2f7d3a'; ctx.fillRect(x - 6, y - 11, 12, 12) // листва
    ctx.fillStyle = '#3f9a4a'; ctx.fillRect(x - 4, y - 9, 5, 5)
    ctx.fillStyle = '#276634'; ctx.fillRect(x + 1, y - 4, 4, 4)
  }

  function drawClock(cx, cy) {
    ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(cx, cy, 10, 0, 7); ctx.fill()
    ctx.fillStyle = '#e8eaed'; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 7); ctx.fill()
    const now = new Date()
    const hA = ((now.getHours() % 12) / 12) * Math.PI * 2 - Math.PI / 2 + (now.getMinutes() / 60) * (Math.PI / 6)
    const mA = (now.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2
    ctx.strokeStyle = '#2a2f38'; ctx.lineWidth = 1.5; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(hA) * 4.5, cy + Math.sin(hA) * 4.5); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(mA) * 7, cy + Math.sin(mA) * 7); ctx.stroke()
    ctx.fillStyle = '#c04040'; ctx.fillRect(cx - 1, cy - 1, 2, 2)
  }

  // Настенный факел с живым пламенем и тёплым светом (Terraria/Doom)
  function drawTorch(x, y, t) {
    const g = ctx.createRadialGradient(x + 1, y - 3, 2, x + 1, y - 3, 30)
    g.addColorStop(0, 'rgba(255,160,60,.22)'); g.addColorStop(1, 'rgba(255,160,60,0)')
    ctx.fillStyle = g; ctx.fillRect(x - 29, y - 33, 60, 60)
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 1, y - 1, 4, 9)
    ctx.fillStyle = '#6b4a26'; ctx.fillRect(x, y, 2, 7)
    const f = Math.floor(t / 160) % 3
    ctx.fillStyle = '#ff9a3c'; ctx.fillRect(x - 1, y - 5 + (f === 1 ? 1 : 0), 4, 5)
    ctx.fillStyle = '#ffd23c'; ctx.fillRect(x, y - 4 + (f === 2 ? 1 : 0), 2, 3)
  }

  // Улица за входом — своя для каждой темы: город / лес Террарии / ад Doom
  function drawOutdoor(t) {
    if (TH === 'terraria') {
      // лесная опушка: земля, трава, деревья, светлячки
      ctx.fillStyle = '#241a10'; ctx.fillRect(0, 600, 1024, 64)                     // земля
      ctx.fillStyle = OUTLINE; ctx.fillRect(0, 600, 1024, 2)
      ctx.fillStyle = '#2f7d3a'; ctx.fillRect(0, 602, 1024, 5)                      // трава
      for (let x = 4; x < 1024; x += 9) { ctx.fillStyle = '#3f9a4a'; ctx.fillRect(x, 600, 2, 4) }  // травинки
      for (const [tx, s] of [[330, 1], [700, 0], [900, 1]]) {                       // деревья
        outlineRect(tx, 614 - s * 4, 8, 42 + s * 4, '#4a3018')
        ctx.fillStyle = '#5b3a21'; ctx.fillRect(tx + 1, 615 - s * 4, 2, 40)
        ctx.fillStyle = OUTLINE; ctx.fillRect(tx - 13, 596 - s * 6, 34, 24)
        ctx.fillStyle = '#25602f'; ctx.fillRect(tx - 12, 597 - s * 6, 32, 22)
        ctx.fillStyle = '#317a3c'; ctx.fillRect(tx - 8, 601 - s * 6, 12, 9)
      }
      for (let i = 0; i < 6; i++) {                                                 // светлячки
        const fx = 60 + i * 170 + Math.sin(t / 900 + i * 2) * 14
        const fy = 622 + Math.cos(t / 700 + i * 3) * 9
        if (Math.floor(t / 400 + i) % 3) { ctx.fillStyle = 'rgba(240,220,110,.85)'; ctx.fillRect(fx, fy, 2, 2) }
      }
      outlineRect(384, 636, 60, 6, '#5b3a21'); ctx.fillStyle = '#6d4a29'; ctx.fillRect(384, 636, 60, 2)  // лавочка
      outlineRect(388, 642, 4, 8, '#3a2416'); outlineRect(436, 642, 4, 8, '#3a2416')
      drawTorch(560, 630, t)
      ctx.fillStyle = 'rgba(252,232,176,.6)'; ctx.font = 'bold 10px monospace'; ctx.fillText('🚬 КУРИЛКА', 384, 616)
      return
    }
    if (TH === 'doom') {
      // адская пустошь: тёмный камень, светящиеся трещины лавы, кости
      ctx.fillStyle = '#170d0b'; ctx.fillRect(0, 600, 1024, 64)
      ctx.fillStyle = OUTLINE; ctx.fillRect(0, 600, 1024, 2)
      for (let i = 0; i < 9; i++) {                                                 // трещины лавы
        const lx = (hsh('lava' + i) % 980) + 20, ly = 610 + (hsh('lv' + i) % 44)
        const pulse = 0.45 + 0.35 * Math.sin(t / 420 + i * 1.7)
        ctx.fillStyle = 'rgba(255,110,40,' + pulse.toFixed(2) + ')'
        ctx.fillRect(lx, ly, 10 + (hsh('lw' + i) % 14), 2)
        ctx.fillStyle = 'rgba(255,200,80,' + (pulse * 0.7).toFixed(2) + ')'
        ctx.fillRect(lx + 3, ly, 4, 1)
      }
      for (const [bx, by] of [[250, 634], [820, 620], [940, 646]]) {                // кости
        ctx.fillStyle = '#cfc4ae'; ctx.fillRect(bx, by, 12, 2); ctx.fillRect(bx - 2, by - 2, 3, 6); ctx.fillRect(bx + 11, by - 2, 3, 6)
      }
      // пентаграмма на камне (слабое красное свечение)
      const px = 150, py = 630, pr = 14
      ctx.strokeStyle = 'rgba(255,60,40,' + (0.35 + 0.2 * Math.sin(t / 600)).toFixed(2) + ')'
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.stroke()
      ctx.beginPath()
      for (let i = 0; i <= 5; i++) {
        const a = -Math.PI / 2 + i * Math.PI * 4 / 5
        const vx = px + Math.cos(a) * pr, vy = py + Math.sin(a) * pr
        i ? ctx.lineTo(vx, vy) : ctx.moveTo(vx, vy)
      }
      ctx.stroke()
      drawTorch(384, 630, t); drawTorch(660, 630, t)
      ctx.fillStyle = 'rgba(255,120,90,.6)'; ctx.font = 'bold 10px monospace'; ctx.fillText('🚬 КУРИЛКА', 404, 616)
      return
    }
    ctx.fillStyle = '#090b0f'; ctx.fillRect(0, 600, 1024, 64)          // ночная улица
    ctx.fillStyle = '#171a20'; ctx.fillRect(360, 600, 320, 60)         // тротуар
    for (let x = 360; x < 680; x += 20) { ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, 600, 1, 60) }
    // свет фонаря (тёплый круг на тротуаре)
    const g = ctx.createRadialGradient(650, 626, 4, 650, 626, 70)
    g.addColorStop(0, 'rgba(255,220,140,.22)'); g.addColorStop(1, 'rgba(255,220,140,0)')
    ctx.fillStyle = g; ctx.fillRect(580, 600, 140, 64)
    // столб фонаря
    ctx.fillStyle = '#2a2f38'; ctx.fillRect(648, 604, 4, 22)
    outlineRect(642, 600, 16, 6, '#d9b45a'); ctx.fillStyle = '#fff3c0'; ctx.fillRect(644, 601, 12, 3)
    // лавочка
    outlineRect(384, 636, 60, 6, '#5b3a21'); ctx.fillStyle = '#6d4a29'; ctx.fillRect(384, 636, 60, 2)
    outlineRect(388, 642, 4, 8, '#3a2416'); outlineRect(436, 642, 4, 8, '#3a2416')
    outlineRect(384, 628, 60, 3, '#4a3020')  // спинка
    // урна-пепельница
    outlineRect(560, 632, 10, 14, '#3a3f47'); ctx.fillStyle = '#20242c'; ctx.fillRect(562, 634, 6, 2)
    // куст
    ctx.fillStyle = OUTLINE; ctx.fillRect(486, 632, 20, 14); ctx.fillStyle = '#25602f'; ctx.fillRect(487, 633, 18, 12)
    ctx.fillStyle = '#317a3c'; ctx.fillRect(490, 635, 6, 5); ctx.fillStyle = '#276634'; ctx.fillRect(498, 638, 5, 4)
    // подпись
    ctx.fillStyle = 'rgba(139,148,158,.55)'; ctx.font = 'bold 10px monospace'; ctx.fillText('🚬 КУРИЛКА', 384, 616)
  }

  // ── КУХНЯ: повар готовит заказы, тикеты «в работе», плита с паром ──────────
  function drawKitchen(t) {
    const { x, y, w, h } = KITCHEN
    // комната со светлой плиткой
    outlineRect(x, y, w, h, '#262d36')
    for (let ty = 0; ty < Math.floor(h / 8); ty++) for (let tx = 0; tx < Math.floor(w / 8); tx++) {
      ctx.fillStyle = (tx + ty) % 2 ? '#3b444f' : '#434d5a'
      ctx.fillRect(x + 2 + tx * 8, y + 2 + ty * 8, 8, 8)
    }
    // окно выдачи в бар (слева, проём в стене)
    ctx.fillStyle = '#161b22'; ctx.fillRect(x - 3, y + 24, 6, 18)
    ctx.fillStyle = '#4d3a25'; ctx.fillRect(x - 4, y + 40, 8, 3)  // полочка окна
    // разделочный стол (сталь) вдоль верха
    outlineRect(x + 6, y + 10, 62, 11, '#9aa4ae')
    ctx.fillStyle = '#c3cbd3'; ctx.fillRect(x + 6, y + 10, 62, 2)
    // нарезка на столе
    ctx.fillStyle = '#f85149'; ctx.fillRect(x + 12, y + 14, 4, 3)
    ctx.fillStyle = '#3fb950'; ctx.fillRect(x + 19, y + 14, 5, 2)
    ctx.fillStyle = '#f0c674'; ctx.fillRect(x + 27, y + 14, 4, 3)
    // плита справа: корпус, конфорки светятся, сковорода с прыгающими ингредиентами
    outlineRect(x + 84, y + 8, 40, 16, '#30363f')
    ctx.fillStyle = '#3d444e'; ctx.fillRect(x + 84, y + 8, 40, 2)
    for (const bx of [x + 92, x + 110]) {
      const glow = 0.5 + 0.4 * Math.sin(t / 250 + bx)
      ctx.fillStyle = 'rgba(255,110,60,' + glow.toFixed(2) + ')'
      ctx.beginPath(); ctx.arc(bx, y + 16, 5, 0, 7); ctx.fill()
      ctx.fillStyle = '#1a1f26'; ctx.beginPath(); ctx.arc(bx, y + 16, 3, 0, 7); ctx.fill()
    }
    // сковорода на левой конфорке
    ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(x + 92, y + 16, 6, 0, 7); ctx.fill()
    ctx.fillStyle = '#22262d'; ctx.beginPath(); ctx.arc(x + 92, y + 16, 5, 0, 7); ctx.fill()
    const jump = Math.abs(Math.sin(t / 160)) * 3
    ctx.fillStyle = '#e0823d'; ctx.fillRect(x + 90, y + 13 - jump, 3, 3)
    ctx.fillStyle = '#3fb950'; ctx.fillRect(x + 94, y + 14 - jump * 0.6, 2, 2)
    // пар над плитой
    drawSmoke(x + 92, y + 4, t)
    drawSmoke(x + 110, y + 6, t + 700)
    // вытяжка
    outlineRect(x + 86, y - 2, 36, 6, '#3a414b')
    // рейл тикетов: заказы в готовке (жёлтые мигают) и новые (серые)
    const orders = (stateData?.orders ?? []).slice(0, 6)
    orders.forEach((o, i) => {
      const txx = x + 6 + i * 21, tyy = y + 26
      const cooking = o.status === 1
      const blink = cooking && Math.floor(t / 400) % 2
      outlineRect(txx, tyy, 17, 20, cooking ? (blink ? '#f0d060' : '#d8b93c') : '#7d8590')
      ctx.fillStyle = '#0d1117'; ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'
      ctx.fillText(String(o.id % 1000), txx + 8, tyy + 8); ctx.textAlign = 'left'
      ctx.fillStyle = 'rgba(13,17,23,.5)'
      ctx.fillRect(txx + 3, tyy + 11, 11, 2); ctx.fillRect(txx + 3, tyy + 15, 8, 2)
    })
    if (!orders.length) {
      ctx.fillStyle = 'rgba(139,148,158,.5)'; ctx.font = '8px monospace'
      ctx.fillText('заказов нет', x + 8, y + 38)
    }
    // повар за столом (колпак поверх причёски, нож «шинкует»)
    const chef = { x: x + 36, y: y + 48, name: '', shirt: '#f0f0ef', hair: '#5b3a21', st: 'atbar', u: 'chef' }
    drawPerson(chef, t)
    const cy = y + 48
    if (TH !== 'doom') {   // в Doom повар в шлеме — колпак не рисуем
      ctx.fillStyle = OUTLINE; ctx.fillRect(x + 30, cy - 42, 12, 8)
      ctx.fillStyle = '#f4f4f2'; ctx.fillRect(x + 31, cy - 41, 10, 6)   // колпак
      ctx.fillStyle = '#e0e0dc'; ctx.fillRect(x + 31, cy - 36, 10, 1)
    }
    const chop = Math.sin(t / 120) * 2
    ctx.fillStyle = OUTLINE; ctx.fillRect(x + 43, cy - 16 + chop, 8, 3)
    ctx.fillStyle = '#c3cbd3'; ctx.fillRect(x + 44, cy - 15 + chop, 6, 1)  // нож
    // неоновая подпись
    ctx.font = 'bold 10px monospace'
    ctx.shadowColor = 'rgba(240,180,80,.9)'; ctx.shadowBlur = 6
    ctx.fillStyle = '#f5c97a'; ctx.fillText('КУХНЯ', x + 4, y - 5)
    ctx.shadowBlur = 0
  }

  // Туалет — нормальная комнатка у нижней стены: светлая плитка, две кабинки
  // с закрытыми дверями, раковина с краном и зеркалом, дверной проём сверху.
  function drawWC() {
    const x = WC.x, y = WC.y
    // стены комнаты
    outlineRect(x - 34, y - 28, 68, 52, '#2a3038')
    // светлая плитка пола (шахматка)
    for (let ty = 0; ty < 6; ty++) for (let tx = 0; tx < 8; tx++) {
      ctx.fillStyle = (tx + ty) % 2 ? '#39424e' : '#414b58'
      ctx.fillRect(x - 32 + tx * 8, y - 26 + ty * 8, 8, 8)
    }
    // дверной проём сверху (вход из зала) + коврик
    ctx.fillStyle = '#39424e'; ctx.fillRect(x - 8, y - 30, 16, 4)
    ctx.fillStyle = '#4a5462'; ctx.fillRect(x - 8, y - 31, 16, 2)
    // две кабинки с дверями (внизу комнаты)
    for (const dx of [-30, 2]) {
      outlineRect(x + dx, y - 4, 28, 26, '#31404f')                    // стенки кабинки
      outlineRect(x + dx + 3, y - 1, 22, 21, '#3d5064')                // дверь
      ctx.fillStyle = shade('#3d5064', 0.22); ctx.fillRect(x + dx + 3, y - 1, 22, 2)   // блик двери
      ctx.fillStyle = '#0f141a'; ctx.fillRect(x + dx + 3, y + 17, 22, 3)               // щель снизу
      ctx.fillStyle = '#c9a15a'; ctx.fillRect(x + dx + 21, y + 8, 2, 4)                // ручка
      ctx.fillStyle = '#8b949e'; ctx.fillRect(x + dx + 11, y + 3, 6, 6)                // табличка на двери
      ctx.fillStyle = '#31404f'; ctx.fillRect(x + dx + 13, y + 5, 2, 2)
    }
    // раковина слева сверху: зеркало, чаша, кран
    ctx.fillStyle = 'rgba(160,200,230,.28)'; ctx.fillRect(x - 30, y - 24, 14, 9)       // зеркало
    ctx.strokeStyle = '#0a0c10'; ctx.strokeRect(x - 30.5, y - 24.5, 15, 10)
    outlineRect(x - 29, y - 12, 12, 6, '#d5d9de')                                      // чаша
    ctx.fillStyle = '#8b9099'; ctx.fillRect(x - 24, y - 15, 2, 4)                      // кран
    // неон-табличка WC над дверью
    ctx.font = 'bold 10px monospace'
    ctx.shadowColor = 'rgba(120,200,255,.9)'; ctx.shadowBlur = 6
    ctx.fillStyle = '#9fd4ff'; ctx.fillText('WC', x - 7, y - 34)
    ctx.shadowBlur = 0
  }

  // Торговый автомат: светящаяся витрина с банками, работает и ночью
  function drawVending(x, y, t) {
    const pulse = 0.25 + 0.08 * Math.sin(t / 600)
    const g = ctx.createRadialGradient(x + 13, y + 20, 4, x + 13, y + 20, 42)
    g.addColorStop(0, 'rgba(120,200,255,' + pulse.toFixed(3) + ')'); g.addColorStop(1, 'rgba(120,200,255,0)')
    ctx.fillStyle = g; ctx.fillRect(x - 28, y - 20, 82, 84)
    outlineRect(x, y, 26, 44, '#1f3a5c')                                  // корпус
    ctx.fillStyle = '#2c4f7c'; ctx.fillRect(x, y, 26, 3)
    outlineRect(x + 3, y + 5, 15, 28, '#0e1c2e')                          // витрина
    const cans = ['#f85149', '#3fb950', '#d29922', '#e85aad', '#58a6ff', '#2dd4bf']
    for (let i = 0; i < 6; i++) { ctx.fillStyle = cans[i]; ctx.fillRect(x + 5 + (i % 2) * 6, y + 8 + Math.floor(i / 2) * 8, 4, 6) }
    ctx.fillStyle = 'rgba(160,220,255,.18)'; ctx.fillRect(x + 3, y + 5, 15, 28)  // стекло
    ctx.fillStyle = '#11151b'; ctx.fillRect(x + 20, y + 8, 4, 12)               // панель
    ctx.fillStyle = '#3fb950'; ctx.fillRect(x + 21, y + 9, 2, 2)
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(x + 4, y + 36, 18, 5)               // лоток выдачи
  }

  function drawProps(t) {
    // вывеска над залом — цвет неона по теме
    const signC = TH === 'doom' ? ['#ff5a3c', '#ff8a6a'] : TH === 'terraria' ? ['#ffd24a', '#ffe08a'] : ['#58a6ff', '#7cc0ff']
    ctx.textAlign = 'center'; ctx.font = 'bold 15px system-ui'
    ctx.shadowColor = signC[0]; ctx.shadowBlur = 10
    ctx.fillStyle = signC[1]; ctx.fillText('GIZMO', 250, 19)
    ctx.shadowBlur = 0; ctx.textAlign = 'left'
    // торговый автомат у стены зала
    drawVending(494, 320, t)
    // растения по углам зала (в аду не растут — вместо них факелы)
    if (TH === 'doom') { drawTorch(505, 54, t); drawTorch(30, 464, t); drawTorch(505, 244, t) }
    else { drawPlant(505, 60); drawPlant(30, 470); drawPlant(505, 250) }
    // факелы на верхней стене (Terraria — уют, Doom — ад)
    if (TH !== 'plain') { drawTorch(330, 8, t); drawTorch(370, 8, t) }
    // часы на верхней стене
    drawClock(430, 13)
    // коврик у входа: в Doom — пентаграмма, иначе WELCOME
    if (TH === 'doom') {
      outlineRect(478, 560, 64, 24, '#241014'); ctx.fillStyle = '#2e1418'; ctx.fillRect(482, 564, 56, 16)
      const px = 510, py = 572, pr = 9
      ctx.strokeStyle = 'rgba(255,70,50,.8)'; ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.stroke()
      ctx.beginPath()
      for (let i = 0; i <= 5; i++) {
        const a = -Math.PI / 2 + i * Math.PI * 4 / 5
        i ? ctx.lineTo(px + Math.cos(a) * pr, py + Math.sin(a) * pr) : ctx.moveTo(px + Math.cos(a) * pr, py + Math.sin(a) * pr)
      }
      ctx.stroke()
    } else {
      outlineRect(478, 560, 64, 24, '#3a2c40'); ctx.fillStyle = '#4a3a52'; ctx.fillRect(482, 564, 56, 16)
      ctx.fillStyle = '#5c4a66'; ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillText('WELCOME', 510, 574); ctx.textAlign = 'left'
    }
    // постеры на верхней стене
    const pcol = TH === 'doom' ? ['#ff3b2f', '#ff8a3c', '#cfc4ae'] : ['#f85149', '#3fb950', '#d29922']
    for (let i = 0; i < 3; i++) { outlineRect(60 + i * 34, 4, 24, 16, '#11151b'); ctx.fillStyle = pcol[i]; ctx.fillRect(63 + i * 34, 7, 18, 6); ctx.fillStyle = '#586170'; ctx.fillRect(63 + i * 34, 14, 18, 3) }
    drawKitchen(t)
    drawWC()
  }

  // Палитры пола/стен per-тема: [зал, BOOT, VIP, консоли, бар, стена, блик стены]
  const FLOORPAL = {
    plain:    { hall: ['#14161c', '#171a21'], boot: ['#0f1b18', '#121f1b'], vip: ['#1a1526', '#1d1729'], cons: ['#211318', '#24151b'], bar: ['#221a12', '#251d14'], wall: '#2a3038', wallHi: '#343b45' },
    terraria: { hall: ['#31241a', '#362a1e'], boot: ['#1c2e14', '#20331a'], vip: ['#2a1c30', '#2e2036'], cons: ['#33161b', '#371a20'], bar: ['#3a2b16', '#3f2f1a'], wall: '#4a3826', wallHi: '#5a462f' },
    doom:     { hall: ['#161314', '#191617'], boot: ['#141c10', '#171f13'], vip: ['#20121a', '#24141d'], cons: ['#261210', '#2a1512'], bar: ['#231710', '#271a13'], wall: '#382014', wallHi: '#452a18' },
  }
  function drawFloor(t) {
    const P = FLOORPAL[TH] || FLOORPAL.plain
    for (let ty = 0; ty < 38; ty++) for (let tx = 0; tx < 64; tx++) {
      let c = (tx + ty) % 2 ? P.hall[0] : P.hall[1]
      const swapR = layoutSeed % 2 === 1
      const topC = swapR ? P.boot : P.vip   // BOOT или VIP сверху
      const midC = swapR ? P.vip : P.boot
      if (tx >= 33 && ty >= 2 && ty <= 15) c = (tx + ty) % 2 ? topC[0] : topC[1]
      if (tx >= 33 && ty >= 17 && ty <= 26) c = (tx + ty) % 2 ? midC[0] : midC[1]
      if (tx >= 33 && ty >= 27) c = (tx + ty) % 2 ? P.cons[0] : P.cons[1]             // КОНСОЛИ
      if (ty >= 30 && tx <= 20) c = (tx + ty) % 2 ? P.bar[0] : P.bar[1]               // бар
      ctx.fillStyle = c; ctx.fillRect(tx * T, ty * T, T, T)
    }
    // фактура: доски (Terraria) / стальная сетка с заклёпками (Doom)
    if (TH === 'terraria') {
      ctx.fillStyle = 'rgba(0,0,0,.16)'
      for (let ty = 1; ty <= 38; ty++) ctx.fillRect(0, ty * T - 1, 1024, 1)
    } else if (TH === 'doom') {
      ctx.fillStyle = 'rgba(0,0,0,.2)'
      for (let ty = 2; ty <= 38; ty += 2) ctx.fillRect(0, ty * T - 1, 1024, 1)
      ctx.fillStyle = 'rgba(120,110,100,.13)'
      for (let ty = 2; ty <= 36; ty += 2) for (let tx = 1; tx < 64; tx += 2) ctx.fillRect(tx * T, ty * T - 2, 2, 2)
    }
    // стены
    ctx.fillStyle = P.wall
    // Верхняя стена ТОЛСТАЯ — на ней висят вывеска, часы и постеры
    ctx.fillRect(0, 0, 1024, 26)
    ctx.fillStyle = P.wallHi; ctx.fillRect(0, 0, 1024, 3)                 // блик верха
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 26, 1024, 4)        // тень стены на пол
    ctx.fillStyle = P.wall
    ctx.fillRect(0, 0, 6, 600); ctx.fillRect(1018, 0, 6, 600); ctx.fillRect(0, 594, 1024, 6)
    ctx.fillRect(526, 6, 5, 554)   // стена VIP/BOOT/КОНСОЛИ (внизу проход)
    ctx.fillRect(531, 268, 490, 5) // перегородка VIP|BOOT
    ctx.fillRect(531, 428, 490, 5) // перегородка BOOT|КОНСОЛИ
    // дверь
    ctx.fillStyle = '#0d1117'; ctx.fillRect(488, 590, 44, 10)
    ctx.fillStyle = '#d29922'; ctx.fillRect(488, 588, 44, 3)
    // подписи зон — лёгкий неон в цвет зоны
    ctx.font = 'bold 11px monospace'
    const neon = (txt, x, y, color) => {
      ctx.shadowColor = color; ctx.shadowBlur = 7
      ctx.fillStyle = color; ctx.fillText(txt, x, y)
      ctx.shadowBlur = 0
    }
    neon('ЗАЛ', 16, 18, 'rgba(139,168,198,.8)')
    if (layoutSeed % 2 === 1) {
      neon('BOOTCAMP', 544, 18, 'rgba(110,205,140,.8)')
      neon('VIP', 544, 292, 'rgba(190,140,235,.85)')
    } else {
      neon('VIP', 544, 18, 'rgba(190,140,235,.85)')
      neon('BOOTCAMP', 544, 292, 'rgba(110,205,140,.8)')
    }
    neon('КОНСОЛИ', 544, 452, 'rgba(235,130,150,.8)')
    neon('БАР', 14, 486, 'rgba(224,164,80,.85)')
    ctx.fillStyle = 'rgba(139,148,158,.5)'; ctx.fillText('ВХОД →', 430, 585)
    drawOutdoor(t)   // улица-курилка снизу
    drawProps(t)     // растения, часы, вывеска, постеры, коврик, туалет
    // задний бар (полки/холодильники) — рисуем ПЕРЕД оператором, он встаёт спереди
    drawBackBar()
    // барная стойка (клиенты подходят сверху, оператор — снизу за ней)
    outlineRect(20, 500, 310, 15, '#3a2c1c')
    ctx.fillStyle = '#5a4529'; ctx.fillRect(20, 500, 310, 3)          // столешница-блик
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(20, 512, 310, 3)  // тень нижнего края
    for (let i = 0; i < 310; i += 26) { ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(20 + i, 503, 1, 9) } // доски
    // заказы на столешнице (со стороны клиентов, сверху)
    const q = stateData ? stateData.orders.length : 0
    for (let i = 0; i < Math.min(q, 11); i++) {
      const ox = 30 + i * 26
      ctx.fillStyle = OUTLINE; ctx.fillRect(ox - 1, 490, 12, 10)
      ctx.fillStyle = i % 2 ? '#d29922' : '#e0823d'; ctx.fillRect(ox, 491, 10, 8)
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(ox, 491, 10, 2)
    }
  }

  function drawDesk(d, t) {
    const host = stateData ? stateData.hosts.find(h => h.name === d.name) : null
    const on = host ? host.busyBy : null
    if (d.zone === 'cons') { // консоль: большой ТВ + приставка + диван
      if (on) screenHalo(d.x, d.y - 8, 64, 22, t, hsh(d.name) % 7)
      outlineRect(d.x - 4, d.y - 12, 72, 30, '#242932')            // корпус ТВ
      ctx.fillStyle = '#333a46'; ctx.fillRect(d.x - 4, d.y - 12, 72, 2) // блик рамки
      outlineRect(d.x, d.y - 8, 64, 22, '#0a0d12')                      // экран
      if (on) drawScreen(d.x, d.y - 8, 64, 22, hsh(d.name) % 97, t)
      if (on && afkHostNames.has(d.name)) drawAfk(d.x, d.y - 8, 64, 22, t)
      outlineRect(d.x + 24, d.y + 20, 16, 5, '#1a1f27')            // приставка
      ctx.fillStyle = '#3fb950'; ctx.fillRect(d.x + 26, d.y + 22, 3, 1)
      // диван со спинкой и подлокотниками
      outlineRect(d.x - 2, d.y + 34, 68, 18, '#5a2e35')
      ctx.fillStyle = '#6d3941'; ctx.fillRect(d.x - 2, d.y + 34, 68, 5)
      ctx.fillStyle = shade('#5a2e35', -0.3); ctx.fillRect(d.x - 2, d.y + 49, 68, 3)
      outlineRect(d.x - 6, d.y + 34, 5, 18, '#4a252b'); outlineRect(d.x + 65, d.y + 34, 5, 18, '#4a252b')
      ctx.fillStyle = 'rgba(160,170,180,.75)'; ctx.font = 'bold 9px monospace'
      const cap = host && host.maxUsers > 1 ? ' ' + (host.sitters?.length ?? 0) + '/' + host.maxUsers : ''
      ctx.fillText(d.name + cap, d.x, d.y - 17)
      return
    }
    // монитор на ножке (обведённый, с бликом рамки)
    if (on) screenHalo(d.x + 6, d.y - 4, 24, 15, t, hsh(d.name) % 7)
    ctx.fillStyle = '#151920'; ctx.fillRect(d.x + 14, d.y + 11, 8, 4)  // ножка
    outlineRect(d.x + 4, d.y - 6, 28, 19, '#242932')
    ctx.fillStyle = '#333a46'; ctx.fillRect(d.x + 4, d.y - 6, 28, 2)    // блик рамки
    outlineRect(d.x + 6, d.y - 4, 24, 15, '#0a0d12')
    if (on) drawScreen(d.x + 6, d.y - 4, 24, 15, hsh(d.name) % 97, t)
    if (on && afkHostNames.has(d.name)) drawAfk(d.x + 6, d.y - 4, 24, 15, t)
    // стол
    const deskC = d.zone === 'vip' ? '#3d3450' : d.zone === 'boot' ? '#2c463c' : '#333a45'
    outlineRect(d.x, d.y + 14, 36, 12, deskC)
    ctx.fillStyle = shade(deskC, 0.18); ctx.fillRect(d.x, d.y + 14, 36, 2)   // блик столешницы
    ctx.fillStyle = shade(deskC, -0.3); ctx.fillRect(d.x, d.y + 24, 36, 2)   // тень
    // клавиатура и мышь
    outlineRect(d.x + 8, d.y + 17, 14, 5, '#232830')
    ctx.fillStyle = '#4b5563'
    for (let k = 0; k < 5; k++) ctx.fillRect(d.x + 9 + k * 2.6, d.y + 18, 2, 2)
    outlineRect(d.x + 26, d.y + 18, 3, 4, '#232830')
    // имя хоста над монитором
    ctx.fillStyle = 'rgba(160,170,180,.75)'; ctx.font = 'bold 9px monospace'
    ctx.fillText(d.name, d.x + 4, d.y - 9)
  }

  // Затемняем экран + значок «пауза» и мигающий AFK: игрок отошёл, хост занят.
  function drawAfk(x, y, w, h, t) {
    ctx.fillStyle = 'rgba(6,8,12,.55)'; ctx.fillRect(x, y, w, h)
    const cx = x + w / 2, cy = y + h / 2 - 1
    ctx.fillStyle = '#d29922'; ctx.fillRect(cx - 3, cy - 3, 2, 6); ctx.fillRect(cx + 1, cy - 3, 2, 6)  // пауза
    if (Math.floor(t / 500) % 2) {
      ctx.fillStyle = '#f0c674'; ctx.font = 'bold 6px monospace'; ctx.textAlign = 'center'
      ctx.fillText('AFK', cx, y + h - 2); ctx.textAlign = 'left'
    }
  }

  // Причёска: аккуратная «шапка» по верху головы. БЕЗ боковых прядей вдоль лица —
  // иначе голова выглядит как шлем/ушанка. Бока головы (кожа) остаются открытыми.
  function drawHair(cx, fy, col, style) {
    const top = fy - 33            // верх головы
    const put = (ox, oy, w, h) => {
      ctx.fillStyle = OUTLINE; ctx.fillRect(cx + ox - 1, oy - 1, w + 2, h + 2)
      ctx.fillStyle = col; ctx.fillRect(cx + ox, oy, w, h)
    }
    if (style === 0) {            // короткая шапочка + лёгкая чёлка
      put(-5, top, 10, 4)
      ctx.fillStyle = col; ctx.fillRect(cx - 4, top + 4, 2, 1); ctx.fillRect(cx + 2, top + 4, 2, 1)
    } else if (style === 1) {     // причёска на пробор
      put(-5, top, 10, 4)
      ctx.fillStyle = shade(col, -0.35); ctx.fillRect(cx, top, 1, 4)
    } else if (style === 2) {     // короткий ёжик/спайки сверху
      ctx.fillStyle = OUTLINE
      for (let i = 0; i < 4; i++) ctx.fillRect(cx - 4 + i * 2 - 1, top - 3, 4, 5)
      ctx.fillStyle = col
      for (let i = 0; i < 4; i++) ctx.fillRect(cx - 4 + i * 2, top - 2, 2, 5)
      put(-5, top + 1, 10, 3)
    } else {                      // подлиннее: объём сверху + тонкие пряди у краёв
      put(-5, top - 1, 10, 5)
      ctx.fillStyle = col; ctx.fillRect(cx - 6, top + 3, 1, 5); ctx.fillRect(cx + 5, top + 3, 1, 5)
    }
    ctx.fillStyle = shade(col, 0.34); ctx.fillRect(cx - 4, top + 1, 6, 1)  // блик
  }

  function drawPerson(a, t) {
    const sit = a.st === 'sit'
    // Сидящий на диване — «утоплен»: без ног, чуть ниже, подушка поверх бёдер.
    const couchSit = sit && a.couch
    const walk = !sit && a.st !== 'atbar' && a.st !== 'smoking'
    const isOp = a.name === 'оператор'
    const x = Math.round(a.x), y = Math.round(a.y)
    // ── Тематические образы ──
    const demon = TH === 'doom' && !isStaff(a)           // игроки в Doom — демоны
    const doomguy = TH === 'doom' && isStaff(a)          // персонал — Doomguy
    const guide = TH === 'terraria' && a.u === 'op'      // оператор в Terraria — Гид
    let skin = '#e8b088', shirt = a.shirt, pants = a.pants || '#20242e', hair = a.hair
    if (TH === 'terraria') skin = SKINS[hsh(a.u + 'sk') % SKINS.length]   // разные тона кожи, как в Terraria
    if (guide) { hair = '#5b3a21'; shirt = '#e6e0d0'; pants = '#2f5aa8' } // Гид: белая рубашка, синие штаны
    // Демон классического Doom: полностью голый — ноги это чуть затемнённая шкура, не «штаны»
    if (demon) { skin = DEMONC[a.trait] || '#a8623a'; shirt = skin; pants = shade(skin, -0.14) }
    // Doomguy 1993: ЯРКО-зелёная броня без рукавов (руки голые), зелёные штаны-поножи
    if (doomguy) { skin = '#d99e73'; shirt = '#3fa33f'; pants = '#2f8430' }
    const skinSh = shade(skin, -0.2)
    const hairStyle = a.hairStyle ?? 0
    const bob = walk && Math.floor(t / 150) % 2 ? 1 : 0
    const yy = y - bob + (couchSit ? 5 : 0)

    if (sit && !a.couch) { // компактная спинка офисного кресла (не «трон», не на диване)
      outlineRect(x - 7, yy - 22, 14, 18, '#252a34')
      ctx.fillStyle = '#333a48'; ctx.fillRect(x - 7, yy - 22, 14, 2)
    }
    if (!couchSit) { ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - 7, y - 1, 14, 3) } // тень

    // Части тела: обводка-проход, затем заливка. Голова отделена короткой шеей.
    const swing = walk ? (Math.floor(t / 150) % 2 ? 1 : -1) : 0
    const armC = doomguy ? skin : shade(shirt, -0.24)   // у Doomguy броня без рукавов — руки голые
    const parts = [
      { x: x - 8, y: yy - 21, w: 3, h: 8, c: armC },                          // левая рука
      { x: x + 5, y: yy - 21, w: 3, h: 8, c: armC },                          // правая рука
      { x: x - 6, y: yy - 22, w: 12, h: 10, c: shirt },                       // торс
      { x: x - 1, y: yy - 24, w: 3, h: 2, c: skin },                          // шея (короткая)
      { x: x - 5, y: yy - 33, w: 10, h: 9, c: doomguy ? '#3fa33f' : skin },   // голова (у Doomguy — шлем)
    ]
    if (!couchSit) {
      parts.unshift(
        { x: x - 5 + (swing < 0 ? -1 : 0), y: yy - 12, w: 4, h: 10, c: pants },  // левая нога
        { x: x + 1 + (swing > 0 ? 1 : 0), y: yy - 12, w: 4, h: 10, c: pants },   // правая нога
      )
    }
    ctx.fillStyle = OUTLINE
    for (const p of parts) ctx.fillRect(p.x - 1, p.y - 1, p.w + 2, p.h + 2)
    for (const p of parts) { ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.w, p.h) }

    if (!couchSit) {
      // ботинки (у демона — когтистые лапы)
      ctx.fillStyle = OUTLINE; ctx.fillRect(x - 6, yy - 3, 5, 3); ctx.fillRect(x + 1, yy - 3, 5, 3)
      ctx.fillStyle = demon ? shade(skin, -0.45) : '#2b2f38'; ctx.fillRect(x - 6, yy - 3, 5, 1); ctx.fillRect(x + 1, yy - 3, 5, 1)
      if (demon) { ctx.fillStyle = '#e8d9c0'; ctx.fillRect(x - 6, yy - 2, 1, 1); ctx.fillRect(x - 3, yy - 2, 1, 1); ctx.fillRect(x + 2, yy - 2, 1, 1); ctx.fillRect(x + 5, yy - 2, 1, 1) }  // когти
      // штаны: тень между ног + боковой блик
      ctx.fillStyle = shade(pants, -0.32); ctx.fillRect(x - 1, yy - 12, 2, 10)
      ctx.fillStyle = shade(pants, 0.2); ctx.fillRect(x - 5, yy - 12, 1, 9)
      // ремень (у демона нет)
      if (!demon) {
        ctx.fillStyle = '#1c2029'; ctx.fillRect(x - 6, yy - 13, 12, 2)
        ctx.fillStyle = '#b0873a'; ctx.fillRect(x - 1, yy - 13, 2, 2)
      }
    }
    // рубашка: блик сверху, тень снизу, центральная складка
    ctx.fillStyle = shade(shirt, 0.26); ctx.fillRect(x - 6, yy - 22, 12, 2)
    ctx.fillStyle = shade(shirt, -0.26); ctx.fillRect(x - 6, yy - 13, 12, 1)
    ctx.fillStyle = shade(shirt, -0.15); ctx.fillRect(x, yy - 21, 1, 8)
    // воротник у шеи
    ctx.fillStyle = shade(shirt, -0.3); ctx.fillRect(x - 3, yy - 22, 6, 1)
    if (demon) {
      // мускулатура как у импа: грудные мышцы + пресс (тени), без одежды
      ctx.fillStyle = shade(skin, 0.18); ctx.fillRect(x - 4, yy - 20, 3, 2); ctx.fillRect(x + 1, yy - 20, 3, 2)   // грудные
      ctx.fillStyle = shade(skin, -0.28)
      ctx.fillRect(x, yy - 21, 1, 8)                                                    // центральная линия
      ctx.fillRect(x - 3, yy - 17, 2, 1); ctx.fillRect(x + 1, yy - 17, 2, 1)            // пресс
      ctx.fillRect(x - 3, yy - 15, 2, 1); ctx.fillRect(x + 1, yy - 15, 2, 1)
      // костяные шипы: плечи (по два), локти, колени — как у импа
      ctx.fillStyle = '#ece2cc'
      ctx.fillRect(x - 9, yy - 24, 2, 3); ctx.fillRect(x - 7, yy - 23, 1, 2)
      ctx.fillRect(x + 7, yy - 24, 2, 3); ctx.fillRect(x + 6, yy - 23, 1, 2)
      ctx.fillRect(x - 9, yy - 16, 1, 2); ctx.fillRect(x + 8, yy - 16, 1, 2)            // локти
      if (!couchSit) { ctx.fillRect(x - 5, yy - 8, 1, 2); ctx.fillRect(x + 4, yy - 8, 1, 2) }  // колени
    }
    if (doomguy) {
      // сегменты нагрудной брони (рёбра, как на спрайте) + зелёные накладки на плечах голых рук
      ctx.fillStyle = shade(shirt, -0.3); ctx.fillRect(x - 6, yy - 19, 12, 1); ctx.fillRect(x - 6, yy - 16, 12, 1)
      ctx.fillStyle = shade(shirt, 0.25); ctx.fillRect(x - 4, yy - 21, 8, 1)
      ctx.fillStyle = shirt; ctx.fillRect(x - 8, yy - 22, 3, 2); ctx.fillRect(x + 5, yy - 22, 3, 2)   // плечевые накладки
      // мышцы на голых руках
      ctx.fillStyle = shade(skin, -0.18); ctx.fillRect(x - 8, yy - 18, 3, 1); ctx.fillRect(x + 5, yy - 18, 3, 1)
      if (!couchSit) { ctx.fillStyle = shade(pants, 0.3); ctx.fillRect(x - 5, yy - 8, 3, 2); ctx.fillRect(x + 2, yy - 8, 3, 2) }  // наколенники
      if (a.u === 'op') {   // оператор держит помповый дробовик поперёк груди
        ctx.fillStyle = OUTLINE; ctx.fillRect(x - 10, yy - 16, 20, 4)
        ctx.fillStyle = '#33343a'; ctx.fillRect(x - 9, yy - 15, 18, 2)   // ствол
        ctx.fillStyle = '#6b4a26'; ctx.fillRect(x + 1, yy - 15, 5, 2)    // цевьё
        ctx.fillStyle = '#8a8f98'; ctx.fillRect(x - 9, yy - 15, 3, 1)    // блик дула
      }
    }
    // фартук бармена у оператора (в Doom он в броне — без фартука)
    if (isOp && !doomguy) {
      ctx.fillStyle = '#e6e8ec'; ctx.fillRect(x - 4, yy - 19, 8, 8)
      ctx.fillStyle = '#c9ccd2'; ctx.fillRect(x - 4, yy - 19, 8, 1)
      ctx.fillStyle = OUTLINE; ctx.fillRect(x - 5, yy - 19, 1, 8); ctx.fillRect(x + 4, yy - 19, 1, 8)
    }
    // кисти рук
    ctx.fillStyle = skin; ctx.fillRect(x - 8, yy - 14, 3, 3); ctx.fillRect(x + 5, yy - 14, 3, 3)
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 8, yy - 11, 3, 1); ctx.fillRect(x + 5, yy - 11, 3, 1)
    // телефон в руке (когда «листает мемы»): корпус + светящийся экран
    if (a.phoneUntil && Date.now() < a.phoneUntil) {
      ctx.fillStyle = OUTLINE; ctx.fillRect(x + 4, yy - 17, 5, 7)
      ctx.fillStyle = ['#58a6ff', '#3fb950', '#e85aad'][Math.floor(t / 400) % 3]; ctx.fillRect(x + 5, yy - 16, 3, 5)
    }
    if (doomguy) {
      // шлем Doomguy 1993: ярко-зелёный, широкий тёмно-серый визор, светлый кант
      ctx.fillStyle = shade('#3fa33f', 0.3); ctx.fillRect(x - 5, yy - 33, 10, 1)    // блик купола
      ctx.fillStyle = '#2a2e33'; ctx.fillRect(x - 4, yy - 30, 8, 3)                 // визор
      ctx.fillStyle = '#568a9e'; ctx.fillRect(x - 3, yy - 29, 2, 1)                 // отблеск стекла
      ctx.fillStyle = shade('#3fa33f', -0.35); ctx.fillRect(x - 5, yy - 27, 10, 1)  // кант под визором
      ctx.fillStyle = shade('#3fa33f', -0.2); ctx.fillRect(x - 1, yy - 26, 2, 2)    // «подбородок» шлема
    } else if (demon) {
      // морда как у импа: надбровный гребень, СПЛОШНЫЕ красные горящие глаза, клыки
      ctx.fillStyle = skinSh; ctx.fillRect(x + 3, yy - 33, 2, 9)
      ctx.fillStyle = shade(skin, -0.35); ctx.fillRect(x - 5, yy - 30, 10, 1)       // надбровный гребень
      ctx.fillStyle = '#c81800'; ctx.fillRect(x - 4, yy - 29, 3, 2); ctx.fillRect(x + 1, yy - 29, 3, 2)
      ctx.fillStyle = '#ff4a30'; ctx.fillRect(x - 3, yy - 29, 2, 1); ctx.fillRect(x + 2, yy - 29, 2, 1)  // глаза горят
      ctx.fillStyle = shade(skin, -0.45); ctx.fillRect(x - 2, yy - 26, 5, 2)        // широкая пасть
      ctx.fillStyle = '#f0f0e8'                                                     // клыки вниз и вверх
      ctx.fillRect(x - 2, yy - 25, 1, 2); ctx.fillRect(x + 2, yy - 25, 1, 2); ctx.fillRect(x, yy - 26, 1, 1)
      // короткие костяные рожки-наросты на макушке (имп)
      ctx.fillStyle = OUTLINE; ctx.fillRect(x - 6, yy - 36, 3, 4); ctx.fillRect(x + 3, yy - 36, 3, 4)
      ctx.fillStyle = '#ece2cc'; ctx.fillRect(x - 5, yy - 35, 1, 3); ctx.fillRect(x + 4, yy - 35, 1, 3)
      ctx.fillRect(x - 1, yy - 35, 2, 1)                                            // нарост по центру лба
    } else {
      // лицо: тень щеки, крупные глаза, брови, рот
      ctx.fillStyle = skinSh; ctx.fillRect(x + 3, yy - 33, 2, 9)
      ctx.fillStyle = '#f6f6f6'; ctx.fillRect(x - 4, yy - 28, 3, 3); ctx.fillRect(x + 1, yy - 28, 3, 3)
      ctx.fillStyle = '#2a5a8c'; ctx.fillRect(x - 3, yy - 27, 2, 2); ctx.fillRect(x + 2, yy - 27, 2, 2)
      ctx.fillStyle = '#0f2c46'; ctx.fillRect(x - 3, yy - 27, 1, 1); ctx.fillRect(x + 2, yy - 27, 1, 1)
      ctx.fillStyle = shade(hair, -0.2); ctx.fillRect(x - 4, yy - 29, 3, 1); ctx.fillRect(x + 1, yy - 29, 3, 1) // брови
      ctx.fillStyle = skinSh; ctx.fillRect(x - 1, yy - 25, 3, 1)  // рот
      // волосы
      drawHair(x, yy, hair, guide ? 3 : hairStyle)
    }

    // наушники у задротов/стримеров — на макушке (демонам и Doomguy не нужны)
    if (!demon && !doomguy && (a.trait === 'задрот' || a.trait === 'стример')) {
      ctx.fillStyle = OUTLINE
      ctx.fillRect(x - 7, yy - 31, 2, 6); ctx.fillRect(x + 5, yy - 31, 2, 6); ctx.fillRect(x - 6, yy - 37, 12, 2)
      ctx.fillStyle = '#3a414d'; ctx.fillRect(x - 7, yy - 30, 1, 4); ctx.fillRect(x + 6, yy - 30, 1, 4)
      if (a.trait === 'стример') { ctx.fillStyle = '#f85149'; ctx.fillRect(x + 5, yy - 26, 3, 2) } // микрофон
    }

    // сигарета у курящего: белая палочка у рта, тлеющий огонёк мигает
    if (a.st === 'smoking') {
      ctx.fillStyle = OUTLINE; ctx.fillRect(x + 3, yy - 27, 8, 3)
      ctx.fillStyle = '#e8e8e4'; ctx.fillRect(x + 4, yy - 26, 5, 1)
      ctx.fillStyle = Math.floor(t / 300) % 2 ? '#ff6a3c' : '#ffb03c'
      ctx.fillRect(x + 9, yy - 26, 2, 1)
    }

    // «утоплен» в диване: подушка сиденья поверх бёдер
    if (couchSit) {
      ctx.fillStyle = OUTLINE; ctx.fillRect(x - 9, yy - 13, 18, 9)
      ctx.fillStyle = '#5a2e35'; ctx.fillRect(x - 8, yy - 12, 16, 7)
      ctx.fillStyle = '#6d3941'; ctx.fillRect(x - 8, yy - 12, 16, 2)
    }

    // имя с тёмной обводкой (читаемо на любом фоне)
    ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineJoin = 'round'
    ctx.strokeText(a.name, x, y + 12)
    ctx.fillStyle = '#c2c9d2'; ctx.fillText(a.name, x, y + 12)
    ctx.textAlign = 'left'
  }

  function drawBubble(x, y, text, until, t) {
    const life = until - t
    if (life <= 0) return false
    const alpha = Math.min(1, life / 700)
    ctx.font = '10px system-ui'
    const lines = []
    let s = text
    while (s.length > 26) { lines.push(s.slice(0, 26)); s = s.slice(26) }
    lines.push(s)
    const w = Math.min(180, Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) + 12)
    const h = lines.length * 12 + 8
    let bx = Math.max(8, Math.min(1024 - w - 8, x - w / 2)), by = y - 26 - h
    if (by < 8) by = 8
    ctx.globalAlpha = alpha
    ctx.fillStyle = '#f3f4f6'; ctx.fillRect(bx, by, w, h)
    ctx.beginPath(); ctx.moveTo(x - 4, by + h); ctx.lineTo(x + 4, by + h); ctx.lineTo(x, by + h + 5); ctx.fill()
    ctx.fillStyle = '#111'
    lines.forEach((l, i) => ctx.fillText(l, bx + 6, by + 13 + i * 12))
    ctx.globalAlpha = 1
    return true
  }

  // ── Камера: вписать в экран, пан тягой, зум колесом ─────────────────────────
  const dpr = window.devicePixelRatio || 1
  let cam = { z: 1, x: 0, y: 0 }
  function resize() {
    cv.width = Math.max(100, cv.clientWidth) * dpr
    cv.height = Math.max(100, cv.clientHeight) * dpr
  }
  function fitCam() {
    resize()
    const z = Math.min(cv.clientWidth / 1024, cv.clientHeight / WORLD_H) * 0.98
    cam = { z, x: (cv.clientWidth - 1024 * z) / 2, y: (cv.clientHeight - WORLD_H * z) / 2 }
  }
  window.addEventListener('resize', fitCam)
  fitCam()
  let drag = null
  cv.addEventListener('pointerdown', (e) => {
    drag = { mx: e.clientX, my: e.clientY, cx: cam.x, cy: cam.y }
    cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'
  })
  cv.addEventListener('pointermove', (e) => {
    if (drag) { cam.x = drag.cx + (e.clientX - drag.mx); cam.y = drag.cy + (e.clientY - drag.my) }
  })
  cv.addEventListener('pointerup', () => { drag = null; cv.style.cursor = 'grab' })
  cv.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = cv.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const k = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const nz = Math.min(4, Math.max(0.35, cam.z * k))
    cam.x = mx - (mx - cam.x) * (nz / cam.z)
    cam.y = my - (my - cam.y) * (nz / cam.z)
    cam.z = nz
  }, { passive: false })
  cv.addEventListener('dblclick', fitCam)

  let last = performance.now()
  function frame(t) {
    const dt = Math.min(50, t - last); last = t
    readTheme()   // тема может смениться на лету — сцена перерисуется в новом стиле
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = TH === 'doom' ? '#0b0505' : TH === 'terraria' ? '#0c1108' : '#07090d'
    ctx.fillRect(0, 0, cv.clientWidth, cv.clientHeight)
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y)
    if (!built) { ctx.fillStyle = '#8b949e'; ctx.font = '13px system-ui'; ctx.fillText('Ждём данные симулятора…', 420, 290); requestAnimationFrame(frame); return }

    // хосты, чьи игроки отошли (курилка/туалет) — показываем на них AFK
    afkHostNames = new Set()
    for (const [, a] of actors) if (AWAY_STATES.has(a.st) && a.hostName) afkHostNames.add(a.hostName)

    drawFloor(t)
    for (const d of desks) drawDesk(d, t)

    // клубный кот бродит по залу
    updateCat(t, dt); drawCat(t)

    // оператор
    drawPerson({ x: OP.x, y: OP.y, name: 'оператор', shirt: '#c74848', hair: '#2b2019', st: 'atbar', u: 'op' }, t)

    const now0 = Date.now()
    const speed = 0.11 * dt // ~110 px/с
    const toDelete = []
    const stationary = (st) => st === 'sit' || st === 'atbar' || st === 'smoking' || st === 'inwc'
    for (const [u, a] of actors) {
      if (!stationary(a.st)) {
        const dx = a.target.x - a.x, dy = a.target.y - a.y
        const dist = Math.hypot(dx, dy)
        if (dist < 3) {
          if (a.st === 'walkin') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
          else if (a.st === 'walkout') { toDelete.push(u); continue }
          else if (a.st === 'tobar') { a.st = 'atbar'; a.barUntil = now0 + 2600 }
          else if (a.st === 'back') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
          else if (a.st === 'tosmoke') { a.st = 'tosmoke2'; a.target = a.smokeSpot }        // вышел за дверь → к курилке
          else if (a.st === 'tosmoke2') { a.st = 'smoking'; a.smokeUntil = now0 + 8000 + (hsh(u) % 6000) }
          else if (a.st === 'fromsmoke') { a.st = 'fromsmoke2'; a.target = a.seat }         // назад через дверь → на место
          else if (a.st === 'fromsmoke2') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
          else if (a.st === 'towc') { a.st = 'inwc'; a.wcUntil = now0 + 4000 + (hsh(u) % 3000) }
          else if (a.st === 'fromwc') { a.st = 'sit'; a.x = a.seat.x; a.y = a.seat.y }
        } else { a.x += dx / dist * speed; a.y += dy / dist * speed }
      } else if (a.st === 'atbar' && now0 > a.barUntil) {
        a.st = 'back'; a.target = a.seat
      } else if (a.st === 'smoking' && now0 > a.smokeUntil) {
        a.st = 'fromsmoke'; a.target = DOOR
      } else if (a.st === 'inwc' && now0 > a.wcUntil) {
        a.st = 'fromwc'; a.target = a.seat
      }
      if (a.st === 'smoking') drawSmoke(a.x, a.y - 30, t)  // дымок над курящим
      if (a.st === 'inwc') continue                         // в туалете — не рисуем (он «внутри»)
      drawPerson(a, t)
    }
    for (const u of toDelete) { actors.delete(u); freeSlots(u, null) }

    // ── Курьер-официант: несёт готовый заказ клиенту (к хосту или на стойку) ──
    if (!courier && deliveries.length) {
      const oid = deliveries.shift()
      const u = orderOwners.get(oid)
      const a = u ? actors.get(u) : null
      const item = FOODC[oid % FOODC.length]
      // «клиент решает»: ~60% — принести к месту, иначе сам заберёт на стойке
      if (a && a.st === 'sit' && (oid % 10) < 6) {
        courier = { x: PASS.x, y: PASS.y, phase: 'go', target: { x: a.x + 14, y: a.y }, backTo: PASS, item, u, oid }
      } else {
        const bx = BAR.x + (u ? hsh(u) % 60 : 30)
        if (a && a.st === 'sit') { a.st = 'tobar'; a.target = { x: bx, y: BAR.y } }
        courier = { x: OP.x, y: OP.y, phase: 'go', target: { x: bx, y: 522 }, backTo: OP, item, u, oid }
      }
    }
    if (courier) {
      const c = courier
      if (c.phase === 'go' || c.phase === 'back') {
        const tgt = c.phase === 'go' ? c.target : c.backTo
        const dx = tgt.x - c.x, dy = tgt.y - c.y, dist = Math.hypot(dx, dy)
        if (dist < 3) {
          if (c.phase === 'go') {
            c.phase = 'give'; c.until = now0 + 900
            const a = c.u ? actors.get(c.u) : null
            if (a) a.bubble = { text: '😋 заказ #' + c.oid + ' — спасибо!', until: now0 + 2600 }
          } else courier = null
        } else { c.x += dx / dist * speed; c.y += dy / dist * speed }
      } else if (c.phase === 'give' && now0 > c.until) c.phase = 'back'
      if (courier) {
        drawPerson({ x: c.x, y: c.y, name: '', shirt: '#c74848', hair: '#2b2019', st: c.phase === 'give' ? 'atbar' : 'walkin', u: 'courier' }, t)
        // поднос с заказом в руках
        const px = Math.round(c.x), py = Math.round(c.y)
        ctx.fillStyle = OUTLINE; ctx.fillRect(px - 6, py - 18, 12, 4)
        ctx.fillStyle = '#d5d9de'; ctx.fillRect(px - 5, py - 17, 10, 2)
        ctx.fillStyle = OUTLINE; ctx.fillRect(px - 3, py - 23, 6, 6)
        ctx.fillStyle = c.item; ctx.fillRect(px - 2, py - 22, 4, 4)
      }
    }
    // облачка — поверх всех
    const now = Date.now()
    for (const [, a] of actors) {
      if (a.bubble && !drawBubble(a.x, a.y - 20, a.bubble.text, a.bubble.until, now)) a.bubble = null
    }
    if (opBubble && !drawBubble(OP.x, OP.y - 20, opBubble.text, opBubble.until, now)) opBubble = null
    // баннеры — в экранных координатах, не зависят от камеры
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    banners = banners.filter(b => b.until > now)
    banners.slice(0, 2).forEach((b, i) => {
      ctx.font = 'bold 12px system-ui'
      const w = ctx.measureText(b.text).width + 24
      const bx = (cv.clientWidth - w) / 2, by = 14 + i * 28
      ctx.fillStyle = 'rgba(13,17,23,.92)'; ctx.fillRect(bx, by, w, 22)
      ctx.strokeStyle = '#d29922'; ctx.strokeRect(bx + .5, by + .5, w - 1, 21)
      ctx.fillStyle = '#e6edf3'; ctx.fillText(b.text, bx + 12, by + 15)
    })
    raf = requestAnimationFrame(frame)
  }
  let raf = requestAnimationFrame(frame)

  return {
    setState,
    handleEvent,
    fitCam,
    destroy() {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fitCam)
    },
  }
}
