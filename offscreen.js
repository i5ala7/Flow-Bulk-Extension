// Sends a heartbeat ping every 20 seconds to keep the background service worker alive
setInterval(() => {
  chrome.runtime.sendMessage({ action: 'KEEP_ALIVE' }).catch(() => {});
}, 20000);