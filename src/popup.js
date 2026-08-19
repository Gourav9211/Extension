const statusText = document.querySelector('#status-text');
const statusDot = document.querySelector('#status-bar .dot');
const analyzeButton = document.querySelector('#analyze');
const result = document.querySelector('#result');
const noGame = document.querySelector('#no-game');
const moveEl = document.querySelector('#move');
const engineEl = document.querySelector('#engine');
const explanationEl = document.querySelector('#explanation');

function setStatus(text, active = false) {
  statusText.textContent = text;
  statusDot.classList.toggle('active', active);
}

function renderAnalysis(analysis) {
  moveEl.textContent = analysis.engine.move;
  const depth = analysis.engine.depth ?? '?';
  const evaluation = analysis.engine.evaluation != null ? (analysis.engine.evaluation / 100).toFixed(1) : '?';
  engineEl.textContent = `Depth ${depth} · Eval ${evaluation}`;
  explanationEl.textContent = analysis.explanation;
  result.hidden = false;
  noGame.hidden = true;
}

analyzeButton.addEventListener('click', async () => {
  analyzeButton.disabled = true;
  result.hidden = true;
  setStatus('Reading the board...', true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('chess.com')) throw new Error('Open a Chess.com analysis board first.');
    const captured = await chrome.tabs.sendMessage(tab.id, { type: 'capture-position' });
    if (!captured?.ok) throw new Error(captured?.error || 'Could not capture the board.');

    setStatus('Analyzing position...', true);
    const analysis = await chrome.runtime.sendMessage({ type: 'analyze-position', fen: captured.position.fen });
    if (!analysis?.ok) throw new Error(analysis?.error || 'Analysis failed.');
    renderAnalysis(analysis);
    setStatus('Analysis complete.');
  } catch (error) {
    noGame.hidden = false;
    setStatus(error.message);
  } finally {
    analyzeButton.disabled = false;
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url?.includes('chess.com')) {
    setStatus('Open Chess.com to start');
    noGame.hidden = false;
    result.hidden = true;
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'capture-position' });
    if (response?.ok) {
      setStatus('Board ready.', true);
      noGame.hidden = true;
    } else {
      setStatus('Waiting for a board...');
      noGame.hidden = false;
    }
  } catch {
    setStatus('Waiting for a board...');
    noGame.hidden = false;
  }
}

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

init();
