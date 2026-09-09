/* app.js
   Wires everything together: screen switching, dashboard tabs, and startup.
   Loaded last so Storage, Auth, Dashboard, and Assistant already exist.
*/
var App = (function () {
  function $(id) { return document.getElementById(id); }

  function showScreen(name) {
    ["login", "signup", "forgot"].forEach(function (s) {
      $("screen-" + s).classList.toggle("hidden", s !== name);
    });
    $("screen-dashboard").classList.toggle("hidden", name !== "dashboard");
    $("assistant-fab").classList.toggle("hidden", name !== "dashboard");
    if (name !== "dashboard") {
      $("assistant-drawer").classList.remove("open");
    }
  }

  function enterDashboard() {
    var user = Auth.getCurrentUser();
    if (!user) {
      // Safety net: if we somehow got here without a signed-in user, send
      // them back to the login screen instead of showing a broken dashboard.
      showScreen("login");
      return;
    }
    $("who-name").textContent = user.name;
    showScreen("dashboard");
    switchDashboardTab("overview");
    Dashboard.resetForNewSession();
  }

  function switchDashboardTab(name) {
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    ["overview", "apply", "applications"].forEach(function (t) {
      $("tab-" + t).classList.toggle("hidden", t !== name);
    });
  }

  function initDashboardTabs() {
    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { switchDashboardTab(btn.dataset.tab); });
    });
  }

  async function init() {
    initDashboardTabs();
    await initSupabaseClient();
    Auth.init();
    Dashboard.init();
    Assistant.init();

    // If the user already has a valid Supabase session (e.g. they
    // refreshed the page, or came back later), skip straight to the
    // dashboard instead of making them log in again.
    var existingUser = await Auth.restoreSession();
    if (existingUser) {
      enterDashboard();
    } else {
      showScreen("login");
    }
  }

  return {
    init: init,
    showScreen: showScreen,
    enterDashboard: enterDashboard
  };
})();

// This script tag is loaded at the very end of <body>, so the DOM is
// already fully parsed and available by the time this file runs. Calling
// init() directly (rather than waiting for a "DOMContentLoaded" listener,
// which can fire before such a listener gets attached) avoids a startup
// race that previously made every button silently do nothing.
App.init();
