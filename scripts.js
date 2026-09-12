"use strict";

// =============================================================================
// Appointment Chat (dv build) — locked PIN gate, then a WhatsApp-native shell.
// =============================================================================

var DV_GAS_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";
var DV_PIN_PREFIX = "0000";
var DV_STATUS_CSV_URL = "PASTE_YOUR_PUBLISHED_STATUS_CSV_URL_HERE";
var DV_ACCENTS = ["#1877F2", "#7C3AED", "#16A34A", "#0D9488", "#EA580C", "#DC2626", "#DB2777", "#4F46E5", "#D97706", "#475569"];

function $(id) { return document.getElementById(id); }

var dvState = {
  role: null,            // "guest" | "mog" | null
  activeTab: "home",
  guestMessages: [], guestTyping: false,
  mogChats: [], activeThreadPin: null, threadMessages: [], threadTyping: false,
  mogGateTapCount: 0,
  inThread: false
};
var dvGuestPollTimer = null, dvThreadPollTimer = null, dvInboxPollTimer = null, dvMogTapResetTimer = null;
var dvIsTabActive = true;
var dvDb = null;
var dvDeferredInstallPrompt = null;

window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  dvDeferredInstallPrompt = e;
});

document.addEventListener("visibilitychange", function () {
  dvIsTabActive = !document.hidden;
  if (dvIsTabActive) {
    if (dvState.role === "guest" && dvState.activeTab === "chat") dvGuestStartPolling();
    if (dvState.role === "mog" && dvState.inThread) dvThreadStartPolling();
    if (dvState.role === "mog" && (dvState.activeTab === "mog" || dvState.activeTab === "chat") && !dvState.inThread) dvInboxStartPolling();
  }
});

// ---------------- tokens ----------------
function dvGuestGetToken() { return localStorage.getItem("dv_guest_token"); }
function dvGuestSetToken(t) { localStorage.setItem("dv_guest_token", t); }
function dvGuestClearToken() { localStorage.removeItem("dv_guest_token"); }
function dvMogGetToken() { return localStorage.getItem("dv_mog_token"); }
function dvMogSetToken(t) { localStorage.setItem("dv_mog_token", t); }
function dvMogClearToken() { localStorage.removeItem("dv_mog_token"); }

// ---------------- IndexedDB message cache ----------------
function dvOpenDb() {
  return new Promise(function (resolve, reject) {
    if (dvDb) return resolve(dvDb);
    var req = indexedDB.open("dv_cache", 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "key" });
    };
    req.onsuccess = function () { dvDb = req.result; resolve(dvDb); };
    req.onerror = function () { reject(req.error); };
  });
}
function dvDbGet(key) {
  return dvOpenDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction("chats", "readonly");
      var req = tx.objectStore("chats").get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { resolve(null); };
    });
  });
}
function dvDbSet(key, data) {
  return dvOpenDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction("chats", "readwrite");
      tx.objectStore("chats").put(Object.assign({ key: key }, data));
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
    });
  });
}
function dvDbDelete(key) {
  return dvOpenDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction("chats", "readwrite");
      tx.objectStore("chats").delete(key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { resolve(false); };
    });
  });
}

// ---------------- overlays ----------------
function dvShowSpinner() { $("dvSpinnerOverlay").classList.remove("dv-hidden"); }
function dvHideSpinner() { $("dvSpinnerOverlay").classList.add("dv-hidden"); }
function dvShowToast(message) {
  $("dvToast").textContent = message;
  $("dvToastOverlay").classList.remove("dv-hidden");
  setTimeout(function () { $("dvToastOverlay").classList.add("dv-hidden"); }, 2600);
}

// ---------------- API ----------------
function dvApiCall(action, extra, token) {
  extra = extra || {};
  if (!DV_GAS_URL || DV_GAS_URL.indexOf("PASTE_YOUR") !== -1) {
    console.error("Appointment Chat: DV_GAS_URL is not configured.");
    return Promise.resolve({ ok: false, error: "This app isn't ready yet. Please check back soon." });
  }
  var body = Object.assign({ action: action }, extra);
  if (token !== undefined) body.token = token;
  return fetch(DV_GAS_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) })
    .then(function (resp) {
      return resp.json().catch(function (err) {
        console.error("Appointment Chat: unreadable server response.", err);
        return { ok: false, error: "Something went wrong. Please try again." };
      });
    })
    .catch(function (err) {
      console.error("Appointment Chat: network error.", err);
      return { ok: false, error: "You appear to be offline. Please check your connection and try again." };
    });
}

// =============================================================================
// PREFERENCES (accent / dark mode / font scale) — device-local, applied on boot
// =============================================================================

function dvApplyAccent(hex) { document.documentElement.style.setProperty("--dv-accent", hex); localStorage.setItem("dv_accent", hex); }
function dvApplyDark(on) { document.documentElement.setAttribute("data-dv-theme", on ? "dark" : "light"); localStorage.setItem("dv_dark", on ? "1" : "0"); }
function dvApplyFontScale(v) { document.documentElement.style.setProperty("--dv-font-scale", v); localStorage.setItem("dv_font_scale", v); }

function dvLoadPreferences() {
  var accent = localStorage.getItem("dv_accent");
  if (accent) dvApplyAccent(accent);
  var dark = localStorage.getItem("dv_dark") === "1";
  dvApplyDark(dark);
  var scale = localStorage.getItem("dv_font_scale");
  if (scale && parseFloat(scale) < 1) scale = "1";
  if (scale) dvApplyFontScale(scale);
}

// =============================================================================
// INIT / ROUTING
// =============================================================================

