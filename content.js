const sleep = ms => new Promise(r => setTimeout(r, ms));

let controlState = 'IDLE'; // IDLE, RUNNING, PAUSED

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

  // Ensure x1 is selected to avoid generating multiple images per prompt and messing up the sequence
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

async function startBulk(prompts, modelName, aspectRatio) {
  console.log('[FlowBulk] Starting bulk generation with', prompts.length, 'prompts.');
  
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    console.log(`[FlowBulk] --- Processing ${i+1}/${prompts.length} ---`);
    console.log(`[FlowBulk] Prompt: "${prompt}"`);
    
    try {
      await waitWhilePaused();
      
      await fillPrompt(prompt);
      await sleep(800);
      
      await waitWhilePaused();
      await setModelOptions(modelName, aspectRatio);
      
      const submitBtn = await waitForSubmitEnabled();
      if (!submitBtn) {
        console.error('[FlowBulk] Submit button is disabled or not found! Aborting loop.');
        break;
      }
      
      // Snapshot existing tiles before clicking generate
      const existingTileIds = new Set(
        [...document.querySelectorAll('[data-tile-id]')].map(el => el.getAttribute('data-tile-id'))
      );
      
      await waitWhilePaused();
      await simulateClick(submitBtn);
      console.log('[FlowBulk] Clicked generate. Waiting for a new tile to finish...');
      
      let newTile = null;
      let targetUrl = null;
      let attempts = 0;
      
      while (attempts < 150) { // Timeout after ~5 minutes
        await waitWhilePaused();
        await sleep(2000);
        
        // 1. Identify the newly added tile
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
        
        // 2. Wait for the new tile to finish generating
        if (newTile) {
          const img = newTile.querySelector('img[src]');
          const text = newTile.textContent || '';
          
          // Image exists, string is not empty, and no percentage loader text
          if (img && img.src.length > 5 && !text.match(/\d+%/)) {
            targetUrl = img.src;
            break;
          }
        }
        attempts++;
      }
      
      // 3. Sequential Downloading
      if (targetUrl) {
        console.log(`[FlowBulk] Generation successful! Downloading specific image...`);
        let downloadUrl = targetUrl;
        
        if (targetUrl.startsWith('blob:')) {
          downloadUrl = await blobToBase64(targetUrl) || targetUrl;
        }
        
        // PAUSE execution until the download actually finishes
        await downloadImageSequence(downloadUrl, i);
        console.log(`[FlowBulk] Download complete. Moving to next prompt in 2 seconds...`);
        
      } else {
        console.error(`[FlowBulk] Timeout waiting for generation of prompt: ${prompt}`);
      }
      
      // 4. Exact wait of 2 seconds before the next loop
      await sleep(2000);
      
    } catch (e) {
      if (e.message === 'USER_STOPPED') {
          console.log('[FlowBulk] User stopped the generation.');
          break;
      }
      console.error(`[FlowBulk] Error during prompt ${i+1}:`, e);
    }
  }
  
  console.log('[FlowBulk] Bulk generation finished or stopped.');
  controlState = 'IDLE';
  chrome.runtime.sendMessage({ action: 'BULK_FINISHED' });
}

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
    sendResponse({ success: true });
  }
});