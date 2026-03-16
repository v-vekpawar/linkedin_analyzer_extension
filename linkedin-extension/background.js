/**
 * LinkedIn Profile Analyzer — Background Service Worker  v3.2
 *
 * Bug 3 fix: set global sidePanel default to disabled at startup,
 *            then enable only on LinkedIn tabs.
 * Bug 4 fix: track panel-open state in chrome.storage.session
 *            (survives service-worker restarts); send "requestClose"
 *            to the side panel so it can call window.close().
 *
 * NOTE: pageChanged relay REMOVED — side panel now uses
 *       chrome.tabs.onUpdated directly (no relay needed, more reliable).
 */

"use strict";

// ── Global: disable side panel on ALL tabs by default (Bug 3 fix) ──
// This overrides the manifest's default_path which would enable it everywhere.
chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: false });

// ── Panel-open state ──────────────────────────────────────────────
// Kept in-memory (Map) so the toggle check is SYNCHRONOUS.
// chrome.sidePanel.open() must be called in the same synchronous turn
// as the user gesture — any await before it breaks the gesture context.
const panelOpenTabs = new Map();

// ── Message router ────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  // FAB clicked — toggle the side panel synchronously (Bug 4 fix)
  if (msg.action === "openSidePanel" && tabId) {
    if (panelOpenTabs.get(tabId)) {
      // Panel is open — ask it to close itself via window.close()
      chrome.runtime.sendMessage({ action: "requestClose" }).catch(() => { });
      panelOpenTabs.set(tabId, false);
    } else {
      // MUST be synchronous — no await before this line
      chrome.sidePanel.open({ tabId });
      panelOpenTabs.set(tabId, true);
    }
    return;
  }

  // Side panel reporting it closed (window unload)
  if (msg.action === "panelClosed") {
    const tid = msg.tabId || tabId;
    if (tid) panelOpenTabs.set(tid, false);
    return;
  }

  // Side panel reporting it is ready / just opened
  if (msg.action === "panelReady") {
    const tid = msg.tabId || tabId;
    if (tid) panelOpenTabs.set(tid, true);
    return;
  }

  // Content script signals — relay to side panel with sender's tabId stamped in
  // "profileReady": profile <h1> is confirmed rendered in DOM — safe to extract
  // "pageChanged":  navigated to a non-profile page
  if (msg.action === "profileReady" || msg.action === "pageChanged") {
    chrome.runtime.sendMessage({ ...msg, tabId: tabId || null }).catch(() => { });
    return;
  }
});

// ── Per-tab panel policy: enable only on LinkedIn (Bug 3 fix) ─────
function applyPanelPolicy(tabId, url) {
  const onLinkedIn = typeof url === "string" && url.includes("linkedin.com");
  chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled: onLinkedIn,
  }).catch(() => { });

  if (!onLinkedIn) panelOpenTabs.set(tabId, false);
}

// Apply policy when any tab finishes loading or its url changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    applyPanelPolicy(tabId, tab.url);
  }

  // Relay URL changes to the content script so it can re-run its SPA logic
  if (changeInfo.url && typeof changeInfo.url === "string" && changeInfo.url.includes("linkedin.com")) {
    chrome.tabs.sendMessage(tabId, { action: "urlChanged", url: changeInfo.url }).catch(() => { });
  }
});

// Apply policy when user switches tabs
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return;
    applyPanelPolicy(tabId, tab.url);
  });
});

// Clean up when tab closes
chrome.tabs.onRemoved.addListener(tabId => {
  panelOpenTabs.delete(tabId);
});

// ── First-install ─────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://www.linkedin.com/feed/" });
  }
});