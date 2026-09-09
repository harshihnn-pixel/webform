// supabase/functions/assistant/index.ts
//
// Gemini chat backend for the loan portal's Assistant panel.
//
// WHY THIS FILE EXISTS
// A Gemini API key can never live in frontend code — anyone can
// view-source it. The browser calls THIS function, and this function
// (running on Supabase's servers) calls Gemini with a secret only it
// can see.
//
// DEPLOY
//   supabase secrets set GEMINI_API_KEY=AIza...
//   supabase functions deploy assistant
// Redeploy after changing secrets. A running instance keeps the
// environment it was built with — this is the #1 cause of
// "GEMINI_API_KEY is not set" while `supabase secrets list` shows it.
//
// LOCAL TESTING (`supabase secrets set` does NOT apply to local runs)
//   supabase functions serve assistant --env-file supabase/functions/.env
//
// MODEL SELECTION
// Google retires models on a real schedule — gemini-2.0-flash was shut
// off on 1 June 2026, and the Flash line moved 3.5 -> 3.6 -> 3.7 in the
// space of about a month. So this function does NOT hard-code one name
// and hope. It tries a list, and if every name 404s it asks Google which
// models the key can actually use and picks one. That means a
// deprecation shows up as a slower first request, not an outage.
//
// Pin a specific model any time with:
//   supabase secrets set GEMINI_MODEL=gemini-3.7-flash

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT =
  "You are a helpful assistant embedded in a loan application portal. " +
  "Applicants use this portal to fill out and submit loan applications (home, plot, construction, " +
  "personal, vehicle, business, education loans) and to upload supporting documents. Help them with: " +
  "understanding the loan process, typical document checklists (ID proof, address proof, income proof, " +
  "bank statements, property documents), what a field on the form means, and general next steps. " +
  "Keep answers short and practical. If asked something unrelated, answer briefly and steer back to " +
  "how you can help with their application.";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Env names accepted for the key, in priority order.
const KEY_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;

// Tried in order. Newest first, older ones as a safety net for keys
// that don't have access to the newest tier yet.
const MODEL_CANDIDATES = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3-flash",
  "gemini-2.5-flash",
];

const MAX_OUTPUT_TOKENS = 1000;
const MAX_HISTORY_MESSAGES = 20; // keep requests bounded on long chats

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/* ------------------------------------------------------------------ */
/* Key handling                                                        */
/* ------------------------------------------------------------------ */

/** Strip the junk that gets pasted in alongside a key. */
function clean(value: string | undefined): string {
  if (!value) return "";
  let s = value.trim();
  // A value wrapped in quotes: "AIza..." or 'AIza...'
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  // Stray carriage returns / newlines — common when pasting in PowerShell
  return s.replace(/[\r\n]/g, "").trim();
}

function findKey(): { name: string; value: string } | null {
  for (const name of KEY_NAMES) {
    const value = clean(Deno.env.get(name));
    if (value) return { name, value };
  }
  return null;
}

/** Are we on `supabase functions serve` rather than the hosted project? */
function isLocalRuntime(): boolean {
  const url = Deno.env.get("SUPABASE_URL") || "";
  return /localhost|127\.0\.0\.1|kong|host\.docker\.internal/i.test(url);
}

/** Names only — never values. Shows whether the secret reached this runtime. */
function visibleKeyNames(): string[] {
  try {
    return Object.keys(Deno.env.toObject())
      .filter((k) => /KEY|TOKEN|SECRET|API/i.test(k))
      .sort();
  } catch {
    return ["(env listing not permitted in this runtime)"];
  }
}

/* ------------------------------------------------------------------ */
/* Model resolution                                                    */
/* ------------------------------------------------------------------ */

// Remembered for the life of this instance so we resolve at most once.
let resolvedModel: string | null = null;