function dvInit() {
  dvLoadPreferences();
  dvBindGateEvents();
  dvBindShellEvents();
  dvBindSidebarEvents();
  dvBindThreadEvents();
  dvBindPageEvents();

  var mogToken = dvMogGetToken();
  var guestToken = dvGuestGetToken();

  if (mogToken) {
    dvShowSpinner();
    dvApiCall("mogMe", {}, mogToken).then(function (res) {
      dvHideSpinner();
      if (res.ok) { dvState.role = "mog"; dvEnterShell(); } else { dvMogClearToken(); dvRouteToGate(); }
    });
  } else if (guestToken) {
    dvShowSpinner();
    dvApiCall("me", {}, guestToken).then(function (res) {
      dvHideSpinner();
      if (res.ok) { dvState.role = "guest"; dvEnterShell(); } else { dvGuestClearToken(); dvRouteToGate(); }
    });
  } else {
    dvRouteToGate();
  }
}

function dvRouteToGate() {
  $("dvShell").classList.add("dv-hidden");
  $("dvThreadScreen").classList.add("dv-hidden");
  $("dvGate").classList.remove("dv-hidden");
  dvCheckGateStatus();
}

function dvEnterShell() {
  $("dvGate").classList.add("dv-hidden");
  $("dvThreadScreen").classList.add("dv-hidden");
  $("dvShell").classList.remove("dv-hidden");
  dvSwitchTab("home");
}

// ---------------- gate status (zero-quota published CSV) ----------------
function dvCheckGateStatus() {
  if (!DV_STATUS_CSV_URL || DV_STATUS_CSV_URL.indexOf("PASTE_YOUR") !== -1) return;
  fetch(DV_STATUS_CSV_URL).then(function (r) { return r.text(); }).then(function (csv) {
    var lines = csv.trim().split("\n");
    var dataLine = lines[lines.length > 1 ? 1 : 0];
    var cols = dataLine.split(",").map(function (c) { return c.replace(/^"|"$/g, "").trim(); });
    var state = (cols[0] || "OPEN").toUpperCase();
    if (state === "LOCKED") {
      $("dvGateDefault").classList.add("dv-hidden");
      $("dvGateLocked").classList.remove("dv-hidden");
      $("dvTickerText").textContent = cols[1] || "Not accepting new PINs right now.";
      $("dvTickerReopens").textContent = cols[2] ? ("Reopens: " + cols[2]) : "";
    } else {
      $("dvGateDefault").classList.remove("dv-hidden");
      $("dvGateLocked").classList.add("dv-hidden");
    }
  }).catch(function () {});
}

// =============================================================================
// GATE / PIN ENTRY (appearance never changes)
// =============================================================================

function dvBindGateEvents() {
  $("dvBtnEnter").addEventListener("click", dvHandleEnterPin);
  var parts = [$("dvPinPart1"), $("dvPinPart2"), $("dvPinPart3")];
  parts.forEach(function (input, idx) {
    input.addEventListener("input", function () {
      input.value = input.value.replace(/[^0-9]/g, "");
      if (input.value.length === 4 && idx < parts.length - 1) parts[idx + 1].focus();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") dvHandleEnterPin();
      if (e.key === "Backspace" && input.value === "" && idx > 0) parts[idx - 1].focus();
    });
  });
  $("dvGateLockIcon").addEventListener("click", function () {
    clearTimeout(dvMogTapResetTimer);
    dvState.mogGateTapCount++;
    if (dvState.mogGateTapCount >= 4) {
      dvState.mogGateTapCount = 0;
      $("dvMogReveal").classList.remove("dv-hidden");
    } else {
      dvMogTapResetTimer = setTimeout(function () { dvState.mogGateTapCount = 0; }, 2000);
    }
  });
  document.querySelectorAll("[data-page]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var page = this.dataset.page;
      if (["schedule", "about", "terms"].indexOf(page) !== -1) dvOpenPage(page);
    });
  });
  $("dvBtnRequestCode").addEventListener("click", dvHandleRequestMogCode);
  $("dvBtnVerifyCode").addEventListener("click", dvHandleVerifyMogCode);
}

function dvDeviceLabel() {
  var ua = navigator.userAgent;
  var label = "Android device";
  if (/Pixel/i.test(ua)) label = "Pixel phone";
  else if (/SM-/i.test(ua)) label = "Samsung phone";
  return label + " \u2014 " + new Date().toLocaleDateString();
}

function dvHandleEnterPin() {
  var raw = $("dvPinPart1").value + $("dvPinPart2").value + $("dvPinPart3").value;
  if (raw.length !== 12) { $("dvGateMessage").textContent = "Enter the full 12-digit PIN."; return; }
  if (raw.indexOf(DV_PIN_PREFIX) !== 0) { $("dvGateMessage").textContent = "PIN not recognized."; return; }

  $("dvGateMessage").textContent = "";
  var btn = $("dvBtnEnter");
  var original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="dv-btn-spinner"></span> Verifying...';
  dvShowSpinner();

  dvApiCall("verifyPin", { pin: raw, deviceName: dvDeviceLabel() }).then(function (res) {
    dvHideSpinner();
    if (res.ok && res.token) {
      dvGuestSetToken(res.token);
      dvState.role = "guest";
      dvEnterShell();
    } else if (res.locked) {
      dvCheckGateStatus();
      $("dvGateMessage").textContent = res.error || "Not accepting new PINs right now.";
    } else {
      $("dvGateMessage").textContent = res.error || "PIN not recognized.";
    }
  }).finally(function () { btn.disabled = false; btn.innerHTML = original; });
}

// ---------------- Man of God auth (from hidden gate gesture) ----------------
var dvMogOtpNonce = null;

function dvHandleRequestMogCode() {
  var btn = $("dvBtnRequestCode");
  btn.disabled = true;
  dvShowSpinner();
  dvApiCall("requestMogCode", {}).then(function (res) {
    dvHideSpinner(); btn.disabled = false;
    if (res.ok) {
      dvMogOtpNonce = res.nonce;
      $("dvMogStepRequest").classList.add("dv-hidden");
      $("dvMogStepVerify").classList.remove("dv-hidden");
      dvShowToast("Code sent. Check your email.");
    } else dvShowToast(res.error || "Could not send code.");
  });
}

