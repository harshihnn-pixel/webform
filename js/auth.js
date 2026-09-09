/* auth.js
   Handles account creation, sign in, and password reset by calling the
   RPC functions defined in supabase/schema.sql (signup_user, login_user,
   reset_password_user). This does NOT use Supabase Auth — there's no
   email confirmation step, and accounts are plain rows in the "users"
   table you can see in Supabase's Table Editor. Passwords are hashed
   in the database (see schema.sql) and never handled as plain text
   once submitted.

   Session handling: since there's no Supabase Auth session/token here,
   staying logged in across a page refresh is handled by remembering
   the logged-in user's id/name/email/phone in localStorage. This is
   fine for getting the app working quickly, but note it isn't a
   cryptographically verified session — anyone with direct access to
   that browser's storage could see who was last logged in. Good
   enough for an internal tool or early testing; ask if you want a
   more robust session approach later.
*/
var Auth = (function () {
  var currentUser = null; // { id, name, email, phone }
  var SESSION_KEY = "lp_session";

  function $(id) { return document.getElementById(id); }

  function showMsg(el, text, type) {
    el.innerHTML = text
      ? '<div class="' + (type === "error" ? "error-msg" : "success-msg") + '">' + escapeHtml(text) + "</div>"
      : "";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function notConfigured(el) {
    if (!supabaseClient) {
      var msg = "This app isn't connected to Supabase yet.";
      if (supabaseInitError === "library") {
        msg = "The Supabase library couldn't be loaded (likely a network, firewall, or browser extension blocking it). Check your internet connection and try refreshing.";
      } else if (supabaseInitError === "client") {
        msg = "Supabase is configured, but the connection failed to initialize. Double check the URL and key in js/config.js are copied correctly.";
      } else {
        msg = "This app isn't connected to Supabase yet. Edit js/config.js with your project's URL and publishable key (see README.txt).";
      }
      showMsg(el, msg, "error");
      return true;
    }
    return false;
  }

  // RPC errors from Postgres arrive as result.error.message — this
  // pulls out just the message we raised in schema.sql, since Supabase
  // sometimes wraps it with extra prefix text.
  function rpcErrorMessage(error, fallback) {
    if (!error) return fallback;
    return error.message || fallback;
  }

  function getCurrentUser() { return currentUser; }
  function setCurrentUser(user) {
    currentUser = user;
    try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch (e) {}
  }
  function logOut() {
    currentUser = null;
    try { window.localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  // Called once at startup to restore a session if the user already
  // had one (e.g. they refreshed the page or came back later).
  async function restoreSession() {
    try {
      var raw = window.localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var user = JSON.parse(raw);
      if (user && user.id) {
        currentUser = user;
        return user;
      }
    } catch (e) {}
    return null;
  }

  function init() {
    var forgotEmailFound = null;

    // Navigation between auth screens
    $("go-signup").addEventListener("click", function () {
      showMsg($("signup-msg"), "");
      App.showScreen("signup");
    });
    $("go-forgot").addEventListener("click", function () {
      resetForgotForm();
      App.showScreen("forgot");
    });
    $("go-login-from-signup").addEventListener("click", function () {
      showMsg($("login-msg"), "");
      App.showScreen("login");
    });
    $("go-login-from-forgot").addEventListener("click", function () {
      showMsg($("login-msg"), "");
      App.showScreen("login");
    });

    // Sign up
    $("signup-submit").addEventListener("click", async function () {
      var msgEl = $("signup-msg");
      showMsg(msgEl, "");
      if (notConfigured(msgEl)) return;

      var name = $("signup-name").value.trim();
      var email = $("signup-email").value.trim().toLowerCase();
      var phone = $("signup-phone").value.trim();
      var password = $("signup-password").value;

      if (!name || !email || !phone || !password) {
        showMsg(msgEl, "Please fill in all fields.", "error");
        return;
      }
      if (password.length < 6) {
        showMsg(msgEl, "Password should be at least 6 characters.", "error");
        return;
      }

      var btn = $("signup-submit");
      btn.disabled = true;
      btn.textContent = "Creating account…";
      var result = await supabaseClient.rpc("signup_user", {
        p_name: name, p_email: email, p_phone: phone, p_password: password
      });
      btn.disabled = false;
      btn.textContent = "Create account";

      if (result.error) {
        showMsg(msgEl, rpcErrorMessage(result.error, "Could not create the account."), "error");
        return;
      }

      setCurrentUser(result.data);
      App.enterDashboard();
    });

    // Sign in
    $("login-submit").addEventListener("click", async function () {
      var msgEl = $("login-msg");
      showMsg(msgEl, "");
      if (notConfigured(msgEl)) return;

      var email = $("login-email").value.trim().toLowerCase();
      var password = $("login-password").value;
      if (!email || !password) {
        showMsg(msgEl, "Enter your email and password.", "error");
        return;
      }

      var btn = $("login-submit");
      btn.disabled = true;
      btn.textContent = "Signing in…";
      var result = await supabaseClient.rpc("login_user", { p_email: email, p_password: password });
      btn.disabled = false;
      btn.textContent = "Sign in";

      if (result.error) {
        showMsg(msgEl, rpcErrorMessage(result.error, "Incorrect email or password."), "error");
        return;
      }

      setCurrentUser(result.data);
      App.enterDashboard();
    });

    ["login-email", "login-password"].forEach(function (id) {
      $(id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") $("login-submit").click();
      });
    });

    // Forgot password — no email is sent; confirming the account email
    // exists is enough to set a new password directly (see README.txt).
    function resetForgotForm() {
      showMsg($("forgot-msg"), "");
      $("forgot-email").value = "";
      $("forgot-new-password").value = "";
      $("forgot-step-1").classList.remove("hidden");
      $("forgot-step-2").classList.add("hidden");
      forgotEmailFound = null;
    }

    $("forgot-find").addEventListener("click", async function () {
      var msgEl = $("forgot-msg");
      showMsg(msgEl, "");
      if (notConfigured(msgEl)) return;

      var email = $("forgot-email").value.trim().toLowerCase();
      if (!email) {
        showMsg(msgEl, "Enter your account email.", "error");
        return;
      }

      var result = await supabaseClient.rpc("account_exists", { p_email: email });
      if (result.error) {
        showMsg(msgEl, rpcErrorMessage(result.error, "Could not look up that account right now."), "error");
        return;
      }
      if (!result.data) {
        showMsg(msgEl, "No account found with that email.", "error");
        return;
      }

      forgotEmailFound = email;
      $("forgot-step-1").classList.add("hidden");
      $("forgot-step-2").classList.remove("hidden");
    });

    $("forgot-reset").addEventListener("click", async function () {
      var msgEl = $("forgot-msg");
      var newPassword = $("forgot-new-password").value;
      if (!newPassword || newPassword.length < 6) {
        showMsg(msgEl, "Password should be at least 6 characters.", "error");
        return;
      }
      var result = await supabaseClient.rpc("reset_password_user", {
        p_email: forgotEmailFound, p_new_password: newPassword
      });
      if (result.error) {
        showMsg(msgEl, rpcErrorMessage(result.error, "Could not reset the password."), "error");
        return;
      }
      showMsg(msgEl, "Password updated. You can sign in now.", "success");
      setTimeout(function () {
        resetForgotForm();
        App.showScreen("login");
      }, 1200);
    });

    // Log out
    $("logout-btn").addEventListener("click", function () {
      logOut();
      App.showScreen("login");
    });
  }

  return {
    init: init,
    getCurrentUser: getCurrentUser,
    setCurrentUser: setCurrentUser,
    restoreSession: restoreSession,
    logOut: logOut
  };
})();
