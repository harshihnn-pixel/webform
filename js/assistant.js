/* assistant.js
   Chat widget for the loan portal.

   A Gemini API key can never be safely placed in frontend code (anyone
   can view-source it), so this file never holds one. It calls the Edge
   Function in supabase/functions/assistant, and that function calls
   Gemini using a secret only the server can see.

   WHAT CHANGED IN THIS VERSION
   - Errors from the backend now show the fix, not just the symptom. The
     function returns a "hint" field and we display it.
   - A response that isn't JSON (a 404 page, a gateway error) no longer
     crashes into the generic "couldn't reach backend" message.
   - "Check connection" runs the function's health endpoint and reports
     exactly where the break is: wrong URL, missing key, or wrong project.
*/
var Assistant = (function () {
  var chatHistory = [];

  function $(id) { return document.getElementById(id); }

  var BUILD = "assistant.js build 3 — self-configuring";

  /* The function lives on the SAME Supabase project as everything else,
     so its URL can be derived from SUPABASE_URL — which is already
     correct, because signup and login work. Keeping a second hand-edited
     copy of the same URL in ASSISTANT_FUNCTION_URL just created a value
     that could go stale on its own. It's now an optional override:
     if it's missing or still holds the placeholder, we derive instead. */
  function functionUrl() {
    var explicit = window.ASSISTANT_FUNCTION_URL;
    if (explicit && explicit.indexOf("https://dkidefkpkuaqwxiqtqei.supabase.co") === -1) return explicit;

    var base = window.SUPABASE_URL;
    if (!base) return null;
    return base.replace(/\/+$/, "") + "/functions/v1/assistant";
  }

  function authToken() {
    var t = window.ASSISTANT_AUTH_TOKEN;
    if (t && t.indexOf("sb_publishable_PzpYmL9Cm3Jk10HOqN07yg_9wHsCc-H") === -1) return t;
    return window.SUPABASE_ANON_KEY || null;
  }

  function isConfigured() {
    return !!functionUrl();
  }

  /* Printed on load so you can tell at a glance which build the browser
     is actually running — a cached old file is otherwise invisible. */
  console.log("[assistant] " + BUILD);
  console.log("[assistant] endpoint:", functionUrl() || "(none — SUPABASE_URL is not set)");

  function authHeaders() {
    var headers = { "Content-Type": "application/json" };
    var token = authToken();
    if (token) {
      headers["Authorization"] = "Bearer " + token;
      headers["apikey"] = token;
    }
    return headers;
  }

  function addMessage(text, cls) {
    var body = $("assistant-body");
    var div = document.createElement("div");
    div.className = "msg " + cls;
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function addUserMessage(text) { return addMessage(text, "user"); }
  function addBotMessage(text) { return addMessage(text, "bot"); }

  function addTyping() {
    var div = addMessage("Assistant is typing…", "typing");
    div.id = "typing-indicator";
  }

  function removeTyping() {
    var t = $("typing-indicator");
    if (t) t.remove();
  }

  /* Read the response body once, whatever shape it's in. A function that
     404s or times out returns HTML, and JSON.parse on that throws — which
     used to surface as a misleading "couldn't reach the backend". */
  async function readBody(response) {
    var raw = await response.text();
    try {
      return { json: JSON.parse(raw), raw: raw };
    } catch (e) {
      return { json: null, raw: raw };
    }
  }

  /* Turn a failed response into something the reader can act on. */
  function describeFailure(response, parsed) {
    if (parsed.json && parsed.json.error) {
      var msg = parsed.json.error;
      if (parsed.json.hint) msg += "\n\nFix: " + parsed.json.hint;
      return msg;
    }
    if (response.status === 404) {
      return "No function found at " + functionUrl() + " (404). The project is right but the " +
             "function isn't there — deploy it: supabase functions deploy assistant";
    }
    if (response.status === 401 || response.status === 403) {
      return "The function rejected this request (" + response.status + "). " +
             "ASSISTANT_AUTH_TOKEN in js/config.js must be your project's publishable/anon key.";
    }
    if (response.status === 546 || response.status === 504) {
      return "The function crashed or timed out. See what happened with: supabase functions logs assistant";
    }
    return "The assistant service returned HTTP " + response.status +
           (parsed.raw ? " — " + parsed.raw.slice(0, 200) : "");
  }

  /* Health check — GET the function and report its own view of itself. */
  async function checkConnection() {
    if (!isConfigured()) {
      addBotMessage("window.SUPABASE_URL isn't set, so there's no project to call. " +
                    "Check js/config.js is loading — open DevTools and look for a line starting [assistant].");
      return;
    }
    addBotMessage("Checking the connection…");
    try {
      var response = await fetch(functionUrl(), {
        method: "GET",
        headers: authHeaders()
      });
      var parsed = await readBody(response);

      if (!response.ok || !parsed.json) {
        addBotMessage(describeFailure(response, parsed));
        return;
      }

      var d = parsed.json;
      if (d.status === "ready") {
        addBotMessage("Connected to Gemini.\n" +
                      "Model: " + (d.model || "auto") + " (" + d.modelSource + ")\n" +
                      "Key found as: " + d.keyNameFound + "\n" +
                      "Runtime: " + d.runtime);
      } else if (d.status === "key_present_but_gemini_unreachable") {
        addBotMessage("The key was found (" + d.keyNameFound + ") but Gemini didn't respond to a " +
                      "model list request. Either the key is invalid, or the Generative Language API " +
                      "isn't enabled for its project. Verify the key at https://aistudio.google.com/apikey");
      } else {
        addBotMessage("The function is reachable but has no API key.\n\n" +
                      "Runtime: " + d.runtime + "\n" +
                      "Env names it can see: " + (d.visibleEnvNames || []).join(", ") + "\n\n" +
                      "If GEMINI_API_KEY isn't in that list, the secret didn't reach this runtime — " +
                      "redeploy with: supabase functions deploy assistant");
      }
    } catch (e) {
      addBotMessage("Couldn't reach " + functionUrl() + ". " +
                    "Either the URL is wrong or the function isn't deployed.");
    }
  }

  async function sendMessage() {
    var input = $("assistant-input");
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    addUserMessage(text);

    if (!isConfigured()) {
      addBotMessage("window.SUPABASE_URL isn't set, so there's no project to call. That usually means " +
                    "js/config.js didn't load at all. Open DevTools (F12) — if you don't see a line " +
                    "starting [assistant], the browser is running a cached or different copy of these files.");
      return;
    }

    chatHistory.push({ role: "user", content: text });
    addTyping();

    try {
      var response = await fetch(functionUrl(), {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ messages: chatHistory })
      });
      var parsed = await readBody(response);
      removeTyping();

      if (!response.ok || !parsed.json) {
        addBotMessage(describeFailure(response, parsed));
        chatHistory.pop(); // don't keep a turn the model never answered
        return;
      }

      var replyText = parsed.json.reply;
      if (!replyText) {
        addBotMessage("The service replied without any text. Try rephrasing your question.");
        chatHistory.pop();
        return;
      }

      addBotMessage(replyText);
      chatHistory.push({ role: "assistant", content: replyText });
    } catch (e) {
      removeTyping();
      chatHistory.pop();
      addBotMessage("Couldn't reach the assistant backend. This is usually one of: the function isn't " +
                    "deployed, ASSISTANT_FUNCTION_URL points at the wrong project, or CORS is blocking " +
                    "the request. Type \"check connection\" to run a diagnostic.");
    }
  }

  function init() {
    $("assistant-fab").addEventListener("click", function () {
      $("assistant-drawer").classList.add("open");
      if (chatHistory.length === 0) {
        if (isConfigured()) {
          addBotMessage("Hi! I can help with document checklists, loan process questions, or explaining " +
                        "a field on the form. What do you need? (Type \"check connection\" if something " +
                        "looks broken.)");
        } else {
          addBotMessage("Hi! I can't find window.SUPABASE_URL, so js/config.js probably didn't load. " +
                        "Open DevTools (F12) and check the Console for a line starting [assistant].");
        }
      }
    });
    $("assistant-close").addEventListener("click", function () {
      $("assistant-drawer").classList.remove("open");
    });
    $("assistant-send").addEventListener("click", handleSend);
    $("assistant-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") handleSend();
    });
  }

  /* "check connection" is a shortcut, not a message to the model. */
  function handleSend() {
    var input = $("assistant-input");
    var text = input.value.trim().toLowerCase();
    if (text === "check connection" || text === "/health" || text === "/debug") {
      input.value = "";
      addUserMessage("check connection");
      checkConnection();
      return;
    }
    sendMessage();
  }

  return { init: init, checkConnection: checkConnection };
})();