function dvHandleVerifyMogCode() {
  var code = $("dvMogCodeInput").value.trim();
  if (code.length !== 6) { dvShowToast("Enter the 6-digit code."); return; }
  var btn = $("dvBtnVerifyCode");
  var original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="dv-btn-spinner"></span> Verifying...';
  dvShowSpinner();

  dvApiCall("verifyMogCode", { nonce: dvMogOtpNonce, code: code }).then(function (res) {
    dvHideSpinner(); btn.disabled = false; btn.innerHTML = original;
    if (res.ok && res.token) {
      dvMogSetToken(res.token);
      $("dvMogCodeInput").value = "";
      $("dvMogStepVerify").classList.add("dv-hidden");
      $("dvMogStepRequest").classList.remove("dv-hidden");
      $("dvMogReveal").classList.add("dv-hidden");
      dvState.role = "mog";
      dvEnterShell();
    } else dvShowToast(res.error || "Incorrect code.");
  });
}

// =============================================================================
// SHELL / TAB ROUTING
// =============================================================================

function dvBindShellEvents() {
  document.querySelectorAll(".dv-nav-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { dvSwitchTab(this.dataset.tab); });
  });
  $("dvSearchInput").addEventListener("input", function () { dvApplySearchFilter(this.value); });
}

function dvApplySearchFilter(query) {
  query = (query || "").trim().toLowerCase();
  var list = $("dvInboxList");
  if (!list) return; // guest's single row / other tabs: nothing to filter
  list.querySelectorAll(".dv-list-row").forEach(function (row) {
    var name = (row.querySelector(".dv-list-name") || {}).textContent || "";
    row.classList.toggle("dv-hidden", query.length > 0 && name.toLowerCase().indexOf(query) === -1);
  });
}

