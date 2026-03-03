/**
 * LinkedIn Profile Analyzer — Background Service Worker
 * Handles extension lifecycle events.
 */

// Log when the extension is first installed or updated
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        console.log("[LinkedIn Analyzer] Extension installed successfully.");
    } else if (details.reason === "update") {
        console.log("[LinkedIn Analyzer] Extension updated to version", chrome.runtime.getManifest().version);
    }
});
