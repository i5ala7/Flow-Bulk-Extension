(function() {
  function blockEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }
  
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "webkitVisibilityState", { configurable: true, get: () => "visible" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "webkitHidden", { configurable: true, get: () => false });
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
  setInterval(() => {
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    } catch (e) {}
    try { window.dispatchEvent(new Event("focus")); } catch(e) {}
  }, 10000);

  document.addEventListener("freeze", blockEvent, true);
  document.addEventListener("resume", blockEvent, true);

  try {
    if (navigator.userActivation) {
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        get: () => ({ isActive: true, hasBeenActive: true })
      });
    }
  } catch (e) {}
})();