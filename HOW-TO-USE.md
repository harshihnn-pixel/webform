# CFF — How To Use It

## What this build does

1. You answer 13 questions, 3 answers each (39 total).
2. As you type, **suggestions appear** — click one to fill the box.
3. On submit, the server **matches every answer against the 38-value
   taxonomy** and scores them.
4. You get your **top 3 values with a rating out of 100**, plus 5
   supporting values and a breakdown across the 8 domains.

---

## STEP 1 — Install

Extract the zip, open a terminal in that folder, and run:

```bash
npm install
```

Once only. It downloads the libraries listed in `package.json`.

---

## STEP 2 — Put in a working Gemini key

Open `.env`. Find this line:

```
GEMINI_API_KEY=AQ.Ab8RN6...
```

**Replace it with a new key.** Two reasons:

- The old one was hardcoded in the source and shipped in a zip, so treat
  it as public. Revoke it.
- It uses the `AQ.` format, which is often rejected by the endpoint this
  server calls. Prefer a classic `AIzaSy...` key from Google AI Studio.

**If you skip this step the app still works.** You get your values and
ratings from the scoring engine, just without the AI's written
commentary, and a yellow notice explains why.

---

## STEP 3 — Start it

```bash
npm start
```

You should see:

```
CFF: value taxonomy loaded — 38 values from csv.
CFF: answer bank loaded — 372 suggestions across 13 questions.
========================================
CFF server running at http://localhost:3000
Value taxonomy: 38 values (csv)
========================================
```

If both numbers are there, everything is loaded. Open
**http://localhost:3000**.

---

## STEP 4 — Take the assessment

Sign up, then start the 13 questions.

Click into any answer box and **suggestions appear immediately**. Type to
filter them:

| You type | You get |
|----------|---------|
| `gym`    | Exercising, gym and physical activity |
| `cod`    | Building and coding projects |
| `pray`   | Praying, meditating and reflecting |

Click a suggestion to fill the box. **You can also type freely** — the
scorer reads free text too, matching on similar words. Picking a
suggestion just scores more strongly, because it is an exact match.

Answer all 39 boxes, then press **Review & Generate Analysis**.

---

## STEP 5 — Read your result

You get:

- **Top 3 values**, each with a domain, a rating out of 100, and the
  answers that produced it
- **5 supporting values** with their ratings
- **Value domains** — your split across the 8 CFF domains
- The written sections (themes, patterns, next steps) when AI is working

The **top value is always 100**, and the others are scaled against it. So
"Entrepreneurship 93" means it is nearly as strong as your top value —
not that it scored 93%.

---

## How scoring works

Every answer is checked against 372 phrases, each carrying similar words.
Points per answer box:

| Match | Points |
|-------|--------|
| Exactly a suggestion phrase | 5 |
| A similar word, as a whole word | 3 |
| A weaker partial match | 1 |

One answer can score several values — "gym and reading" honestly signals
both. But each value scores **at most once per box**, so repeating a word
cannot inflate it.

This runs in plain code, not AI, so **the same 39 answers always give the
same ranking**. The AI is handed that ranking and writes the explanation
around it — it cannot reorder or substitute your values.

---

## Editing the data

**To change the values** — edit `data/cff_value_taxonomy.csv`
(id, slug, value_name, domain, description, example_signals).

**To add suggestions** — edit `data/cff_answer_bank.csv`:

```csv
question_no,answer_text,slug,domain,similar_words,is_sample
2,Volunteering at the temple,service,Relational,"volunteer,seva,temple,helping",no
```

Columns: `question_no` (1-13), `answer_text` (what the user sees),
`slug` (must exist in the taxonomy CSV), `domain` (for your reference
when editing), `similar_words` (what users can type to find it),
`is_sample` (marks the 3 worked examples per question).

`similar_words` is what users can type to find that phrase. `slug` must
already exist in the taxonomy CSV.

Restart the server after editing either file.

---

## Optional — move to Supabase

Run `sql/phase2-taxonomy.sql` in Supabase → SQL Editor. The server then
reads the taxonomy from the database instead of the CSV, so you can edit
values without redeploying.

The migration enables RLS with **no policies on purpose**: the browser
can read nothing, while the server's service key bypasses RLS.

Check which source is live:

```bash
curl http://localhost:3000/api/health
```

---

## If something goes wrong

Watch the **server terminal**, not the browser.

| Message | Meaning |
|---------|---------|
| `Gemini API returned 401` / `403` | Key rejected — see Step 2. You still get results. |
| `GEMINI EMPTY RESPONSE` | Ran out of tokens. Thinking is already disabled; lower the schema size if it persists. |
| `INSUFFICIENT_MATCHES` | Answers too short or unusual. Use suggestions or add detail. |
| `only N value(s) matched` | Same as above. |
| Suggestions don't appear | Server not running, or a hard refresh is needed (Ctrl+Shift+R) — the service worker caches the old JS. |

---

## Not done yet

Answers and results save to **browser localStorage only**, not Supabase.
Clear your browser and they are gone. Saving them to the database is the
natural next step.
