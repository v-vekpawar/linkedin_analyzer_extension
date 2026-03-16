/**
 * LinkedIn Profile Analyzer — Content Script  v3.3
 *
 * Navigation fix: instead of the side panel guessing timing via
 * chrome.tabs.onUpdated (unreliable due to LinkedIn's multiple
 * pushState/replaceState calls per navigation), the content script
 * now patches the History API and uses a MutationObserver to watch
 * for the profile <h1> to actually render. Only then does it signal
 * the side panel — eliminating all race conditions.
 */

(() => {
  "use strict";

  const UI_PREFIX = "lia";
  const SAVE_PROFILE_URL = "http://localhost:5000/save-user-profile";

  let userId = null;
  let lastUrl = "";
  let navDebounce = null;
  let profileObserver = null; // MutationObserver watching for profile DOM

  // ── Extension validity ──────────────────────────────────────────
  function isExtensionValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ── URL helpers ─────────────────────────────────────────────────
  function isProfilePage(url) {
    return /linkedin\.com\/in\/[^/?#]+/.test(url);
  }
  function cleanUrl(url) {
    return url.split("?")[0].split("#")[0];
  }

  // ════════════════════════════════════════════════════════════════
  //  NAVIGATION DETECTION (v4.0 fix)
  //  Listens to background.js for reliable URL changes, plus
  //  a polling fallback to ensure we never miss an SPA navigation.
  // ════════════════════════════════════════════════════════════════
  function setupNavigationListener() {
    // 1. Fallback polling: check URL every 500ms
    setInterval(() => {
      const currentUrl = cleanUrl(window.location.href);
      if (currentUrl !== lastUrl) {
        scheduleNavCheck();
      }
    }, 500);

    // 3. Keep popstate for native back/forward button clicks
    window.addEventListener("popstate", scheduleNavCheck);
  }

  function scheduleNavCheck() {
    clearTimeout(navDebounce);
    navDebounce = setTimeout(handleNavigation, 300);
  }

  function handleNavigation() {
    const url = cleanUrl(window.location.href);
    if (url === lastUrl) return;
    lastUrl = url;

    // Stop any existing profile-DOM watcher
    if (profileObserver) { profileObserver.disconnect(); profileObserver = null; }

    if (!isExtensionValid()) return;

    if (isProfilePage(url)) {
      // Profile page: wait for the <h1> to actually render before signalling
      waitForProfileDOM(url);
    } else {
      // Non-profile page: signal immediately — no DOM wait needed
      chrome.runtime.sendMessage({ action: "pageChanged", url, isProfilePage: false }).catch(() => { });
    }
  }

  function waitForProfileDOM(url) {
    // Delay checking by 800ms to allow LinkedIn's SPA to unmount the previous page (e.g. Feed)
    setTimeout(() => {
      // Check immediately if DOM is already there
      if (trySignalProfileReady(url)) return;

      // Otherwise watch the DOM
      profileObserver = new MutationObserver(() => {
        if (trySignalProfileReady(url)) {
          profileObserver.disconnect();
          profileObserver = null;
        }
      });
      profileObserver.observe(document.body, { childList: true, subtree: true });

      // Safety timeout: if observer never fires after 8s, signal anyway
      setTimeout(() => {
        if (profileObserver) {
          profileObserver.disconnect();
          profileObserver = null;
          if (!isExtensionValid()) return;
          chrome.runtime.sendMessage({ action: "profileReady", url }).catch(() => { });
        }
      }, 8000);
    }, 800);
  }

  function findProfileName(allowTitleFallback = false) {
    // 1. Target the exact classes where LinkedIn puts the name, regardless of tag
    // This allows it to work even if React re-renders the name as an <h2> or <div> during SPA navigation
    const primaryTitle = document.querySelector(".pv-top-card .text-heading-xlarge, .pv-text-details__left-panel .text-heading-xlarge, .pv-top-card h1, h1.text-heading-xlarge");
    if (primaryTitle && primaryTitle.innerText.trim()) return primaryTitle.innerText.trim();

    // 2. Fallback: iterate over all H1s and H2s in the top card
    for (const el of document.querySelectorAll(".pv-top-card h1, .pv-top-card h2, .pv-text-details__left-panel h1, .pv-text-details__left-panel h2")) {
      // Skip screen-reader only headings
      if (el.classList.contains("visually-hidden")) continue;
      const text = el.innerText.trim();
      if (text) return text;
    }

    // 3. Bulletproof Fallback: extract from document title (e.g. "First Last | LinkedIn")
    if (allowTitleFallback && document.title && document.title.includes(" | LinkedIn")) {
       const titleName = document.title.split(" | LinkedIn")[0].replace(/^\(\d+\)\s*/, "").trim();
       if (titleName && titleName !== "LinkedIn" && titleName !== "Feed") return titleName;
    }

    return "";
  }

  function trySignalProfileReady(url) {
    // Crucial: Only rely on DOM elements to signal readiness, NOT the document title.
    // The title updates instantly on SPA navigation, but the DOM takes time.
    const name = findProfileName(false);
    if (!name) return false;

    if (!isExtensionValid()) return true; // stop observing but don't message
    chrome.runtime.sendMessage({ action: "profileReady", url }).catch(() => { });
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  FAB — on every LinkedIn page
  // ════════════════════════════════════════════════════════════════
  function injectFab() {
    if (!isExtensionValid()) return;
    if (document.getElementById(`${UI_PREFIX}-fab`)) return;

    const fab = document.createElement("button");
    fab.id = `${UI_PREFIX}-fab`;
    fab.title = "LinkedIn Profile Analyzer";
    const logoUrl = chrome.runtime.getURL("icons/logo.png");
    fab.innerHTML = `<img src="${logoUrl}" alt="Analyze" />`;

    fab.addEventListener("click", () => {
      if (!isExtensionValid()) return;
      chrome.runtime.sendMessage({ action: "openSidePanel" }).catch(() => { });
    });

    document.body.appendChild(fab);
  }

  function watchFab() {
    new MutationObserver(() => {
      if (!document.getElementById(`${UI_PREFIX}-fab`)) injectFab();
    }).observe(document.body, { childList: true });
  }

  // ════════════════════════════════════════════════════════════════
  //  ONBOARDING TOAST  (Bug 1 fix)
  //  Injected into LinkedIn's DOM — styled by content.css.
  //  "Go to My Profile" uses window.location.href (same tab).
  // ════════════════════════════════════════════════════════════════
  async function maybeShowOnboardingToast() {
    if (!isExtensionValid()) return;

    // Skip if already synced
    try {
      const stored = await chrome.storage.local.get("lia_user_synced");
      if (stored.lia_user_synced) return;
    } catch { return; }

    if (document.getElementById(`${UI_PREFIX}-onboarding-toast`)) return;

    // Find the user's own profile URL from links on the page
    const findOwnProfileUrl = () => {
      for (const link of document.querySelectorAll('a[href*="/in/"]')) {
        const href = (link.getAttribute("href") || "").split("?")[0];
        if (/^\/in\/[a-zA-Z0-9_-]{3,100}\/?$/.test(href)) {
          return `https://www.linkedin.com${href}`;
        }
      }
      return "https://www.linkedin.com/in/me/";
    };

    const profileUrl = findOwnProfileUrl();
    const logoUrl = isExtensionValid() ? chrome.runtime.getURL("icons/logo.png") : "";

    const toast = document.createElement("div");
    toast.id = `${UI_PREFIX}-onboarding-toast`;
    toast.innerHTML = `
      <div class="lia-toast-inner">
        ${logoUrl ? `<img src="${logoUrl}" class="lia-toast-logo" alt="Logo" />` : ""}
        <div class="lia-toast-content">
          <strong>LinkedIn Profile Analyzer</strong>
          <p>Visit your profile once to enable <b>compatibility scoring</b> when analyzing others.</p>
        </div>
      </div>
      <div class="lia-toast-actions">
        <button class="lia-toast-btn lia-toast-btn-primary" id="lia-toast-go">Go to My Profile</button>
        <button class="lia-toast-btn lia-toast-dismiss"     id="lia-toast-later">Later</button>
      </div>`;

    document.body.appendChild(toast);
    // Trigger CSS transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add("lia-toast-visible"));
    });

    function dismissToast() {
      toast.classList.remove("lia-toast-visible");
      setTimeout(() => toast.remove(), 400);
    }

    // "Go to My Profile" — same tab navigation (Bug 1 fix)
    document.getElementById("lia-toast-go").addEventListener("click", () => {
      window.location.href = profileUrl;
    });

    document.getElementById("lia-toast-later").addEventListener("click", dismissToast);

    // Auto-dismiss after 14 s
    setTimeout(dismissToast, 14000);
  }

  // ════════════════════════════════════════════════════════════════
  //  DOM DATA EXTRACTION
  // ════════════════════════════════════════════════════════════════
  function safeText(selector, root = document, fallback = "") {
    try {
      const el = root.querySelector(selector);
      return el ? el.innerText.trim() : fallback;
    } catch { return fallback; }
  }

  function extractProfileData() {
    return {
      name: extractName(),
      headline: extractHeadline(),
      about: extractAbout(),
      experience: extractExperience(),
      skills: extractSkills(),
      education: extractEducation(),
      certifications: extractCertifications(),
    };
  }

  function extractName() {
    // When performing the actual data extraction, it's safe to use the title fallback as a last resort
    return findProfileName(true) || "Unknown";
  }

  function extractHeadline() {
    return safeText("div.text-body-medium.break-words") ||
      safeText(".pv-top-card--list .text-body-medium") || "";
  }

  function extractAbout() {
    for (const section of document.querySelectorAll("section")) {
      const header = section.querySelector("div#about, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "about") {
        const span =
          section.querySelector("div.display-flex.full-width span[aria-hidden='true']") ||
          section.querySelector("div.inline-show-more-text span[aria-hidden='true']") ||
          section.querySelector("span[aria-hidden='true']");
        return span ? span.innerText.trim() : "";
      }
    }
    return "";
  }

  function extractExperience() {
    const items = [];
    for (const section of document.querySelectorAll("section")) {
      const header = section.querySelector("div#experience, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "experience") {
        section.querySelectorAll("li.artdeco-list__item").forEach(li => {
          const title = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const company = safeText("span.t-14.t-normal span[aria-hidden='true']", li);
          if (title) items.push({ title, company: company || "" });
        });
        break;
      }
    }
    return items.slice(0, 8);
  }

  function extractSkills() {
    const skills = [];
    for (const section of document.querySelectorAll("section")) {
      const header = section.querySelector("div#skills, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "skills") {
        section.querySelectorAll("li.artdeco-list__item").forEach(li => {
          const skill = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          if (skill && !skills.includes(skill)) skills.push(skill);
        });
        break;
      }
    }
    return skills.slice(0, 15);
  }

  function extractEducation() {
    const items = [];
    for (const section of document.querySelectorAll("section")) {
      const header = section.querySelector("div#education, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "education") {
        section.querySelectorAll("li.artdeco-list__item").forEach(li => {
          const school = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const degreeEls = li.querySelectorAll("span.t-14.t-normal span[aria-hidden='true']");
          const degree = degreeEls[0]?.innerText.trim() || "";
          const year = degreeEls[1]?.innerText.trim() || "";
          if (school) items.push({ school, degree, field: "", year });
        });
        break;
      }
    }
    return items.slice(0, 5);
  }

  function extractCertifications() {
    const items = [];
    for (const section of document.querySelectorAll("section")) {
      const header = section.querySelector("div#licenses_and_certifications, h2 span.visually-hidden");
      if (header && (
        header.textContent.trim().toLowerCase() === "licenses & certifications" ||
        header.textContent.trim().toLowerCase() === "licenses and certifications"
      )) {
        section.querySelectorAll("li.artdeco-list__item").forEach(li => {
          const cert = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const issuer = safeText("span.t-14.t-normal span[aria-hidden='true']", li);
          if (cert) items.push({ certificate: cert, issuer: issuer || "", link: "", date: "" });
        });
        break;
      }
    }
    return items.slice(0, 5);
  }

  // ════════════════════════════════════════════════════════════════
  //  OWN PROFILE AUTO-SYNC
  // ════════════════════════════════════════════════════════════════
  async function syncOwnProfile() {
    if (!isExtensionValid() || !isProfilePage(window.location.href)) return;

    const isOwnProfile =
      !!document.querySelector("button[aria-label='Open to']") ||
      !!document.querySelector("button[aria-label='Add profile section']") ||
      !!document.querySelector("button[aria-label='Edit intro']") ||
      !!document.querySelector(".pv-top-card--edit-name-pencil") ||
      !!document.querySelector("#profile-edit-toggle");

    if (!isOwnProfile) return;

    try {
      const stored = await chrome.storage.local.get("lia_last_sync");
      if (Date.now() - (stored.lia_last_sync || 0) < 3_600_000) return;
    } catch { return; }

    const uid = await ensureUserId();
    if (!uid) return;

    const profileData = extractProfileData();
    if (!profileData.name || profileData.name === "Unknown") return;

    try {
      const resp = await fetch(SAVE_PROFILE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: uid, profile_data: profileData }),
      });
      if (resp.ok) {
        await chrome.storage.local.set({ lia_last_sync: Date.now(), lia_user_synced: true });
        // Remove toast if visible
        const toast = document.getElementById(`${UI_PREFIX}-onboarding-toast`);
        if (toast) {
          toast.classList.remove("lia-toast-visible");
          setTimeout(() => toast.remove(), 400);
        }
        console.log("[LinkedIn Analyzer] ✅ Own profile synced.");
      }
    } catch (e) {
      console.warn("[LinkedIn Analyzer] Own profile sync failed:", e);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  USER ID
  // ════════════════════════════════════════════════════════════════
  function generateUUID() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }

  async function ensureUserId() {
    if (userId) return userId;
    if (!isExtensionValid()) return null;
    try {
      const data = await chrome.storage.local.get("lia_user_id");
      userId = data.lia_user_id || generateUUID();
      if (!data.lia_user_id) await chrome.storage.local.set({ lia_user_id: userId });
      return userId;
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════
  //  MESSAGE HANDLER  (side panel requests profile data)
  // ════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isExtensionValid()) return;

    if (msg.action === "urlChanged") {
      scheduleNavCheck();
      return false;
    }

    if (msg.action === "getPageInfo") {
      const url = cleanUrl(window.location.href);
      const onProfilePage = isProfilePage(url);

      if (onProfilePage) {
        ensureUserId().then(uid => {
          sendResponse({
            isProfilePage: true,
            url,
            profileData: extractProfileData(),
            userId: uid || "",
          });
        });
        return true; // keep channel open for async response
      } else {
        sendResponse({ isProfilePage: false, url });
      }
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ════════════════════════════════════════════════════════════════
  setupNavigationListener();
  lastUrl = cleanUrl(window.location.href);

  // FAB on every LinkedIn page
  setTimeout(() => { injectFab(); watchFab(); }, 1000);

  // If this is already a profile page on initial load, wait for DOM then signal
  if (isProfilePage(window.location.href)) {
    setTimeout(() => waitForProfileDOM(lastUrl), 1500);
    setTimeout(syncOwnProfile, 4000);
  } else {
    // Toast on non-profile pages
    setTimeout(maybeShowOnboardingToast, 3000);
  }

  console.log("[LinkedIn Analyzer] v3.4 content script loaded with polling fix.");
})();