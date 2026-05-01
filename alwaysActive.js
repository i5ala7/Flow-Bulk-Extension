(function() {
  function blockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  
  try {
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(Document.prototype, "webkitVisibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(Document.prototype, "webkitHidden", { configurable: true, get: () => false });
  } catch (e) {}
  
  document.addEventListener("visibilitychange", blockEvent, true);
  document.addEventListener("webkitvisibilitychange", blockEvent, true);
  window.addEventListener("pagehide", blockEvent, true);
  window.addEventListener("blur", blockEvent, true);
  window.addEventListener("focus", blockEvent, true);
  window.addEventListener("mouseout", blockEvent, true);
  window.addEventListener("mouseleave", blockEvent, true);
  window.addEventListener("lostpointercapture", blockEvent, true);
  
  Document.prototype.hasFocus = new Proxy(Document.prototype.hasFocus, { apply: () => true });
  
  // Replace requestAnimationFrame with setTimeout fallback so it works
  // even when Chrome suspends rAF (RDP disconnect / locked screen / minimized).
  let lastTime = 0;
  window.requestAnimationFrame = function(callback) {
    const currTime = Date.now();
    const timeToCall = Math.max(0, 16 - (currTime - lastTime));
    const id = window.setTimeout(() => { callback(performance.now()); }, timeToCall);
    lastTime = currTime + timeToCall;
    return id;
  };
  
  const originalCancel = window.cancelAnimationFrame;
  window.cancelAnimationFrame = function(id) {
    clearTimeout(id);
    if (originalCancel) originalCancel(id);
  };

  // ---- RDP / Lock-screen hardening ----
  // Periodically re-assert visibility state every 10 seconds.
  // When an RDP session disconnects the browser may briefly reset these properties;
  // re-defining them on an interval keeps the page believing it is visible.
  setInterval(() => {
    try {
      Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
    } catch (e) {}
    // Fire a synthetic focus event so the page thinks it has focus.
    try { window.dispatchEvent(new Event("focus")); } catch(e) {}
  }, 10000);

  // Prevent Chrome from throttling timers via the Page Lifecycle API.
  // Chrome may call 'freeze' on background pages; intercepting the event stops that.
  document.addEventListener("freeze", blockEvent, true);
  document.addEventListener("resume", blockEvent, true);

  // Override navigator.userActivation (if it exists) to always look active.
  try {
    if (navigator.userActivation) {
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        get: () => ({ isActive: true, hasBeenActive: true })
      });
    }
  } catch (e) {}
})();