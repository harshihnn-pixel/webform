# CFF — Company Formation Framework

An assessment app that helps visitors, business owners, and employees understand
their personal values, life journey, and role in building a successful company —
starting with a 13-question Values Assessment analysed by AI.

This project has two parts:

- A static frontend (`index.html`, `css/`, `js/`) — the app you see in the browser.
- A small Node.js/Express backend (`server/server.js`) — the only thing that ever
  talks to the AI provider, so your API key never touches the browser.

## Two ways to open this site

1. **Double-click `index.html`** — opens immediately in your browser, no
   install or terminal needed. You can browse every screen (role selection,
   sign-up, the 13 questions, settings). The frontend scripts are plain
   classic `<script>` files (not ES modules), so this works straight from
   disk. **Limitation:** the AI features won't work in this mode — clicking
   "Generate My Values Analysis" will show a connection error, and the "Ask
   CFF AI" chat widget will fall back to its offline demo answers — because
   both talk to a backend endpoint (`/api/analyse-values`, `/api/chat`) that
   only exists once the server below is running.
2. **Run the Node server** (steps 1–6 below) and open `http://localhost:3000`
   — same site, same look, but now the real AI analysis and real AI chat
   replies work too, because the browser can reach your running server.
3. **Install it as an app** — once it's served over http/https (option 2, or
   any real deployment), open it on a phone and use "Add to Home Screen" for
   an installable PWA, or build the native Android/iOS app in `mobile-app/`.
   See "Mobile app" further down.

---

## 1. Required software

You need, before you start:

- **Node.js version 18 or newer** (includes `npm`). Check with:
  ```bash
  node -v
  npm -v
  ```
  If you don't have it, download it from [nodejs.org](https://nodejs.org/).
