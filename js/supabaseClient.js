/* supabaseClient.js
   Creates the single shared Supabase client used by auth.js and
   dashboard.js. Relies on window.SUPABASE_URL / window.SUPABASE_ANON_KEY
   from config.js, and on the Supabase JS SDK, which index.html loads
   from a CDN.

   window.supabaseClient starts as null and is set once
   initSupabaseClient() (called from app.js on startup) finishes. If it's
   still null afterwards, window.supabaseInitError explains exactly why —
   either config.js still has placeholder values, or the Supabase library
   itself failed to load (network/firewall/ad-blocker issue), which are
   two very different problems that used to show the same vague message.
*/
var supabaseClient = null;
var supabaseInitError = null;

async function initSupabaseClient() {
  var placeholder = !window.SUPABASE_URL || window.SUPABASE_URL.indexOf("YOUR-PROJECT-REF") !== -1;
  if (placeholder) {
    supabaseInitError = "config";
    console.warn("Supabase is not configured yet — js/config.js still has placeholder values.");
    return null;
  }

  // The CDN <script> tag in index.html usually already loaded the
  // library by the time this runs. If it didn't (blocked by a firewall,
  // ad-blocker, or flaky network), try one alternate CDN before giving up.
  if (typeof window.supabase === "undefined") {
    console.warn("Supabase library not found yet — trying a fallback CDN...");
    await tryLoadScript("https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.js");
  }

  if (typeof window.supabase === "undefined") {
    supabaseInitError = "library";
    console.error("The Supabase JavaScript library could not be loaded from either CDN. Check your internet connection, firewall, or any script-blocking browser extension.");
    return null;
  }

  try {
    supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    supabaseInitError = null;
    return supabaseClient;
  } catch (e) {
    supabaseInitError = "client";
    console.error("Could not create the Supabase client:", e);
    return null;
  }
}

function tryLoadScript(src) {
  return new Promise(function (resolve) {
    var script = document.createElement("script");
    script.src = src;
    script.onload = function () { resolve(true); };
    script.onerror = function () { resolve(false); };
    document.head.appendChild(script);
    // Don't hang forever if the fallback also stalls.
    setTimeout(function () { resolve(false); }, 5000);
  });
}
