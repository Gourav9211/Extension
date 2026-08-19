const analyzeButton = document.querySelector('#analyze');
const settingsButton = document.querySelector('#settings');
const status = document.querySelector('#status');
const result = document.querySelector('#result');

function setStatus(message) {
  status.textContent = message;
}

settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  result.hidden = true;
  setStatus('Reading the visible board...');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const captured = await chrome.tabs.sendMessage(tab.id, { type: 'capture-position' });
    if (!captured?.ok) throw new Error(captured?.error || 'Could not capture the board.');
    setStatus('Checking the position...');
    const analyzed = await chrome.runtime.sendMessage({ type: 'analyze-position', fen: captured.position.fen });
    if (!analyzed?.ok) throw new Error(analyzed?.error || 'Could not analyze the position.');
    document.querySelector('#move').textContent = analyzed.engine.move;
    document.querySelector('#engine').textContent = `Cloud engine depth ${analyzed.engine.depth ?? 'unknown'} · ${captured.position.source}`;
    document.querySelector('#explanation').textContent = analyzed.explanation;
    result.hidden = false;
    setStatus('Analysis complete.');
  } catch (error) {
    setStatus(error.message);
  } finally {
    analyzeButton.disabled = false;
  }
});
