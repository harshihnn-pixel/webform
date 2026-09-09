// supabase/functions/match-banks/index.ts
//
// Stage 2 of bank matching. The browser POSTs the applicant's details;
// this function:
//   1. calls the match_banks() RPC, which does the cheap numeric filtering
//      in Postgres and hands back the shortlist WITH each desk's policy text
//   2. gives that text to Gemini, which reads the judgement-call rules SQL
//      cannot ("based on the clarification we can do it") and ranks them
//   3. returns a clean JSON list the UI can render
//
// Doing it in this order matters. Sending all 30 desks and 669 policy
// sentences to Gemini on every submission is slow, expensive, and less
// accurate than sending the 6 that already passed the hard filters.
//
// DEPLOY
//   supabase secrets set GEMINI_API_KEY=AIza...
//   supabase functions deploy match-banks
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically
// by the platform - you do not set those yourself.
//
// NOTE: this uses Deno.serve, which is built into the Supabase runtime.
// Importing serve from deno.land/std also works locally but can fail to
// resolve during a dashboard deploy, which shows up as a deploy that
// never appears in your function list. No imports = nothing to resolve.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_CANDIDATES = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3-flash", "gemini-2.5-flash"];
const MAX_TO_RANK = 8; // how many shortlisted desks Gemini actually reads

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are a loan underwriting assistant for an Indian DSA (loan agent).

You will receive an applicant's profile and a shortlist of lender desks. Each desk
carries that lender's real 2024 policy notes, written informally by the agents who
deal with them. The notes use Indian lending shorthand:
  FOIR = EMI-to-income ratio     BT = balance transfer
  CIBIL -1 = no credit history   PAT = permanent address verification
  Cat A/B/C/D = internal company category   25K = Rs 25,000 per month
  MCA = years the company has been registered   PL = personal loan
  DPD = days past due            T/W = two-wheeler loan

A numeric pre-filter has already run, so nothing here breaks a hard number.
Your job is the judgement the numbers miss: read the policy notes and decide how
strong each desk really is for THIS applicant.

Rules:
- Only use the notes provided. Never invent a policy, rate, or requirement.
- If a note is vague ("case to case", "based on profile"), say so rather than
  guessing - that is useful information for the agent.
- Confidence: "strong" = notes clearly support this profile. "possible" = likely
  but something needs confirming. "weak" = the notes raise a real concern.
- Flag any document the notes demand that the applicant has not supplied.

Reply with ONLY a JSON object, no markdown fences, no preamble:
{
  "matches": [
    {
      "desk_slug": "...",
      "confidence": "strong" | "possible" | "weak",
      "why": "one or two plain sentences the agent can read to the customer",
      "watch_out": "the single biggest risk or missing document, or null",
      "documents_needed": ["..."]
    }
  ],
  "overall_advice": "one short paragraph on how to approach this file"
}
Order matches best-first. Include every desk you were given.`;

let resolvedModel: string | null = null;

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const pinned = (Deno.env.get("GEMINI_MODEL") || "").trim();
  const attempts = pinned ? [pinned] : resolvedModel ? [resolvedModel, ...MODEL_CANDIDATES] : MODEL_CANDIDATES;

  let lastError = "No model available";
  for (const model of attempts) {
    const res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { maxOutputTokens: 2000, temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .map((p: { text?: string }) => p?.text || "").join("");
      if (text) { resolvedModel = model; return text; }
      lastError = "Gemini returned an empty response";
      continue;
    }
    lastError = data?.error?.message || `HTTP ${res.status}`;
    if (res.status !== 404) break; // 404 = model retired, try the next name
  }
  throw new Error(lastError);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const profile = body?.profile ?? body;

    // ---- Stage 1: the SQL filter ------------------------------------
    const rpc = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/match_banks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`,
      },
      body: JSON.stringify({ p_application: profile }),
    });

    if (!rpc.ok) {
      return json({ error: "Database matching failed", detail: await rpc.text() }, 500);
    }

    type Row = {
      desk_slug: string; bank_name: string; contact_name: string | null;
      contact_phone: string | null; verdict: string; reasons: string[];
      policies: Record<string, string>;
    };
    const rows: Row[] = await rpc.json();

    const shortlist = rows.filter((r) => r.verdict !== "rejected").slice(0, MAX_TO_RANK);
    const rejected = rows.filter((r) => r.verdict === "rejected");

    if (shortlist.length === 0) {
      return json({
        matches: [],
        rejected: rejected.map((r) => ({ bank: r.bank_name, reasons: r.reasons })),
        overall_advice:
          "No lender in the current policy set fits this profile as entered. " +
          "The most common fixes are waiting for the CIBIL score to improve, " +
          "reducing the requested amount, or adding a co-applicant.",
      }, 200);
    }

    // ---- Stage 2: Gemini reads the policy text ----------------------
    const apiKey = (Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY") || "").trim();
    if (!apiKey) {
      // Degrade gracefully: the SQL result on its own is still useful.
      return json({ matches: shortlist, rejected, note: "AI ranking unavailable (no GEMINI_API_KEY set)" }, 200);
    }

    const prompt =
      `APPLICANT:\n${JSON.stringify(profile, null, 1)}\n\n` +
      `SHORTLISTED DESKS:\n` +
      shortlist.map((d) =>
        `--- desk_slug: ${d.desk_slug}\n` +
        `lender: ${d.bank_name}${d.contact_name ? ` (desk of ${d.contact_name})` : " (direct)"}\n` +
        `pre-filter notes: ${d.reasons.length ? d.reasons.join("; ") : "clears every recorded rule"}\n` +
        `policy notes:\n${Object.entries(d.policies).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`
      ).join("\n\n");

    let ai: { matches?: unknown[]; overall_advice?: string } = {};
    try {
      ai = JSON.parse((await callGemini(apiKey, prompt)).replace(/```json|```/g, "").trim());
    } catch (e) {
      return json({
        matches: shortlist,
        rejected,
        note: `AI ranking failed, showing rule-based results only: ${e instanceof Error ? e.message : e}`,
      }, 200);
    }

    // Merge the AI's judgement back onto the real database rows, so
    // bank names and phone numbers come from the DB and never from the model.
    const byslug = new Map(shortlist.map((d) => [d.desk_slug, d]));
    const matches = (ai.matches || [])
      .map((m) => {
        const mm = m as Record<string, unknown>;
        const desk = byslug.get(String(mm.desk_slug));
        if (!desk) return null;
        return {
          bank: desk.bank_name,
          contact_name: desk.contact_name,
          contact_phone: desk.contact_phone,
          verdict: desk.verdict,
          confidence: mm.confidence ?? "possible",
          why: mm.why ?? "",
          watch_out: mm.watch_out ?? null,
          documents_needed: mm.documents_needed ?? [],
          rule_notes: desk.reasons,
        };
      })
      .filter(Boolean);

    return json({
      matches,
      rejected: rejected.map((r) => ({ bank: r.bank_name, reasons: r.reasons })),
      overall_advice: ai.overall_advice ?? "",
      disclaimer:
        "Indicative only, based on 2024 policy notes. Final approval is the lender's decision.",
    }, 200);

  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
