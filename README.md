# 🪨📄✂️ RPS Battle — Telegram Mini App

Rock Paper Scissors with **CPU mode** and **real-time multiplayer** (quick match + private rooms).

---

## 📁 Project structure

```
rps-battle/
├── index.html       ← App shell (3 screens: home / waiting / game)
├── style.css        ← Cyber-gaming design, all animations
├── app.js           ← Frontend logic (no framework, vanilla JS)
├── server.js        ← HTTP API + static server (Node.js, no extra deps)
├── package.json     ← `npm start` script
├── data/
│   └── state.json   ← Player stats (auto-created)
└── README.md
```

---

## 🚀 Quick start

```bash
npm start
```

Open: **http://localhost:3000**

> **vs CPU** works with no server (opens `index.html` directly in a browser).  
> **Multiplayer** requires the Node server.

---

## 🎮 Game modes

| Mode             | How it works                                                |
| ---------------- | ----------------------------------------------------------- |
| **vs CPU**       | Instant — plays offline or with backend stats               |
| **Quick match**  | Two players join the queue; server pairs them automatically |
| **Private room** | Host creates a 6-char code; guest enters it to join         |

---

## 📡 API endpoints

| Method | Path                      | Description                    |
| ------ | ------------------------- | ------------------------------ |
| GET    | `/api/health`             | Server liveness check          |
| GET    | `/api/profile`            | Load or create player profile  |
| POST   | `/api/solo/play`          | Play a CPU round, update stats |
| POST   | `/api/solo/reset`         | Reset stats                    |
| POST   | `/api/matchmaking/join`   | Enter quick-match queue        |
| GET    | `/api/matchmaking/status` | Poll for a match               |
| POST   | `/api/matchmaking/leave`  | Leave queue                    |
| POST   | `/api/rooms/create`       | Create private room            |
| POST   | `/api/rooms/join`         | Join by 6-char code            |
| GET    | `/api/rooms/state`        | Poll room state                |
| POST   | `/api/rooms/play`         | Submit choice in room          |
| POST   | `/api/rooms/ready`        | Signal ready for next round    |
| POST   | `/api/rooms/leave`        | Leave room                     |

---

## 📲 Telegram Mini App setup

1. Open **@BotFather** → `/newbot` → follow prompts → copy token
2. `/newapp` → set title `RPS Battle`, short name e.g. `rps_battle`
3. Host the project on any HTTPS server (see below)
4. Paste your HTTPS URL into BotFather
5. Share: `https://t.me/YOUR_BOT/rps_battle`

### Free hosting options

| Platform                | Command / steps                                                |
| ----------------------- | -------------------------------------------------------------- |
| **Railway**             | `railway up` (auto-detects `npm start`)                        |
| **Render**              | Connect repo → Build: `npm install` → Start: `npm start`       |
| **Netlify** (solo only) | Drag-and-drop `index.html`, `style.css`, `app.js` — no backend |
| **Ngrok** (local dev)   | `ngrok http 3000` → use the HTTPS URL                          |

---

## 🐛 Bugs fixed in this version

1. **Duplicate function declarations** — original had ~900 lines of identical functions defined twice inside the same IIFE, causing silent overwrites and confusing behaviour.
2. **`syncBackendAvailability`** — referenced DOM elements by wrong names; multiplayer buttons were never properly disabled when server was offline.
3. **Offline notice** — new `#offline-notice` banner now clearly tells users to run `npm start`.
4. **Solo scoreboard** — was showing cumulative lifetime wins/losses from server; now shows session wins/losses that reset when you re-enter solo mode.
5. **`dom.game.avatarOppInit`** — original used a fragile `querySelector`; now uses a proper `id="game-init-opp"` on the span.
6. **Blank screen on load** — `setScreen("home")` now called before the async `loadProfile` fetch, so users see the UI immediately.
7. **`renderOutcomeBanner` / `syncRoomHeader` / `syncBoardFromRoom`** — each declared twice; consolidated to single canonical definition.
8. **`code-input` uppercase** — now applied via CSS `text-transform: uppercase` and `.toUpperCase()` on submit, so codes always match server format.
9. **Toast timer** — used a module-level variable that could leak between calls; now uses a property on the function itself.
10. **`isPlaying` not reset on room choice error** — could permanently lock the buttons; fixed.

---

## 🔧 Production deployment (Netlify + Render + MongoDB)

- Frontend: deploy `index.html`, `app.js`, `style.css` to Netlify (HTTPS provided automatically).
- Backend: deploy `server.js` to Render or Railway. Add `MONGODB_URI` env var for MongoDB Atlas.
- If `MONGODB_URI` is not provided, the server falls back to `data/state.json` (not recommended for production).

Files added to help deploy:

- `render.yaml` — example Render service config.
- `.env.example` — environment variables example.

After deploy, add your Netlify domain to BotFather as an allowed Web App domain and set the Web App URL in your bot.

## 📦 Docker / Heroku / Generic deploy

You can run the backend anywhere that accepts a Node.js process. Example using Docker:

```bash
# build
docker build -t rps-game .
# run (exposes port 3000)
docker run -e MONGODB_URI="<your uri>" -p 3000:3000 rps-game
```

On Heroku or similar PaaS, use the `Procfile` included (`web: node server.js`). Ensure `MONGODB_URI` env var is configured.
