# Fixes — "Final analysis is not working"

All changes are in `server/server.js` plus a note added to `.env`.
No frontend files were touched. The 13-question structure is unchanged.

---

## What was verified first

Before changing anything, the app was run locally and a complete,
valid 13-question payload was posted to `/api/analyse-values`.

It passed Zod validation and the question-text match check, and reached
the AI call. So `js/app.js`, `js/api.js`, the request schema and the
question wiring were never the problem. **Every failure was happening at
the Gemini request itself.**

---

## 1. Hardcoded API key removed (security)

`server/server.js` had a live Gemini key pasted as the fallback for both
providers:

```js
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || "AQ.Ab8RN6...";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "AQ.Ab8RN6...";
```

Two problems. The Anthropic fallback was a Google key, so it could never
have worked. And because a hardcoded string is always truthy, the
`MISSING_API_KEY` check and the startup warnings could never fire — the
server always claimed to be configured.

Both fallbacks are now `""`.

**Revoke that key.** It was committed in source and shipped in a zip.

---

## 2. Thinking tokens were eating the whole answer

`gemini-2.5-flash` is a thinking model. Reasoning tokens come out of the
*same* `maxOutputTokens` budget as the visible answer.

The required schema is large: 3 top values (4 fields each), 5 supporting
values, 12 arrays, and a values statement. The model could spend the
entire 6000-token budget thinking and return `finishReason: "MAX_TOKENS"`
with empty `parts` — which is exactly the "Gemini returned an empty
response" branch in the log.

Added to `generationConfig` in `callGemini()`:

```js
if (/^gemini-2\.5/.test(AI_MODEL)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
}
```

The whole budget now goes to the JSON. This task is extraction and
summarisation, not multi-step reasoning, so nothing is lost.

---

## 3. The real error was being thrown away

`callGemini()` logged the Gemini status and body, then threw a bare
`new Error("Gemini returned " + status)`. The route caught it, matched
nothing, and answered with a generic 502 `AI_PROVIDER_ERROR`. That is why
the browser said "please try again in a moment" no matter what the actual
cause was — including when retrying could never possibly help.

Errors now carry `status`, `providerBody` and a `code`, and the route
answers with distinct messages:

| Code             | Meaning                                    |
|------------------|--------------------------------------------|
| `AI_AUTH_FAILED` | 401/403 — the key was rejected             |
| `AI_TRUNCATED`   | ran out of output tokens mid-JSON          |
| `AI_BLOCKED`     | safety / recitation stop                   |
| `AI_INVALID_JSON`| response was not parseable JSON            |
| `AI_SCHEMA_INVALID` | JSON parsed but did not match the schema |

---

## 4. Your API key format — read this

Your key starts with `AQ.` — Google's new "Auth key" format. Google is
partway through migrating Gemini keys away from the old `AIzaSy...`
"Standard" format, and new keys from AI Studio come out as `AQ.` keys.

Many developers report these are rejected by the exact endpoint this
server calls — `generativelanguage.googleapis.com/v1beta/models/...:generateContent`
— with `401 UNAUTHENTICATED / ACCESS_TOKEN_TYPE_UNSUPPORTED`, using
either the `x-goog-api-key` header or the `?key=` query parameter.

**This cannot be fixed in code.** What the fix adds instead:

- a loud warning at server startup if the key starts with `AQ.`
- `geminiKeyFormat` in `GET /api/health`, so you can check without
  opening `.env`
- a specific `AI_AUTH_FAILED` message instead of a vague retry prompt

To resolve it, create a classic `AIzaSy...` key in Google AI Studio, or
switch to the official `@google/genai` SDK, which handles the newer key
type internally rather than hand-rolling the fetch.

---

## How to confirm which cause you hit

```bash
npm start
curl http://localhost:3000/api/health
```

Check `geminiKeyFormat`. Then run an analysis and watch the **server
terminal**, not the browser:

- `Gemini API returned 401`/`403` → key problem, see section 4
- `GEMINI EMPTY RESPONSE` with `MAX_TOKENS` → section 2 should now fix it
- `AI SCHEMA ERROR` → the model returned valid JSON in the wrong shape

---

## Still outstanding (not changed)

`.env` contains a line `SUPERBASE API_URL=...` — commented out, since a
space in a variable name means dotenv ignored it anyway. Safe to delete.

---

# Phase 2 — Taxonomy Comparison

## The problem

The analysis was never comparing against `cff_value_taxonomy.csv`.

`buildUserMessage()` sent Gemini only two things: the user's role, and the
39 answers. The taxonomy was never in the request. Gemini had no idea the
38 values existed, so it invented plausible names each run — which is why
"Growth & Learning" appeared instead of `learning` / "Learning & Study".

## What now happens

```
Answers -> [Answers + 38-value taxonomy] -> Gemini
        -> returns slugs -> validated against the real slug list
        -> canonical names + domain rollup -> UI
```

Four changes make it real:

**1. Taxonomy goes into the prompt.** All 38 values are injected as
`slug | Display Name — description (signals: ...)`. The `example_signals`
column does the heavy lifting: it is what connects "using laptop to learn
new things" to `learning`.

**2. The model must return slugs.** `TopValueSchema` and
`SupportingValueSchema` now require `slug`. The system prompt states the
rule explicitly, including that "Growth & Learning" is invalid.

**3. Slugs are verified server-side.** `resolveAgainstTaxonomy()` checks
every returned slug against the real list. Near-misses (a display name
where a slug was expected) are repaired by name match. Anything still
unmatched is dropped, and if fewer than 3 top / 5 supporting values
survive, the request fails with `AI_TAXONOMY_MISMATCH` instead of showing
invented values. **The model's own label is never displayed** — the
canonical `value_name` from the taxonomy always overwrites it.

**4. Domain scoring.** Now that values are canonical, they roll up into
your 8 domains (top values weighted x2). Rendered as a bar breakdown.

Verified against the exact output from the screenshot:

```
UNMATCHED (rejected): [ 'Growth & Learning', 'Family & Well-being', 'TOTALLY_MADE_UP' ]
career_advancement => Career Advancement | Business
```

## Where the taxonomy lives

Two sources, tried in order:

1. Supabase table `value_taxonomy` — run `sql/phase2-taxonomy.sql`
2. `data/cff_value_taxonomy.csv` — automatic fallback

**Running the SQL is optional.** It works out of the box from the CSV.
Create the table when you want to edit values without redeploying.

The migration enables RLS with **no policies on purpose**: the browser
(anon key) can read nothing, while the server's service_role key bypasses
RLS. The taxonomy never reaches the frontend.

Check which source is active:

```bash
curl http://localhost:3000/api/health
# -> "taxonomyValues": 38, "taxonomySource": "csv"
```

## Files

| File | Change |
|------|--------|
| `server/taxonomy.js` | **new** — CSV parser + Supabase loader + prompt block |
| `data/cff_value_taxonomy.csv` | **new** — your 38 values |
| `sql/phase2-taxonomy.sql` | **new** — optional Supabase migration |
| `server/server.js` | prompt injection, slug schema, enforcement, domain scoring |
| `js/app.js` | renders domain breakdown + domain on each value card |

The 13 questions are unchanged.

## Not done yet

Submissions and analyses are still **not saved to Supabase** — they live
in browser localStorage only. Clear your browser and results are gone.
That is the next phase.