function dvSwitchTab(tab) {
  dvState.activeTab = tab;
  document.querySelectorAll(".dv-nav-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tab); });
  if (dvInboxPollTimer) clearTimeout(dvInboxPollTimer);
  if (dvGuestPollTimer) clearTimeout(dvGuestPollTimer);
  $("dvSearchInput").value = "";

  if (tab === "home") { $("dvHeader2").classList.add("dv-hidden"); dvRenderHome(); }
  else if (tab === "chat") { $("dvHeader2").classList.remove("dv-hidden"); dvRenderChatOrInbox(); }
  else if (tab === "mog") { $("dvHeader2").classList.toggle("dv-hidden", dvState.role !== "mog"); dvRenderMogTab(); }
  else if (tab === "more") { $("dvHeader2").classList.add("dv-hidden"); dvRenderMore(); }
}

function dvInitialsFor(name, pin) {
  if (name) return name.trim().slice(0, 2).toUpperCase();
  return (pin || "??").slice(-2);
}
function dvRelativeTime(ts) {
  if (!ts) return "";
  var d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}

// ---------------- HOME ----------------
function dvRenderHome() {
  $("dvTabBody").innerHTML =
    '<div class="dv-home-hero">' +
      '<div class="dv-home-hero-banner">' +
        '<img class="dv-home-hero-img" src="YOUR_PHOTO_URL_HERE" alt="" />' +
        '<div class="dv-home-hero-name">Reverend [Your Name]</div>' +
        '<div class="dv-home-hero-role">Man of God \u00b7 Trainer &amp; Researcher \u00b7 Developer</div>' +
      '</div>' +
    '</div>' +
    '<div class="dv-quick-actions">' +
      '<button class="dv-quick-action" id="dvQaChat"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span><span>Chat Now</span></button>' +
      '<button class="dv-quick-action" id="dvQaSchedule"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg></span><span>Schedule</span></button>' +
      '<button class="dv-quick-action" id="dvQaAbout"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg></span><span>Learn More</span></button>' +
    '</div>';
  $("dvQaChat").addEventListener("click", function () { dvSwitchTab("chat"); });
  $("dvQaSchedule").addEventListener("click", function () { dvOpenPage("schedule"); });
  $("dvQaAbout").addEventListener("click", function () { dvOpenLeftSidebar(); });
}

// ---------------- CHAT tab (guest: 1 row \u00b7 mog: same as inbox) ----------------
function dvRenderChatOrInbox() {
  if (dvState.role === "mog") { dvRenderMogInboxInto($("dvTabBody"), false); return; }
  dvRenderGuestSingleRow();
}

function dvRenderGuestSingleRow() {
  var container = $("dvTabBody");
  dvApiCall("me", {}, dvGuestGetToken()).then(function (res) {
    var name = res.ok ? (res.personName || "Man of God") : "Man of God";
    container.innerHTML =
      '<div class="dv-list-row" id="dvGuestRow">' +
        '<div class="dv-avatar">' + dvInitialsFor(name, "") + '</div>' +
        '<div class="dv-list-main"><div class="dv-list-name">' + dvEscapeHtml(name) + '</div><div class="dv-list-sub">Tap to continue your appointment chat</div></div>' +
        '<button class="dv-chat-pill">Chat</button>' +
      '</div>' +
      '<div class="dv-encrypt-note"><span class="dv-icon" style="width:14px;height:14px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span>This appointment chat is private between you and the Man of God.</div>';
    $("dvGuestRow").addEventListener("click", function () {
      dvOpenThread({ pin: "self", personName: name, role: "guest" });
    });
  });
  dvApiCall("getChat", {}, dvGuestGetToken()).then(function (res) {
    if (!res.ok) return;
    var messages = res.messages || [];
    var last = messages[messages.length - 1];
    var lastSeen = parseInt(localStorage.getItem("dv_lastseen_guest") || "0", 10);
    var unread = last && last.role === "mog" && last.createdAt > lastSeen;
    dvSetChatBadge(unread ? 1 : 0);
  });
}

// ---------------- MOG tab ----------------
function dvRenderMogTab() {
  var container = $("dvTabBody");
  if (dvState.role !== "mog") {
    container.innerHTML =
      '<div class="dv-mog-locked">' +
        '<span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span>' +
        '<div>This section is reserved for the Man of God.</div>' +
      '</div>';
    return;
  }
  dvRenderMogInboxInto(container, true);
}

function dvRenderMogInboxInto(container, showTools) {
  container.innerHTML = '<div id="dvInboxList"></div>';
  var header2 = $("dvHeader2");
  var existingToolsBtn = $("dvMogToolsBtn");
  if (existingToolsBtn) existingToolsBtn.remove();
  if (showTools) {
    var toolsBtn = document.createElement("button");
    toolsBtn.id = "dvMogToolsBtn";
    toolsBtn.className = "dv-header-btn";
    toolsBtn.style.marginLeft = "auto";
    toolsBtn.innerHTML = '<span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg></span>';
    toolsBtn.addEventListener("click", dvOpenMogTools);
    header2.style.display = "flex";
    header2.style.alignItems = "center";
    header2.appendChild(toolsBtn);
  } else {
    header2.style.display = "";
    header2.style.alignItems = "";
  }
  dvLoadInbox();
  dvInboxStartPolling();
}

function dvLoadInbox() {
  dvApiCall("mogListChats", {}, dvMogGetToken()).then(function (res) {
    if (!res.ok) { if (res.error) dvShowToast(res.error); return; }
    dvState.mogChats = res.chats || [];
    dvRenderInboxList();
  });
}

function dvRenderInboxList() {
  var list = $("dvInboxList");
  if (!list) return;
  list.innerHTML = "";
  if (!dvState.mogChats.length) {
    list.innerHTML = '<div class="dv-list-empty">No conversations yet. Share a PIN to get started.</div>';
    dvSetChatBadge(0);
    return;
  }
  var unreadCount = 0;
  dvState.mogChats.forEach(function (chat) {
    var row = document.createElement("div");
    row.className = "dv-list-row";
    var lastSeen = parseInt(localStorage.getItem("dv_lastseen_" + chat.pin) || "0", 10);
    var isUnread = chat.lastRole === "user" && chat.updatedAt && chat.updatedAt > lastSeen;
    if (isUnread) unreadCount++;
    row.innerHTML =
      '<div class="dv-avatar">' + dvInitialsFor(chat.personName, chat.pin) + '</div>' +
      '<div class="dv-list-main"><div class="dv-list-name">' + dvEscapeHtml(chat.personName || ("PIN \u2022\u2022\u2022\u2022 " + chat.pin.slice(-4))) + (chat.terminated ? ' (logged out)' : '') + (isUnread ? ' \u25cf' : '') + '</div>' +
      '<div class="dv-list-sub">' + (chat.lastPreview ? dvEscapeHtml((chat.lastRole === "mog" ? "You: " : "") + chat.lastPreview) : "No messages yet") + '</div></div>' +
      '<button class="dv-chat-pill">Chat</button>' +
      '<button class="dv-list-dismiss" data-pin="' + chat.pin + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>';
    row.querySelector(".dv-chat-pill").addEventListener("click", function () { dvOpenThread({ pin: chat.pin, personName: chat.personName, role: "mog" }); });
    row.querySelector(".dv-list-dismiss").addEventListener("click", function (e) { e.stopPropagation(); dvHandleLogoutGuest(chat.pin); });
    list.appendChild(row);
  });
  dvSetChatBadge(unreadCount);
}

function dvSetChatBadge(count) {
  var badge = $("dvChatBadge");
  if (count > 0) { badge.textContent = count > 9 ? "9+" : String(count); badge.classList.remove("dv-hidden"); }
  else badge.classList.add("dv-hidden");
}

var dvLogoutArmedPin = null;
function dvHandleLogoutGuest(pin) {
  if (dvLogoutArmedPin !== pin) {
    dvLogoutArmedPin = pin;
    dvShowToast("Tap the X again to log this person out.");
    setTimeout(function () { if (dvLogoutArmedPin === pin) dvLogoutArmedPin = null; }, 3000);
    return;
  }
  dvLogoutArmedPin = null;
  dvApiCall("mogTerminateSession", { pin: pin }, dvMogGetToken()).then(function (res) {
    if (res.ok) { dvShowToast("Logged out."); dvLoadInbox(); } else dvShowToast(res.error || "Could not log that user out.");
  });
}

function dvInboxStartPolling() {
  if (dvInboxPollTimer) clearTimeout(dvInboxPollTimer);
  if (!dvIsTabActive || dvState.role !== "mog" || dvState.inThread || (dvState.activeTab !== "mog" && dvState.activeTab !== "chat")) return;
  dvLoadInbox();
  dvInboxPollTimer = setTimeout(dvInboxStartPolling, 6000);
}

// ---------------- MORE tab ----------------
function dvRenderMore() {
  $("dvTabBody").innerHTML = dvSettingsPanelHtml();
  dvBindSettingsPanel($("dvTabBody"));
}

// =============================================================================
// THREAD VIEW (guest's own chat, or MOG viewing one guest's chat)
// =============================================================================

function dvOpenThread(opts) {
  dvState.inThread = true;
  dvState.activeThreadPin = opts.pin;
  $("dvShell").classList.add("dv-hidden");
  $("dvThreadScreen").classList.remove("dv-hidden");
  $("dvThreadAvatar").textContent = dvInitialsFor(opts.personName, opts.pin);
  $("dvThreadTitle").textContent = opts.personName || "Man of God";
  $("dvThreadSub").textContent = "";
  $("dvBtnThreadKebab").classList.toggle("dv-hidden", opts.role !== "mog");

  var lastSeenKey = opts.role === "guest" ? "dv_lastseen_guest" : "dv_lastseen_" + opts.pin;
  localStorage.setItem(lastSeenKey, String(Date.now()));
  dvSetChatBadge(0);

  if (opts.role === "guest") dvLoadGuestThread();
  else dvLoadMogThread(opts.pin);
}

function dvLoadGuestThread() {
  dvDbGet("guest:self").then(function (cached) {
    if (cached && cached.messages) { dvState.threadMessages = cached.messages; dvRenderThreadMessages("user"); dvScrollBottom(); }
    dvApiCall("getChat", {}, dvGuestGetToken()).then(function (res) {
      if (res.ok) {
        dvState.threadMessages = res.messages || [];
        dvRenderThreadMessages("user"); dvScrollBottom();
        dvDbSet("guest:self", { messages: dvState.threadMessages, updatedAt: res.updatedAt });
      }
    });
  });
  dvGuestStartPolling();
}

function dvLoadMogThread(pin) {
  var key = "mog:" + pin;
  dvDbGet(key).then(function (cached) {
    if (cached && cached.messages) { dvState.threadMessages = cached.messages; dvRenderThreadMessages("mog"); dvScrollBottom(); }
    dvApiCall("mogGetChat", { pin: pin }, dvMogGetToken()).then(function (res) {
      if (res.ok) {
        dvState.threadMessages = res.messages || [];
        dvRenderThreadMessages("mog"); dvScrollBottom();
        dvDbSet(key, { messages: dvState.threadMessages, updatedAt: res.updatedAt });
      }
    });
  });
  dvThreadStartPolling();
}

function dvGuestStartPolling() {
  if (dvGuestPollTimer) clearTimeout(dvGuestPollTimer);
  if (!dvIsTabActive || dvState.role !== "guest" || !dvState.inThread) return;
  dvApiCall("syncState", { typing: dvState.threadTyping }, dvGuestGetToken()).then(function (res) {
    if (!res.ok) return;
    $("dvThreadTyping").classList.toggle("dv-hidden", !res.peerTyping);
    dvDbGet("guest:self").then(function (cached) {
      var known = cached ? cached.updatedAt : null;
      if (res.chatUpdatedAt && res.chatUpdatedAt !== known) {
        dvApiCall("getChat", {}, dvGuestGetToken()).then(function (chatRes) {
          if (chatRes.ok) {
            dvState.threadMessages = chatRes.messages || [];
            dvRenderThreadMessages("user"); dvScrollBottom();
            dvDbSet("guest:self", { messages: dvState.threadMessages, updatedAt: chatRes.updatedAt });
            localStorage.setItem("dv_lastseen_guest", String(Date.now()));
          }
        });
      }
    });
  }).finally(function () {
    if (dvIsTabActive && dvState.inThread) dvGuestPollTimer = setTimeout(dvGuestStartPolling, dvState.threadTyping ? 3000 : 6000);
  });
}

function dvThreadStartPolling() {
  if (dvThreadPollTimer) clearTimeout(dvThreadPollTimer);
  if (!dvIsTabActive || dvState.role !== "mog" || !dvState.inThread) return;
  var pin = dvState.activeThreadPin;
  dvApiCall("mogSyncThread", { pin: pin, typing: dvState.threadTyping }, dvMogGetToken()).then(function (res) {
    if (!res.ok) return;
    $("dvThreadTyping").classList.toggle("dv-hidden", !res.peerTyping);
    var key = "mog:" + pin;
    dvDbGet(key).then(function (cached) {
      var known = cached ? cached.updatedAt : null;
      if (res.chatUpdatedAt && res.chatUpdatedAt !== known) {
        dvApiCall("mogGetChat", { pin: pin }, dvMogGetToken()).then(function (chatRes) {
          if (chatRes.ok) {
            dvState.threadMessages = chatRes.messages || [];
            dvRenderThreadMessages("mog"); dvScrollBottom();
            dvDbSet(key, { messages: dvState.threadMessages, updatedAt: chatRes.updatedAt });
            localStorage.setItem("dv_lastseen_" + pin, String(Date.now()));
          }
        });
      }
    });
  }).finally(function () {
    if (dvIsTabActive && dvState.inThread) dvThreadPollTimer = setTimeout(dvThreadStartPolling, dvState.threadTyping ? 3000 : 6000);
  });
}

function dvEscapeHtml(str) { var d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML; }
function dvRenderThreadMessages(mineRole) {
  var container = $("dvThreadMessages");
  container.innerHTML = "";
  dvState.threadMessages.forEach(function (msg) {
    var wrap = document.createElement("div");
    wrap.className = "dv-msg " + (msg.role === mineRole ? "dv-msg-mine" : "dv-msg-theirs");
    var bubble = document.createElement("div");
    bubble.className = "dv-bubble";
    bubble.textContent = msg.content;
    if (msg.failed) { bubble.style.opacity = "0.55"; bubble.title = "Not sent \u2014 tap to retry"; }
    wrap.appendChild(bubble);
    if (msg.createdAt) {
      var time = document.createElement("div");
      time.className = "dv-msg-time";
      time.textContent = new Date(msg.createdAt).toLocaleString() + (msg.failed ? " \u00b7 not sent" : "");
      wrap.appendChild(time);
    }
    container.appendChild(wrap);
  });
}
function dvScrollBottom() { var el = $("dvThreadMessages"); el.scrollTop = el.scrollHeight; }

function dvAutoGrow(el) { el.style.height = "auto"; var max = window.innerHeight * 0.30; el.style.height = Math.min(el.scrollHeight, max) + "px"; }

function dvBindThreadEvents() {
  $("dvThreadSend").addEventListener("click", dvHandleThreadSend);
  $("dvThreadInput").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); dvHandleThreadSend(); } });
  $("dvThreadInput").addEventListener("input", function () { dvAutoGrow(this); dvState.threadTyping = this.value.trim().length > 0; });
  $("dvBtnThreadBack").addEventListener("click", function () {
    dvState.inThread = false;
    if (dvThreadPollTimer) clearTimeout(dvThreadPollTimer);
    if (dvGuestPollTimer) clearTimeout(dvGuestPollTimer);
    $("dvThreadScreen").classList.add("dv-hidden");
    $("dvShell").classList.remove("dv-hidden");
    dvSwitchTab(dvState.activeTab);
  });
  $("dvBtnThreadKebab").addEventListener("click", function () { dvHandleLogoutGuest(dvState.activeThreadPin); });
}

