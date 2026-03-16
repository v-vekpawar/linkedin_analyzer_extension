/**
 * LinkedIn Profile Analyzer — Side Panel Script  v3.2
 *
 * Bug 2 fix: side panel directly watches chrome.tabs.onUpdated
 *            instead of relying on background relay (which was
 *            unreliable due to service worker termination).
 * Bug 4 fix: listens for "requestClose" from background and calls
 *            window.close(); sends "panelClosed" on unload.
 */

"use strict";

const BACKEND_URL = "http://localhost:5000/analyze";

// ── State ─────────────────────────────────────────────────────────
let currentProfileData = null;
let currentUserId = null;
let currentUrl = "";
let linkedInTabId = null;   // the specific LinkedIn tab this panel serves

// ── DOM refs ──────────────────────────────────────────────────────
const views = {
  "no-profile": document.getElementById("view-no-profile"),
  "idle": document.getElementById("view-idle"),
  "loading": document.getElementById("view-loading"),
  "results": document.getElementById("view-results"),
  "error": document.getElementById("view-error"),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle("active", k === name);
  });
}

// ── Tabs ──────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel-body").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`)?.classList.add("active");
  });
});

// ── Button listeners ──────────────────────────────────────────────
document.getElementById("refresh-btn").addEventListener("click", initPanel);
document.getElementById("retry-btn").addEventListener("click", runAnalysis);
document.getElementById("re-analyze-btn").addEventListener("click", runAnalysis);
document.getElementById("analyze-btn").addEventListener("click", runAnalysis);

// ── Copy / Send ───────────────────────────────────────────────────
document.addEventListener("click", e => {
  const copyBtn = e.target.closest(".copy-btn");
  if (copyBtn) {
    navigator.clipboard.writeText(decodeAttr(copyBtn.dataset.text)).then(() => {
      copyBtn.textContent = "✓";
      setTimeout(() => { copyBtn.innerHTML = copyIcon(); }, 1600);
    });
  }
  const sendBtn = e.target.closest(".send-btn");
  if (sendBtn) {
    navigator.clipboard.writeText(decodeAttr(sendBtn.dataset.text)).then(() => {
      sendBtn.textContent = "✓";
      setTimeout(() => { sendBtn.innerHTML = sendIcon(); }, 2000);
    });
  }
});

// ─────────────────────────────────────────────────────────────────
//  TAB RESOLUTION
//  Side panel has "tabs" permission so it can query directly.
//  NEVER use { currentWindow: true } — that resolves to the side
//  panel's own detached window, not the LinkedIn tab.
// ─────────────────────────────────────────────────────────────────
function resolveLinkedInTab() {
  return new Promise(resolve => {
    // Try the cached tab first
    if (linkedInTabId !== null) {
      chrome.tabs.get(linkedInTabId, tab => {
        if (chrome.runtime.lastError || !tab?.url?.includes("linkedin.com")) {
          linkedInTabId = null;
          resolveLinkedInTab().then(resolve);
        } else {
          resolve(tab);
        }
      });
      return;
    }
    // Query across ALL windows (not just currentWindow)
    chrome.tabs.query({ url: "*://*.linkedin.com/*" }, tabs => {
      if (!tabs.length) { resolve(null); return; }
      // Prefer the active tab among LinkedIn tabs
      const active = tabs.find(t => t.active) || tabs[0];
      linkedInTabId = active.id;
      resolve(active);
    });
  });
}