- A code editor, e.g. [VS Code](https://code.visualstudio.com/).
- An **Anthropic API key**. Get one at [console.anthropic.com](https://console.anthropic.com/).

You do **not** need to install a database, Docker, or anything else for this to run.

---

## 2. Installation steps

1. Download or clone this project so you have a `cff-site` folder.
2. Open a terminal **inside that folder**:
   ```bash
   cd cff-site
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
   This reads `package.json` and downloads Express, Helmet, Zod, etc. into a
   `node_modules` folder. This is normal and that folder should never be committed
   to git (it's already excluded in `.gitignore`).

---

## 3. Create your `.env` file

The app reads secrets and settings from a file called `.env`, which is **not**
included in this project (on purpose — it would expose your API key).

1. Copy the example file:
   ```bash
   cp .env.example .env
   ```
   (On Windows, you can just duplicate `.env.example` and rename the copy to `.env`.)
2. Open `.env` in your editor. You'll see:
   ```env
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=your_api_key_here
   AI_MODEL=claude-sonnet-5
   PORT=3000
   CORS_ORIGIN=http://localhost:3000
   RATE_LIMIT_MAX=20
   CHAT_RATE_LIMIT_MAX=30
   ```

## 4. Where to add your AI API key

This app supports **two** AI providers — Anthropic (Claude) and Google (Gemini).
`AI_PROVIDER` in `.env` decides which one is actually used; you only need to fill
in the key for that one.

### Using Gemini

1. Get a free key from [Google AI Studio](https://aistudio.google.com/apikey).
2. In `.env`, set:
   ```env
   AI_PROVIDER=gemini
   AI_MODEL=gemini-2.5-flash
   GEMINI_API_KEY=your_real_gemini_key_here
   ```
   Other available models: `gemini-3.5-flash` (newest, no scheduled shutdown yet),
   `gemini-2.5-pro`. Note: Google regularly retires older Gemini model names
   (e.g. `gemini-2.0-flash` was shut down June 1, 2026, and `gemini-2.5-flash`
   itself is scheduled for shutdown October 16, 2026) — if analysis suddenly
   starts failing after months of working fine, check the model name against
   [Google's current model list](https://ai.google.dev/gemini-api/docs/models)
   first.

### Using Anthropic (Claude)

1. Get a key from [console.anthropic.com](https://console.anthropic.com/).
2. In `.env`, set:
   ```env
   AI_PROVIDER=anthropic
   AI_MODEL=claude-sonnet-5
   ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

Save the file. **Never** paste your key anywhere else — not in the HTML, not in
the JavaScript, not in a commit message. The backend is the only file that reads
it (`server/server.js`, via `process.env.GEMINI_API_KEY` /
`process.env.ANTHROPIC_API_KEY`), and only the key matching your chosen
`AI_PROVIDER` is ever used.

---

## 5. Start the server

```bash
npm start
```

You should see:

```
CFF server running at http://localhost:3000
AI provider: anthropic (claude-sonnet-5)
```

If instead you see a warning about a missing API key, go back to step 4.

For development, `npm run dev` restarts the server automatically whenever you
edit a server file.

---

## 6. Open the website

Open your browser and go to:

```
http://localhost:3000
```

You should see the CFF role-selection screen. Pick a profile, sign up (no
password needed in this build), and try the Values Assessment. When you generate
your analysis, the browser calls your own server at `/api/analyse-values`, which
then calls Anthropic on your behalf.

You'll also see a round chat launcher in the bottom-right corner on every
screen — that's the new "Ask CFF AI" assistant, described below.

---

## 7. Common errors and solutions

| Problem | Likely cause | Fix |
|---|---|---|
| `Error: listen EADDRINUSE: address already in use :::3000` | Something else is already running on port 3000 | Stop that process, or change `PORT` in `.env` and restart |
| Page loads but "Generate My Values Analysis" fails immediately with "not configured" | `.env` file missing or `ANTHROPIC_API_KEY` still says `your_api_key_here` | Recheck step 3 and 4, restart the server after editing `.env` |
| `Cannot find module 'express'` (or similar) | Dependencies not installed | Run `npm install` inside `cff-site` |
| Analysis fails with "AI provider could not complete the request" | Invalid/expired API key, no internet access, or Anthropic API is temporarily down | Check your key at console.anthropic.com, check your connection, try again |
| "Too many analysis requests" | You hit the built-in rate limit (`RATE_LIMIT_MAX` per 15 minutes) | Wait a few minutes, or raise `RATE_LIMIT_MAX` in `.env` for local testing |
| Chat widget replies with a generic offline/demo answer instead of a real AI answer | `/api/chat` isn't reachable — server isn't running, or `ANTHROPIC_API_KEY` isn't set | Make sure you're visiting `http://localhost:3000` (server running via `npm start`) and that steps 3–4 above are done |
| "Too many chat messages" | You hit the chat rate limit (`CHAT_RATE_LIMIT_MAX` per 15 minutes) | Wait a few minutes, or raise `CHAT_RATE_LIMIT_MAX` in `.env` for local testing |
| Answers disappear after refreshing | Your browser is blocking `localStorage` (e.g. private/incognito mode with strict settings) | Use a normal browser window, or note the in-app warning that appears when storage is unavailable |
| Styles look broken / unstyled page | Browser blocked a file load, or you moved `index.html` without its `css`/`js` folders | Keep `index.html`, `css/`, and `js/` together in the same folder — don't move just the HTML file on its own |

---

## 8. How to deploy the project

This is a normal Node/Express app, so it runs on most Node hosts:

1. Push the project to a Git repository (GitHub, GitLab, etc.) — `.env` will be
   excluded automatically because of `.gitignore`.
2. Pick a host that runs Node.js apps, for example **Render**, **Railway**, or
   a basic **VPS** (e.g. via `pm2` + nginx).
3. In your hosting provider's dashboard, set these as **environment variables**
   (do **not** upload your `.env` file itself):
   - `AI_PROVIDER`
   - `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` (whichever matches `AI_PROVIDER`)
   - `AI_MODEL`
   - `PORT` (most hosts set this for you automatically)
   - `CORS_ORIGIN` — set this to your real deployed URL, e.g. `https://cff.example.com`
   - `RATE_LIMIT_MAX`
   - `CHAT_RATE_LIMIT_MAX`
4. Set the start command to:
   ```bash
   npm install && npm start
   ```
5. Once deployed, visit your host's URL — the same single server serves both the
   frontend and the `/api/analyse-values` endpoint, so there's nothing extra to
   configure.

---

## 9. Security warning about API keys

- Your `ANTHROPIC_API_KEY` is a secret. Anyone who has it can make requests that
  are billed to your account.
- It should only ever exist in your `.env` file (locally) or your hosting
  provider's environment-variable settings (in production). It is read exclusively
  by `server/server.js`.
- It is never sent to the browser, never written into `index.html` or any file in
  `js/`, and `dotfiles: 'ignore'` in the server's static-file config means even a
  misconfigured request can't accidentally download your `.env` file.
- Rotate your key immediately at console.anthropic.com if you ever suspect it has
  leaked (e.g. committed to a public repo by mistake).

---

## Project structure

```text
cff-site/
├── index.html          # App shell — loads js/config.js, storage.js, api.js, app.js, ai-widget.js as classic scripts (works via file:// too)
├── manifest.json        # PWA manifest — enables "Add to Home Screen" install
├── sw.js                 # Service worker — offline app-shell caching, never caches /api/*
├── icons/                # App icons (72–512px, plus maskable variants + apple-touch-icon)
├── css/
│   └── style.css        # All styling: layout, components, responsive, print, a11y, AI widget
├── js/
│   ├── config.js         # API base URL — '' here; swapped for a real URL in the native app build
│   ├── storage.js        # Safe localStorage wrapper (autosave/load/clear) — load first
│   ├── api.js             # Frontend client for POST /api/analyse-values — load second
│   ├── app.js              # State, rendering, event handling, all views — load third
│   └── ai-widget.js        # "Ask CFF AI" chat widget — injected on every screen, load last
├── server/
│   └── server.js           # Express app: static hosting + /api/analyse-values + /api/chat
├── mobile-app/               # Native Android/iOS app shell (Capacitor) — see mobile-app/README.md
├── .env.example              # Template for your local secrets
├── .gitignore
├── package.json
└── README.md
```

## Mobile app

CFF ships as a mobile app in two ways — pick whichever fits:

1. **Installable PWA (already active, nothing to build):** visit the site on
   a phone (served over http/https — not by double-clicking the file) and
   use "Add to Home Screen" (Android Chrome) or Share → "Add to Home Screen"
   (iOS Safari). It installs with its own icon, opens full-screen with no
   browser chrome, and keeps working offline thanks to `sw.js` — only the
   live AI calls need a connection. No app store, no build step.
2. **Native Android/iOS app (Capacitor):** the `mobile-app/` folder is a
   ready-to-open native project for both platforms — see
   **`mobile-app/README.md`** for the full walkthrough, including where to
   point the app at your deployed backend and how to produce a real
   `.apk`/`.aab` or `.ipa`.

## AI Assistant ("Ask CFF AI")

Every screen now has a chat widget in the bottom-right corner (built in
`js/ai-widget.js`, styled in `css/style.css` — no HTML edits needed since it's
injected on load, the same way the Values Assessment analyser lives in `js/api.js`).
It works in two modes:

1. **Demo mode (works immediately, no setup):** if `/api/chat` isn't reachable —
   for example if you open `index.html` directly as a file instead of running the
   server — the widget falls back to a small built-in responder that answers common
   questions (what CFF is, how the assessment works, which role to pick, privacy,
   results) using simple keyword matching. This is enough to demo the feature, but
   it is **not real AI** — it's a scripted fallback.

2. **Real AI mode (once the server is running with a valid key):** the widget POSTs
   to `POST /api/chat`, a new endpoint in `server/server.js` that calls the real
   Claude API (same `ANTHROPIC_API_KEY` / `AI_MODEL` you already configured for the
   Values Assessment) with a system prompt describing CFF, how the assessment
   works, and clear guardrails against giving clinical, legal, or financial advice.

Nothing extra to install — this reuses the same Express server, the same
`ANTHROPIC_API_KEY`, and the same `dotenv`/`helmet`/`cors`/`zod` setup as
`/api/analyse-values`. The only new setting is `CHAT_RATE_LIMIT_MAX` (default 30
messages per device per 15 minutes), which you can raise or lower in `.env`.

### Customizing what the assistant knows and says

Edit the `CHAT_SYSTEM_PROMPT` constant in `server/server.js` — that's where you
control what the assistant is told about CFF (how the app works, tone, what it
should and shouldn't answer). Keep it factual and update it whenever the real
assessment, roles, or policies change, so the assistant doesn't give outdated
answers. This is a separate constant from `SYSTEM_PROMPT`, which still powers the
structured Values Assessment analysis and should not be merged with it — one
returns free-form chat replies, the other must always return the strict JSON shape
the results screen expects.

### Security note

Just like `/api/analyse-values`, the chat endpoint never exposes your API key to
the browser — `ANTHROPIC_API_KEY` is read only inside `server/server.js` via
`process.env`. The widget only ever talks to your own same-origin `/api/chat`
route.