function dvHandleThreadSend() {
  var input = $("dvThreadInput");
  var text = input.value.trim();
  if (!text) return;
  input.value = ""; dvAutoGrow(input); dvState.threadTyping = false;
  var sendBtn = $("dvThreadSend");
  sendBtn.disabled = true;

  if (dvState.role === "guest") {
    var optimistic = { role: "user", content: text, createdAt: Date.now() };
    dvState.threadMessages.push(optimistic);
    dvRenderThreadMessages("user"); dvScrollBottom();
    dvApiCall("sendMessage", { content: text }, dvGuestGetToken()).then(function (res) {
      if (!res.ok) { optimistic.failed = true; dvRenderThreadMessages("user"); dvShowToast(res.error || "Message could not be sent."); }
      else dvDbSet("guest:self", { messages: dvState.threadMessages, updatedAt: res.message.createdAt });
    }).finally(function () { sendBtn.disabled = false; });
  } else {
    var pin = dvState.activeThreadPin;
    var optimisticM = { role: "mog", content: text, createdAt: Date.now() };
    dvState.threadMessages.push(optimisticM);
    dvRenderThreadMessages("mog"); dvScrollBottom();
    dvApiCall("mogSendMessage", { pin: pin, content: text }, dvMogGetToken()).then(function (res) {
      if (!res.ok) { optimisticM.failed = true; dvRenderThreadMessages("mog"); dvShowToast(res.error || "Message could not be sent."); }
      else dvDbSet("mog:" + pin, { messages: dvState.threadMessages, updatedAt: res.message.createdAt });
    }).finally(function () { sendBtn.disabled = false; });
  }
}