/** Ask Google which models this key can actually use. */
async function discoverModel(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const usable = (data?.models || [])
      .filter((m: { supportedGenerationMethods?: string[] }) =>
        (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m: { name: string }) => String(m.name).replace(/^models\//, ""));

    // Prefer a stable flash model; skip preview/experimental/vision/lite builds.
    const isStable = (n: string) => !/preview|exp|experimental|vision|tuning/i.test(n);
    const flash = usable.filter((n: string) => /flash/i.test(n) && isStable(n));
    const pro = usable.filter((n: string) => /pro/i.test(n) && isStable(n));

      // Highest version first. Compare segment by segment so a future
      // "gemini-3.10-flash" outranks "gemini-3.7-flash" — parseFloat
      // would read 3.10 as 3.1 and get this backwards.
      const byVersionDesc = (a: string, b: string) => {
        const segs = (s: string) => ((s.match(/(\d+(?:\.\d+)*)/) || ["0"])[0]).split(".").map(Number);
        const [x, y] = [segs(a), segs(b)];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
          const diff = (y[i] || 0) - (x[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      };

    return flash.sort(byVersionDesc)[0] || pro.sort(byVersionDesc)[0] || usable[0] || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Gemini call                                                         */
/* ------------------------------------------------------------------ */

type ChatMessage = { role: string; content: string };

type GeminiResult =
  | { ok: true; reply: string; model: string }
  | { ok: false; status: number; message: string; hint?: string; modelNotFound?: boolean };

async function generate(apiKey: string, model: string, messages: ChatMessage[]): Promise<GeminiResult> {
  // Gemini says "model" where most APIs say "assistant", and carries the
  // system prompt in its own field rather than as a message.
  const contents = messages.map((m) => ({
    role: m.role === "assistant" || m.role === "model" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey, // header, not query string — keeps the key out of URL logs
      },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      message: e instanceof Error ? e.message : "Could not reach Gemini.",
      hint: "The function couldn't open a connection to generativelanguage.googleapis.com.",
    };
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = data?.error?.message || `Gemini returned HTTP ${res.status}`;
    let hint: string | undefined;

    if (res.status === 404) {
      return { ok: false, status: 404, message, modelNotFound: true };
    }
    if (res.status === 400 && /API key not valid/i.test(message)) {
      hint = "The key reached Google but was rejected. Re-set it without quotes: " +
             "supabase secrets set GEMINI_API_KEY=AIza... — then redeploy.";
    } else if (res.status === 403) {
      hint = "The key is valid but not authorised for this. Check the Generative Language API " +
             "is enabled for the key's project in Google AI Studio.";
    } else if (res.status === 429) {
      hint = "Rate limit or quota exhausted on Google's side. Wait a minute, or check quota in Google AI Studio.";
    } else if (res.status >= 500) {
      hint = "Gemini itself is erroring. Usually transient — retry shortly.";
    }
    return { ok: false, status: res.status, message, hint };
  }

  const candidate = data?.candidates?.[0];
  const reply = (candidate?.content?.parts || [])
    .map((p: { text?: string }) => p?.text || "")
    .filter(Boolean)
    .join("\n");

  // A blocked prompt returns 200 with no text and a finishReason.
  if (!reply) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason;
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || data?.promptFeedback?.blockReason) {
      return {
        ok: false,
        status: 400,
        message: "Gemini declined to answer that one. Try rewording your question.",
      };
    }
    if (reason === "MAX_TOKENS") {
      return {
        ok: false,
        status: 400,
        message: "The answer hit the length limit before any text came back. Try a narrower question.",
      };
    }
  }

  return { ok: true, reply, model };
}

/**
 * Run a request, resolving the model on first use and re-resolving if the
 * pinned one has been retired.
 */
async function generateWithModelFallback(apiKey: string, messages: ChatMessage[]): Promise<GeminiResult> {
  const pinned = clean(Deno.env.get("GEMINI_MODEL"));
  const attempts = pinned
    ? [pinned]
    : resolvedModel
      ? [resolvedModel, ...MODEL_CANDIDATES.filter((m) => m !== resolvedModel)]
      : MODEL_CANDIDATES;

  let lastNotFound: GeminiResult | null = null;

  for (const model of attempts) {
    const result = await generate(apiKey, model, messages);
    if (result.ok) {
      resolvedModel = model; // remember the winner for subsequent requests
      return result;
    }
    if (!result.modelNotFound) return result; // a real error — surface it as-is
    lastNotFound = result;
  }

  // Every known name is gone. Ask Google what this key can use.
  const discovered = await discoverModel(apiKey);
  if (discovered) {
    const result = await generate(apiKey, discovered, messages);
    if (result.ok) {
      resolvedModel = discovered;
      return result;
    }
    return result;
  }

  return {
    ok: false,
    status: 404,
    message: lastNotFound?.message || "No usable Gemini model found for this API key.",
    hint: `Tried: ${attempts.join(", ")}. None exist for this key, and listing models returned nothing. ` +
          "Pin one explicitly with: supabase secrets set GEMINI_MODEL=<model-name>",
  };
}

/* ------------------------------------------------------------------ */
/* Request handler                                                     */
/* ------------------------------------------------------------------ */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const key = findKey();
  const local = isLocalRuntime();
  const pinned = clean(Deno.env.get("GEMINI_MODEL"));

  // ---- Health check: GET the function URL, or type "check connection" in the app.
  if (req.method === "GET") {
    let reachable: string | null = null;
    if (key) reachable = await discoverModel(key.value);

    return jsonResponse({
      status: !key ? "no_api_key" : reachable ? "ready" : "key_present_but_gemini_unreachable",
      provider: "gemini",
      keyNameFound: key?.name || null,
      model: pinned || resolvedModel || reachable || null,
      modelSource: pinned ? "pinned via GEMINI_MODEL" : resolvedModel ? "resolved" : "auto",
      runtime: local ? "local (supabase functions serve)" : "hosted (deployed)",
      visibleEnvNames: visibleKeyNames(),
      note: "Names only — key values are never returned.",
    }, 200);
  }

  try {
    // ---- No key: say exactly which of the three causes it is.
    if (!key) {
      const hint = local
        ? "This function is running LOCALLY, and `supabase secrets set` does not apply to local runs. " +
          "Put the key in supabase/functions/.env and restart with: " +
          "supabase functions serve assistant --env-file supabase/functions/.env"
        : "The secret shows in `supabase secrets list` but isn't visible here. That means one of: " +
          "(1) this function hasn't been redeployed since you set it — run `supabase functions deploy assistant`; " +
          "(2) the browser is calling a different project — compare the ref in ASSISTANT_FUNCTION_URL " +
          "against `supabase projects list`; " +
          "(3) the secret went to another project — re-set it with `--project-ref <ref>`.";

      return jsonResponse({
        error: "No Gemini API key is readable by this function.",
        hint,
        diagnostics: {
          runtime: local ? "local" : "hosted",
          checkedNames: KEY_NAMES,
          visibleEnvNames: visibleKeyNames(),
        },
      }, 500);
    }

    // ---- Parse and validate the chat payload.
    let body: { messages?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse({
        error: "Request body wasn't valid JSON.",
        hint: 'Send: { "messages": [{ "role": "user", "content": "..." }] }',
      }, 400);
    }

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m): m is ChatMessage =>
        !!m && typeof m === "object" &&
        typeof (m as ChatMessage).content === "string" &&
        (m as ChatMessage).content.trim().length > 0)
      .slice(-MAX_HISTORY_MESSAGES);

    if (messages.length === 0) {
      return jsonResponse({
        error: "No messages provided.",
        hint: 'Send at least one message: { "messages": [{ "role": "user", "content": "..." }] }',
      }, 400);
    }

    const result = await generateWithModelFallback(key.value, messages);

    if (!result.ok) {
      return jsonResponse({
        error: result.message,
        hint: result.hint,
        provider: "gemini",
      }, result.status);
    }

    return jsonResponse({
      reply: result.reply,
      provider: "gemini",
      model: result.model,
    }, 200);

  } catch (err) {
    return jsonResponse({
      error: err instanceof Error ? err.message : "Unexpected server error.",
      hint: "Check the function logs: supabase functions logs assistant",
    }, 500);
  }
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
