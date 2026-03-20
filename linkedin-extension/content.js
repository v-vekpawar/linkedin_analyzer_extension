// LinkedIn Profile Analyzer Content Script.
// Detects LinkedIn profile navigation, extracts profile data intuitively, and syncs user info.

(() => {
  "use strict";

  // Identifiers used for extension UI elements.
  // URL to save synced data to the backend locally.
  const UI_PREFIX = "lia";
  const SAVE_PROFILE_URL = "http://localhost:5000/save-user-profile";
  // const SAVE_PROFILE_URL = "https://your-render-app-url.onrender.com/save-user-profile"; // Replace with your Render URL

  // State variables for routing and tracking current sessions.
  // Helps determine navigation states to watch the DOM effectively.
  let userId = null;
  let lastUrl = "";
  let navDebounce = null;
  let profileObserver = null; 

  // Safely checks if the extension context is still valid.
  // Prevents invalid runtime errors on disconnected extensions.
  function isExtensionValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // Verifies if the standard LinkedIn URL corresponds to a user's profile.
  function isProfilePage(url) {
    return /linkedin\.com\/in\/[^/?#]+/.test(url);
  }

  // Parses URLs to remove query arrays and hash fragments.
  // Helps reliably compare current clean navigation paths.
  function cleanUrl(url) {
    return url.split("?")[0].split("#")[0];
  }

  // Regularly checks URL changes for LinkedIn SPA router handling.
  // Provides popstate listeners to safely capture location history events.
  function setupNavigationListener() {
    setInterval(() => {
      const currentUrl = cleanUrl(window.location.href);
      if (currentUrl !== lastUrl) {
        scheduleNavCheck();
      }
    }, 500);

    window.addEventListener("popstate", scheduleNavCheck);
  }

  // Resets tracking debounce counters on navigation events.
  // Delays validation momentarily to combine overlapping path changes.
  function scheduleNavCheck() {
    clearTimeout(navDebounce);
    navDebounce = setTimeout(handleNavigation, 300);
  }

  // Verifies state context upon URL navigation and emits 'pageChanged'.
  // Initiates DOM tracking whenever a targeted profile page opens up.
  function handleNavigation() {
    const url = cleanUrl(window.location.href);
    if (url === lastUrl) return;
    lastUrl = url;

    if (profileObserver) { profileObserver.disconnect(); profileObserver = null; }
    
    // Hide FAB if not on profile page
    const fab = document.getElementById(`${UI_PREFIX}-fab`);
    if (!isProfilePage(url) && fab) {
        fab.remove();
    }

    if (!isExtensionValid()) return;

    if (isProfilePage(url)) {
      waitForProfileDOM(url);
      injectFab(); // Ensure FAB is injected if it's a profile page
    } else {
      chrome.runtime.sendMessage({ action: "pageChanged", url, isProfilePage: false }).catch(() => { });
    }
  }

  // Listens dynamically for LinkedIn's lazy <h1> profile injection on SPAs.
  // Signals the side panel confidently once the primary header exists.
  function waitForProfileDOM(url) {
    setTimeout(() => {
      if (trySignalProfileReady(url)) return;

      profileObserver = new MutationObserver(() => {
        if (trySignalProfileReady(url)) {
          profileObserver.disconnect();
          profileObserver = null;
        }
      });
      profileObserver.observe(document.body, { childList: true, subtree: true });

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

  // Probes DOM trees iteratively trying to locate primary profile names reliably.
  // Employs a fallback parsing document titles if required.
  function findProfileName(allowTitleFallback = false) {
    const primaryTitle = document.querySelector(
      ".pv-top-card .text-heading-xlarge, " +
      ".pv-text-details__left-panel .text-heading-xlarge, " +
      ".pv-top-card h1, " +
      "h1.text-heading-xlarge"
    );
    if (primaryTitle && primaryTitle.innerText.trim()) return primaryTitle.innerText.trim();

    for (const el of document.querySelectorAll(
      ".pv-top-card h1, .pv-top-card h2, " +
      ".pv-text-details__left-panel h1, .pv-text-details__left-panel h2"
    )) {
      if (el.classList.contains("visually-hidden")) continue;
      const text = el.innerText.trim();
      if (text) return text;
    }

    if (allowTitleFallback && document.title && document.title.includes(" | LinkedIn")) {
      const titleName = document.title.split(" | LinkedIn")[0].replace(/^\(\d+\)\s*/, "").trim();
      if (titleName && titleName !== "LinkedIn" && titleName !== "Feed") return titleName;
    }

    return "";
  }

  // Ascertains whether profile <h1> strings exist before sending a relay.
  // Ensures the analyzer waits accurately without race conditions occurring.
  function trySignalProfileReady(url) {
    const name = findProfileName(false);
    if (!name) return false;

    if (!isExtensionValid()) return true;
    chrome.runtime.sendMessage({ action: "profileReady", url }).catch(() => { });
    return true;
  }

  // Injects a floating action button safely onto valid LinkedIn pages.
  // Triggers 'openSidePanel' events enabling analyzers seamlessly for profiles.
  function injectFab() {
    if (!isExtensionValid()) return;
    if (!isProfilePage(window.location.href)) return; // Only inject on profile pages
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

  // Employs MutationObservers continuously protecting injected FABs against hydration rewrites.
  function watchFab() {
    new MutationObserver(() => {
      if (!document.getElementById(`${UI_PREFIX}-fab`)) injectFab();
    }).observe(document.body, { childList: true });
  }

  // Generates conditional toasts recommending users inspect their 'Own' profiles properly.
  // Syncs compatibility scores automatically by promoting self-analyses initially.
  async function maybeShowOnboardingToast() {
    if (!isExtensionValid()) return;

    try {
      const stored = await chrome.storage.local.get("lia_user_synced");
      if (stored.lia_user_synced) return;
    } catch { return; }

    if (document.getElementById(`${UI_PREFIX}-onboarding-toast`)) return;

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
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add("lia-toast-visible"));
    });

    function dismissToast() {
      toast.classList.remove("lia-toast-visible");
      setTimeout(() => toast.remove(), 400);
    }

    document.getElementById("lia-toast-go").addEventListener("click", () => {
      window.location.href = profileUrl;
    });

    document.getElementById("lia-toast-later").addEventListener("click", dismissToast);

    setTimeout(dismissToast, 14000);
  }

  // Securely derives text payloads directly out of DOM selectors catching errors intuitively.
  function safeText(selector, root = document, fallback = "") {
    try {
      const el = root.querySelector(selector);
      return el ? el.innerText.trim() : fallback;
    } catch { return fallback; }
  }

  // Combines extracted node objects collectively to assemble comprehensive profile metadata.
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

  // Employs generalized node detection trying to collect reliable profile names.
  function extractName() {
    return findProfileName(true) || "Unknown";
  }

  // Iterates through common profile selectors aiming to parse primary headline information accurately.
  function extractHeadline() {
    return safeText("div.text-body-medium.break-words") ||
      safeText(".pv-top-card--list .text-body-medium") || "";
  }

  // Retrieves 'About' text dynamically querying explicitly hidden section elements reliably.
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

  // Fetches lists iteratively from experience DOM cards formatting cleanly into descriptive metadata.
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

  // Validates explicit skill texts dynamically appending successfully identified arrays together efficiently.
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

  // Discovers recent educational strings linking standard university properties structurally safely.
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

  // Parses linked credential entries organizing certificates comprehensively via text filters intelligently.
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

  // Verifies parsed objects confirming robust lists populated appropriately bypassing basic name constraints conditionally.
  function profileDataIsRich(data) {
    return (
      data.experience.length > 0 ||
      data.skills.length > 0 ||
      data.education.length > 0 ||
      data.about.length > 20
    );
  }

  // Scrolls strategically rendering virtual react arrays guaranteeing safe intersection interactions properly triggering data correctly.
  async function extractProfileDataWhenReady(forceScroll = false) {
    const immediate = extractProfileData();
    if (profileDataIsRich(immediate)) return immediate;

    const savedScrollY = window.scrollY;

    const scrollContainer =
      document.querySelector("div.scaffold-layout__main") ||
      document.querySelector("main") ||
      null;

    // Forces scroll coordinates iteratively mimicking user views directly.
    function scrollTo(y) {
      if (scrollContainer) {
        scrollContainer.scrollTop = y;
      }
      window.scrollTo({ top: y, behavior: "instant" });
    }

    let data = immediate;
    
    if (forceScroll) {
      const steps = [400, 800, 1200, 1800, 2600, 3600];

      // Awaits dynamically letting virtual DOMs render nodes correctly inside containers passively.
      for (const y of steps) {
        scrollTo(y);
        await new Promise(r => setTimeout(r, 300));
        data = extractProfileData();
        if (profileDataIsRich(data)) break;
      }
    }

    // Falls back slightly rendering nodes conditionally providing extraction final iterations passively.
    if (!profileDataIsRich(data)) {
      await new Promise(r => setTimeout(r, 800));
      data = extractProfileData();
    }

    if (forceScroll) {
       scrollTo(savedScrollY);
    }

    return data;
  }

  function isUsersOwnProfile() {
    return !!document.querySelector("button[aria-label='Open to']") ||
      !!document.querySelector("button[aria-label='Add profile section']") ||
      !!document.querySelector("button[aria-label='Edit intro']") ||
      !!document.querySelector(".pv-top-card--edit-name-pencil") ||
      !!document.querySelector("#profile-edit-toggle");
  }

  // Triggers personal profile fetching asynchronously storing baseline analytics permanently directly server-side eventually.
  async function syncOwnProfile() {
    if (!isExtensionValid() || !isProfilePage(window.location.href)) return;

    if (!isUsersOwnProfile()) return;

    try {
      const stored = await chrome.storage.local.get("lia_last_sync");
      if (Date.now() - (stored.lia_last_sync || 0) < 3_600_000) return;
    } catch { return; }

    const uid = await ensureUserId();
    if (!uid) return;

    // When syncing own profile in background, we can force scroll to get all data
    const profileData = await extractProfileDataWhenReady(true);
    if (!profileData.name || profileData.name === "Unknown") return;

    try {
      const resp = await fetch(SAVE_PROFILE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: uid, profile_data: profileData }),
      });
      if (resp.ok) {
        await chrome.storage.local.set({ lia_last_sync: Date.now(), lia_user_synced: true });
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

  // Evaluates cryptographically randomized UUID generation conditionally managing keys explicitly randomly.
  function generateUUID() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
  }

  // Securely coordinates async session identifiers ensuring user profiles remain uniquely accessible independently reliably.
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

  // Responds explicitly handling page extraction queries securely responding gracefully catching async operations globally directly.
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
        ensureUserId().then(async uid => {
          const isOwn = isUsersOwnProfile();
          // Do not force scroll if this is just getting page info for the manual click (which annoys user),
          // although for own profile sync we allow force scroll to capture all data.
          const profileData = await extractProfileDataWhenReady(false);
          sendResponse({
            isProfilePage: true,
            isOwnProfile: isOwn,
            url,
            profileData,
            userId: uid || "",
          });
        });
        return true; 
      } else {
        sendResponse({ isProfilePage: false, url, isOwnProfile: false });
      }
    }
  });

  // Initializes primary listeners sequentially initiating FAB tracking dynamically waiting efficiently internally globally.
  setupNavigationListener();
  lastUrl = cleanUrl(window.location.href);

  setTimeout(() => { injectFab(); watchFab(); }, 1000);

  if (isProfilePage(window.location.href)) {
    setTimeout(() => waitForProfileDOM(lastUrl), 1500);
    setTimeout(syncOwnProfile, 4000);
  } else {
    setTimeout(maybeShowOnboardingToast, 3000);
  }

  console.log("[LinkedIn Analyzer] v3.4 content script loaded with lazy-section fix.");
})();