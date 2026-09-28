const $ = (s) => document.querySelector(s);

const statusBar = $('#status-bar');
const statusText = $('#status-text');
const result = $('#result');
const noGame = $('#no-game');
const moveEl = $('#move');
const engineEl = $('#engine');
const evalNumEl = $('#eval-num');
const evalSideEl = $('#eval-side');
const depthBadge = $('#depth-badge');
const explanationEl = $('#explanation');
const explanationSection = $('#explanation-section');
const altMovesEl = $('#alt-moves');
const maiaSection = $('#maia-section');
const maiaEloEl = $('#maia-elo');
const maiaEvalEl = $('#maia-eval');
const maiaMovesEl = $('#maia-moves');
const maiaNoteEl = $('#maia-note');
const evalContainer = $('#eval-container');
const evalFill = $('#eval-fill');
const openingBanner = $('#opening-banner');
const openingName = $('#opening-name');
const darkToggle = $('#dark-toggle');
const toggleAnalysisBtn = $('#toggle-analysis');
const graphSection = $('#graph-section');
const graphCanvas = $('#eval-graph');
const historySection = $('#history-section');
const moveHistory = $('#move-history');
const accuracyBadge = $('#accuracy-badge');
const classifyBanner = $('#classification-banner');
const classifyIcon = $('#classify-icon');
const classifyText = $('#classify-text');
const updateBanner = $('#update-banner');
const updateText = $('#update-text');
const updateLink = $('#update-link');
const versionText = $('#version-text');
const updateStatusText = $('#update-status-text');
const checkUpdateBtn = $('#check-update');
const skeleton = $('#skeleton');

let audioCtx = null;
let evalHistory = [];
let analyzingTimer = null;
let monitoring = false;
let settings = { sound: true, coords: true, graph: true, history: true, classify: true };

// Classification colours. Defined once so the banner and the history rows
// cannot drift apart.
const CLASSES = {
  brilliant: { sym: '!!', color: '#4ade80' },
  good: { sym: '!', color: '#86efac' },
  inaccuracy: { sym: '?!', color: '#f0b45e' },
  mistake: { sym: '?', color: '#fb923c' },
  blunder: { sym: '??', color: '#f87171' }
};

function setStatus(text, mode) {
  statusText.textContent = text;
  statusBar.classList.toggle('live', mode === 'live');
  statusBar.classList.toggle('busy', mode === 'busy');
  statusBar.classList.toggle('err', mode === 'err');
  skeleton.hidden = mode !== 'busy';
}

// Never leave "Analyzing..." hanging: if no result lands within 45s the
// engine is wedged or extremely slow - say so instead of spinning forever.
function armAnalyzingWatchdog() {
  clearTimeout(analyzingTimer);
  analyzingTimer = setTimeout(function() {
    setStatus('Still analysing - engine slow or stuck', 'busy');
  }, 45000);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(settings));
  for (const key of Object.keys(settings)) {
    if (stored[key] != null) settings[key] = stored[key];
  }
}

function playNotifSound() {
  if (!settings.sound) return;
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
  } catch (e) {}
}

function evalToCp(engine) {
  const top = engine.moves[0];
  let cp = top.evaluation;
  if (cp == null && top.mate != null) cp = top.mate > 0 ? 10000 : -10000;
  return cp;
}

function renderEval(engine) {
  const cp = evalToCp(engine);
  if (cp == null) return;
  evalContainer.hidden = false;
  // Map centipawns to a 0-100 bar. The scale saturates at +/-8 pawns so a
  // winning position is not permanently pinned to the right edge, and the
  // midpoint stays exactly 50 at equality.
  const pct = Math.max(2, Math.min(98, 50 + (cp / 800) * 50));
  evalFill.style.width = pct + '%';
  evalFill.classList.toggle('white', cp > 0);
}

function formatEvalShort(m) {
  if (m.mate != null) return 'M' + m.mate;
  if (m.evaluation != null) {
    const pawns = (m.evaluation / 100).toFixed(1);
    return pawns > 0 ? '+' + pawns : pawns;
  }
  return '';
}

// Pawn-equivalent score for the headline number, mate-aware.
function headlineEval(topMove) {
  if (topMove.mate != null) return { text: 'M' + topMove.mate, side: topMove.mate > 0 ? 'white' : 'black' };
  if (topMove.evaluation != null) {
    const p = topMove.evaluation / 100;
    return { text: (p > 0 ? '+' : '') + p.toFixed(1), side: p > 0 ? 'white' : p < 0 ? 'black' : 'even' };
  }
  return { text: '--', side: 'even' };
}