// =============================================================================
// MAN OF GOD TOOLS (lock/ticker, hide presence, sign out) — reached via the
// tools icon shown only on the MOG tab.
// =============================================================================

function dvOpenMogTools() {
  dvApiCall("mogGetStatus", {}, dvMogGetToken()).then(function (res) {
    var status = res.ok ? res.status : { state: "OPEN", message: "", reopensAt: "" };
    var hidePresence = res.ok ? res.hidePresence : false;

    dvOpenPageRaw("Man of God Tools",
      '<div class="dv-toggle-row" style="margin-bottom:14px;"><div><strong>Pause new PINs</strong><div style="font-size:0.8rem;color:var(--dv-text-secondary);">Hides the PIN field and shows a message instead</div></div><button id="dvToggleLock" class="dv-switch ' + (status.state === "LOCKED" ? "on" : "") + '"></button></div>' +
      '<div class="dv-settings-label">Message shown while paused</div>' +
      '<textarea id="dvLockMessage" rows="2" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--dv-border);background:var(--dv-bg-elevated);color:var(--dv-text);">' + dvEscapeHtml(status.message) + '</textarea>' +
      '<div class="dv-settings-label" style="margin-top:14px;">Reopens (optional)</div>' +
      '<input id="dvLockReopens" type="text" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--dv-border);background:var(--dv-bg-elevated);color:var(--dv-text);" value="' + dvEscapeHtml(status.reopensAt) + '" />' +
      '<div class="dv-toggle-row" style="margin-top:18px;"><div><strong>Hide typing / online / read</strong><div style="font-size:0.8rem;color:var(--dv-text-secondary);">Turns off presence signals in both directions</div></div><button id="dvToggleHidePresence" class="dv-switch ' + (hidePresence ? "on" : "") + '"></button></div>' +
      '<button id="dvBtnSaveStatus" class="dv-btn dv-btn-primary" style="margin-top:22px;">Save</button>' +
      '<button id="dvBtnMogLogout" class="dv-btn dv-btn-text" style="margin-top:12px;color:var(--dv-danger);">Sign out this device</button>'
    );

    var lockState = status.state === "LOCKED", presenceState = !!hidePresence;
    $("dvToggleLock").addEventListener("click", function () { lockState = !lockState; this.classList.toggle("on", lockState); });
    $("dvToggleHidePresence").addEventListener("click", function () { presenceState = !presenceState; this.classList.toggle("on", presenceState); });
    $("dvBtnSaveStatus").addEventListener("click", function () {
      dvShowSpinner();
      dvApiCall("mogSetStatus", { state: lockState ? "LOCKED" : "OPEN", message: $("dvLockMessage").value.trim(), reopensAt: $("dvLockReopens").value.trim(), hidePresence: presenceState }, dvMogGetToken())
        .then(function (res) { dvHideSpinner(); if (res.ok) { dvShowToast("Saved."); dvClosePage(); } else dvShowToast(res.error || "Could not save."); });
    });
    $("dvBtnMogLogout").addEventListener("click", function () {
      dvShowSpinner();
      dvApiCall("mogLogout", {}, dvMogGetToken()).then(function () {
        dvHideSpinner(); dvMogClearToken(); dvClosePage(); dvState.role = null; dvRouteToGate();
      });
    });
  });
}

// =============================================================================
// SIDEBARS
// =============================================================================

