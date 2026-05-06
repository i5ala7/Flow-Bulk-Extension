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
  let elapsed = 0;
  while (elapsed < timeout) {
    await waitWhilePaused();
    const btn = findSubmitButton();
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && btn.getAttribute('data-state') !== 'disabled') {
      return btn;
    }
    await sleep(200);
    elapsed += 200;
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
async function submitPromptAndGetTileId(prompt, index) {
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
  console.log(`[FlowBulk] Clicked generate for prompt ${index + 1}. Waiting for tile...`);

  let newTileId = null;
  for (let i = 0; i < 50; i++) {
    await waitWhilePaused();
    await sleep(200);
    const currentTiles = document.querySelectorAll('[data-tile-id]');
    for (const tile of currentTiles) {
      const id = tile.getAttribute('data-tile-id');
      if (id && !existingTileIds.has(id)) {
        newTileId = id;
        break;
      }
    }
    if (newTileId) break;
  }

  if (!newTileId) throw new Error('New tile did not appear after submission');
  console.log(`[FlowBulk] Detected new tile ID for prompt ${index + 1}: ${newTileId}`);
  return newTileId;
}

async function waitForTileAndDownload(tileId, index) {
  let targetUrl = null;
  let pollCount = 0;
  const MAX_POLL = 150;
  let missingCount = 0;

  while (pollCount < MAX_POLL) {
    await waitWhilePaused();
    await sleep(2000);

    // Check for blocking error dialogs
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog, .mat-mdc-dialog-container');
    for (const d of dialogs) {
      if (!d.offsetParent) continue; // skip hidden
      const dText = (d.textContent || '').toLowerCase();
      if (dText.includes('policy') || dText.includes('couldn\'t') || dText.includes('unable') || dText.includes('violat') || dText.includes('safety') || dText.includes('error')) {
        const closeBtn = d.querySelector('button');
        if (closeBtn) {
          try { closeBtn.click(); } catch(e){}
        }
        throw new Error('Error dialog detected during generation');
      }
    }

    const tile = document.querySelector(`[data-tile-id="${tileId}"]`);
    if (!tile) {
      missingCount++;
      if (missingCount >= 4) {
        throw new Error('Tile removed from DOM (likely generation failed)');
      }
      pollCount++;
      continue;
    }
    missingCount = 0;

    const img = tile.querySelector('img[src]');
    const text = (tile.textContent || '').toLowerCase();

    if (text.includes('policy') || text.includes('couldn\'t') || text.includes('unable') || text.includes('violat') || text.includes('safety') || text.includes('failed') || text.includes('error')) {
      throw new Error('Policy or generation error detected in tile');
    }

    if (img && img.src.length > 5 && !text.match(/\d+%/)) {
      targetUrl = img.src;
      break;
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
async function startBulk(prompts, modelName, aspectRatio, concurrentCount = 1, resumeLast = false, targetIndices = null) {
  // Inject anti-throttling scripts once at the start
  await new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'INJECT_ANTI_THROTTLING' }, resolve);
  });

  // Start content-script-level keep-alive heartbeat
  startKeepAlive();

  console.log('[FlowBulk] Starting bulk generation with', prompts.length, 'prompts.');

  const indicesToProcess = targetIndices || prompts.map((_, i) => i);
  let startIndex = 0;

  if (resumeLast && !targetIndices) {
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'GET_LAST_DOWNLOAD_INDEX' }, resolve);
    });
    if (response && response.maxIndex > 0) {
      startIndex = response.maxIndex;
      console.log(`[FlowBulk] Resuming from prompt ${startIndex + 1} (found up to index ${startIndex})`);
      // Update the UI immediately for skipped prompts
      for (let i = 0; i < startIndex && i < prompts.length; i++) {
        chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', index: i, success: true });
      }
    }
  }

  const actualIndices = indicesToProcess.slice(startIndex);

  // ---------- Set model/ratio ONCE before the loop ----------
  try {
    await setModelOptions(modelName, aspectRatio);
  } catch (e) {
    console.error('[FlowBulk] Failed to set model options:', e);
  }

  // ---------- Process each prompt ----------
  for (let i = 0; i < actualIndices.length; i += concurrentCount) {
    if (controlState === 'IDLE') break;

    const batchSize = Math.min(concurrentCount, actualIndices.length - i);
    const batchTiles = [];

    // 1. Submit prompts in the batch
    for (let j = 0; j < batchSize; j++) {
      if (controlState === 'IDLE') break;
      const promptIndex = actualIndices[i + j];
      const prompt = prompts[promptIndex];
      
      console.log(`[FlowBulk] --- Submitting ${promptIndex + 1}/${prompts.length} ---`);

      let tileId = null;
      let promptSuccess = false;
      const MAX_RETRIES = 2;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          tileId = await submitPromptAndGetTileId(prompt, promptIndex);
          promptSuccess = true;
          break; 
        } catch (e) {
          if (e.message === 'USER_STOPPED') {
             console.log('[FlowBulk] User stopped the generation.');
             break;
          }
          console.warn(`[FlowBulk] Submission failed for prompt ${promptIndex + 1} attempt ${attempt}:`, e.message);
          if (attempt < MAX_RETRIES) {
            await sleep(3000);
          }
        }
      }

      if (promptSuccess && tileId) {
        batchTiles.push({ tileId, index: promptIndex });
      } else if (controlState !== 'IDLE') {
        chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', index: promptIndex, success: false });
      }

      // Delay between submissions in a batch
      if (j < batchSize - 1 && controlState !== 'IDLE') {
        await sleep(2500); 
      }
    }

    if (controlState === 'IDLE') break;

    // 2. Wait for all submitted tiles to generate and download
    const waitPromises = batchTiles.map(async (item) => {
      try {
        await waitForTileAndDownload(item.tileId, item.index);
        chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', index: item.index, success: true });
      } catch (e) {
        if (e.message === 'USER_STOPPED') return;
        console.error(`[FlowBulk] Generation failed for prompt ${item.index + 1}:`, e.message);
        chrome.runtime.sendMessage({ action: 'PROGRESS_UPDATE', index: item.index, success: false });
      }
    });

    await Promise.allSettled(waitPromises);

    // 3. Sleep before next batch
    if (i + batchSize < actualIndices.length && controlState !== 'IDLE') {
       await sleep(4000);
    }
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
    startBulk(request.prompts, request.model, request.aspectRatio, request.concurrentCount, request.resumeLast, request.targetIndices);
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