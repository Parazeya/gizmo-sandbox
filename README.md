# GGBook Club Simulator

**English** | [Русский](README.ru.md)

A living e-sports club simulator + API test bench for **Gizmo V3**.

Virtual players walk into the club, take seats at PCs and consoles, play games, order from the bar, top up balances, book seats, check out assets and go out for smoke breaks — all through the real Gizmo API. The activity shows up in the Gizmo admin panel and in every report (finance, applications, shifts). The second half of the project is the **API Tests** tab: scenario checks plus a full scan of ~1000 endpoints from the OpenAPI document, with saved reports and diffs between Gizmo versions.

> ## ⚠️ TEST SERVER ONLY
>
> The simulator writes **real data** into Gizmo: it creates users and products,
> performs deposits, sales, invoices and register Pay In/Pay Out, and the
> "♻ World" button **permanently deletes** all bots. Running it against a
> production server will corrupt your reports, register and customer base.
> Set up a dedicated test Gizmo server and point the simulator only at it.

## Requirements

- Node.js ≥ 18
- A **Gizmo V3** test server (verified on v3.0.81) and an operator account with user/sales/shift permissions
- Optional: SQL Server access to the Gizmo database — needed only for the "player launched Dota 2" event (AppStat rows are written by the Gizmo client; there is no API for them). Everything else works without SQL.

## Getting started

```bash
npm install
npm run build:web          # build the web UI (once)
npm start
```

Open **http://localhost:5555** — on first run a setup wizard walks you through:

1. **Connection** — Gizmo address/port, operator login/password, branch, SQL password (optional). "🔌 Test connection" actually pings Gizmo and SQL and shows the server version.
2. **Mode** — "Club simulator" or "Test Gizmo V3 API" (both tabs remain available at any time).
3. **UI theme** — plain, Terraria or Doom Eternal (in Doom the players on the map are demons and the staff is Doomguy; the accent color is switchable).

Everything is stored in `sim.config.json` (git-ignored). From then on just `npm start`.

> The web UI is available in English and Russian (switchable in the wizard and in the header).
> The live simulation feed (bot chatter, order comments, personas) is generated in Russian —
> that's the flavor of the simulated club.

## Features

- **Dashboard** — host map, player cards with personas, order queue, shift counters, live event feed (SSE push, no polling).
- **🕹 Top-down view** — a pixel-art live map of the club: HALL/VIP/BOOTCAMP/CONSOLES/BAR zones, animated "in-game" monitors, walks to the bar and the outdoor smoking spot, a kitchen with a cook and order tickets, a waiter delivering orders, a WC, a vending machine and the club cat. Camera: wheel to zoom, drag to pan, double-click to fit. The art style follows the UI theme.
- **📊 Reports** — exchange-style live charts (occupancy, register, queue, service) in a side panel that overlays any tab.
- **⚡ Events** — force events: seat a player, a group, a tournament, a newcomer, an order, an invoice void, register Pay In/Out.
- **♻ World** — tear the test world down (hard-deletes all bots, frees the logins) and generate a new one: different personas and a different room layout.
- **🧪 API Tests**:
  - 19 scenario tests (self-cleaning: sale→void, reservation→cancel, login→logout);
  - a full scan of the GET catalog from `GET /openapi/v3.json` (auto-filled required parameters, live sample ids, per-request inspector with full request/response details);
  - a **mutation scan**: for every module with a POST+DELETE pair it creates a test record (body generated from the OpenAPI schema), updates it with PUT and deletes it — nothing but its own data is ever touched;
  - reports saved to `apitest-reports/`, diffs between Gizmo versions for both **scan results** and the **API documents themselves** (added/removed/changed endpoints with parameter and field details), manual doc-vs-doc comparison and report cleanup.

Every bot has a persona (name + character: grinder, casual, foodie, silent one, drop-in, streamer) that drives attendance, session length, chattiness and generosity. The club lives by a daily rhythm: evening rush hour, empty nights, busier weekends. New players register over time (up to `maxPlayers`). A bot operator runs the shift, cooks and hands out orders, sells at the register.

### Consoles (endpoint hosts)

The simulator seeds endpoint hosts "PS5 1"/"PS5 2" (maximumUsers 4) — several people sit at a console together, and groups prefer it. On the map it is a TV with a couch; the label shows occupancy ("PS5 2 2/4"). Gizmo gotchas: an endpoint host must belong to a host group (otherwise loginResult 32); loginResult 65536 means you hit the license concurrent-session limit (keep `maxSeated` below it).

## What gets simulated

| Event | How | Where it shows in Gizmo |
|---|---|---|
| Player takes a seat | `POST /users/{id}/login/{hostId}` | Monitoring: host busy |
| Player leaves | `POST /users/{id}/logout` | visits/logins/playtime |
| Bar order (with a comment) | user cart + note | Orders, SSE |
| Balance top-up | operator cart (cash/card) | Finance, deposits |
| Time package purchase | operator cart, invoice | Sales, shift report |
| Register sale / invoice void | invoice + `invoices/{id}/void` | Voids report |
| Register Pay In / Pay Out | `registertransactions` (types 1/2) | Shift report |
| Evening reservation | `POST /reservations` | Reservations |
| Asset check-out/check-in | checkout/checkin | User assets |
| Played an application | INSERT into AppStat (SQL) | Applications report |
| Group visit / tournament | group logins + AppStat | Monitoring, applications |
| New player registration | `POST /users` with a persona | User base |

## Configuration

Priority: CLI arguments → environment variables (`GIZMO_*`, `SQL_*`, `SIM_*`) → `sim.config.json` → defaults. Everything is editable from ⚙ Settings in the web UI: tick/speed/weights apply live, credentials and the starting bot count apply after a restart.

| Key | Meaning |
|---|---|
| `players` / `maxPlayers` | starting bot count / user-base cap |
| `maxSeated` | target occupancy; keep it **below your license session limit** |
| `tickSeconds` / `speed` | event frequency / club-time acceleration |
| `uiPort` | web UI port (0 disables it) |
| `uiLang` | web UI language: `en` or `ru` |
| `weights` | relative event frequencies |

```bash
node index.js --players 8 --tick 5    # CLI overrides
npm run calm                          # quiet evening
npm run rush                          # rush hour
```

`Ctrl+C` performs a soft stop: bots return their assets and log out.

## Web UI development

The frontend lives in `web/` (Vite + Svelte 5 + bits-ui). Dev mode: `cd web && npm run dev` (port 5556, API proxied to 5555). Production: `npm run build:web` — the resulting `web/dist` is served by the simulator itself.

## Compatibility

SDK — [gizmovsky](https://www.npmjs.com/package/gizmovsky) (v1/v2/v3). Verified on Gizmo v3.0.81. Known server-side Gizmo bugs (not the simulator's): `/achievements*` and some `/reports/*` return 500 on certain builds — the API scan flags them honestly.

## License

MIT
