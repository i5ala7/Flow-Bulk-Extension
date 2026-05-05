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
// SLATE / REACT PROMPT FILLER
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
    chrome.downloads.search({}, (items) => {
      let maxIndex = 0;
      for (const item of items) {
        if (item.exists && item.filename && item.filename.includes('bulk images')) {
          const match = item.filename.match(/bulk images[\\/](\d+)\.[a-zA-Z0-9]+$/i);
          if (match) {
            maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
          }
        }
      }
      sendResponse({ maxIndex });
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
        const downloadListener = (delta) => {
          if (delta.id === downloadId && delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              sendResponse({ success: true, downloadId });
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              sendResponse({ success: false, error: 'Download interrupted' });
            }
          }
        };
        chrome.downloads.onChanged.addListener(downloadListener);
      }
    });
    return true; 
  }
  
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
});