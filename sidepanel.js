let targetTabId = null;

function setUIState(state) {
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const resumeBtn = document.getElementById('resumeBtn');
  const stopBtn = document.getElementById('stopBtn');
  const inputs = document.querySelectorAll('textarea, select');
  const statusEl = document.getElementById('status');

  if (state === 'IDLE') {
    startBtn.style.display = 'block';
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    inputs.forEach(el => el.disabled = false);
  } else if (state === 'RUNNING') {
    startBtn.style.display = 'none';
    pauseBtn.style.display = 'block';
    resumeBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    inputs.forEach(el => el.disabled = true);
    statusEl.textContent = 'Running...';
  } else if (state === 'PAUSED') {
    startBtn.style.display = 'none';
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = 'block';
    stopBtn.style.display = 'block';
    statusEl.textContent = 'Paused.';
  }
}

document.getElementById('prompts').addEventListener('input', (e) => {
  const prompts = e.target.value.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  document.getElementById('promptCount').textContent = `${prompts.length} Prompts`;
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const promptsText = document.getElementById('prompts').value;
  const model = document.getElementById('model').value;
  const aspectRatio = document.getElementById('aspectRatio').value;
  const statusEl = document.getElementById('status');

  const prompts = promptsText.split('\n').map(p => p.trim()).filter(p => p.length > 0);
  if (prompts.length === 0) {
    statusEl.textContent = 'Please enter at least one prompt.';
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab || !tab.url || !tab.url.includes('labs.google/fx')) {
    statusEl.textContent = 'Please run this on labs.google/fx';
    return;
  }

  targetTabId = tab.id;
  setUIState('RUNNING');

  document.getElementById('progressBar').value = 0;
  document.getElementById('progressBar').max = prompts.length;
  document.getElementById('successCount').textContent = '0 ✓';
  document.getElementById('failCount').textContent = '0 ✗';

  chrome.tabs.sendMessage(targetTabId, {
    action: 'START_BULK',
    prompts: prompts,
    model: model,
    aspectRatio: aspectRatio
  }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'Error: Please refresh the Flow page and try again.';
      setUIState('IDLE');
    }
  });
});

document.getElementById('pauseBtn').addEventListener('click', () => {
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { action: 'PAUSE' });
    setUIState('PAUSED');
  }
});

document.getElementById('resumeBtn').addEventListener('click', () => {
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { action: 'RESUME' });
    setUIState('RUNNING');
  }
});

document.getElementById('stopBtn').addEventListener('click', () => {
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, { action: 'STOP' });
    setUIState('IDLE');
    document.getElementById('status').textContent = 'Stopped.';
  }
});

// Reset UI automatically when loop finishes naturally
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'BULK_FINISHED') {
    document.getElementById('status').textContent = 'Finished generating.';
    setUIState('IDLE');
  } else if (msg.action === 'PROGRESS_UPDATE') {
    document.getElementById('progressBar').value = msg.index + 1;
    if (msg.success) {
      const successCount = parseInt(document.getElementById('successCount').textContent);
      document.getElementById('successCount').textContent = `${successCount + 1} ✓`;
    } else {
      const failCount = parseInt(document.getElementById('failCount').textContent);
      document.getElementById('failCount').textContent = `${failCount + 1} ✗`;
    }
  }
});