const sleep = ms => new Promise(r => setTimeout(r, ms));

let controlState = 'IDLE'; 

async function waitWhilePaused() {
  while (controlState === 'PAUSED') {
    await sleep(500);
  }
  if (controlState === 'IDLE') throw new Error('USER_STOPPED');
}

async function fillPrompt(text) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'FILL_PROMPT', text }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve();
      } else {
        reject(new Error(response?.error || 'Unknown error filling prompt'));
      }
    });
  });
}

async function downloadImageSequence(url, index) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'DOWNLOAD_IMAGE', url: url, index: index }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success) {
        resolve(response);
      } else {
        reject(new Error(response?.error || 'Download failed'));
      }
    });
  });
}

async function simulateClick(el) {
  if (!el || !document.body.contains(el)) return;
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch(e) {}
  await sleep(50);
  
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy };

  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  
  const id = el.id || '';
  if (id.includes('trigger-IMAGE') || id.includes('trigger-VIDEO') || el.getAttribute('role') === 'tab') {
    try { el.click(); } catch(e) {}
  }
  await sleep(300);
}

function findSubmitButton() {
  const icons = document.querySelectorAll('i.google-symbols');
  const primary = [...icons].find(el => el.textContent.trim() === 'arrow_forward')?.closest('button');
  if (primary) return primary;

  const SUBMIT_ARIA = /generate|submit|생성|제출|生成|送信/i;
  const ariaBtns = document.querySelectorAll('button[aria-label]');
  for (const btn of ariaBtns) {
    if (!btn.offsetParent) continue;
    const label = btn.getAttribute('aria-label') || '';
    if (SUBMIT_ARIA.test(label) && btn.getAttribute('aria-haspopup') !== 'menu') {
      return btn;
    }
  }
  return null;
}

async function waitForSubmitEnabled(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await waitWhilePaused();
    const btn = findSubmitButton();
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getAttribute('data-state') !== 'disabled') {
      return btn;
    }
    await sleep(200);
  }
  return null;
}

function findModelSettingsBtn() {
  const submitBtn = findSubmitButton();
  return submitBtn?.parentElement?.querySelector('button[aria-haspopup="menu"]') || 
         document.querySelector('button[aria-haspopup="menu"][aria-label*="Model"], button[aria-haspopup="menu"][aria-label*="Settings"]');
}

async function setModelOptions(modelName, aspectRatio) {
  console.log(`[FlowBulk] Configuring model: ${modelName}, Aspect Ratio: ${aspectRatio}`);
  const menuBtn = findModelSettingsBtn();
  if (menuBtn) {
    await simulateClick(menuBtn);
    await sleep(800);
  }

  const modelBtn = [...document.querySelectorAll('button, [role="menuitem"]')]
    .find(btn => btn.offsetParent !== null && btn.textContent && btn.textContent.includes(modelName));
  if (modelBtn) {
    await simulateClick(modelBtn);
    await sleep(500);
  }

  if (aspectRatio) {
    const aspectName = aspectRatio.toLowerCase();
    const aspectBtn = [...document.querySelectorAll('button, [role="menuitem"]')]
      .find(btn => btn.offsetParent !== null && (
        (btn.id && btn.id.includes(aspectRatio)) || 
        (btn.textContent && btn.textContent.toLowerCase().includes(aspectName)) ||
        (btn.getAttribute('aria-label') && btn.getAttribute('aria-label').toLowerCase().includes(aspectName))
      ));
    if (aspectBtn) {
      await simulateClick(aspectBtn);
      await sleep(500);
    }
  }

  const x1Btn = [...document.querySelectorAll('button, [role="menuitem"]')].find(btn => 
    btn.offsetParent !== null && 
    ((btn.id && btn.id.includes('trigger-1')) || 
     (btn.textContent && btn.textContent.includes('x1')) || 
     (btn.textContent && btn.textContent.trim() === '1'))
  );
  
  if (x1Btn) {
    await simulateClick(x1Btn);
    await sleep(500);
  }
  
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
  await sleep(800);
}

async function blobToBase64(url) {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.error('[FlowBulk] Error converting blob:', e);
    return null;
  }
}

// -------------------------------------------------------------
// KEEP-ALIVE HEARTBEAT  —  prevents Chrome from throttling
// the content-script's timers when the tab is hidden (RDP disconnect).
// Sends a lightweight message to the background every 15 s.
// Also re-injects alwaysActive scripts every 60 s as a safety net.
// -------------------------------------------------------------
let keepAliveInterval = null;
let reInjectInterval = null;

function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'KEEP_ALIVE' }).catch(() => {});
  }, 15000);
  reInjectInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'INJECT_ANTI_THROTTLING' }).catch(() => {});
  }, 60000);
}

function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (reInjectInterval) { clearInterval(reInjectInterval); reInjectInterval = null; }
}