function fetchPageInfo() {
  return resolveLinkedInTab().then(tab => {
    if (!tab?.id) return null;
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { action: "getPageInfo" }, resp => {
        if (chrome.runtime.lastError) { resolve(null); }
        else { resolve(resp); }
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────
//  NAVIGATION DETECTION  (v3.3 fix)
//
//  Instead of guessing timing with chrome.tabs.onUpdated (which fires
//  multiple times per LinkedIn SPA navigation and can have stale URLs),
//  the content script now signals us:
//    "profileReady"  — profile <h1> is confirmed in the DOM; extract now
//    "pageChanged"   — navigated to a non-profile page
//
//  This eliminates all race conditions and fixed-delay guesswork.
// ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  // Store the LinkedIn tab ID whenever it's relayed from background
  if (msg.tabId) linkedInTabId = msg.tabId;

  if (msg.action === "profileReady") {
    // DOM is confirmed ready — fetch and display immediately, no retry needed
    fetchPageInfo().then(info => {
      if (info?.profileData?.name && info.profileData.name !== "Unknown") {
        applyProfileData(info);
      } else {
        // Fallback: profile signalled ready but extraction returned empty —
        // run the full initPanel which has its own short retry loop
        initPanel();
      }
    });
  }

  if (msg.action === "pageChanged") {
    // Non-profile page — show the "prospecting" screen immediately
    currentProfileData = null;
    showView("no-profile");
  }

  if (msg.action === "requestClose") {
    window.close();
  }
});

// ─────────────────────────────────────────────────────────────────
//  INIT PANEL  (retry loop for SPA DOM timing)
// ─────────────────────────────────────────────────────────────────
const DOM_RETRIES = 15;
const DOM_RETRY_MS = 800;

async function initPanel() {
  showView("loading");

  // Step 1: get page type
  let info = await fetchPageInfo();
  if (!info) {
    await sleep(1500);
    info = await fetchPageInfo();
    if (!info) { showView("no-profile"); return; }
  }

  currentUrl = info.url || "";

  if (!info.isProfilePage) {
    currentProfileData = null;
    showView("no-profile");
    return;
  }

  // Step 2: profile page confirmed — wait for DOM to render
  for (let i = 0; i < DOM_RETRIES; i++) {
    const data = await fetchPageInfo();
    if (data?.profileData?.name && data.profileData.name !== "Unknown") {
      applyProfileData(data);
      return;
    }
    await sleep(DOM_RETRY_MS);
  }

  showView("no-profile");
}

function applyProfileData(info) {
  currentProfileData = info.profileData || null;
  currentUserId = info.userId || "";
  currentUrl = info.url || currentUrl;

  const name = currentProfileData?.name || "Unknown";
  const headline = currentProfileData?.headline || "";

  document.getElementById("idle-avatar").textContent = name[0].toUpperCase();
  document.getElementById("idle-name").textContent = name;
  document.getElementById("idle-headline").textContent = headline;
  showView("idle");
}

// ─────────────────────────────────────────────────────────────────
//  RUN ANALYSIS
// ─────────────────────────────────────────────────────────────────
async function runAnalysis() {
  if (!currentProfileData) {
    await initPanel();
    if (!currentProfileData) return;
  }
  showView("loading");
  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_data: currentProfileData,
        profile_url: currentUrl,
        user_id: currentUserId || "",
      }),
    });
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    renderResults(await response.json());
    showView("results");
  } catch (err) {
    document.getElementById("error-msg").textContent =
      `Analysis failed: ${err.message}. Is the backend running at localhost:5000?`;
    showView("error");
  }
}

