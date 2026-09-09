/* dashboard.js
   Everything shown after login: overview stats, the multi-step loan
   application form (with document upload), and the "My Applications"
   list. Applications are saved via the submit_application / get_applications
   RPC functions in supabase/schema.sql — the app never talks to the
   applications table directly, only through those controlled functions.
   Attached documents are stored inline (base64) inside the application
   row, so there's no separate Storage bucket to configure.
*/
var Dashboard = (function () {
  var draftDocuments = [];
  var currentRef = "";
  var allApplications = [];

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function showMsg(el, text, type) {
    el.innerHTML = text
      ? '<div class="' + (type === "error" ? "error-msg" : "success-msg") + '">' + escapeHtml(text) + "</div>"
      : "";
  }

  function genRef() {
    var n = Math.floor(10000 + Math.random() * 90000);
    return "REF-" + new Date().getFullYear() + "-" + n;
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return ts; }
  }
  function fmtMoney(v) {
    if (v === "" || v === null || v === undefined) return "—";
    return "₹" + Number(v).toLocaleString("en-IN");
  }

  function currentUserId() {
    var user = Auth.getCurrentUser();
    return user ? user.id : null;
  }

  // ---------- step navigation within the application form ----------
  function goToStep(step) {
    document.querySelectorAll(".step-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.step === step);
    });
    document.querySelectorAll(".step-panel").forEach(function (p) {
      p.classList.remove("active");
    });
    $("step-" + step).classList.add("active");
    if (step === "review") renderReviewSummary();
  }

  function initStepNav() {
    document.querySelectorAll(".step-tab").forEach(function (btn) {
      btn.addEventListener("click", function () { goToStep(btn.dataset.step); });
    });
    document.querySelectorAll(".next-step").forEach(function (btn) {
      btn.addEventListener("click", function () { goToStep(btn.dataset.next); });
    });
    document.querySelectorAll(".prev-step").forEach(function (btn) {
      btn.addEventListener("click", function () { goToStep(btn.dataset.prev); });
    });
    $("p-same-address").addEventListener("change", function () {
      $("permanent-address-field").classList.toggle("hidden", this.checked);
    });
  }

  // ---------- documents ----------
  function initDocuments() {
    $("doc-input").addEventListener("change", function (e) {
      var files = Array.from(e.target.files || []);
      files.forEach(function (file) {
        if (file.size > 3 * 1024 * 1024) {
          alert(file.name + " is larger than 3MB and was skipped.");
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          draftDocuments.push({ name: file.name, type: file.type, size: file.size, dataUrl: reader.result });
          renderDocList();
        };
        reader.readAsDataURL(file);
      });
      e.target.value = "";
    });
  }

  function renderDocList() {
    var ul = $("doc-list");
    ul.innerHTML = "";
    draftDocuments.forEach(function (doc, idx) {
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.className = "doc-name";
      span.textContent = doc.name + "  ·  " + Math.round(doc.size / 1024) + " KB";
      var btn = document.createElement("button");
      btn.textContent = "Remove";
      btn.addEventListener("click", function () { draftDocuments.splice(idx, 1); renderDocList(); });
      li.appendChild(span);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  // ---------- gather form data ----------
  function collectFormData() {
    return {
      personal: {
        name: $("p-name").value.trim(),
        dob: $("p-dob").value,
        gender: $("p-gender").value,
        marital: $("p-marital").value,
        phone: $("p-phone").value.trim(),
        altPhone: $("p-altphone").value.trim(),
        email: $("p-email").value.trim(),
        idNumber: $("p-idnumber").value.trim(),
        address: $("p-address").value.trim(),
        city: $("p-city").value.trim(),
        state: $("p-state").value.trim(),
        pincode: $("p-pincode").value.trim(),
        sameAddress: $("p-same-address").checked,
        permanentAddress: $("p-same-address").checked ? $("p-address").value.trim() : $("p-permanent-address").value.trim()
      },
      employment: {
        type: $("e-type").value,
        org: $("e-org").value.trim(),
        designation: $("e-designation").value.trim(),
        experience: $("e-experience").value,
        income: $("e-income").value,
        otherIncome: $("e-other-income").value,
        existingEmis: $("e-existing-emis").value.trim(),

        // Credit profile (step 4). Nested inside employment rather than
        // passed as its own argument so no change to submit_application is
        // needed — applications.employment is already jsonb, so new keys
        // simply start saving with no migration.
        credit: {
          cibilScore: $("c-cibil").value,
          companyType: $("c-company-type").value,
          employmentStatus: $("c-employment-status").value,
          industry: $("c-industry").value,
          existingEmiAmount: $("c-existing-emi").value,
          accommodation: $("c-accommodation").value,
          enquiries3m: $("c-enquiries").value,
          bounces12m: $("c-bounces").value,
          settledLoans: $("c-settled").value
        }
      },
      loan: {
        type: $("l-type").value,
        amount: $("l-amount").value,
        tenure: $("l-tenure").value,
        purpose: $("l-purpose").value.trim(),
        propertyType: $("l-prop-type").value,
        propertyLocation: $("l-prop-location").value.trim(),
        propertyValue: $("l-prop-value").value,
        bank: $("l-bank").value.trim(),
        coApplicantName: $("l-coapp-name").value.trim(),
        coApplicantRelation: $("l-coapp-relation").value.trim(),
        coApplicantIncome: $("l-coapp-income").value
      }
    };
  }

  // ---------- credit profile helpers ----------
  var COMPANY_TYPE_LABELS = {
    listed: "Listed company",
    unlisted: "Unlisted / private limited",
    government: "Government / PSU",
    manpower: "Manpower or staffing agency"
  };
  var ACCOMMODATION_LABELS = {
    own: "Own house", family: "Family home", rented: "Rented, with family",
    bachelor: "Bachelor accommodation", pg: "PG / hostel"
  };

  function labelFor(map, key) {
    return map[key] || "Not provided";
  }

  /** Whole years between a date-of-birth string and today. */
  function ageFromDob(dob) {
    if (!dob) return null;
    var d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var age = now.getFullYear() - d.getFullYear();
    var m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age > 0 && age < 120 ? age : null;
  }

  /** Only send a number if the user actually typed one — 0 and "" differ. */
  function numOrNull(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  /**
   * Flatten the form into the shape match_banks() expects. Keys with a
   * null value are dropped: the SQL treats a missing key as "unknown"
   * and returns 'review', which is very different from treating a blank
   * CIBIL score as a zero and rejecting every lender.
   */
  function buildMatchProfile(data) {
    var c = data.employment.credit;
    var profile = {
      monthly_income: numOrNull(data.employment.income),
      experience_months: data.employment.experience ? Number(data.employment.experience) * 12 : null,
      loan_amount: numOrNull(data.loan.amount),
      age: ageFromDob(data.personal.dob),
      cibil_score: numOrNull(c.cibilScore),
      company_type: c.companyType || null,
      employment_type: c.employmentStatus || null,
      industry: c.industry || null,
      existing_emi: numOrNull(c.existingEmiAmount),
      enquiries_3m: numOrNull(c.enquiries3m),
      bounces_12m: numOrNull(c.bounces12m),
      accommodation: c.accommodation || null,
      settled_loans: c.settledLoans || null,
      loan_type: data.loan.type || null
    };
    Object.keys(profile).forEach(function (k) {
      if (profile[k] === null) delete profile[k];
    });
    return profile;
  }

  function renderReviewSummary() {
    var data = collectFormData();
    var html = "";
    html += reviewGroup("Personal", [
      ["Name", data.personal.name || "—"],
      ["Phone", data.personal.phone || "—"],
      ["Email", data.personal.email || "—"],
      ["City / State", [data.personal.city, data.personal.state].filter(Boolean).join(", ") || "—"]
    ]);
    html += reviewGroup("Employment", [
      ["Type", data.employment.type || "—"],
      ["Organisation", data.employment.org || "—"],
      ["Monthly income", fmtMoney(data.employment.income)]
    ]);
    html += reviewGroup("Loan", [
      ["Loan type", data.loan.type || "—"],
      ["Amount required", fmtMoney(data.loan.amount)],
      ["Tenure", data.loan.tenure ? data.loan.tenure + " years" : "—"],
      ["Property location", data.loan.propertyLocation || "—"]
    ]);
    html += reviewGroup("Credit profile", [
      ["CIBIL score", data.employment.credit.cibilScore || "Not provided"],
      ["Company type", labelFor(COMPANY_TYPE_LABELS, data.employment.credit.companyType)],
      ["Existing EMIs", data.employment.credit.existingEmiAmount
        ? fmtMoney(data.employment.credit.existingEmiAmount) + " / month" : "None or not provided"],
      ["Accommodation", labelFor(ACCOMMODATION_LABELS, data.employment.credit.accommodation)]
    ]);
    html += reviewGroup("Documents", [
      ["Attached files", draftDocuments.length ? draftDocuments.length + " file(s)" : "None attached"]
    ]);
    $("review-summary").innerHTML = html;
  }

  function reviewGroup(title, rows) {
    var rowsHtml = rows.map(function (r) {
      return '<div class="rs-row"><span>' + escapeHtml(r[0]) + '</span><span>' + escapeHtml(String(r[1])) + "</span></div>";
    }).join("");
    return '<div class="rs-group"><div class="rs-title">' + escapeHtml(title) + "</div>" + rowsHtml + "</div>";
  }

  function resetApplicationForm() {
    [
      "p-name", "p-dob", "p-phone", "p-altphone", "p-email", "p-idnumber", "p-address",
      "p-city", "p-state", "p-pincode", "p-permanent-address",
      "e-org", "e-designation", "e-experience", "e-income", "e-other-income", "e-existing-emis",
      "l-amount", "l-tenure", "l-purpose", "l-prop-location", "l-prop-value", "l-bank",
      "l-coapp-name", "l-coapp-relation", "l-coapp-income",
      "c-cibil", "c-existing-emi", "c-enquiries", "c-bounces"
    ].forEach(function (id) { $(id).value = ""; });
    ["p-gender", "p-marital", "e-type", "l-type", "l-prop-type",
     "c-company-type", "c-employment-status", "c-industry", "c-accommodation", "c-settled"
    ].forEach(function (id) { $(id).value = ""; });
    $("p-same-address").checked = false;
    $("permanent-address-field").classList.remove("hidden");
    $("r-consent").checked = false;
    draftDocuments = [];
    renderDocList();
    currentRef = genRef();
    $("app-ref").textContent = currentRef;
    goToStep("personal");
  }

  // ---------- bank matching ----------

  /**
   * Turn raw match_banks() rows into the same shape the Edge Function
   * returns, so renderMatches() doesn't care which path produced them.
   * No Gemini here, so there are no written explanations — but the
   * verdicts and reasons come from the same SQL either way.
   */
  function shapeRpcRows(rows) {
    var keep = (rows || []).filter(function (r) { return r.verdict !== "rejected"; });
    var out = (rows || []).filter(function (r) { return r.verdict === "rejected"; });

    return {
      matches: keep.slice(0, 8).map(function (r) {
        return {
          bank: r.bank_name,
          contact_name: r.contact_name,
          contact_phone: r.contact_phone,
          verdict: r.verdict,
          confidence: r.verdict === "eligible" ? "strong" : "possible",
          why: r.verdict === "eligible"
            ? "Meets every rule recorded for this lender."
            : "Breaks no recorded rule, but some of their policy isn't on file — confirm before applying.",
          watch_out: null,
          documents_needed: [],
          rule_notes: r.reasons || []
        };
      }),
      rejected: out.map(function (r) {
        return { bank: r.bank_name, reasons: r.reasons || [] };
      }),
      overall_advice: keep.length
        ? "Matched against " + (rows || []).length + " lender desks using the policy rules in your database."
        : "No lender on file matches this profile as entered.",
      disclaimer: "Indicative only, based on 2024 policy notes. Final approval is the lender's decision."
    };
  }

  /**
   * Two routes to a result, tried in order:
   *
   *   1. the match-banks Edge Function — SQL filtering plus Gemini
   *      reading the policy text and writing an explanation
   *   2. calling match_banks() straight from the browser — same SQL,
   *      same verdicts, no written explanations
   *
   * Route 2 exists because the Edge Function is the fragile part: it
   * has to be deployed, have JWT verification off, and hold a working
   * Gemini key. The database function needs none of that. Losing the
   * explanations is a much smaller loss than losing the matching.
   */
  async function runBankMatch(profile) {
    var url = window.MATCH_FUNCTION_URL;

    if (url) {
      try {
        var res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + (window.SUPABASE_ANON_KEY || "")
          },
          body: JSON.stringify({ profile: profile })
        });
        if (res.ok) return await res.json();
        console.info("match-banks function returned HTTP " + res.status + " — using the database directly instead.");
      } catch (e) {
        console.info("match-banks function unreachable (" + (e.message || e) + ") — using the database directly instead.");
      }
    }

    // Fall back to the SQL function.
    if (!supabaseClient) {
      return { error: "Not connected to Supabase." };
    }

    var rpc = await supabaseClient.rpc("match_banks", { p_application: profile });
    if (rpc.error) {
      return {
        error: "Couldn't run the match: " + (rpc.error.message || "unknown error") +
               " (has supabase/10_bank_policy_schema.sql been run?)"
      };
    }
    if (!rpc.data || rpc.data.length === 0) {
      return {
        error: "No lender policies are loaded yet. Import policy_import.csv and run " +
               "supabase/12_import_fanout.sql, then try again."
      };
    }

    var shaped = shapeRpcRows(rpc.data);
    shaped.note = "Rule-based match. Deploy the match-banks function for written explanations.";
    return shaped;
  }

  function confidenceClass(c) {
    if (c === "strong") return "conf conf-strong";
    if (c === "weak") return "conf conf-weak";
    return "conf conf-possible";
  }

  function renderMatches(result) {
    var statusEl = $("match-status");
    var listEl = $("match-results");

    if (result.error) {
      statusEl.innerHTML = '<div class="error-msg">' + escapeHtml(result.error) +
        " Your application was saved — an advisor will review it manually.</div>";
      listEl.innerHTML = "";
      return;
    }

    var matches = result.matches || [];
    var rejected = result.rejected || [];

    if (matches.length === 0) {
      statusEl.innerHTML = '<div class="error-msg">' +
        escapeHtml(result.overall_advice ||
          "No lender on file matches this profile as entered.") + "</div>";
    } else {
      statusEl.innerHTML =
        '<div class="match-head"><strong>' + matches.length + " lender" +
        (matches.length === 1 ? "" : "s") + " worth approaching</strong>" +
        (result.overall_advice ? '<p class="muted">' + escapeHtml(result.overall_advice) + "</p>" : "") +
        "</div>";
    }

    var html = matches.map(function (m) {
      var docs = (m.documents_needed || []).map(function (d) {
        return '<span class="doc-chip">' + escapeHtml(d) + "</span>";
      }).join("");

      return '<div class="match-card">' +
        '<div class="match-card-top">' +
          "<h4>" + escapeHtml(m.bank || "") + "</h4>" +
          '<span class="' + confidenceClass(m.confidence) + '">' + escapeHtml(m.confidence || "possible") + "</span>" +
        "</div>" +
        (m.why ? "<p>" + escapeHtml(m.why) + "</p>" : "") +
        (m.watch_out ? '<p class="match-watch"><strong>Watch out:</strong> ' + escapeHtml(m.watch_out) + "</p>" : "") +
        (docs ? '<div class="doc-chips">' + docs + "</div>" : "") +
        ((m.rule_notes && m.rule_notes.length)
          ? '<ul class="rule-notes">' + m.rule_notes.map(function (r) {
              return "<li>" + escapeHtml(r) + "</li>";
            }).join("") + "</ul>"
          : "") +
        (m.contact_name
          ? '<div class="match-contact mono">Desk: ' + escapeHtml(m.contact_name) +
            (m.contact_phone ? " · " + escapeHtml(m.contact_phone) : "") + "</div>"
          : "") +
        "</div>";
    }).join("");

    // "Why not" is often more useful to an advisor than "why yes".
    if (rejected.length) {
      html += '<details class="rejected-block"><summary>' + rejected.length +
        " lender" + (rejected.length === 1 ? "" : "s") + " ruled out — see why</summary>" +
        rejected.map(function (r) {
          return '<div class="rejected-row"><strong>' + escapeHtml(r.bank) + "</strong>" +
            '<span class="muted">' + escapeHtml((r.reasons || []).join("; ")) + "</span></div>";
        }).join("") + "</details>";
    }

    if (result.disclaimer) {
      html += '<p class="fine-print">' + escapeHtml(result.disclaimer) + "</p>";
    }

    listEl.innerHTML = html;
  }

  function showPostSubmit(ref) {
    $("apply-form").classList.add("hidden");
    $("post-submit").classList.remove("hidden");
    $("submitted-ref").textContent = ref;
    $("match-status").innerHTML = '<div class="match-loading">Checking your details against every lender policy on file…</div>';
    $("match-results").innerHTML = "";
  }

  function initPostSubmit() {
    $("start-new-application").addEventListener("click", function () {
      $("post-submit").classList.add("hidden");
      $("apply-form").classList.remove("hidden");
      showMsg($("apply-msg"), "");
      resetApplicationForm();
    });
  }

  function initSubmit() {
    $("submit-application").addEventListener("click", async function () {
      var msgEl = $("apply-msg");
      showMsg(msgEl, "");

      if (!supabaseClient) {
        showMsg(msgEl, "This app isn't connected to Supabase yet. Edit js/config.js (see README.txt).", "error");
        return;
      }

      var data = collectFormData();
      if (!data.personal.name || !data.personal.phone) {
        showMsg(msgEl, "Full name and phone number are required.", "error");
        goToStep("personal");
        return;
      }
      if (!data.loan.type) {
        showMsg(msgEl, "Please select a loan type.", "error");
        goToStep("loan");
        return;
      }
      if (!$("r-consent").checked) {
        showMsg(msgEl, "Please confirm the consent checkbox before submitting.", "error");
        goToStep("review");
        return;
      }

      var userId = currentUserId();
      if (!userId) {
        showMsg(msgEl, "You've been signed out. Please sign in again.", "error");
        return;
      }

      var submitBtn = $("submit-application");
      submitBtn.disabled = true;
      submitBtn.textContent = "Submitting…";

      var result = await supabaseClient.rpc("submit_application", {
        p_user_id: userId,
        p_ref: currentRef,
        p_personal: data.personal,
        p_employment: data.employment,
        p_loan: data.loan,
        p_documents: draftDocuments
      });

      submitBtn.disabled = false;
      submitBtn.textContent = "Submit application";

      if (result.error) {
        showMsg(msgEl, "Could not submit your application: " + (result.error.message || "please try again."), "error");
        return;
      }

      var submittedRef = currentRef;
      showPostSubmit(submittedRef);
      loadApplications();
      renderOverview();

      var matchResult = await runBankMatch(buildMatchProfile(data));
      renderMatches(matchResult);

      // Keep the recommendation on the application row so an advisor can
      // see what was suggested and when. Optional: this quietly does
      // nothing until supabase/30_application_matches.sql has been run.
      if (!matchResult.error && result.data && result.data.id) {
        supabaseClient.rpc("save_application_matches", {
          p_application_id: result.data.id,
          p_matches: matchResult
        }).then(function (r) {
          if (r.error) console.info("Match results not saved (run supabase/30_application_matches.sql to enable).");
        });
      }
    });
  }

  // ---------- load / list applications ----------
  async function loadApplications() {
    var userId = currentUserId();
    if (!userId || !supabaseClient) { allApplications = []; return allApplications; }
    var result = await supabaseClient.rpc("get_applications", { p_user_id: userId });
    if (result.error) {
      console.error("Could not load applications:", result.error.message);
      allApplications = [];
      return allApplications;
    }
    allApplications = (result.data || []).map(function (row) {
      return {
        id: row.id,
        ref: row.ref,
        personal: row.personal || {},
        employment: row.employment || {},
        loan: row.loan || {},
        documents: row.documents || [],
        status: row.status,
        createdAt: new Date(row.created_at).getTime()
      };
    });
    return allApplications;
  }

  function statusBadgeClass(status) {
    if (status === "Submitted") return "badge status-submitted";
    if (status === "In review") return "badge status-review";
    return "badge";
  }

  function renderApplicationsList() {
    var container = $("applications-container");
    var q = ($("applications-search").value || "").toLowerCase();
    var list = allApplications.filter(function (a) {
      if (!q) return true;
      return (a.loan.type || "").toLowerCase().indexOf(q) >= 0 ||
             (a.ref || "").toLowerCase().indexOf(q) >= 0;
    });
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-state">No applications yet. Start one from "New Application".</div>';
      return;
    }
    var table = document.createElement("table");
    table.className = "register";
    table.innerHTML = "<thead><tr><th>Reference</th><th>Loan type</th><th>Amount</th><th>Status</th><th>Documents</th><th>Submitted</th></tr></thead>";
    var tbody = document.createElement("tbody");
    list.forEach(function (a) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="mono">' + escapeHtml(a.ref) + "</td>" +
        "<td>" + escapeHtml(a.loan.type || "") + "</td>" +
        '<td class="mono">' + fmtMoney(a.loan.amount) + "</td>" +
        "<td><span class=\"" + statusBadgeClass(a.status) + "\">" + escapeHtml(a.status) + "</span></td>" +
        "<td>" + (a.documents ? a.documents.length : 0) + "</td>" +
        '<td style="font-size:11px;color:var(--muted);">' + fmtDate(a.createdAt) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
  }

  function initApplicationsTab() {
    $("applications-refresh").addEventListener("click", async function () {
      await loadApplications();
      renderApplicationsList();
    });
    $("applications-search").addEventListener("input", renderApplicationsList);
  }

  // ---------- overview ----------
  async function renderOverview() {
    var apps = await loadApplications();
    var statsRow = $("stats-row");
    statsRow.innerHTML =
      statCard(apps.length, "Total applications") +
      statCard(apps.filter(function (a) { return a.status === "Submitted"; }).length, "Submitted") +
      statCard(apps.filter(function (a) { return a.status === "In review"; }).length, "In review");

    var recentEl = $("overview-recent");
    if (apps.length === 0) {
      recentEl.innerHTML = '<div class="empty-state">No applications yet. Start your first one from "New Application".</div>';
      return;
    }
    var recent = apps.slice(0, 3);
    recentEl.innerHTML = recent.map(function (a) {
      return '<div class="rs-row" style="padding:8px 0;"><span>' + escapeHtml(a.ref) + " — " + escapeHtml(a.loan.type || "") +
        '</span><span><span class="' + statusBadgeClass(a.status) + '">' + escapeHtml(a.status) + "</span></span></div>";
    }).join("");
  }

  function statCard(num, label) {
    return '<div class="stat-card"><div class="num">' + num + '</div><div class="label">' + escapeHtml(label) + "</div></div>";
  }

  function initOverviewTab() {
    $("overview-refresh").addEventListener("click", renderOverview);
  }

  async function resetForNewSession() {
    currentRef = genRef();
    $("app-ref").textContent = currentRef;
    draftDocuments = [];
    renderDocList();
    showMsg($("apply-msg"), "");
    $("post-submit").classList.add("hidden");
    $("apply-form").classList.remove("hidden");
    goToStep("personal");
    await renderOverview();
    await loadApplications();
    renderApplicationsList();
  }

  function init() {
    initStepNav();
    initDocuments();
    initSubmit();
    initPostSubmit();
    initApplicationsTab();
    initOverviewTab();
  }

  return { init: init, resetForNewSession: resetForNewSession };
})();