function renderMoves(engine) {
  const top = engine.moves[0];
  moveEl.textContent = top.move;
  const ev = headlineEval(top);
  evalNumEl.textContent = ev.text;
  evalSideEl.textContent = ev.side;
  evalNumEl.classList.toggle('white', ev.side === 'white');
  evalNumEl.classList.toggle('black', ev.side === 'black');

  altMovesEl.innerHTML = '';
  const ordinals = ['2nd', '3rd', '4th', '5th'];
  engine.moves.slice(1).forEach(function(m, i) {
    const row = document.createElement('div');
    row.className = 'alt';
    const rank = document.createElement('span');
    rank.className = 'alt-rank';
    rank.textContent = ordinals[i] || ((i + 2) + 'th');
    const move = document.createElement('span');
    move.className = 'alt-move';
    move.textContent = m.move;
    const evalEl = document.createElement('span');
    evalEl.className = 'alt-eval';
    evalEl.textContent = formatEvalShort(m);
    row.append(rank, move, evalEl);
    altMovesEl.appendChild(row);
  });
}

// Maia's own distribution over legal moves. The percentages are relative to
// what a player of that strength would consider, not to the engine's ranking,
// which is why they get their own panel rather than joining the alt-move list.
function renderMaia(maia) {
  if (!maia || !maia.moves || !maia.moves.length) {
    maiaSection.hidden = true;
    return;
  }
  maiaSection.hidden = false;
  // Maia-3 is told both ratings, so show the opponent's whenever it is not just
  // mirroring the player's - otherwise the panel reads as if Maia were
  // ignoring a setting the options page exposes.
  maiaEloEl.textContent = maia.opponentElo && maia.opponentElo !== maia.elo
    ? maia.elo + ' vs ' + maia.opponentElo
    : String(maia.elo);

  const wdl = maia.wdl || [0, 0, 0];
  const win = Math.round((wdl[2] || 0) * 100);
  const loss = Math.round((wdl[0] || 0) * 100);
  if (typeof maia.scoreCp === 'number') {
    const pawns = (maia.scoreCp / 100).toFixed(1);
    maiaEvalEl.textContent = (pawns > 0 ? '+' : '') + pawns + '  \u00b7  ' + win + '/' + loss + ' w/l';
  } else {
    maiaEvalEl.textContent = win + '/' + loss + ' w/l';
  }

  maiaMovesEl.innerHTML = '';
  const selection = maia.selection;
  const playedKey = selection && selection.uci ? selection.uci.substring(0, 4) : null;
  const top = maia.moves[0].prob || 0;
  maia.moves.slice(0, 5).forEach(function(m) {
    const row = document.createElement('div');
    row.className = 'maia-bar';
    if (playedKey && m.uci.substring(0, 4) === playedKey) row.classList.add('picked');
    const move = document.createElement('span');
    move.className = 'maia-move';
    move.textContent = m.uci;
    const track = document.createElement('div');
    track.className = 'maia-track';
    const fill = document.createElement('div');
    fill.className = 'maia-fill';
    // Scale against Maia's own best move so the bars stay readable even when
    // every candidate is improbable.
    fill.style.width = (top > 0 ? Math.max(4, (m.prob / top) * 100) : 4) + '%';
    track.appendChild(fill);
    const num = document.createElement('span');
    num.className = 'maia-pct';
    num.textContent = Math.round((m.prob || 0) * 100) + '%';
    row.append(move, track, num);
    maiaMovesEl.appendChild(row);
  });

  maiaNoteEl.classList.remove('guarded');
  if (selection && selection.fromMaia) {
    maiaNoteEl.textContent = 'Would play ' + selection.uci + '.';
  } else if (selection && selection.reason === 'guarded') {
    maiaNoteEl.textContent = 'Every move Maia wanted was too losing for the blunder guard, so Stockfish moves instead.';
    maiaNoteEl.classList.add('guarded');
  } else {
    maiaNoteEl.textContent = '';
  }
}

function setExplanation(text) {
  explanationEl.textContent = text || '';
  explanationSection.hidden = !text;
}

function renderClassification(cls) {
  if (!settings.classify || !cls) {
    classifyBanner.hidden = true;
    return;
  }
  classifyBanner.hidden = false;
  const c = CLASSES[cls];
  classifyIcon.textContent = c ? c.sym : '';
  classifyText.textContent = cls.charAt(0).toUpperCase() + cls.slice(1);
  classifyBanner.style.color = c ? c.color : '';
}

