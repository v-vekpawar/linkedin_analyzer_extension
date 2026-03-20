// LinkedIn Profile Analyzer Side Panel Script.
// Responsible for rendering profile metadata dynamically within extension side panels directly.

"use strict";

// Declares the primary backend server endpoint.
const BACKEND_URL = "http://localhost:5000/analyze";
// const BACKEND_URL = "https://your-render-app-url.onrender.com/analyze"; // Replace with your Render URL

// Maintains active panel states globally within local tracking scopes.
let currentProfileData = null;
let currentUserId = null;
let currentUrl = "";
let linkedInTabId = null;
let isOwnProfile = false;

// Maps standard HTML sections explicitly onto internal constants respectively.
const views = {
  "no-profile": document.getElementById("view-no-profile"),
  "idle": document.getElementById("view-idle"),
  "loading": document.getElementById("view-loading"),
  "results": document.getElementById("view-results"),
  "error": document.getElementById("view-error"),
};

// Toggles active CSS states rendering requested views iteratively seamlessly.
function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle("active", k === name);
  });
}

// Binds internal tab components responding appropriately handling interactive elements seamlessly.
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel-body").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`)?.classList.add("active");
  });
});

// Attaches click handlers explicitly binding buttons onto designated analysis properties.
document.getElementById("refresh-btn").addEventListener("click", initPanel);
document.getElementById("retry-btn").addEventListener("click", runAnalysis);
document.getElementById("re-analyze-btn").addEventListener("click", runAnalysis);
document.getElementById("analyze-btn").addEventListener("click", runAnalysis);

// Listens broadly supporting intuitive copy/send clipboard functionalities seamlessly.
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

// Queries actively resolving relevant LinkedIn tabs robustly circumventing context isolation errors properly.
function resolveLinkedInTab() {
  return new Promise(resolve => {
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
    chrome.tabs.query({ url: "*://*.linkedin.com/*" }, tabs => {
      if (!tabs.length) { resolve(null); return; }
      const active = tabs.find(t => t.active) || tabs[0];
      linkedInTabId = active.id;
      resolve(active);
    });
  });
}

// Passes standard page context queries targeting active tab contexts directly internally safely.
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

// Responds robustly rendering internal UI changes conditionally matching relayed content properties conditionally.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.tabId) linkedInTabId = msg.tabId;

  if (msg.action === "profileReady") {
    fetchPageInfo().then(info => {
      if (info?.profileData?.name && info.profileData.name !== "Unknown") {
        applyProfileData(info);
      } else {
        initPanel();
      }
    });
  }

  if (msg.action === "pageChanged") {
    currentProfileData = null;
    showView("no-profile");
  }

  if (msg.action === "requestClose") {
    window.close();
  }
});

// Tracks explicit DOM polling iterations resolving SPA latency cleanly locally automatically.
const DOM_RETRIES = 15;
const DOM_RETRY_MS = 800;

// Initializes primary states evaluating initial DOM structures robustly retrying consistently sequentially.
async function initPanel() {
  document.getElementById("loading-status").innerText = "Loading Profile Data...";
  showView("loading");

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

// Populates structural UI elements assigning generic properties retrieved accurately locally successfully.
function applyProfileData(info) {
  currentProfileData = info.profileData || null;
  currentUserId = info.userId || "";
  currentUrl = info.url || currentUrl;
  isOwnProfile = info.isOwnProfile || false;

  const name = currentProfileData?.name || "Unknown";
  const headline = currentProfileData?.headline || "";

  document.getElementById("idle-avatar").textContent = name[0].toUpperCase();
  document.getElementById("idle-name").textContent = name;
  document.getElementById("idle-headline").textContent = headline;
  showView("idle");
}

// Executes comprehensive API inquiries requesting parsed insight profiles formatting successfully actively organically.
async function runAnalysis() {
  document.getElementById("loading-status").innerText = "Analyzing Profile, this would take a few moments";
  showView("loading");

  let freshInfo = null;
  for (let i = 0; i < 5; i++) {
    freshInfo = await fetchPageInfo();
    if (freshInfo?.profileData?.name && freshInfo.profileData.name !== "Unknown") {
      break;
    }
    await sleep(800);
  }

  if (!freshInfo?.isProfilePage || !freshInfo?.profileData) {
    document.getElementById("error-msg").textContent =
      "Could not read profile data. Make sure you are on a LinkedIn profile page.";
    showView("error");
    return;
  }

  currentProfileData = freshInfo.profileData;
  currentUserId = freshInfo.userId || currentUserId || "";
  currentUrl = freshInfo.url || currentUrl;
  isOwnProfile = freshInfo.isOwnProfile || false;

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

// Constructs explicit internal HTML node trees assembling analytical scores dynamically.
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

  if (compat && !isOwnProfile) {
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

// Broadcasts graceful termination indicators closing loose contextual loops comprehensively.
window.addEventListener("unload", () => {
  chrome.runtime.sendMessage({ action: "panelClosed", tabId: linkedInTabId }).catch(() => { });
});

// Implements secure contextual filtering actively isolating user rendered variables flawlessly.
function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// Maps generic structural properties handling reserved DOM keywords correctly successfully.
function escAttr(str) {
  return (str || "")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Safely reconstructs mapped internal attribute replacements parsing native strings clearly.
function decodeAttr(str) {
  return (str || "")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Crafts dynamic HTML node injections returning organized card components safely.
function card(title, body, extraClass = "") {
  return `<div class="card ${extraClass}"><h4>${title}</h4>${body}</div>`;
}

// Returns inline SVG tags effectively drawing intuitive copy actions beautifully.
function copyIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

// Returns inline SVG fragments mapping generic arrow representations correctly nicely.
function sendIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
}

// Awaits sequentially with standard asynchronous setTimeout calls correctly pausing workflows predictability.
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Resolves generic LinkedIn elements gracefully opening panel behaviors organically cleanly.
resolveLinkedInTab().then(tab => {
  if (tab) linkedInTabId = tab.id;
  initPanel();
});