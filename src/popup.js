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
const graphSection = document.querySelector('#graph-section');
const graphCanvas = document.querySelector('#eval-graph');
const historySection = document.querySelector('#history-section');
const moveHistory = document.querySelector('#move-history');
const accuracyBadge = document.querySelector('#accuracy-badge');
const classifyBanner = document.querySelector('#classification-banner');
const classifyIcon = document.querySelector('#classify-icon');
const classifyText = document.querySelector('#classify-text');

let audioCtx = null;
let evalHistory = [];
let settings = { sound: true, coords: true, graph: true, history: true, classify: true };
let graphRafPending = false;
let latestEvals = null;

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (data) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(data || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve((tabs && tabs[0]) || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function openOptionsPageSafe() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.openOptionsPage(function() {
        if (chrome.runtime.lastError) {
          try {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') }, function() {
              resolve();
            });
          } catch (e) {
            resolve();
          }
        } else {
          resolve();
        }
      });
    } catch (e) {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/options.html') }, function() {
          resolve();
        });
      } catch (err) {
        resolve();
      }
    }
  });
}

function setStatus(text, active) {
  statusText.textContent = text;
  statusDot.classList.toggle('active', !!active);
}

async function loadSettings() {
  const stored = await storageGet(Object.keys(settings));
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
  const pawns = (cp / 100).toFixed(1);
  evalLabel.textContent = pawns > 0 ? '+' + pawns : pawns;
  const pct = 50 + (cp / 100) * 5;
  const clamped = Math.max(2, Math.min(98, pct));
  evalFill.style.height = clamped + '%';
  evalFill.style.background = clamped > 52 ? '#fffdf7' : clamped < 48 ? '#1d2824' : '#888';
}

function renderMoves(engine) {
  moveEl.textContent = engine.moves[0].move;
  altMovesEl.innerHTML = '';
  engine.moves.slice(1).forEach(function(m) {
    const chip = document.createElement('span');
    chip.className = 'move-chip';
    chip.textContent = m.move;
    altMovesEl.appendChild(chip);
  });
}

function renderClassification(cls) {
  if (!settings.classify || !cls) {
    classifyBanner.hidden = true;
    return;
  }
  classifyBanner.hidden = false;
  const labels = { brilliant: '!!', good: '!', inaccuracy: '?!', mistake: '?', blunder: '??' };
  const colors = { brilliant: '#2ecc71', good: '#27ae60', inaccuracy: '#f39c12', mistake: '#e74c3c', blunder: '#c0392b' };
  classifyIcon.textContent = labels[cls] || '';
  classifyIcon.style.color = colors[cls] || '#999';
  classifyText.textContent = cls.charAt(0).toUpperCase() + cls.slice(1);
  classifyText.style.color = colors[cls] || '#999';
}

function drawGraph(evals) {
  const ctx = graphCanvas.getContext('2d');
  const w = graphCanvas.width;
  const h = graphCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const validEvals = evals.map(function(e) {
    if (e == null) return 0;
    return Math.max(-1000, Math.min(1000, e));
  });

  ctx.fillStyle = '#e8e4db';
  ctx.fillRect(0, 0, w, h);

  ctx.beginPath();
  for (let i = 0; i < validEvals.length; i++) {
    const x = (i / (validEvals.length - 1)) * w;
    const y = h / 2 - (validEvals[i] / 1000) * (h / 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#263d32';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  for (let i = 0; i < validEvals.length; i++) {
    const x = (i / (validEvals.length - 1)) * w;
    const y = h / 2 - (validEvals[i] / 1000) * (h / 2);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h / 2);
  ctx.lineTo(0, h / 2);
  ctx.fillStyle = validEvals[validEvals.length - 1] > 0 ? 'rgba(38,61,50,0.15)' : 'rgba(192,57,43,0.15)';
  ctx.fill();
}

function renderGraph(evals) {
  if (!settings.graph || evals.length < 2) {
    graphSection.hidden = true;
    return;
  }
  graphSection.hidden = false;
  latestEvals = evals;
  if (!graphRafPending) {
    graphRafPending = true;
    requestAnimationFrame(function() {
      graphRafPending = false;
      if (latestEvals) drawGraph(latestEvals);
    });
  }
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
    div.className = 'history-entry';
    const num = (i + 1) + '. ';
    const moveSpan = document.createElement('span');
    moveSpan.className = 'history-move';
    moveSpan.textContent = num + entry.bestMove;
    const evalSpan = document.createElement('span');
    evalSpan.className = 'history-eval';
    if (entry.eval != null) {
      const pawns = (entry.eval / 100).toFixed(1);
      evalSpan.textContent = (pawns > 0 ? '+' : '') + pawns;
    }
    const clsSpan = document.createElement('span');
    clsSpan.className = 'history-cls';
    if (entry.classification) {
      const labels = { brilliant: '!!', good: '!', inaccuracy: '?!', mistake: '?', blunder: '??' };
      clsSpan.textContent = labels[entry.classification] || '';
      const colors = { brilliant: '#2ecc71', good: '#27ae60', inaccuracy: '#f39c12', mistake: '#e74c3c', blunder: '#c0392b' };
      clsSpan.style.color = colors[entry.classification] || '#999';
    }
    div.appendChild(moveSpan);
    div.appendChild(evalSpan);
    div.appendChild(clsSpan);
    moveHistory.appendChild(div);
  }
  moveHistory.scrollTop = moveHistory.scrollHeight;
}