function renderGraph(evals) {
  if (!settings.graph || evals.length < 2) {
    graphSection.hidden = true;
    return;
  }
  graphSection.hidden = false;
  const ctx = graphCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = graphCanvas.clientWidth || 360;
  const cssH = 54;
  // Size the backing store to device pixels so the line is not blurry on
  // HiDPI displays, then scale so all drawing stays in CSS pixels.
  graphCanvas.width = Math.round(cssW * dpr);
  graphCanvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const valid = evals.map(e => (e == null ? 0 : Math.max(-1000, Math.min(1000, e))));
  const x = (i) => (i / (valid.length - 1)) * cssW;
  const y = (v) => cssH / 2 - (v / 1000) * (cssH / 2 - 2);

  // Area fill first, so the stroke lands on top of it.
  ctx.beginPath();
  ctx.moveTo(0, cssH / 2);
  for (let i = 0; i < valid.length; i++) ctx.lineTo(x(i), y(valid[i]));
  ctx.lineTo(cssW, cssH / 2);
  ctx.closePath();
  const lead = valid[valid.length - 1];
  const g = ctx.createLinearGradient(0, 0, 0, cssH);
  if (lead >= 0) { g.addColorStop(0, '#4ade8033'); g.addColorStop(1, '#4ade8000'); }
  else { g.addColorStop(0, '#f8717100'); g.addColorStop(1, '#f8717133'); }
  ctx.fillStyle = g;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < valid.length; i++) {
    if (i === 0) ctx.moveTo(x(i), y(valid[i])); else ctx.lineTo(x(i), y(valid[i]));
  }
  ctx.strokeStyle = lead >= 0 ? '#4ade80' : '#f87171';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Marker on the latest point, so the current state is unambiguous.
  ctx.beginPath();
  ctx.arc(x(valid.length - 1), y(lead), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = lead >= 0 ? '#4ade80' : '#f87171';
  ctx.fill();
}

function renderMoveHistory(history) {
  if (!settings.history || history.length < 2) {
    historySection.hidden = true;
    return;
  }
  historySection.hidden = false;
  moveHistory.innerHTML = '';
  const last20 = history.slice(-20);
  for (let i = 0; i < last20.length; i++) {
    const entry = last20[i];
    const div = document.createElement('div');
    div.className = 'hist-row';
    const num = document.createElement('span');
    num.className = 'hist-n';
    num.textContent = (i + 1) + '.';
    const moveSpan = document.createElement('span');
    moveSpan.textContent = entry.bestMove;
    const evalSpan = document.createElement('span');
    evalSpan.className = 'hist-e';
    if (entry.eval != null) {
      const pawns = (entry.eval / 100).toFixed(1);
      evalSpan.textContent = (pawns > 0 ? '+' : '') + pawns;
    }
    const clsSpan = document.createElement('span');
    clsSpan.className = 'hist-c';
    const c = CLASSES[entry.classification];
    if (c) {
      clsSpan.textContent = c.sym;
      clsSpan.style.color = c.color;
    }
    div.append(num, moveSpan, evalSpan, clsSpan);
    moveHistory.appendChild(div);
  }
  moveHistory.scrollTop = moveHistory.scrollHeight;
}

function calculateAccuracyFromHistory(history) {
  if (history.length < 2) return null;
  let totalDiff = 0;
  let count = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].eval;
    const curr = history[i].eval;
    if (prev != null && curr != null) {
      totalDiff += Math.max(0, 100 - Math.abs(prev - curr) / 10);
      count++;
    }
  }
  return count > 0 ? totalDiff / count : null;
}

function renderAccuracy(history) {
  const acc = calculateAccuracyFromHistory(history);
  if (acc == null) {
    accuracyBadge.hidden = true;
    return;
  }
  accuracyBadge.hidden = false;
  accuracyBadge.textContent = Math.round(acc) + '% acc';
}

function renderAnalysis(analysis) {
  renderMoves(analysis.engine);
  renderEval(analysis.engine);
  renderClassification(analysis.classification);
  renderMaia(analysis.maia);
  setExplanation(analysis.explanation);

  const depth = analysis.engine.depth === 100 ? 'TB' : analysis.engine.depth || '?';
  depthBadge.textContent = 'd' + depth;
  const topMove = analysis.engine.moves[0];
  engineEl.textContent = analysis.tablebase
    ? 'Tablebase verdict'
    : (topMove.line ? topMove.line.split(' ').slice(0, 6).join(' ') : 'depth ' + depth);

  if (analysis.opening) {
    openingBanner.hidden = false;
    openingName.textContent = analysis.opening;
  }

  result.hidden = false;
  noGame.hidden = true;
  setStatus('Your turn', 'live');
  playNotifSound();

  evalHistory.push(evalToCp(analysis.engine));
  renderGraph(evalHistory);
}

async function refreshHistory() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'get-history' });
    if (resp && resp.ok) {
      renderMoveHistory(resp.history);
      renderAccuracy(resp.history);
    }
  } catch (e) {}
}

function clearResultPanels() {
  result.hidden = true;
  evalContainer.hidden = true;
  openingBanner.hidden = true;
  classifyBanner.hidden = true;
  maiaSection.hidden = true;
  explanationSection.hidden = true;
  graphSection.hidden = true;
  historySection.hidden = true;
  evalHistory = [];
}