// -------------------------------------------------------------
// SINGLE-PROMPT GENERATION ATTEMPT
// Returns true on success, throws on failure.
// -------------------------------------------------------------
async function generateSinglePrompt(prompt, index) {
  await waitWhilePaused();
  await fillPrompt(prompt);
  await sleep(800);

  const submitBtn = await waitForSubmitEnabled(10000);
  if (!submitBtn) {
    throw new Error('Submit button is disabled or not found');
  }

  const existingTileIds = new Set(
    [...document.querySelectorAll('[data-tile-id]')].map(el => el.getAttribute('data-tile-id'))
  );

  await waitWhilePaused();
  await simulateClick(submitBtn);
  console.log(`[FlowBulk] Clicked generate for prompt ${index + 1}. Waiting for result...`);

  let newTile = null;
  let targetUrl = null;
  let pollCount = 0;
  const MAX_POLL = 150; // 150 × 2 s = 5 min max wait

  while (pollCount < MAX_POLL) {
    await waitWhilePaused();
    await sleep(2000);

    // Detect new tile
    if (!newTile) {
      const currentTiles = document.querySelectorAll('[data-tile-id]');
      for (const tile of currentTiles) {
        const id = tile.getAttribute('data-tile-id');
        if (id && !existingTileIds.has(id)) {
          newTile = tile;
          console.log(`[FlowBulk] Detected new tile ID: ${id}`);
          break;
        }
      }
    }

    if (newTile) {
      const img = newTile.querySelector('img[src]');
      const text = (newTile.textContent || '').toLowerCase();

      // Detect policy / safety / error failures in tile text
      if (text.includes('policy') || text.includes('couldn\'t') || text.includes('unable') || text.includes('violat') || text.includes('safety')) {
        throw new Error('Policy or generation error detected in tile');
      }

      // Image is ready when it has a valid src and no percentage spinner
      if (img && img.src.length > 5 && !text.match(/\d+%/)) {
        targetUrl = img.src;
        break;
      }
    }
    pollCount++;
  }

  if (!targetUrl) {
    throw new Error('Timeout waiting for generation');
  }

  let downloadUrl = targetUrl;
  if (targetUrl.startsWith('blob:')) {
    downloadUrl = await blobToBase64(targetUrl) || targetUrl;
  }
  await downloadImageSequence(downloadUrl, index);
  return true;
}

// -------------------------------------------------------------
// MAIN BULK LOOP
// -------------------------------------------------------------
async function startBulk(prompts, modelName, aspectRatio) {
  // Inject anti-throttling scripts once at the start
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'INJECT_ANTI_THROTTLING' }, resolve);
  });

  // Start content-script-level keep-alive heartbeat
  startKeepAlive();

  console.log('[FlowBulk] Starting bulk generation with', prompts.length, 'prompts.');

  // ---------- Set model/ratio ONCE before the loop ----------
  try {
    await setModelOptions(modelName, aspectRatio);
  } catch (e) {
    console.error('[FlowBulk] Failed to set model options:', e);
  }

  // ---------- Process each prompt ----------
  for (let i = 0; i < prompts.length; i++) {
    // Check if the user stopped before even starting the next prompt
    if (controlState === 'IDLE') break;

    const prompt = prompts[i];
    console.log(`[FlowBulk] --- Processing ${i + 1}/${prompts.length} ---`);

    let promptSuccess = false;
    const MAX_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await generateSinglePrompt(prompt, i);
        promptSuccess = true;
        break; // success — no need to retry
      } catch (e) {
        if (e.message === 'USER_STOPPED') {
          console.log('[FlowBulk] User stopped the generation.');
          chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', index: i, success: false });
          // Jump straight to cleanup
          stopKeepAlive();
          controlState = 'IDLE';
          chrome.runtime.sendMessage({ action: 'BULK_FINISHED' });
          return;
        }
        console.warn(`[FlowBulk] Prompt ${i + 1} attempt ${attempt} failed:`, e.message);
        if (attempt < MAX_RETRIES) {
          console.log(`[FlowBulk] Retrying prompt ${i + 1}...`);
          await sleep(3000);
        }
      }
    }

    // Report progress regardless of outcome
    chrome.runtime.sendMessage({
      action: 'PROGRESS_UPDATE',
      index: i,
      success: promptSuccess
    });

    if (!promptSuccess) {
      console.error(`[FlowBulk] Prompt ${i + 1} failed after ${MAX_RETRIES} attempts. Skipping to next.`);
    }

    await sleep(2000);
  }

  console.log('[FlowBulk] Bulk generation finished.');
  stopKeepAlive();
  controlState = 'IDLE';
  chrome.runtime.sendMessage({ action: 'BULK_FINISHED' });
}

// -------------------------------------------------------------
// MESSAGE LISTENER
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'START_BULK') {
    if (controlState !== 'IDLE') {
        sendResponse({ success: false, error: 'Already running' });
        return;
    }
    controlState = 'RUNNING';
    startBulk(request.prompts, request.model, request.aspectRatio);
    sendResponse({ success: true });
  } else if (request.action === 'PAUSE') {
    controlState = 'PAUSED';
    sendResponse({ success: true });
  } else if (request.action === 'RESUME') {
    controlState = 'RUNNING';
    sendResponse({ success: true });
  } else if (request.action === 'STOP') {
    controlState = 'IDLE';
    stopKeepAlive();
    sendResponse({ success: true });
  }
});