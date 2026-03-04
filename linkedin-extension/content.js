/**
 * LinkedIn Profile Analyzer — Content Script
 * ============================================
 * Injected on https://www.linkedin.com/in/* pages.
 *
 * Responsibilities:
 *   1. Detect LinkedIn profile pages (including SPA navigation)
 *   2. Inject a floating "Analyze Profile" button
 *   3. Extract profile data from the DOM
 *   4. Send data to Flask backend via fetch()
 *   5. Display results in a slide-in sidebar
 */

(() => {
  "use strict";

  // ════════════════════════════════════════════════════════════════
  //  CONFIGURATION
  // ════════════════════════════════════════════════════════════════
  const BACKEND_URL = "http://localhost:5000/analyze";
  const SAVE_PROFILE_URL = "http://localhost:5000/save-user-profile";
  const UI_PREFIX = "lia";   // prefix for all injected element IDs

  // ════════════════════════════════════════════════════════════════
  //  STATE
  // ════════════════════════════════════════════════════════════════
  let isUIInjected = false;
  let lastProfileUrl = "";
  let userId = null;

  /**
   * Check if the extension context is still valid.
   * After reloading the extension in chrome://extensions, the old
   * content script becomes orphaned and chrome.runtime calls throw.
   */
  function isExtensionValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  SPA NAVIGATION DETECTION
  // ════════════════════════════════════════════════════════════════

  /**
   * LinkedIn is an SPA — page transitions don't trigger a full reload.
   * We use a MutationObserver on <body> combined with URL polling
   * to detect when the user navigates to a new /in/* profile.
   */
  function startNavigationWatcher() {
    // URL polling (catches pushState navigations the observer might miss)
    setInterval(() => {
      const url = window.location.href;
      if (isProfilePage(url) && url !== lastProfileUrl) {
        lastProfileUrl = url;
        onProfilePageLoad();
      } else if (!isProfilePage(url)) {
        removeUI();
      }
    }, 1500);

    // MutationObserver for DOM changes
    const observer = new MutationObserver(() => {
      const url = window.location.href;
      if (isProfilePage(url) && !isUIInjected) {
        lastProfileUrl = url;
        onProfilePageLoad();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  /** Check if the current URL is a LinkedIn profile page */
  function isProfilePage(url) {
    return /linkedin\.com\/in\/[^/]+/.test(url);
  }

  // ════════════════════════════════════════════════════════════════
  //  UI INJECTION
  // ════════════════════════════════════════════════════════════════

  /** Called whenever we land on a profile page */
  function onProfilePageLoad() {
    // Prevent duplicate injection
    if (document.getElementById(`${UI_PREFIX}-fab`)) {
      isUIInjected = true;
      return;
    }
    injectFAB();
    isUIInjected = true;
  }

  /** Remove all injected UI (when navigating away from /in/*) */
  function removeUI() {
    [`${UI_PREFIX}-fab`, `${UI_PREFIX}-sidebar`, `${UI_PREFIX}-overlay`].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    isUIInjected = false;
  }

  /** Inject the floating logo button (mid-right) */
  function injectFAB() {
    if (!isExtensionValid()) { removeUI(); return; }
    const fab = document.createElement("button");
    fab.id = `${UI_PREFIX}-fab`;
    fab.title = "Analyze this LinkedIn Profile";
    const logoUrl = chrome.runtime.getURL("icons/logo.png");
    fab.innerHTML = `<img src="${logoUrl}" alt="Analyze" />`;
    fab.addEventListener("click", handleAnalyzeClick);
    document.body.appendChild(fab);
  }

  // ════════════════════════════════════════════════════════════════
  //  DOM DATA EXTRACTION
  // ════════════════════════════════════════════════════════════════

  /** Safely get text from a selector, return fallback on failure */
  function safeText(selector, root = document, fallback = "") {
    try {
      const el = root.querySelector(selector);
      return el ? el.innerText.trim() : fallback;
    } catch { return fallback; }
  }

  /** Extract the full profile data from the current page DOM */
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
    // Primary: the main h1 on profile pages
    return safeText("h1.text-heading-xlarge") ||
      safeText("h1") ||
      "Unknown";
  }

  function extractHeadline() {
    return safeText("div.text-body-medium.break-words") ||
      safeText(".pv-top-card--list .text-body-medium") ||
      "";
  }

  function extractAbout() {
    // The About section lives inside a section whose header says "About"
    const sections = document.querySelectorAll("section");
    for (const section of sections) {
      const header = section.querySelector("div#about, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "about") {
        // LinkedIn often hides full text behind "see more"
        const span = section.querySelector("div.display-flex.full-width span[aria-hidden='true']") ||
          section.querySelector("div.inline-show-more-text span[aria-hidden='true']") ||
          section.querySelector("span[aria-hidden='true']");
        return span ? span.innerText.trim() : "";
      }
    }
    return "";
  }

  function extractExperience() {
    const items = [];
    const sections = document.querySelectorAll("section");
    for (const section of sections) {
      const header = section.querySelector("div#experience, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "experience") {
        const listItems = section.querySelectorAll("li.artdeco-list__item");
        listItems.forEach(li => {
          const title = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const company = safeText("span.t-14.t-normal span[aria-hidden='true']", li);
          if (title) {
            items.push({ title, company: company || "" });
          }
        });
        break;
      }
    }
    return items.slice(0, 8);
  }

  function extractSkills() {
    const skills = [];
    const sections = document.querySelectorAll("section");
    for (const section of sections) {
      const header = section.querySelector("div#skills, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "skills") {
        const listItems = section.querySelectorAll("li.artdeco-list__item");
        listItems.forEach(li => {
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
    const sections = document.querySelectorAll("section");
    for (const section of sections) {
      const header = section.querySelector("div#education, h2 span.visually-hidden");
      if (header && header.textContent.trim().toLowerCase() === "education") {
        const listItems = section.querySelectorAll("li.artdeco-list__item");
        listItems.forEach(li => {
          const school = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const degreeEl = li.querySelectorAll("span.t-14.t-normal span[aria-hidden='true']");
          const degree = degreeEl.length > 0 ? degreeEl[0].innerText.trim() : "";
          const year = degreeEl.length > 1 ? degreeEl[1].innerText.trim() : "";
          if (school) {
            items.push({ school, degree, field: "", year });
          }
        });
        break;
      }
    }
    return items.slice(0, 5);
  }

  function extractCertifications() {
    const items = [];
    const sections = document.querySelectorAll("section");
    for (const section of sections) {
      const header = section.querySelector("div#licenses_and_certifications, h2 span.visually-hidden");
      if (header && (
        header.textContent.trim().toLowerCase() === "licenses & certifications" ||
        header.textContent.trim().toLowerCase() === "licenses and certifications"
      )) {
        const listItems = section.querySelectorAll("li.artdeco-list__item");
        listItems.forEach(li => {
          const cert = safeText("div.display-flex.align-items-center span[aria-hidden='true']", li) ||
            safeText("span[aria-hidden='true']", li);
          const issuer = safeText("span.t-14.t-normal span[aria-hidden='true']", li);
          if (cert) {
            items.push({ certificate: cert, issuer: issuer || "", link: "", date: "" });
          }
        });
        break;
      }
    }
    return items.slice(0, 5);
  }

  // ════════════════════════════════════════════════════════════════
  //  ANALYZE FLOW
  // ════════════════════════════════════════════════════════════════

  /** Main click handler for the FAB */
  async function handleAnalyzeClick() {
    if (!isExtensionValid()) { removeUI(); return; }

    // Extract data first
    const profileData = extractProfileData();
    const profileUrl = window.location.href.split("?")[0]; // clean URL without query params

    if (!profileData.name || profileData.name === "Unknown") {
      showError("Could not extract profile data. Make sure you're on a LinkedIn profile page and the page has fully loaded.");
      return;
    }

    // Show sidebar with loading state
    showSidebar(profileData, null, true);

    try {
      // Ensure we have a user ID for compatibility scoring
      await ensureUserId();

      // Single unified API call — returns about_profile + approach_person + compatibility_score
      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_data: profileData,
          profile_url: profileUrl,
          user_id: userId || "",
        }),
      });

      if (!response.ok) throw new Error(`Server error (${response.status})`);
      const result = await response.json();

      showSidebar(profileData, {
        about: result.about_profile || {},
        approach: result.approach_person || {},
        compatibility: result.compatibility_score || null,
        cached: result.cached || false,
      }, false);

    } catch (err) {
      console.error("[LinkedIn Analyzer] Error:", err);
      showError(`Analysis failed: ${err.message}. Is the backend running at ${BACKEND_URL.replace('/analyze', '')}?`);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  SIDEBAR UI
  // ════════════════════════════════════════════════════════════════

  /** Show loading or results in the sidebar */
  function showSidebar(profileData, results, isLoading) {
    // Remove existing sidebar
    const existing = document.getElementById(`${UI_PREFIX}-sidebar`);
    if (existing) existing.remove();

    // Create overlay
    let overlay = document.getElementById(`${UI_PREFIX}-overlay`);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = `${UI_PREFIX}-overlay`;
      overlay.addEventListener("click", closeSidebar);
      document.body.appendChild(overlay);
    }
    overlay.classList.add(`${UI_PREFIX}-overlay-visible`);

    // Create sidebar
    const sidebar = document.createElement("div");
    sidebar.id = `${UI_PREFIX}-sidebar`;

    if (isLoading) {
      sidebar.innerHTML = buildLoadingHTML(profileData);
    } else {
      sidebar.innerHTML = buildResultsHTML(profileData, results);
    }

    document.body.appendChild(sidebar);

    // Trigger slide-in animation
    requestAnimationFrame(() => {
      sidebar.classList.add(`${UI_PREFIX}-sidebar-visible`);
    });

    // Wire up close button
    const closeBtn = sidebar.querySelector(`#${UI_PREFIX}-close-btn`);
    if (closeBtn) closeBtn.addEventListener("click", closeSidebar);

    // Wire up tab buttons
    sidebar.querySelectorAll(`.${UI_PREFIX}-tab-btn`).forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab, sidebar));
    });
  }

  function closeSidebar() {
    const sidebar = document.getElementById(`${UI_PREFIX}-sidebar`);
    const overlay = document.getElementById(`${UI_PREFIX}-overlay`);
    if (sidebar) {
      sidebar.classList.remove(`${UI_PREFIX}-sidebar-visible`);
      setTimeout(() => sidebar.remove(), 350);
    }
    if (overlay) overlay.classList.remove(`${UI_PREFIX}-overlay-visible`);
  }

  function switchTab(tabName, sidebar) {
    sidebar.querySelectorAll(`.${UI_PREFIX}-tab-btn`).forEach(b => b.classList.remove("active"));
    sidebar.querySelectorAll(`.${UI_PREFIX}-tab-panel`).forEach(p => p.classList.remove("active"));

    const activeBtn = sidebar.querySelector(`.${UI_PREFIX}-tab-btn[data-tab="${tabName}"]`);
    const activePanel = sidebar.querySelector(`#${UI_PREFIX}-panel-${tabName}`);
    if (activeBtn) activeBtn.classList.add("active");
    if (activePanel) activePanel.classList.add("active");
  }

  // ════════════════════════════════════════════════════════════════
  //  HTML BUILDERS
  // ════════════════════════════════════════════════════════════════

  function buildLoadingHTML(profile) {
    const bannerUrl = chrome.runtime.getURL("icons/banner.png");
    const logoUrl = chrome.runtime.getURL("icons/logo.png");
    return `
      <div class="${UI_PREFIX}-banner">
        <img src="${bannerUrl}" alt="LinkedIn Analyzer" />
      </div>
      <div class="${UI_PREFIX}-sidebar-header">
        <div class="${UI_PREFIX}-header-left">
          <img src="${logoUrl}" alt="Logo" />
          <span class="${UI_PREFIX}-header-title">Analyzing Profile</span>
        </div>
        <button id="${UI_PREFIX}-close-btn" class="${UI_PREFIX}-close-btn" title="Close">&times;</button>
      </div>
      <div class="${UI_PREFIX}-sidebar-body">
        <div class="${UI_PREFIX}-profile-mini">
          <div class="${UI_PREFIX}-avatar">${(profile.name || "?")[0].toUpperCase()}</div>
          <div>
            <div class="${UI_PREFIX}-profile-name">${escapeHTML(profile.name)}</div>
            <div class="${UI_PREFIX}-profile-headline">${escapeHTML(profile.headline)}</div>
          </div>
        </div>
        <div class="${UI_PREFIX}-loading">
          <div class="${UI_PREFIX}-spinner"></div>
          <p>Running AI analysis…</p>
          <p class="${UI_PREFIX}-loading-sub">This may take 10-20 seconds</p>
        </div>
      </div>
    `;
  }

  function buildResultsHTML(profile, results) {
    const about = results.about || {};
    const approach = results.approach || {};
    const compatibility = results.compatibility || null;
    const bannerUrl = chrome.runtime.getURL("icons/banner.png");
    const logoUrl = chrome.runtime.getURL("icons/logo.png");

    return `
      <div class="${UI_PREFIX}-banner">
        <img src="${bannerUrl}" alt="LinkedIn Analyzer" />
      </div>
      <div class="${UI_PREFIX}-sidebar-header">
        <div class="${UI_PREFIX}-header-left">
          <img src="${logoUrl}" alt="Logo" />
          <span class="${UI_PREFIX}-header-title">Profile Analysis</span>
        </div>
        <button id="${UI_PREFIX}-close-btn" class="${UI_PREFIX}-close-btn" title="Close">&times;</button>
      </div>

      <!-- Profile mini-card -->
      <div class="${UI_PREFIX}-profile-mini">
        <div class="${UI_PREFIX}-avatar">${(profile.name || "?")[0].toUpperCase()}</div>
        <div>
          <div class="${UI_PREFIX}-profile-name">${escapeHTML(profile.name)}</div>
          <div class="${UI_PREFIX}-profile-headline">${escapeHTML(profile.headline)}</div>
        </div>
      </div>

      <!-- Tabs -->
      <div class="${UI_PREFIX}-tabs">
        <button class="${UI_PREFIX}-tab-btn active" data-tab="analysis">Analysis</button>
        <button class="${UI_PREFIX}-tab-btn" data-tab="approach">Approach</button>
      </div>

      <div class="${UI_PREFIX}-sidebar-body">

        <!-- ── Tab: Analysis ── -->
        <div id="${UI_PREFIX}-panel-analysis" class="${UI_PREFIX}-tab-panel active">

          ${compatibility ? `
            <div class="${UI_PREFIX}-card ${UI_PREFIX}-compat-card">
              <h4>🎯 Compatibility Score</h4>
              <div class="${UI_PREFIX}-compat-gauge">
                <div class="${UI_PREFIX}-compat-score">${typeof compatibility.compatibility_score === 'number' ? compatibility.compatibility_score : '—'}%</div>
              </div>
              ${compatibility.recommendation ? `<p class="${UI_PREFIX}-compat-rec">${escapeHTML(compatibility.recommendation)}</p>` : ''}
              ${compatibility.why && compatibility.why.length ? `
                <ul class="${UI_PREFIX}-compat-reasons">
                  ${compatibility.why.map(r => `<li>${escapeHTML(r)}</li>`).join('')}
                </ul>` : ''}
            </div>` : ''}
          ${about.seniority_level ? `<span class="${UI_PREFIX}-badge">${escapeHTML(about.seniority_level)} Level</span>` : ""}

          ${about.who_they_are ? `
            <div class="${UI_PREFIX}-card">
              <h4>Who They Are</h4>
              <p>${escapeHTML(about.who_they_are)}</p>
            </div>` : ""}

          ${about.what_they_specialize_in ? `
            <div class="${UI_PREFIX}-card">
              <h4>Specialization</h4>
              <p>${escapeHTML(about.what_they_specialize_in)}</p>
            </div>` : ""}

          ${about.key_strengths && about.key_strengths.length ? `
            <div class="${UI_PREFIX}-card">
              <h4>Key Strengths</h4>
              <div class="${UI_PREFIX}-chips">
                ${about.key_strengths.map(s => `<span class="${UI_PREFIX}-chip">${escapeHTML(s)}</span>`).join("")}
              </div>
            </div>` : ""}

          ${about.career_trajectory ? `
            <div class="${UI_PREFIX}-card">
              <h4>Career Trajectory</h4>
              <p>${escapeHTML(about.career_trajectory)}</p>
            </div>` : ""}

          ${about.potential_talking_points ? `
            <div class="${UI_PREFIX}-card ${UI_PREFIX}-highlight-card">
              <h4>💡 Talking Points</h4>
              <p>${escapeHTML(about.potential_talking_points)}</p>
            </div>` : ""}
        </div>

        <!-- ── Tab: Approach ── -->
        <div id="${UI_PREFIX}-panel-approach" class="${UI_PREFIX}-tab-panel">
          ${approach.outreach_angles && approach.outreach_angles.length ? `
            <div class="${UI_PREFIX}-card">
              <h4>Outreach Angles</h4>
              ${approach.outreach_angles.map(a => `
                <div class="${UI_PREFIX}-angle">
                  <strong>${escapeHTML(a.angle_type || "")}</strong>
                  <p>${escapeHTML(a.explanation || "")}</p>
                </div>
              `).join("")}
            </div>` : ""}

          ${approach.personalized_messages ? `
            <div class="${UI_PREFIX}-card">
              <h4>Message Templates</h4>
              ${Object.entries(approach.personalized_messages)
          .filter(([, v]) => v && v.length > 0)
          .map(([k, v]) => `
                  <div class="${UI_PREFIX}-message-block">
                    <div class="${UI_PREFIX}-msg-label">${escapeHTML(k.replace(/_/g, " "))}</div>
                    <div class="${UI_PREFIX}-msg-body">
                      <p>${escapeHTML(v)}</p>
                      <div class="${UI_PREFIX}-msg-actions">
                        <button class="${UI_PREFIX}-copy-btn" data-text="${escapeAttr(v)}" title="Copy message">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        </button>
                        <button class="${UI_PREFIX}-send-btn" data-text="${escapeAttr(v)}" title="Copy & open messaging">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                        </button>
                      </div>
                    </div>
                  </div>
                `).join("")}
            </div>` : ""}
        </div>

      </div>
    `;
  }

  /** Show a standalone error in the sidebar */
  function showError(message) {
    const existing = document.getElementById(`${UI_PREFIX}-sidebar`);
    if (existing) existing.remove();

    const bannerUrl = chrome.runtime.getURL("icons/banner.png");
    const sidebar = document.createElement("div");
    sidebar.id = `${UI_PREFIX}-sidebar`;
    sidebar.innerHTML = `
      <div class="${UI_PREFIX}-banner">
        <img src="${bannerUrl}" alt="LinkedIn Analyzer" />
      </div>
      <div class="${UI_PREFIX}-sidebar-header">
        <div class="${UI_PREFIX}-header-left">
          <span class="${UI_PREFIX}-header-title">Error</span>
        </div>
        <button id="${UI_PREFIX}-close-btn" class="${UI_PREFIX}-close-btn" title="Close">&times;</button>
      </div>
      <div class="${UI_PREFIX}-sidebar-body">
        <div class="${UI_PREFIX}-error">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d32f2f"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
          <p>${escapeHTML(message)}</p>
          <button class="${UI_PREFIX}-retry-btn" id="${UI_PREFIX}-retry-btn">Try Again</button>
        </div>
      </div>
    `;
    document.body.appendChild(sidebar);
    requestAnimationFrame(() => sidebar.classList.add(`${UI_PREFIX}-sidebar-visible`));

    sidebar.querySelector(`#${UI_PREFIX}-close-btn`).addEventListener("click", closeSidebar);
    sidebar.querySelector(`#${UI_PREFIX}-retry-btn`).addEventListener("click", () => {
      closeSidebar();
      setTimeout(handleAnalyzeClick, 400);
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ════════════════════════════════════════════════════════════════

  function escapeHTML(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || "").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ════════════════════════════════════════════════════════════════
  //  GLOBAL EVENT DELEGATION (copy buttons)
  // ════════════════════════════════════════════════════════════════
  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(`.${UI_PREFIX}-copy-btn`);
    if (copyBtn) {
      const text = copyBtn.getAttribute("data-text")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.innerHTML = "✓";
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
        }, 1500);
      });
    }

    // Send button: copy + open LinkedIn messaging
    const sendBtn = e.target.closest(`.${UI_PREFIX}-send-btn`);
    if (sendBtn) {
      const text = sendBtn.getAttribute("data-text")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      navigator.clipboard.writeText(text).then(() => {
        sendBtn.innerHTML = "✓ Copied";
        setTimeout(() => {
          sendBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
        }, 2000);

        // Try to click LinkedIn's "Message" button on the profile
        const msgBtn = document.querySelector('button[aria-label*="Message"]') ||
          document.querySelector('a[href*="messaging"]');
        if (msgBtn) msgBtn.click();
      });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  USER PROFILE SYNC
  // ════════════════════════════════════════════════════════════════

  /** Generate a UUID v4 using crypto API */
  function generateUUID() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  /** Load or create a persistent user ID in chrome.storage.local */
  async function ensureUserId() {
    if (userId) return userId;
    if (!isExtensionValid()) return null;

    try {
      const data = await chrome.storage.local.get("lia_user_id");
      if (data.lia_user_id) {
        userId = data.lia_user_id;
      } else {
        userId = generateUUID();
        await chrome.storage.local.set({ lia_user_id: userId });
        console.log("[LinkedIn Analyzer] Generated new user ID:", userId);
      }
      return userId;
    } catch (e) {
      console.warn("[LinkedIn Analyzer] Storage access failed:", e);
      return null;
    }
  }

  /**
   * Detect if the user is on their OWN LinkedIn profile and sync it.
   * LinkedIn adds specific indicators when viewing your own profile.
   */
  async function syncUserProfile() {
    if (!isExtensionValid() || !isProfilePage(window.location.href)) return;

    // LinkedIn shows "Add profile section" or edit buttons only on your own profile
    const isOwnProfile =
      document.querySelector("button[aria-label='Open to']") !== null ||
      document.querySelector("button[aria-label='Add profile section']") !== null ||
      document.querySelector(".pv-top-card--edit-name-pencil") !== null ||
      document.querySelector("div.pv-profile-card button.profile-edit-btn") !== null;

    if (!isOwnProfile) return;

    const uid = await ensureUserId();
    if (!uid) return;

    // Check if we already synced recently (within the last hour)
    try {
      const stored = await chrome.storage.local.get("lia_last_sync");
      const lastSync = stored.lia_last_sync || 0;
      if (Date.now() - lastSync < 3600000) return; // 1 hour cooldown
    } catch { /* continue */ }

    const profileData = extractProfileData();
    if (!profileData.name || profileData.name === "Unknown") return;

    try {
      const response = await fetch(SAVE_PROFILE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: uid,
          profile_data: profileData,
        }),
      });

      if (response.ok) {
        await chrome.storage.local.set({ lia_last_sync: Date.now() });
        console.log("[LinkedIn Analyzer] Synced your profile for compatibility scoring.");
      }
    } catch (e) {
      console.warn("[LinkedIn Analyzer] Profile sync failed (non-fatal):", e);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  BOOTSTRAP
  // ════════════════════════════════════════════════════════════════

  // Initial check — page might already be a profile
  if (isProfilePage(window.location.href)) {
    lastProfileUrl = window.location.href;
    // Wait for the page to settle before injecting
    setTimeout(onProfilePageLoad, 1500);
    // Attempt to sync user profile if they're on their own page
    setTimeout(syncUserProfile, 3000);
  }

  // Start watching for SPA navigations
  startNavigationWatcher();

  console.log("[LinkedIn Analyzer] Content script loaded.");
})();