function dvBindSidebarEvents() {
  $("dvBtnLeftSidebar").addEventListener("click", dvOpenLeftSidebar);
  $("dvLeftBackdrop").addEventListener("click", dvCloseLeftSidebar);
  $("dvBtnExitLeftSidebar").addEventListener("click", dvCloseLeftSidebar);
  document.querySelectorAll("#dvLeftSidebar [data-page]").forEach(function (btn) {
    btn.addEventListener("click", function () { dvCloseLeftSidebar(); dvOpenPage(this.dataset.page); });
  });
  $("dvBtnRightSidebar").addEventListener("click", dvOpenRightSidebar);
  $("dvRightBackdrop").addEventListener("click", dvCloseRightSidebar);
}
function dvOpenLeftSidebar() { $("dvLeftBackdrop").classList.remove("dv-hidden"); $("dvLeftSidebar").classList.remove("dv-hidden"); }
function dvCloseLeftSidebar() { $("dvLeftBackdrop").classList.add("dv-hidden"); $("dvLeftSidebar").classList.add("dv-hidden"); }
function dvOpenRightSidebar() {
  $("dvRightSidebarBody").innerHTML = dvSettingsPanelHtml();
  dvBindSettingsPanel($("dvRightSidebarBody"));
  $("dvRightBackdrop").classList.remove("dv-hidden"); $("dvRightSidebar").classList.remove("dv-hidden");
}
function dvCloseRightSidebar() { $("dvRightBackdrop").classList.add("dv-hidden"); $("dvRightSidebar").classList.add("dv-hidden"); }

// ---------------- shared settings panel (right sidebar + More tab) ----------------
function dvSettingsPanelHtml() {
  var currentAccent = localStorage.getItem("dv_accent") || DV_ACCENTS[0];
  var dark = localStorage.getItem("dv_dark") === "1";
  var scale = localStorage.getItem("dv_font_scale") || "1";
  var swatches = DV_ACCENTS.map(function (c) {
    return '<button class="dv-accent-swatch' + (c.toLowerCase() === currentAccent.toLowerCase() ? " selected" : "") + '" style="background:' + c + ';" data-color="' + c + '"></button>';
  }).join("");

  return (
    '<div class="dv-settings-block"><div class="dv-settings-label">Profile</div><div class="dv-profile-info">Loading...</div></div>' +
    '<div class="dv-settings-block"><div class="dv-settings-label">Accent Color</div><div class="dv-accent-grid">' + swatches + '</div></div>' +
    '<div class="dv-settings-block"><div class="dv-settings-label">Font Size</div><div class="dv-font-row"><span style="font-size:0.75rem;">A</span><input class="dv-font-slider" type="range" min="1" max="1.3" step="0.05" value="' + scale + '" /><span style="font-size:1.1rem;">A</span></div></div>' +
    '<div class="dv-settings-block"><div class="dv-toggle-row"><span>Dark Mode</span><button class="dv-switch dv-toggle-dark ' + (dark ? "on" : "") + '"></button></div></div>' +
    '<div class="dv-settings-block"><button class="dv-settings-btn dv-btn-install"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></span>Install App</button></div>' +
    '<div class="dv-settings-block"><button class="dv-settings-btn dv-btn-share"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line></svg></span>Share App</button></div>'
  );
}

function dvBindSettingsPanel(scope) {
  var profileEl = scope.querySelector(".dv-profile-info");
  if (dvState.role === "mog") {
    dvApiCall("mogMe", {}, dvMogGetToken()).then(function (res) { profileEl.textContent = res.ok ? ("Man of God \u00b7 " + res.email) : "Signed out"; });
  } else if (dvState.role === "guest") {
    dvApiCall("me", {}, dvGuestGetToken()).then(function (res) { profileEl.textContent = res.ok ? (res.personName || "Guest") : "Session ended"; });
  } else profileEl.textContent = "Not signed in";

  scope.querySelectorAll(".dv-accent-swatch").forEach(function (sw) {
    sw.addEventListener("click", function () {
      dvApplyAccent(this.dataset.color);
      scope.querySelectorAll(".dv-accent-swatch").forEach(function (s) { s.classList.remove("selected"); });
      this.classList.add("selected");
    });
  });
  var fontSlider = scope.querySelector(".dv-font-slider");
  if (fontSlider) fontSlider.addEventListener("input", function () { dvApplyFontScale(this.value); });
  var darkToggle = scope.querySelector(".dv-toggle-dark");
  if (darkToggle) darkToggle.addEventListener("click", function () {
    var on = !this.classList.contains("on");
    this.classList.toggle("on", on);
    dvApplyDark(on);
  });
  var installBtn = scope.querySelector(".dv-btn-install");
  if (installBtn) installBtn.addEventListener("click", function () {
    if (!dvDeferredInstallPrompt) { dvShowToast("Already installed, or your browser doesn't support this."); return; }
    dvDeferredInstallPrompt.prompt();
    dvDeferredInstallPrompt.userChoice.then(function () { dvDeferredInstallPrompt = null; });
  });
  var shareBtn = scope.querySelector(".dv-btn-share");
  if (shareBtn) shareBtn.addEventListener("click", function () {
    if (navigator.share) {
      navigator.share({ title: "Appointment Chat", url: location.href }).catch(function () {});
    } else {
      navigator.clipboard.writeText(location.href).then(function () { dvShowToast("Link copied."); }).catch(function () { dvShowToast("Could not share or copy the link."); });
    }
  });
}

// =============================================================================
// FULL-PAGE CONTENT (About / Terms / Schedule / sidebar info pages)
// =============================================================================

