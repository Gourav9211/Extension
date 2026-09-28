const $ = (sel) => document.querySelector(sel);
const DEFAULTS = {
  depth: 22,
  autoPlay: false,
  adaptiveOpponent: true,
  multiPv: 3,
  sound: true,
  darkMode: true,
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
  autoNormalEvalCp: 150,
  maxAutoPlayMs: 9000,
  maiaEnabled: false,
  maiaModel: '5m',
  maiaElo: 1500,
  maiaOpponentElo: 0,
  maiaAutoPlay: false,
  maiaShow: true,
  maiaMaxLossCp: 120,
  maiaCandidatePool: 3,
  maiaTemperature: 1,
  maiaSearchLines: 6,
  monitoring: true
};

// Fields that accept fractional values; parseInt would floor them to 0.
const FLOAT_FIELDS = new Set(['maiaTemperature']);

// Maia settings other than the master switch, dimmed while it is disabled.
const MAIA_CHILD_FIELDS = [
  'maiaModel', 'maiaElo', 'maiaOpponentElo', 'maiaAutoPlay', 'maiaShow',
  'maiaMaxLossCp', 'maiaCandidatePool', 'maiaTemperature', 'maiaSearchLines'
];

let statusTimer = null;
function setStatus(msg) {
  const el = $('#status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.classList.remove('show');
    el.textContent = '';
  }, 2200);
}

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('light', !dark);
  const btn = $('#dark-toggle');
  if (btn) {
    btn.textContent = dark ? '\u2600' : '\u263D';
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
}

// Dim any row whose data-requires dependency is off, so the page reads as a
// dependency tree instead of a flat wall of switches.
function syncDependencies() {
  for (const row of document.querySelectorAll('[data-requires]')) {
    const dep = $('#' + row.dataset.requires);
    row.classList.toggle('disabled', !!(dep && !dep.checked));
  }
}

function syncMaiaState() {
  const on = $('#maiaEnabled') && $('#maiaEnabled').checked;
  for (const key of MAIA_CHILD_FIELDS) {
    const el = $(`#${key}`);
    if (!el) continue;
    el.disabled = !on;
    const row = el.closest('.set');
    if (row) row.classList.toggle('disabled', !on);
  }
  syncDependencies();
  const total = MAIA_CHILD_FIELDS.length;
  const el = $('#maia-count');
  if (el) el.textContent = on ? total + ' settings active' : total + ' settings';
}

function syncAutoplayState() {
  const on = $('#autoPlay') && $('#autoPlay').checked;
  const el = $('#autoplay-count');
  if (el) el.textContent = on ? 'active' : 'off';
  // Maia's auto-play replaces the alternative-move logic entirely, so
  // presenting both as live choices would be misleading.
  const maia = $('#maiaAutoPlay');
  const note = $('#autoPlayConflict');
  if (maia && note) {
    const conflict = on && $('#maiaEnabled') && $('#maiaEnabled').checked && maia.checked;
    note.hidden = !conflict;
  }
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
  applyTheme(stored.darkMode !== false);
  syncMaiaState();
  syncAutoplayState();
}

async function saveSettings() {
  const settings = {};
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const el = $(`#${key}`);
    if (!el) continue;
    if (el.type === 'checkbox') settings[key] = el.checked;
    else if (el.type === 'number') {
      const parsed = FLOAT_FIELDS.has(key) ? parseFloat(el.value) : parseInt(el.value, 10);
      settings[key] = Number.isFinite(parsed) ? parsed : def;
    } else settings[key] = el.value;
  }
  await chrome.storage.local.set(settings);
  applyTheme(settings.darkMode !== false);
  syncMaiaState();
  syncAutoplayState();
  // Preload the network so the first analysed position is not the one that
  // pays the ~10MB model read. Failure is non-fatal: the panel just appears
  // when it is eventually ready.
  if (settings.maiaEnabled) {
    chrome.runtime.sendMessage({ type: 'maia-warm', model: settings.maiaModel })
      .catch(() => {});
  }
  setStatus('Saved');
}

async function loadArchive() {
  const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
  const list = $('#archiveList');
  if (!list) return;
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
  if (!el) return;
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
    '<div class="set"><div class="set-label">Average accuracy</div><strong>' + Math.round(avg) + '%</strong></div>' +
    '<div class="set"><div class="set-label">Best game</div><strong>' + Math.round(best) + '%</strong></div>' +
    '<div class="set"><div class="set-label">Worst game</div><strong>' + Math.round(worst) + '%</strong></div>' +
    '<div class="set"><div class="set-label">Games analyzed</div><strong>' + games.length + '</strong></div>';
}

document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(true);
  await loadSettings();
  await loadArchive();
  await loadAccuracy();

  for (const key of Object.keys(DEFAULTS)) {
    const el = $(`#${key}`);
    if (!el) continue;
    el.addEventListener('change', () => { saveSettings(); });
    el.addEventListener('input', () => { saveSettings(); });
  }

  // Repaint dependencies immediately on toggle; the save listener above
  // already handles persistence.
  for (const el of document.querySelectorAll('input[type="checkbox"]')) {
    el.addEventListener('change', () => {
      syncMaiaState();
      syncAutoplayState();
      syncDependencies();
    });
  }

  $('#dark-toggle')?.addEventListener('click', async () => {
    const dark = !document.body.classList.contains('dark');
    applyTheme(dark);
    await chrome.storage.local.set({ darkMode: dark });
  });

  $('#analyzeFen')?.addEventListener('click', async () => {
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

  $('#exportAll')?.addEventListener('click', async () => {
    const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
    if (!gameArchive.length) return setStatus('No games to export.');
    let allPgn = '';
    for (const game of gameArchive) {
      allPgn += gameToPGN(game) + '\n\n';
    }
    downloadFile(allPgn, 'all-games.pgn', 'application/x-chess-pgn');
  });

  $('#clearArchive')?.addEventListener('click', async () => {
    if (!confirm('Clear all saved games?')) return;
    await chrome.storage.local.set({ gameArchive: [], accuracyData: [] });
    loadArchive();
    loadAccuracy();
    setStatus('Archive cleared');
  });
});