function calculateAccuracyFromHistory(history) {
  if (history.length < 2) return null;
  let totalScore = 0;
  let count = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].eval;
    const curr = history[i].eval;
    if (prev != null && curr != null) {
      const swing = Math.abs(prev - curr);
      const clamped = Math.min(swing, 1000);
      totalScore += Math.max(0, 100 - clamped / 15);
      count++;
    }
  }
  return count > 0 ? Math.min(100, Math.max(0, totalScore / count)) : null;
}

function renderAccuracy(history) {
  const acc = calculateAccuracyFromHistory(history);
  if (acc == null) {
    accuracyBadge.hidden = true;
    return;
  }
  accuracyBadge.hidden = false;
  accuracyBadge.textContent = 'Accuracy: ' + Math.round(acc) + '%';
}

function renderAnalysis(analysis) {
  renderMoves(analysis.engine);
  renderEval(analysis.engine);
  renderClassification(analysis.classification);

  const depth = analysis.engine.depth === 100 ? 'TB' : analysis.engine.depth || '?';
  const topMove = analysis.engine.moves[0];
  let eval_;
  if (analysis.tablebase) {
    eval_ = topMove.mate != null ? 'M' + topMove.mate : (topMove.category || '?');
  } else {
    eval_ = topMove.evaluation != null ? (topMove.evaluation / 100).toFixed(1) :
      topMove.mate != null ? 'M' + topMove.mate : '?';
  }
  engineEl.textContent = 'Depth ' + depth + ' \u00b7 Eval ' + eval_ + (analysis.tablebase ? ' (tablebase)' : '');
  explanationEl.textContent = analysis.explanation;

  if (analysis.opening) {
    openingBanner.hidden = false;
    openingName.textContent = analysis.opening;
  }

  result.hidden = false;
  noGame.hidden = true;
  setStatus('Your turn \u2014 play the move', true);
  playNotifSound();

  evalHistory.push(evalToCp(analysis.engine));
  renderGraph(evalHistory);
}

async function refreshHistory() {
  try {
    const resp = await runtimeSendMessage({ type: 'get-history' });
    if (resp && resp.ok) {
      renderMoveHistory(resp.history);
      renderAccuracy(resp.history);
    }
  } catch (e) {}
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'analysis-result') {
    if (message.ok) {
      renderAnalysis(message);
      refreshHistory();
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
      classifyBanner.hidden = true;
    }
  }
  if (message.type === 'darkMode-changed') {
    if (message.darkMode) document.body.classList.add('dark');
    else document.body.classList.remove('dark');
  }
});

async function init() {
  await loadSettings();
  chrome.storage.local.get('darkMode', (data) => {
    if (data.darkMode) document.body.classList.add('dark');
  });
  const tab = await queryActiveTab();
  if (!tab || !tab.url || !tab.url.includes('chess.com')) {
    setStatus('Open Chess.com to start');
    noGame.hidden = false;
    result.hidden = true;
    return;
  }
  try {
    const response = await tabsSendMessage(tab.id, { type: 'capture-position' });
    if (response && response.ok) {
      setStatus('Analyzing...', true);
      noGame.hidden = true;
      await runtimeSendMessage({ type: 'board-update', fen: response.position.fen });
    } else {
      setStatus('Waiting for game...');
      noGame.hidden = false;
    }
  } catch (e) {
    setStatus('Waiting for game...');
    noGame.hidden = false;
  }
}

document.querySelector('#export-pgn').addEventListener('click', async () => {
  const resp = await runtimeSendMessage({ type: 'export-pgn' });
  if (resp && resp.ok && resp.pgn) {
    const blob = new Blob([resp.pgn], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url: url, filename: 'game-analysis.pgn', saveAs: true });
  }
});

document.querySelector('#save-game').addEventListener('click', async () => {
  const resp = await runtimeSendMessage({ type: 'save-game' });
  if (resp && resp.ok) {
    setStatus('Game saved to archive.');
  }
});

document.querySelector('#settings').addEventListener('click', async () => {
  await openOptionsPageSafe();
});

darkToggle.addEventListener('click', async () => {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  await storageSet({ darkMode: isDark });
});

init();
