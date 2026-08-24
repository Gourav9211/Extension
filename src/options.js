const $ = (sel) => document.querySelector(sel);
const DEFAULTS = {
  depth: 22,
  autoPlay: false,
  adaptiveOpponent: true,
  multiPv: 3,
  sound: true,
  darkMode: false,
  coords: true,
  graph: true,
  history: true,
  classify: true,
  geminiKey: '',
  geminiPrompt: '',
  debounceMs: 500,
  engineMoveTimeMs: 8000,
  autoTimingMode: 'match',
  autoBeatByMs: 1000,
  autoDelayMinMs: 2500,
  autoDelayMaxMs: 4000,
  autoSlowOneIn: 3,
  autoSlowMinMs: 5500,
  autoSlowMaxMs: 10000,
  autoNormalOneIn: 5,
  autoNormalEvalCp: 150
};

function setStatus(msg) {
  const el = $('#status');
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const val = stored[key] ?? def;
    const el = $(`#${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = val;
    else el.value = val;
  }
  if (stored.darkMode) document.body.classList.add('dark');
}

async function saveSettings() {
  const settings = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const el = $(`#${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') settings[key] = el.checked;
    else if (el.type === 'number') settings[key] = parseInt(el.value) || def;
    else settings[key] = el.value;
  }
  await chrome.storage.local.set(settings);
  if (settings.darkMode) document.body.classList.add('dark');
  else document.body.classList.remove('dark');
  setStatus('Settings saved.');
}

async function loadArchive() {
  const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
  const list = $('#archiveList');
  if (!gameArchive.length) {
    list.innerHTML = '<div class="empty">No saved games yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const game of gameArchive.slice().reverse()) {
    const div = document.createElement('div');
    div.className = 'archive-item';
    const date = new Date(game.timestamp).toLocaleDateString();
    const moveCount = game.moves ? game.moves.length : 0;
    const accuracy = game.accuracy != null ? Math.round(game.accuracy) + '%' : '--';
    div.innerHTML = '<span class="date">' + date + '</span> &middot; ' +
      moveCount + ' moves &middot; accuracy: ' + accuracy;
    div.addEventListener('click', () => {
      const pgn = gameToPGN(game);
      downloadFile(pgn, 'game-' + date + '.pgn', 'application/x-chess-pgn');
    });
    list.appendChild(div);
  }
}

function gameToPGN(game) {
  let pgn = '[Event "Analyzed Game"]\n';
  pgn += '[Date "' + new Date(game.timestamp).toISOString().split('T')[0] + '"]\n';
  pgn += '[White "User"]\n[Black "Engine"]\n\n';
  const moves = game.moves || [];
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) pgn += (Math.floor(i / 2) + 1) + '. ';
    pgn += moves[i] + ' ';
  }
  return pgn.trim();
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type: type || 'text/plain' });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true });
}

async function loadAccuracy() {
  const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
  const el = $('#accuracyStats');
  if (!gameArchive.length) {
    el.innerHTML = '<div class="empty">Play and analyze games to see your accuracy score.</div>';
    return;
  }
  const games = gameArchive.filter(g => g.accuracy != null);
  if (!games.length) {
    el.innerHTML = '<div class="empty">No accuracy data yet. Finish a game to see stats.</div>';
    return;
  }
  const avg = games.reduce((s, g) => s + g.accuracy, 0) / games.length;
  const best = Math.max(...games.map(g => g.accuracy));
  const worst = Math.min(...games.map(g => g.accuracy));
  el.innerHTML =
    '<div class="row"><label>Average accuracy</label><strong>' + Math.round(avg) + '%</strong></div>' +
    '<div class="row"><label>Best game</label><strong>' + Math.round(best) + '%</strong></div>' +
    '<div class="row"><label>Worst game</label><strong>' + Math.round(worst) + '%</strong></div>' +
    '<div class="row"><label>Games analyzed</label><strong>' + games.length + '</strong></div>';
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadArchive();
  await loadAccuracy();

  for (const key of Object.keys(DEFAULTS)) {
    const el = $(`#${key}`);
    if (el) {
      el.addEventListener('change', saveSettings);
      el.addEventListener('input', saveSettings);
    }
  }

  $('#analyzeFen').addEventListener('click', async () => {
    const fen = $('#fenInput').value.trim();
    if (!fen) return setStatus('Enter a FEN first.');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'analyze-position', fen });
      if (resp && resp.ok) {
        const top = resp.engine.moves[0];
        const eval_ = top.evaluation != null ? (top.evaluation / 100).toFixed(1) :
          top.mate != null ? 'M' + top.mate : '?';
        setStatus('Best: ' + top.move + ' (eval: ' + eval_ + ')');
      } else {
        setStatus('Error: ' + (resp ? resp.error : 'no response'));
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
    }
  });

  $('#exportAll').addEventListener('click', async () => {
    const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
    if (!gameArchive.length) return setStatus('No games to export.');
    let allPgn = '';
    for (const game of gameArchive) {
      allPgn += gameToPGN(game) + '\n\n';
    }
    downloadFile(allPgn, 'all-games.pgn', 'application/x-chess-pgn');
  });

  $('#clearArchive').addEventListener('click', async () => {
    if (!confirm('Clear all saved games?')) return;
    await chrome.storage.local.set({ gameArchive: [], accuracyData: [] });
    loadArchive();
    loadAccuracy();
    setStatus('Archive cleared.');
  });
});