// ─────────────────────────────────────────────────────────────────
//  RENDER RESULTS
// ─────────────────────────────────────────────────────────────────
function renderResults(result) {
  const about = result.about_profile || {};
  const appr = result.approach_person || {};
  const compat = result.compatibility_score || null;
  const name = result.profile_name || currentProfileData?.name || "Profile";

  document.getElementById("res-avatar").textContent = name[0].toUpperCase();
  document.getElementById("res-name").textContent = name;
  document.getElementById("res-headline").textContent = currentProfileData?.headline || "";

  const analysisEl = document.getElementById("panel-analysis");
  analysisEl.innerHTML = "";

  if (result.cached) {
    analysisEl.insertAdjacentHTML("beforeend",
      `<div class="cached-note"><span class="cached-dot"></span>Cached result</div>`);
  }

  if (compat) {
    const score = typeof compat.compatibility_score === "number" ? compat.compatibility_score : "—";
    const whyItems = (compat.why || []).map(r => `<li>${esc(r)}</li>`).join("");
    analysisEl.insertAdjacentHTML("beforeend", `
      <div class="card card-compat">
        <h4>🎯 Compatibility Score</h4>
        <div class="compat-gauge"><div class="compat-score">${score}%</div></div>
        ${compat.recommendation ? `<p class="compat-rec">${esc(compat.recommendation)}</p>` : ""}
        ${whyItems ? `<ul class="compat-list">${whyItems}</ul>` : ""}
      </div>`);
  }

  if (about.seniority_level) {
    analysisEl.insertAdjacentHTML("beforeend",
      `<span class="badge">${esc(about.seniority_level)} Level</span>`);
  }
  if (about.who_they_are) {
    analysisEl.insertAdjacentHTML("beforeend", card("Who They Are", `<p>${esc(about.who_they_are)}</p>`));
  }
  if (about.what_they_specialize_in) {
    analysisEl.insertAdjacentHTML("beforeend", card("Specialization", `<p>${esc(about.what_they_specialize_in)}</p>`));
  }
  if (about.key_strengths?.length) {
    const chips = about.key_strengths.map(s => `<span class="chip">${esc(s)}</span>`).join("");
    analysisEl.insertAdjacentHTML("beforeend", card("Key Strengths", `<div class="chips">${chips}</div>`));
  }
  if (about.career_trajectory) {
    analysisEl.insertAdjacentHTML("beforeend", card("Career Trajectory", `<p>${esc(about.career_trajectory)}</p>`));
  }
  if (about.potential_talking_points) {
    analysisEl.insertAdjacentHTML("beforeend",
      card("💡 Talking Points", `<p>${esc(about.potential_talking_points)}</p>`, "card-highlight"));
  }

  const approachEl = document.getElementById("panel-approach");
  approachEl.innerHTML = "";

  if (appr.outreach_angles?.length) {
    const angles = appr.outreach_angles.map(a => `
      <div class="angle">
        <strong>${esc(a.angle_type || "")}</strong>
        <p>${esc(a.explanation || "")}</p>
      </div>`).join("");
    approachEl.insertAdjacentHTML("beforeend", card("Outreach Angles", angles));
  }

  if (appr.personalized_messages) {
    const msgs = Object.entries(appr.personalized_messages).filter(([, v]) => v?.length);
    if (msgs.length) {
      const blocks = msgs.map(([k, v]) => `
        <div class="msg-block">
          <div class="msg-label">${esc(k.replace(/_/g, " "))}</div>
          <div class="msg-body">
            <p>${esc(v)}</p>
            <div class="msg-actions">
              <button class="action-btn copy-btn" data-text="${escAttr(v)}" title="Copy">${copyIcon()}</button>
              <button class="action-btn send-btn" data-text="${escAttr(v)}" title="Copy">${sendIcon()}</button>
            </div>
          </div>
        </div>`).join("");
      approachEl.insertAdjacentHTML("beforeend", card("Message Templates", blocks));
    }
  }
}

// Notify background when panel unloads (Bug 4 fix)
window.addEventListener("unload", () => {
  chrome.runtime.sendMessage({ action: "panelClosed", tabId: linkedInTabId }).catch(() => { });
});

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}
function escAttr(str) {
  return (str || "")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeAttr(str) {
  return (str || "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function card(title, body, extraClass = "") {
  return `<div class="card ${extraClass}"><h4>${title}</h4>${body}</div>`;
}
function copyIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}
function sendIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────

// Find our LinkedIn tab first, then initialize
resolveLinkedInTab().then(tab => {
  if (tab) linkedInTabId = tab.id;
  initPanel();
});