/**
 * LinkedIn Profile Analyzer — Background Service Worker
 * Handles extension lifecycle events and first-time onboarding.
 */

// On first install, open LinkedIn feed so the content script can sync the user's profile
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        console.log("[LinkedIn Analyzer] Extension installed — opening LinkedIn for profile sync.");
        chrome.tabs.create({ url: "https://www.linkedin.com/feed/" });
    } else if (details.reason === "update") {
        console.log("[LinkedIn Analyzer] Extension updated to version", chrome.runtime.getManifest().version);
    }
});