var DV_PAGES = {
  "about": { title: "About", html: null }, // alias, filled below
  "about-app": {
    title: "About this App",
    html: "<h3>About this App</h3><p>Appointment Chat is a private, appointment-only chat space. Access is by PIN, granted individually, with no public sign-up.</p>"
  },
  "about-mog": {
    title: "About the Man of God",
    html: '<div class="dv-profile-wrap"><div class="dv-profile-hero">' +
      '<div class="dv-profile-ring"><img class="dv-profile-img" src="YOUR_PHOTO_URL_HERE" alt="" /></div>' +
      '<h2 class="dv-profile-name">Reverend [Your Name]</h2>' +
      '<span class="dv-profile-role">Prophet of God \u00b7 Founder &amp; Visionary \u00b7 Trainer &amp; Researcher \u00b7 Full Stack Developer</span>' +
      '</div><div class="dv-profile-body">' +
      '<div class="dv-text-card">' +
      '<div class="dv-text-card-title">About Our<br>Founder</div>' +
      '<div id="dvBioText" class="dv-profile-bio">Our Founder is an ordained Reverend Minister of the Lord Jesus Christ, a multifaceted personality with a PhD in Christian Education and Philosophy, serving as a trainer, researcher, and theologian dedicated to online counseling.</div>' +
      '<button id="dvBioBtn" class="dv-bio-toggle">Show more</button>' +
      '</div>' +
      '<div class="dv-action-group">' +       
     '<a href="PASTE_YOUR_PORTFOLIO_LINK_HERE" target="_blank" class="dv-pill-btn dv-pill-solid"><span style="text-decoration: underline;">View Portfolio</span></a>' +
      '<a href="PASTE_YOUR_WHATSAPP_LINK_HERE" target="_blank" class="dv-pill-btn dv-pill-green"><span class="dv-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span><span style="text-decoration: underline;">Follow WhatsApp Channel</span></a>' +
      '</div>' +
      '<div class="dv-stats-card"><div class="dv-stats-grid">' +
      '<div class="dv-stat-item"><div class="dv-stat-num">70+</div><div class="dv-stat-label">Nations</div></div>' +
      '<div class="dv-stat-item"><div class="dv-stat-num">100+</div><div class="dv-stat-label">Apps</div></div>' +
      '<div class="dv-stat-item"><div class="dv-stat-num">100%</div><div class="dv-stat-label">Passionate</div></div>' +
      '</div></div></div></div>'
  },
  "mission": {
    title: "About Mission",
    html: "<h3>Our Mission</h3><p>Dedicated to online counseling and ministry, reaching people wherever they are, with a private appointment-based chat that respects everyone's time and privacy.</p>"
  },
  "terms": {
    title: "Terms of Use",
    html: '<h3>Terms of Use</h3><div class="dv-info-list">' +
      '<div class="dv-info-row"><span class="dv-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></span><span class="dv-info-text">Access to this chat is by appointment only, granted at the sole discretion of the Man of God.</span></div>' +
      '<div class="dv-info-row"><span class="dv-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><circle cx="12" cy="16" r="1.5"></circle><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg></span><span class="dv-info-text">PINs are personal and single-use per session.</span></div>' +
      '<div class="dv-info-row"><span class="dv-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"></line></svg></span><span class="dv-info-text">Access may be terminated at any time without notice.</span></div>' +
      '<div class="dv-info-row"><span class="dv-info-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><line x1="10" y1="12" x2="14" y2="12"></line></svg></span><span class="dv-info-text">Conversations are retained for the Man of God\u2019s records.</span></div>' +
      '</div>'
  },
  "proprietary": {
    title: "Proprietary Software Notice",
    html: "<h3>Proprietary Software Notice</h3><p>This application and its source code are proprietary. Unauthorized copying, redistribution, or reverse engineering is not permitted.</p>"
  },
  "schedule": {
    title: "Appointment",
    html: '<h3>Schedule an Appointment</h3><p>Reach out through any of the channels below to request your appointment PIN.</p>' +
      '<a href="mailto:PASTE_YOUR_EMAIL_HERE" class="dv-contact-row-item"><span class="dv-contact-icon-circle dv-btn-email"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"></path><polyline points="22,6 12,13 2,6"></polyline></svg></span><span><div class="dv-contact-btn-title">Email</div><div class="dv-contact-btn-sub">Send a message</div></span></a>' +
      '<a href="PASTE_YOUR_FACEBOOK_LINK_HERE" target="_blank" class="dv-contact-row-item"><span class="dv-contact-icon-circle dv-btn-fb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"></path></svg></span><span><div class="dv-contact-btn-title">Facebook</div><div class="dv-contact-btn-sub">Message us</div></span></a>' +
      '<a href="PASTE_YOUR_WHATSAPP_LINK_HERE" target="_blank" class="dv-contact-row-item"><span class="dv-contact-icon-circle dv-btn-wa"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg></span><span><div class="dv-contact-btn-title">WhatsApp</div><div class="dv-contact-btn-sub">Chat instantly</div></span></a>' +
      '<a href="tel:PASTE_YOUR_PHONE_HERE" class="dv-contact-row-item"><span class="dv-contact-icon-circle dv-btn-phone"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"></path></svg></span><span><div class="dv-contact-btn-title">Phone</div><div class="dv-contact-btn-sub">Call directly</div></span></a>'
  }
};
DV_PAGES["about"] = DV_PAGES["about-mog"]; // gate's "About" link = About the Man of God

function dvBindPageEvents() { $("dvBtnClosePage").addEventListener("click", dvClosePage); }
function dvOpenPage(key) {
  var page = DV_PAGES[key];
  if (!page) return;
  dvOpenPageRaw(page.title, page.html);
  if (key === "about-mog" || key === "about") {
    $("dvPageBody").classList.add("dv-page-flush");
    var bioBtn = $("dvBioBtn"), bioText = $("dvBioText");
    if (bioBtn && bioText) bioBtn.addEventListener("click", function () {
      bioText.classList.toggle("expanded");
      bioBtn.textContent = bioText.classList.contains("expanded") ? "Show less" : "Show more";
    });
  }
}
function dvOpenPageRaw(title, html) {
  $("dvPageTitle").textContent = title;
  $("dvPageBody").innerHTML = html;
  $("dvPageBody").classList.remove("dv-page-flush");
  $("dvPageOverlay").classList.remove("dv-hidden");
}
function dvClosePage() { $("dvPageOverlay").classList.add("dv-hidden"); }

// ---------------- service worker ----------------
function dvRegisterServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function () {});
}

document.addEventListener("DOMContentLoaded", function () { dvInit(); dvRegisterServiceWorker(); });
