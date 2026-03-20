// Background Service Worker for LinkedIn Profile Analyzer.
// Manages global side panel state and handles messaging.

"use strict";

// Disables the side panel globally by default.
// Ensures it only activates on valid LinkedIn tabs.
chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: false });

// Stores the open/closed state of the side panel per tab.
// Allows synchronous toggling without breaking user gestures.
const panelOpenTabs = new Map();

// Listens for messages from the content script and side panel.
// Routes actions like toggling the panel or relaying profile status.
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;

  // Handles 'openSidePanel' action by toggling synchronous visibility.
  // Sends a close request if open, or opens the panel using the API.
  if (msg.action === "openSidePanel" && tabId) {
    if (panelOpenTabs.get(tabId)) {
      chrome.runtime.sendMessage({ action: "requestClose" }).catch(() => { });
      panelOpenTabs.set(tabId, false);
    } else {
      chrome.sidePanel.open({ tabId });
      panelOpenTabs.set(tabId, true);
    }
    return;
  }

  // Receives 'panelClosed' signal from the closed window.
  // Updates the internal map to mark the panel as closed.
  if (msg.action === "panelClosed") {
    const tid = msg.tabId || tabId;
    if (tid) panelOpenTabs.set(tid, false);
    return;
  }

  // Receives 'panelReady' signal from a newly opened side panel.
  // Updates the internal map to mark the panel as ready and open.
  if (msg.action === "panelReady") {
    const tid = msg.tabId || tabId;
    if (tid) panelOpenTabs.set(tid, true);
    return;
  }

  // Relays 'profileReady' or 'pageChanged' events from content scripts.
  // Forwards these events to the side panel with the sender's tabId.
  if (msg.action === "profileReady" || msg.action === "pageChanged") {
    chrome.runtime.sendMessage({ ...msg, tabId: tabId || null }).catch(() => { });
    return;
  }
});

// Enables the side panel only for URLs that belong to LinkedIn.
// Reverts the panel's internal state to closed if navigating away.
function applyPanelPolicy(tabId, url) {
  const onLinkedIn = typeof url === "string" && url.includes("linkedin.com");
  chrome.sidePanel.setOptions({
    tabId,
    path: "sidepanel.html",
    enabled: onLinkedIn,
  }).catch(() => { });

  if (!onLinkedIn) panelOpenTabs.set(tabId, false);
}

// Applies side panel policy when a tab's URL changes or updating finishes.
// Notifies content scripts of URL changes to trigger navigation logic.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    applyPanelPolicy(tabId, tab.url);
  }

  if (changeInfo.url && typeof changeInfo.url === "string" && changeInfo.url.includes("linkedin.com")) {
    chrome.tabs.sendMessage(tabId, { action: "urlChanged", url: changeInfo.url }).catch(() => { });
  }
});

// Re-evaluates panel availability whenever the user switches tabs.
// Ensures accurate side panel visibility based on the active tab's URL.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return;
    applyPanelPolicy(tabId, tab.url);
  });
});

// Cleans up memory by removing the stored open state when a tab closes.
// Prevents memory leaks by maintaining accurate state tracking.
chrome.tabs.onRemoved.addListener(tabId => {
  panelOpenTabs.delete(tabId);
});

// Automatically opens a LinkedIn feed tab on extension installation.
// Streamlines onboarding by redirecting users to a relevant page.
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: "https://www.linkedin.com/feed/" });
  }
});