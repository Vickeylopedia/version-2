# 🎧 Audius Feed Bot (v2 — Account 2 Engine)

Automated, headless **Audius Feed Bot** controlled directly via **Telegram**. The bot monitors your Audius user feed in real time, runs an interactive countdown card with live skip & undo support, automatically likes & reposts new tracks, and **streams/plays songs in the background** to simulate genuine human engagement without a browser.

Optimized for 24/7 deployment as a **Render Web Service** with external cron keep-alive.

---

## ⚡ Core Features

- **Headless & Ultra-Lightweight** — Zero browser overhead. Direct communication with Audius Discovery Nodes and the Audius Identity Service.
- **Headless Audio Streaming (Play Feature)** — To prevent suspicious activity (liking/reposting without listening), processed tracks are queued into a background streaming worker that streams **30%–60% of each track's duration** directly from the Audius Discovery stream endpoint.
- **Dynamic Node Discovery** — Automatically resolves and connects to healthy Audius Discovery Nodes via `https://api.audius.co`.
- **Dual Execution Engine** — Direct EIP-191 cryptographic wallet signature actions (`identityservice.audius.co`) with seamless fallback to `@audius/sdk`.
- **Interactive Telegram Controller**:
  - Live second-by-second countdown cards on newly detected tracks.
  - **`[ ⏭️ Skip Track ]`** inline button to immediately cancel liking/reposting during the countdown.
  - **`[ ↩️ Undo (Unlike & Unrepost) ]`** persistent inline button to instantly revert actions anytime.
  - Full remote management commands (`/status`, `/start_bot`, `/stop_bot`, `/toggle_like`, `/toggle_repost`, `/clear_cache`).
  - Auto-registered Telegram bot slash command menu.
- **Render Web Service Ready**:
  - Embedded HTTP keep-alive server on port `10000` (or `process.env.PORT`).
  - Active V8 RAM protection running garbage collection (`--expose-gc`) when heap exceeds 250MB (tuned for Render's 512MB RAM cap).
  - Fast-start workflow: wipes in-memory cache on launch so new tracks are immediately picked up across restarts.
- **Granular Threshold & Safety Filters**:
  - Maximum track duration check (default: 300s / 5 minutes).
  - Popularity thresholds (skips tracks already exceeding 10 likes or 10 reposts).
  - Randomized human-like action delays (3–10s).
  - Probability rolls (80% like roll, 100% repost roll).

---

## 🏗️ Architecture & Workflow

```
               ┌──────────────────────────────┐
               │    Audius Discovery Node     │
               │   (Auto-selected via API)    │
               └──────────────┬───────────────┘
                              │ Polling (/v1/users/:id/feed every 5s)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    bot.mjs Main Loop                        │
│                                                             │
│ 1. Filter checks:                                           │
│    • Already processed? (cache check)                       │
│    • Track duration <= 300s (5 mins)?                       │
│    • Likes < 10 & Reposts < 10?                             │
│                                                             │
│ 2. Telegram Interactive Countdown (3–10s):                  │
│    • Sends live countdown card to Telegram                  │
│    • User can click [ ⏭️ Skip Track ] to abort               │
│                                                             │
│ 3. Execution (if not skipped & bot active):                 │
│    • Like roll (80% probability)                            │
│    • Repost roll (100% probability)                         │
│    • Execute via Audius Identity Service (Wallet Signature) │
│      or fallback to @audius/sdk                             │
│                                                             │
│ 4. Queue for Background Streaming:                          │
│    • Pushes track to streamingQueue                         │
│    • Updates Telegram card with queue status                │
│    • Saves to cache_acc2.json                               │
│                                                             │
│ 5. Idle Streaming Worker (between new tracks):              │
│    • Streams 30%–60% of track audio headlessly              │
│    • Registers listen/play on Audius Discovery Node         │
│    • Notifies Telegram once stream completes                │
└─────────────────────────────────────────────────────────────┘
                              │
             Telegram Poller & HTTP Server
     • Listens for commands (/status, /toggle_like, etc.)
     • Handles inline button callbacks (skip/undo)
     • HTTP port 10000 server for Render keep-alive & health checks
```

---

## ⚙️ Configuration & Environment Variables

All settings can be customized through environment variables (or fall back to built-in defaults):

| Environment Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP server port for Render health checks | `10000` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | Built-in fallback |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID | Built-in fallback |
| `AUDIUS_USER_ID` | Audius user ID whose feed is monitored | `ygvzYM4` |
| `APP_NAME` | Client application identifier | `audius-client` |
| `AUDIUS_API_KEY` | Audius Developer API Key | Built-in fallback |
| `AUDIUS_API_SECRET` | Audius Developer API Secret | Built-in fallback |
| `AUDIUS_BEARER_TOKEN`| Audius Bearer Token | Built-in fallback |
| `AUDIUS_PRIVATE_KEY` | Ethereum private key for signed Web3 actions (optional) | None |

---

## 🚀 Deployment on Render

### 1. Deploy as a Web Service
1. Create a new **Web Service** on [Render](https://render.com).
2. Connect your Git repository (`version-2-main`).
3. Choose **Docker** as the Environment (or Node with build command `npm install` and start command `npm start`).
4. Port: Render automatically routes to port `10000`.
5. Add any override environment variables in Render's **Environment** tab.

### 2. Preventing Sleep via External Cron Keep-Alive
Render free-tier web services spin down after 15 minutes of inactivity. The bot runs an HTTP server responding with `200 OK` on `GET /`.

To keep the service alive 24/7:
- Set up an external cron job or free uptime monitor (e.g. [cron-job.org](https://cron-job.org), [UptimeRobot](https://uptimerobot.com), or GitHub Actions cron).
- Target URL: `https://<your-render-app-name>.onrender.com/`
- Schedule: Every **5 to 10 minutes**.

Whenever Render restarts the instance, the bot automatically clears in-memory cache and immediately starts scanning the live feed.

---

## 💬 Telegram Commands & Controls

Send these commands to your **Telegram Bot**:

| Command | Action |
|---|---|
| `/status` | Displays full system status (active discovery node, uptime, toggle states, cached count, and streaming queue size). |
| `/active` | Quick ping verifying the bot is running and showing the topmost track in the feed. |
| `/start_bot` | Resumes automated feed monitoring and action execution. |
| `/stop_bot` | Pauses automated actions and halts current background streams. |
| `/toggle_like` | Toggles the 80% auto-like action ON or OFF. |
| `/toggle_repost` | Toggles the 100% auto-repost action ON or OFF. |
| `/clear_cache` | Wipes the current processed track cache, clears the streaming queue, and re-scans feed tracks immediately. |

### Interactive Buttons:
- **`[ ⏭️ Skip Track ]`**: Displayed during the 3–10s countdown. Tap to cancel the action on that track without liking or reposting.
- **`[ ↩️ Undo (Unlike & Unrepost) ]`**: Displayed on completion cards. Tap anytime to reverse the like and repost on Audius.

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Run the bot with memory optimizations and GC exposed
npm start
```

Press `Ctrl+C` for a clean shutdown.
