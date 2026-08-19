const statusText = document.querySelector('#status-text');
const statusDot = document.querySelector('#status-bar .dot');
const result = document.querySelector('#result');
const noGame = document.querySelector('#no-game');
const moveEl = document.querySelector('#move');
const engineEl = document.querySelector('#engine');
const explanationEl = document.querySelector('#explanation');
const altMovesEl = document.querySelector('#alt-moves');
const evalContainer = document.querySelector('#eval-container');
const evalFill = document.querySelector('#eval-fill');
const evalLabel = document.querySelector('#eval-label');
const openingBanner = document.querySelector('#opening-banner');
const openingName = document.querySelector('#opening-name');
const darkToggle = document.querySelector('#dark-toggle');

let audioCtx = null;

function setStatus(text, active = false) {
  statusText.textContent = text;
  statusDot.classList.toggle('active', active);
}

function playNotifSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.2);
  } catch {}
}

function renderEval(engine) {
  const top = engine.moves[0];
  let cp = top.evaluation;
  if (cp == null && top.mate != null) cp = top.mate > 0 ? 10000 : -10000;
  if (cp == null) return;

  evalContainer.hidden = false;
  const pawns = (cp / 100).toFixed(1);
  evalLabel.textContent = pawns > 0 ? `+${pawns}` : pawns;

  const pct = 50 + (cp / 100) * 5;
  const clamped = Math.max(2, Math.min(98, pct));
  evalFill.style.height = clamped + '%';
  evalFill.style.background = clamped > 52 ? '#fffdf7' : clamped < 48 ? '#1d2824' : '#888';
}

function renderMoves(engine) {
  moveEl.textContent = engine.moves[0].move;
  altMovesEl.innerHTML = '';
  engine.moves.slice(1).forEach(m => {
    const chip = document.createElement('span');
    chip.className = 'move-chip';
    chip.textContent = m.move;
    altMovesEl.appendChild(chip);
  });
}

function renderAnalysis(analysis) {
  renderMoves(analysis.engine);
  renderEval(analysis.engine);

  const depth = analysis.engine.depth ?? '?';
  const eval_ = analysis.engine.moves[0].evaluation != null
    ? (analysis.engine.moves[0].evaluation / 100).toFixed(1)
    : analysis.engine.moves[0].mate != null
      ? `M${analysis.engine.moves[0].mate}`
      : '?';
  engineEl.textContent = `Depth ${depth} · Eval ${eval_}`;
  explanationEl.textContent = analysis.explanation;

  if (analysis.opening) {
    openingBanner.hidden = false;
    openingName.textContent = analysis.opening;
  }

  result.hidden = false;
  noGame.hidden = true;
  setStatus('Your turn \u2014 play the move', true);
  playNotifSound();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'analysis-result') {
    if (message.ok) {
      renderAnalysis(message);
    } else {
      setStatus(message.error || 'Analysis failed');
    }
  }
  if (message.type === 'monitoring-toggled') {
    if (message.monitoring) {
      setStatus('Monitoring active', true);
    } else {
      setStatus('Monitoring paused');
      result.hidden = true;
      noGame.hidden = false;
      evalContainer.hidden = true;
      openingBanner.hidden = true;
    }
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
      setStatus('Analyzing...', true);
      noGame.hidden = true;
      await chrome.runtime.sendMessage({ type: 'board-update', fen: response.position.fen });
    } else {
      setStatus('Waiting for game...');
      noGame.hidden = false;
    }
  } catch {
    setStatus('Waiting for game...');
    noGame.hidden = false;
  }
}

document.querySelector('#export-pgn').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'export-pgn' });
  if (resp?.ok && resp.pgn) {
    const blob = new Blob([resp.pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'game-analysis.pgn', saveAs: true });
  }
});

document.querySelector('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

darkToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  chrome.storage.local.set({ darkMode: isDark });
});

chrome.storage.local.get('darkMode', ({ darkMode }) => {
  if (darkMode) document.body.classList.add('dark');
});

init();
