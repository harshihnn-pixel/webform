/* config.js
   Your Supabase project details go here — this is the ONE file you need
   to edit to connect this site to Supabase.

   WHERE TO FIND THESE VALUES:
   Supabase Dashboard -> Project Settings -> API
     - "Project URL"                      -> SUPABASE_URL
     - "anon public" / "publishable key"  -> SUPABASE_ANON_KEY
   (Supabase renamed "anon key" to "publishable key" in newer projects —
   they're the same thing, just grab whichever label your dashboard shows.)

   SAFE TO EXPOSE?
   Yes. SUPABASE_URL and SUPABASE_ANON_KEY are DESIGNED to be public and
   shipped in frontend code like this. Your data is protected by Row
   Level Security policies (set up by supabase/schema.sql), not by
   keeping these values secret.
*/

window.SUPABASE_URL = "https://dkidefkpkuaqwxiqtqei.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_PzpYmL9Cm3Jk10HOqN07yg_9wHsCc-H";


/* ------------------------------------------------------------------
   AI ASSISTANT PANEL (GEMINI)
   These connect the chat button to the Edge Function that talks to
   Google Gemini on your behalf. Your GEMINI_API_KEY is NOT here and
   must never be — it lives only as a Supabase secret on the server. They are separate from the two values
   above: those connect accounts/applications to Supabase.

   IMPORTANT — the project ref below must match the project you ran
   `supabase link` against. If they differ, the browser calls one
   project while your secrets live in another, and the function reports
   a missing API key even though `supabase secrets list` shows it.
   Confirm with:  supabase projects list
   ------------------------------------------------------------------ */

window.ASSISTANT_FUNCTION_URL = "https://dkidefkpkuaqwxiqtqei.supabase.co/rest/v1/";



/* ------------------------------------------------------------------
   BANK MATCHING
   The Edge Function that decides which lenders an applicant can
   approach. It calls the match_banks() SQL function for the numeric
   filtering, then asks Gemini to read the shortlisted lenders' policy
   notes and rank them.

   Same project ref as above. Deploy it with:
     supabase functions deploy match-banks

   Leave this unset and the portal still works — applications submit
   normally, you just don't get recommendations.
   ------------------------------------------------------------------ */
window.MATCH_FUNCTION_URL = "https://dkidefkpkuaqwxiqtqei.supabase.co/functions/v1/rapid-function";
