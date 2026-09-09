# CFF — Phase 1: Authentication

Supabase email/password auth: Create Account → Login → Forgot Password →
Session persistence → Logout.

---

## ⚠️ Rotate your API keys first

Your original `.gitignore` contained environment variables instead of ignore
rules, which meant `.env` was never ignored. Your live Gemini key and Supabase
keys were shipped inside the project zip.

1. **Gemini** — regenerate at https://aistudio.google.com/apikey
2. **Supabase** — Project Settings → API → roll the `service_role` key

The `anon` / publishable key does **not** need rotating — it is public by
design — *provided you run `sql/phase1-auth.sql`*, which is what actually
protects your data.

`.gitignore` has been rewritten with real rules.

---

## Setup

### 1. Run the SQL

Supabase → SQL Editor → New query → paste all of `sql/phase1-auth.sql` → Run.

This creates `public.profiles`, enables Row Level Security with
own-row-only policies, and adds a trigger that creates a profile row
automatically whenever someone signs up.

### 2. Environment variables

Your existing `SUPABASE_PUBLISHABLE_KEY` is already picked up as the browser
key, so login works with no `.env` changes. Recommended additions:

```
SUPABASE_ANON_KEY=<your anon public key>
SUPABASE_SECRET_KEY=<your service_role key>
```

- `SUPABASE_ANON_KEY` — sent to the browser. Public by design, protected by RLS.
- `SUPABASE_SECRET_KEY` — server only. Bypasses RLS. Never sent to the browser.

### 3. Email confirmation (optional, for faster testing)

Authentication → Providers → Email → uncheck **Confirm email**.

Leave it on and the app shows a "Check your email" screen after signup —
that path is fully implemented either way.

### 4. Run

```bash
npm install
npm start
```

---

## Files changed

**New**
| File | Purpose |
|---|---|
| `js/auth.js` | All Supabase auth logic, isolated from `app.js` |
| `sql/phase1-auth.sql` | `profiles` table, RLS policies, signup trigger |

**Modified**
| File | Change |
|---|---|
| `server/server.js` | CSP allows Supabase origins; generates `/js/config.js` from `.env`; serves SDK at `/vendor/supabase.js`; fixed `SUPABASE_KEY` fallback bug |
| `js/app.js` | Signup/login/forgot/reset views; session restore on boot; real logout |
| `js/storage.js` | Saved state keyed per user id |
| `index.html` | Loads `vendor/supabase.js` + `js/auth.js` |
| `js/config.js` | Now a fallback only — server generates the live copy |
| `sw.js` | Cache bumped to `cff-v2`; `config.js` is network-first |
| `css/style.css` | Auth styles appended (nothing above changed) |
| `.gitignore` | Rewritten — was leaking secrets |
| `.env.example` | Documents the anon vs secret key split |

**Untouched:** the 13 questions, assessment flow, AI analysis, dashboard,
`js/api.js`, `js/ai-widget.js`, `package.json`, `manifest.json`, `README.md`.

---

## Two decisions worth knowing about

**The Supabase SDK is served from your own server, not a CDN.** Loading it
from jsDelivr would have forced `script-src` open to third-party scripts.
`/vendor/supabase.js` serves the copy already in `node_modules`, so
`script-src` stays `'self'`.

**The anon key is sent to the browser, and that is correct.** Supabase auth
runs client-side; every Supabase web app ships this key. It is protected by
RLS policies, not secrecy. This is why `sql/phase1-auth.sql` is mandatory
rather than optional. Your `service_role` key and all AI keys stay on the
server.

---

## Test checklist

| # | Test | Expected |
|---|---|---|
| 1 | Pick a profile → fill signup form | Lands on dashboard; row appears in Supabase → Table Editor → `profiles` |
| 2 | Hard refresh (Ctrl+Shift+R) | Brief "Loading your account…" splash, then dashboard — *not* the profile picker |
| 3 | Logout, then refresh | Stays logged out |
| 4 | Login with wrong password | Readable error; **typed email is preserved** |
| 5 | Login with correct password | Dashboard, previous answers intact |
| 6 | Forgot password → enter email | Same message whether the email exists or not (deliberate — otherwise the form leaks who your users are) |
| 7 | Click the emailed link | "Choose a new password" screen; tokens stripped from the URL bar |
| 8 | Sign up a 2nd account in the same browser | Empty assessment — not the first user's answers |
| 9 | Password `abc` | Rejected: needs 8+ chars with a letter and a number |
| 10 | Mismatched confirm password | Rejected before any network call |

### If login fails

Open DevTools → Console.

- **CSP / "Refused to connect"** → `SUPABASE_URL` in `.env` doesn't match your project
- **"Sign in is not configured"** → anon key missing, or server not restarted
- **"Email not confirmed"** → click the link, or turn off Confirm email
- **Stale behaviour after deploy** → Application → Service Workers → Unregister, then hard refresh

---

## Not done yet (Phase 2)

The 13 answers still save to `localStorage`. They're now namespaced per user
id so accounts don't collide, but they are still local-only. Moving them into
Supabase is Phase 2:

1. `assessments` + `assessment_answers` tables with RLS
2. Save each answer against `auth.uid()`
3. One-time migration of existing localStorage answers on first login
4. Dashboard progress read from the database
