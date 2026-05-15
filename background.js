// Enable side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// -------------------------------------------------------------
// OFFSCREEN DOCUMENT SETUP (Keeps Service Worker Awake)
// -------------------------------------------------------------
let offscreenDocPromise = null;

async function setupOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) return;

  if (offscreenDocPromise) {
    await offscreenDocPromise;
    return;
  }

  offscreenDocPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Keep background service worker alive during long generation loops'
  });
  await offscreenDocPromise;
  offscreenDocPromise = null;
}

chrome.runtime.onInstalled.addListener(setupOffscreenDocument);
chrome.runtime.onStartup.addListener(setupOffscreenDocument);

// -------------------------------------------------------------
// CHROME DEBUGGER PROTOCOL — State Management
// Tracks which tabs have the debugger attached.
// -------------------------------------------------------------
const debuggerAttachedTabs = new Set();

chrome.tabs.onRemoved.addListener(tabId => {
  debuggerAttachedTabs.delete(tabId);
});

chrome.debugger.onDetach.addListener(source => {
  if (source.tabId !== undefined) {
    debuggerAttachedTabs.delete(source.tabId);
  }
});

// -------------------------------------------------------------
// SLATE / REACT PROMPT FILLER (kept as fallback)
// -------------------------------------------------------------
function fillPromptReact(text) {
  try {
    const editor = document.querySelector('[contenteditable="true"][data-slate-editor="true"]');
    if (!editor) throw new Error('Editor not found');
    
    const fiberKey = Object.keys(editor).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
    if (!fiberKey) throw new Error('React fiber not found');
    
    let node = editor[fiberKey];
    let slate = null;
    while (node) {
      const p = node.memoizedProps;
      if (p && p.editor && typeof p.editor.insertText === 'function') { 
        slate = p.editor; 
        break; 
      }
      node = node.return;
    }
    if (!slate) throw new Error('Slate instance not found');

    editor.focus();

    const lastIdx = Math.max(0, slate.children.length - 1);
    const lastChild = slate.children[lastIdx];
    const lastOffset = (lastChild && lastChild.children && lastChild.children[0])
      ? (lastChild.children[0].text || '').length : 0;
      
    slate.select({
      anchor: { path: [0, 0], offset: 0 },
      focus:  { path: [lastIdx, 0], offset: lastOffset }
    });
    
    slate.insertText(text);
    editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// -------------------------------------------------------------
// MESSAGE LISTENER
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'KEEP_ALIVE') {
    sendResponse({ ok: true });
    return true;
  }

  // Inject Anti-Throttling files into the page just like the original extension
  if (request.action === 'INJECT_ANTI_THROTTLING') {
    chrome.power.requestKeepAwake('system');
    Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        files: ['alwaysActive.js'],
        world: 'MAIN'
      }).catch(() => null),
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        files: ['alwaysActiveIsolated.js'],
        world: 'ISOLATED'
      }).catch(() => null)
    ]).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.action === 'BULK_FINISHED') {
    chrome.power.releaseKeepAwake();
    return false;
  }

  if (request.action === 'GET_LAST_DOWNLOAD_INDEX') {
    chrome.storage.local.get(['lastDownloadedIndex'], (result) => {
      sendResponse({ maxIndex: result.lastDownloadedIndex || 0 });
    });
    return true;
  }

  if (request.action === 'DOWNLOAD_IMAGE') {
    const { url, index } = request;
    const promptNumber = index + 1;
    const formattedIndex = promptNumber.toString().padStart(2, '0');
    const filename = `bulk images/${formattedIndex}.png`;

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        let responded = false;
        const completeResponse = (success, data) => {
          if (!responded) {
            responded = true;
            if (success) {
              chrome.storage.local.get(['lastDownloadedIndex'], (res) => {
                const newMax = Math.max(res.lastDownloadedIndex || 0, promptNumber);
                chrome.storage.local.set({ lastDownloadedIndex: newMax });
              });
            }
            sendResponse(success ? { success: true, downloadId: data } : { success: false, error: data });
          }
        };

        const downloadListener = (delta) => {
          if (delta.id === downloadId && delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              completeResponse(true, downloadId);
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              completeResponse(false, 'Download interrupted');
            }
          }
        };
        chrome.downloads.onChanged.addListener(downloadListener);
        
        // Safety check in case it completed before listener was added
        setTimeout(() => {
          if (!responded) {
            chrome.downloads.search({ id: downloadId }, (items) => {
              if (items && items[0]) {
                if (items[0].state === 'complete') {
                  chrome.downloads.onChanged.removeListener(downloadListener);
                  completeResponse(true, downloadId);
                } else if (items[0].state === 'interrupted') {
                  chrome.downloads.onChanged.removeListener(downloadListener);
                  completeResponse(false, 'Download interrupted early');
                }
              }
            });
          }
        }, 500);
      }
    });
    return true;
  }
  
  // Legacy Slate-based prompt fill (kept as fallback)
  if (request.action === 'FILL_PROMPT') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: fillPromptReact,
      args: [request.text]
    }, (results) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else if (results && results[0]) {
        sendResponse(results[0].result);
      } else {
        sendResponse({ success: false, error: 'Unknown execution error' });
      }
    });
    return true;
  }

  // ---------------------------------------------------------
  // CHROME DEBUGGER PROTOCOL HANDLERS
  // These send input at the browser-engine level, bypassing
  // any JavaScript-level synthetic event rejection by Flow.
  // ---------------------------------------------------------

  // CA — Attach debugger to the sender tab
  if (request.action === 'CA') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab ID' });
      return true;
    }
    (async () => {
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
        debuggerAttachedTabs.add(tabId);
        sendResponse({ success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already attached')) {
          debuggerAttachedTabs.add(tabId);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: msg });
        }
      }
    })();
    return true;
  }

  // CD — Detach debugger from the sender tab
  if (request.action === 'CD') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab ID' });
      return true;
    }
    (async () => {
      const target = { tabId };
      try {
        if (debuggerAttachedTabs.has(tabId)) {
          await chrome.debugger.detach(target);
          debuggerAttachedTabs.delete(tabId);
        }
        sendResponse({ success: true });
      } catch (err) {
        debuggerAttachedTabs.delete(tabId);
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // CIT — Insert text via Chrome Debugger Protocol (Input.insertText)
  if (request.action === 'CIT') {
    const { text } = request;
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab ID' });
      return true;
    }
    (async () => {
      const target = { tabId };
      try {
        if (!debuggerAttachedTabs.has(tabId)) {
          await chrome.debugger.attach(target, '1.3');
          debuggerAttachedTabs.add(tabId);
        }
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // CK — Simulate key press via Chrome Debugger Protocol (Input.dispatchKeyEvent)
  if (request.action === 'CK') {
    const { key, keyCode, code } = request;
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab ID' });
      return true;
    }
    (async () => {
      const target = { tabId };
      try {
        if (!debuggerAttachedTabs.has(tabId)) {
          await chrome.debugger.attach(target, '1.3');
          debuggerAttachedTabs.add(tabId);
        }
        const params = {
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode
        };
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // CC — Simulate mouse click via Chrome Debugger Protocol (Input.dispatchMouseEvent)
  if (request.action === 'CC') {
    const { x, y } = request;
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No tab ID' });
      return true;
    }
    const target = { tabId };
    // Add small random jitter like the working extension does
    const jitter = () => Math.round(6 * (Math.random() - 0.5));
    const cx = x + jitter();
    const cy = y + jitter();

    const performClick = async () => {
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: cx, y: cy, button: 'none', modifiers: 0
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1, modifiers: 0
      });
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1, modifiers: 0
      });
    };

    (async () => {
      try {
        if (!debuggerAttachedTabs.has(tabId)) {
          await chrome.debugger.attach(target, '1.3');
          debuggerAttachedTabs.add(tabId);
        }
        await performClick();
        sendResponse({ success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse({ success: false, error: msg });
      }
    })();
    return true;
  }
});