function setMonitoringUI(on) {
  monitoring = !!on;
  toggleAnalysisBtn.setAttribute('aria-pressed', String(monitoring));
  toggleAnalysisBtn.title = monitoring
    ? 'Pause analysis (Ctrl+Shift+A)'
    : 'Resume analysis (Ctrl+Shift+A)';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'analysis-result') {
    clearTimeout(analyzingTimer);
    if (message.ok) {
      renderAnalysis(message);
      refreshHistory();
    } else {
      setStatus(message.error || 'Analysis failed', 'err');
    }
  }
  if (message.type === 'analysis-explanation') {
    setExplanation(message.explanation);
  }
  if (message.type === 'monitoring-toggled') {
    setMonitoringUI(message.monitoring);
    if (message.monitoring) {
      setStatus('Monitoring active', 'live');
    } else {
      setStatus('Analysis paused');
      clearResultPanels();
      noGame.hidden = false;
    }
  }
});

function applyUpdateStatus(status) {
  if (status && status.updateAvailable && status.releaseUrl) {
    updateBanner.hidden = false;
    updateText.textContent = 'v' + status.latestVersion + ' available';
    updateLink.href = status.releaseUrl;
  } else {
    updateBanner.hidden = true;
    updateLink.removeAttribute('href');
  }
}

async function refreshUpdateStatus(force) {
  const originalLabel = checkUpdateBtn.textContent;
  checkUpdateBtn.disabled = true;
  checkUpdateBtn.textContent = '...';
  updateStatusText.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'check-update', force: !!force });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'no response');
    applyUpdateStatus(resp.update);
    if (resp.update && !resp.update.updateAvailable) {
      updateStatusText.textContent = 'Up to date';
    }
  } catch (e) {
    updateStatusText.textContent = 'Update check failed';
    updateStatusText.title = e.message || String(e);
    applyUpdateStatus(null);
  } finally {
    checkUpdateBtn.disabled = false;
    checkUpdateBtn.textContent = originalLabel;
  }
}

async function init() {
  await loadSettings();

  // The master switch lives in the service worker, so ask rather than guess:
  // reading storage directly here would race the worker's own load.
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get-settings' });
    if (r && r.ok) setMonitoringUI(r.settings.monitoring !== false);
  } catch (e) {}

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('chess.com')) {
    setStatus('Open Chess.com to start');
    noGame.hidden = false;
    result.hidden = true;
    maiaSection.hidden = true;
    return;
  }
  if (!monitoring) {
    setStatus('Analysis paused');
    noGame.hidden = false;
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'capture-position' });
    if (response && response.ok) {
      setStatus('Analysing', 'busy');
      armAnalyzingWatchdog();
      noGame.hidden = true;
      await chrome.runtime.sendMessage({ type: 'board-update', fen: response.position.fen });
    } else {
      setStatus('Waiting for game');
      noGame.hidden = false;
    }
  } catch (e) {
    setStatus('Waiting for game');
    noGame.hidden = false;
  }
}

$('#export-pgn').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'export-pgn' });
  if (resp && resp.ok && resp.pgn) {
    const blob = new Blob([resp.pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url: url, filename: 'game-analysis.pgn', saveAs: true });
  }
});

$('#save-game').addEventListener('click', async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'save-game' });
  if (resp && resp.ok) {
    setStatus('Game saved', 'live');
  }
});

$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

checkUpdateBtn.addEventListener('click', () => refreshUpdateStatus(true));

// Same action as the Ctrl+Shift+A command: the service worker owns the toggle
// so the state stays consistent across the command, this button and the popup.
toggleAnalysisBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ monitoring: !monitoring });
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: monitoring ? 'start-monitoring' : 'stop-monitoring'
      });
    }
  } catch (e) {}
  setMonitoringUI(!monitoring);
  if (monitoring) setStatus('Monitoring active', 'live');
  else { setStatus('Analysis paused'); clearResultPanels(); noGame.hidden = false; }
});

// Dark is the default in this build. `darkMode` is stored as-is (true = dark)
// so a user who explicitly chose light stays on light.
function applyTheme(dark) {
  document.body.classList.toggle('light', !dark);
  document.body.classList.toggle('dark', dark);
  darkToggle.textContent = dark ? '\u2600' : '\u263D';
  darkToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

darkToggle.addEventListener('click', async () => {
  const dark = !document.body.classList.contains('dark');
  applyTheme(dark);
  await chrome.storage.local.set({ darkMode: dark });
  // The graph draws with literal colours, so it has to be repainted on a
  // theme change or it keeps the previous palette.
  renderGraph(evalHistory);
});

chrome.storage.local.get('darkMode', (data) => applyTheme(data.darkMode !== false));
applyTheme(true);
init();
versionText.textContent = 'v' + chrome.runtime.getManifest().version;
refreshUpdateStatus(false);
