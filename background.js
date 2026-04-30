// Enable side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Helper function to be safely injected into the page's MAIN world
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

    // Select all existing text safely using Slate's internal selection
    const lastIdx = Math.max(0, slate.children.length - 1);
    const lastChild = slate.children[lastIdx];
    const lastOffset = (lastChild && lastChild.children && lastChild.children[0])
      ? (lastChild.children[0].text || '').length : 0;
      
    slate.select({
      anchor: { path: [0, 0], offset: 0 },
      focus:  { path: [lastIdx, 0], offset: lastOffset }
    });
    
    // Safely replace text via Slate directly
    slate.insertText(text);
    
    // Force DOM event to ensure any wrappers catch the change
    editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'DOWNLOAD_IMAGE') {
    const { url, index } = request;
    const promptNumber = index + 1;
    const formattedIndex = promptNumber.toString().padStart(2, '0');
    const filename = `bulk images/${formattedIndex}.png`;

    console.log(`[Background] Downloading image ${formattedIndex}...`);

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[Background] Download failed:`, chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log(`[Background] Download started with ID: ${downloadId}. Waiting for completion...`);
        
        // Listen for the download to finish
        const downloadListener = (delta) => {
          if (delta.id === downloadId && delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              console.log(`[Background] Download ${downloadId} completed.`);
              sendResponse({ success: true, downloadId });
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(downloadListener);
              console.error(`[Background] Download ${downloadId} interrupted.`);
              sendResponse({ success: false, error: 'Download interrupted' });
            }
          }
        };
        chrome.downloads.onChanged.addListener(downloadListener);
      }
    });

    return true; // Keep the message channel open to sendResponse asynchronously
  }
  
  if (request.action === 'FILL_PROMPT') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: fillPromptReact,
      args: [request.text]
    }, (results) => {
      if (chrome.runtime.lastError) {
        console.error('[Background] Scripting error:', chrome.runtime.lastError);
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