const GEMINI_MODEL = 'gemini-2.0-flash';
const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard';
const CACHE_TTL = 60000;
const MAX_CACHE_SIZE = 50;
// Board square part of the initial position - marks a fresh game.
const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
// Release checks: on every start (and at most once per hour afterwards) the
// extension compares its manifest version against the latest GitHub release,
// so the popup can offer the update button.
const UPDATE_REPO = 'Gourav9211/Extension';
const UPDATE_CHECK_INTERVAL_MS = 3600000;
// Auto-play humaniser defaults - every value is user-configurable in the
// options page (see settings.auto* below). Every auto-played move first waits
// a random autoDelayMin-autoDelayMax window; one move in autoSlowOneIn crosses
// the slow band instead. Roughly one move in autoNormalOneIn, when the
// position is quiet (evaluation within autoNormalEvalCp centipawns, no mate
// in sight, no tablebase verdict), swaps the engine's top choice for one of
// its alternative lines - a plausible "normal" move. Critical positions
// always get the engine's best.
const AUTO_DEFAULTS = {
  autoTimingMode: 'match',
  autoBeatByMs: 1000,
  autoDelayMinMs: 2500,
  autoDelayMaxMs: 4000,
  autoSlowMinMs: 5500,
  autoSlowMaxMs: 10000,
  autoSlowOneIn: 3,
  autoNormalOneIn: 5,
  autoNormalEvalCp: 150,
  engineMoveTimeMs: 8000,
  debounceMs: 500,
  maxAutoPlayMs: 9000
};
// Maia is a separate human-move model: instead of "play the engine's 2nd best
// now and then", it plays the move a player of a given strength would actually
// choose. Every value is user-configurable in the options page.
//   maiaEnabled        master switch; when off nothing is even loaded
//   maiaModel          which bundled network to run ('3m' or '5m')
//   maiaElo            the rating Maia plays at; Maia-3 takes this as an
//                      input, so one network covers the whole range
//   maiaOpponentElo    the rating of the other player, which Maia also
//                      conditions on (0 = assume it matches maiaElo)
//   maiaAutoPlay       use Maia to pick auto-played moves (replaces the humaniser)
//   maiaShow           surface Maia's pick in the popup next to the engine line
//   maiaMaxLossCp      blunder guard: drop Maia moves that cost more than this
//                      many centipawns against Stockfish's best (0 = no guard)
//   maiaCandidatePool  how many of Maia's top moves may be considered
//   maiaTemperature    >1 spreads probability over the candidate moves,
//                      <1 makes Maia more deterministic
//   maiaSearchLines    extra Stockfish lines searched so the guard can score
//                      Maia's candidates (only while Maia drives auto-play)
const MAIA_MODELS = ['3m', '5m'];
// The upstream UCI engine accepts 0-5000 for its Elo options. These bounds are
// tighter only to keep a typo in the options page from asking for a strength
// the model has never seen; real players all land well inside them.
const MAIA_ELO_MIN = 100;
const MAIA_ELO_MAX = 3000;

function clampElo(value) {
  return Math.min(MAIA_ELO_MAX, Math.max(MAIA_ELO_MIN, value));
}
// Shallowest engine search the blunder guard is allowed to act on. Below this
// the per-line scores are dominated by move ordering, not by position quality.
const MAIA_GUARD_MIN_DEPTH = 8;
const MAIA_DEFAULTS = {
  maiaEnabled: false,
  maiaModel: '5m',
  maiaElo: 1500,
  maiaOpponentElo: 0,
  maiaAutoPlay: false,
  maiaShow: true,
  maiaMaxLossCp: 120,
  maiaCandidatePool: 3,
  maiaTemperature: 1,
  maiaSearchLines: 6
};

let analysisTimeout = null;
let positionCache = new Map();
let gameHistory = [];
let offscreenCreated = false;
let engineReady = false;
let engineReadyWaiters = [];
let pendingEval = null;
let lastEval = null;
// UCI has no request ids: track outstanding searches so the bestmove emitted
// when we stop a superseded evaluation can never be mistaken for the result
// of the newer one.
let searchesStarted = 0;
let bestmovesSeen = 0;
let settings = Object.assign({ depth: 22, multiPv: 3, sound: true, classify: true, autoPlay: false, adaptiveOpponent: true, geminiPrompt: '' }, AUTO_DEFAULTS, MAIA_DEFAULTS);

// Random integer in [min, max]; tolerates a swapped min/max from user input.
function randMs(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Opponent pace tracking: the content script sends a 'turn-tick' for every
// newly seen side-to-move. The gap between an opponent-to-move tick and the
// following our-to-move tick is (roughly) how long the opponent thought.
// Samples are EMA-smoothed and reset when a fresh game starts; gaps over
// five minutes are discarded (background-tab throttling, not real thinking).
//
// MV3 service workers are killed after ~30s idle - exactly how long an
// opponent can think - so this state lives in chrome.storage.session and is
// restored on every wake-up. Without persistence the pace was always zero by
// the time it mattered and matching silently fell back to random.
let lastTickAt = 0;
let lastTickTurn = '';
let opponentPaceMs = 0;
let opponentMovedAtMs = 0;
let opponentElo = 0;
let userColor = '';
let userPaceMs = 0;
let lastUserTickAt = 0;
const OPPONENT_GAP_CAP_MS = 300000;

// MV3 wakes the service worker straight INTO a message handler, before the
// async session-storage restore finishes - so early ticks are buffered until
// state is back, otherwise the first sample after every wake-up was garbage
// and matched timing silently degraded to random.
let paceStateReady = false;
const pendingTicks = [];

function persistPaceState() {
  chrome.storage.session.set({
    paceState: {
      lastTickAt: lastTickAt,
      lastTickTurn: lastTickTurn,
      opponentPaceMs: opponentPaceMs,
      opponentMovedAtMs: opponentMovedAtMs,
      opponentElo: opponentElo,
      userColor: userColor,
      userPaceMs: userPaceMs,
      lastUserTickAt: lastUserTickAt
    }
  }).catch(function() {});
}

(function restorePaceState() {
  chrome.storage.session.get('paceState').then(function(data) {
    const s = data && data.paceState;
    if (s && s.lastTickAt && Date.now() - s.lastTickAt < OPPONENT_GAP_CAP_MS) {
      lastTickAt = s.lastTickAt;
      lastTickTurn = s.lastTickTurn || '';
      opponentPaceMs = s.opponentPaceMs || 0;
      opponentMovedAtMs = s.opponentMovedAtMs || 0;
      opponentElo = s.opponentElo || 0;
      userColor = s.userColor || '';
      userPaceMs = s.userPaceMs || 0;
      lastUserTickAt = s.lastUserTickAt || 0;
      logAnalysis('restored pace state: opp ~' + (opponentPaceMs / 1000).toFixed(1) + 's, you ~' + (userPaceMs / 1000).toFixed(1) + 's, elo ' + (opponentElo || '?'));
    }
    paceStateReady = true;
    while (pendingTicks.length) trackTurnTick.apply(null, pendingTicks.shift());
  }).catch(function() {
    paceStateReady = true;
    while (pendingTicks.length) trackTurnTick.apply(null, pendingTicks.shift());
  });
})();

function trackTurnTick(userColor_, turn, fen, oppElo) {
  if (!paceStateReady) {
    pendingTicks.push([userColor_, turn, fen, oppElo]);
    logAnalysis('tick queued (pace state not ready): turn=' + turn);
    return;
  }
  // A fresh initial placement means a new game - forget the old pace.
  if ((fen || '').split(' ')[0] === START_PLACEMENT) {
    logAnalysis('new game detected - resetting all pace data');
    lastTickAt = 0;
    lastTickTurn = '';
    opponentPaceMs = 0;
    opponentMovedAtMs = 0;
    userPaceMs = 0;
    lastUserTickAt = 0;
    persistPaceState();
    return;
  }
  if (oppElo >= 100 && oppElo <= 3500) opponentElo = oppElo;
  if (userColor_ === 'w' || userColor_ === 'b') userColor = userColor_;
  const uc = userColor_ === 'b' ? 'b' : 'w';
  const opp = uc === 'w' ? 'b' : 'w';
  const now = Date.now();
  logAnalysis('tick: turn=' + turn + ' (you=' + uc + ', opp=' + opp + ') lastTurn=' + lastTickTurn);
  if (turn === uc) {
    // Their move just completed - this instant is t=0 for matched timing.
    opponentMovedAtMs = now;
    const gap = lastTickAt ? now - lastTickAt : 0;
    if (lastTickTurn === opp && gap > 0 && gap <= OPPONENT_GAP_CAP_MS) {
      opponentPaceMs = opponentPaceMs ? Math.round(opponentPaceMs * 0.6 + gap * 0.4) : gap;
      logAnalysis('opponent pace updated: raw=' + (gap / 1000).toFixed(1) + 's -> ema=' + (opponentPaceMs / 1000).toFixed(1) + 's' +
        (opponentElo ? ', elo ' + opponentElo : ''));
    } else {
      logAnalysis('opponent tick skipped: lastTurn=' + lastTickTurn + ' gap=' + (gap / 1000).toFixed(1) + 's');
    }
  }
  if (turn === opp) {
    // User's move just completed - track their pace for balanced timing.
    const userGap = lastUserTickAt ? now - lastUserTickAt : 0;
    if (userGap > 0 && userGap <= OPPONENT_GAP_CAP_MS) {
      userPaceMs = userPaceMs ? Math.round(userPaceMs * 0.6 + userGap * 0.4) : userGap;
      logAnalysis('user pace updated: raw=' + (userGap / 1000).toFixed(1) + 's -> ema=' + (userPaceMs / 1000).toFixed(1) + 's');
    } else {
      logAnalysis('user tick skipped: lastUserTickAt=' + (lastUserTickAt ? 'set' : '0') + ' gap=' + (userGap / 1000).toFixed(1) + 's');
    }
    lastUserTickAt = now;
  }
  lastTickAt = now;
  lastTickTurn = turn || '';
  persistPaceState();
}

// Adaptive difficulty ("slightly higher level"): scale deviation frequency
// and the quiet-position band to the opponent's rating so weaker opponents
// face more human-looking variety and stronger ones face tighter play.
function adaptiveParams() {
  if (!settings.adaptiveOpponent || !opponentElo) {
    return { oneIn: settings.autoNormalOneIn, evalCp: settings.autoNormalEvalCp, beatDeltaMs: 0 };
  }
  if (opponentElo < 1000) return { oneIn: 3, evalCp: 300, beatDeltaMs: 500 };
  if (opponentElo < 1400) return { oneIn: 4, evalCp: 220, beatDeltaMs: 250 };
  if (opponentElo < 1800) return { oneIn: 5, evalCp: 150, beatDeltaMs: 0 };
  if (opponentElo < 2200) return { oneIn: 7, evalCp: 110, beatDeltaMs: -200 };
  return { oneIn: 8, evalCp: 90, beatDeltaMs: -300 };
}

// Lifecycle diagnostics visible in the service worker console
// (chrome://extensions -> Chess Position Analyst -> "Inspect views: service worker").
function logEngine(msg) { console.log('[engine]', msg); }
function logAnalysis(msg) { console.log('[analysis]', msg); }

const OPENINGS = {
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR': "King's Pawn",
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR': "Queen's Pawn",
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR': 'English',
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R': 'Reti',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR': 'Open Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR': 'Scandinavian',
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR': 'Sicilian',
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R': 'French',
  'rnbqkbnr/pppp1ppp/8/8/3nP2N/8/PPPP1PPP/RNBQKB1R': 'Scotch'
};

function countPieces(fen) {
  const board = fen.split(' ')[0];
  let count = 0;
  for (const ch of board) {
    if (ch >= '1' && ch <= '8') count += parseInt(ch);
    else if (ch !== '/') count += 1;
  }
  return count;
}

function classifyMove(prevCp, currCp, isMate) {
  if (prevCp == null || currCp == null) return null;
  const diff = prevCp - currCp;
  if (isMate) return diff > 50 ? 'brilliant' : diff > 0 ? 'good' : diff > -100 ? 'inaccuracy' : diff > -300 ? 'mistake' : 'blunder';
  if (diff >= -10) return 'brilliant';
  if (diff >= -30) return 'good';
  if (diff >= -100) return 'inaccuracy';
  if (diff >= -300) return 'mistake';
  return 'blunder';
}

function classifyLabel(cls) {
  const map = { brilliant: '!!', good: '!', inaccuracy: '?!', mistake: '?', blunder: '??' };
  return map[cls] || '';
}

function validateFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error('Invalid FEN: expected at least 5 fields, got ' + fields.length);
  const ranks = fields[0].split('/');
  if (ranks.length !== 8) throw new Error('Invalid FEN: expected 8 ranks, got ' + ranks.length);
  for (let i = 0; i < ranks.length; i++) {
    let squares = 0;
    for (const ch of ranks[i]) {
      if (ch >= '1' && ch <= '8') squares += parseInt(ch);
      else if ('prnbqkPRNBQK'.includes(ch)) squares += 1;
      else throw new Error('Invalid FEN: bad character "' + ch + '" in rank ' + (i + 1));
    }
    if (squares !== 8) throw new Error('Invalid FEN: rank ' + (i + 1) + ' has ' + squares + ' squares, expected 8');
  }
  if (fields[1] !== 'w' && fields[1] !== 'b') throw new Error('Invalid FEN: side to move must be "w" or "b"');
  return fields.join(' ');
}

function getCached(fen) {
  const entry = positionCache.get(fen);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  positionCache.delete(fen);
  return null;
}

function setCache(fen, data) {
  if (positionCache.size >= MAX_CACHE_SIZE) {
    const oldest = positionCache.keys().next().value;
    positionCache.delete(oldest);
  }
  positionCache.set(fen, { data, ts: Date.now() });
}

async function loadSettings() {
  const keys = ['depth', 'multiPv', 'sound', 'classify', 'autoPlay', 'geminiPrompt'].concat(Object.keys(AUTO_DEFAULTS), Object.keys(MAIA_DEFAULTS));
  const stored = await chrome.storage.local.get(keys);
  if (stored.depth) settings.depth = stored.depth;
  if (stored.autoPlay != null) settings.autoPlay = !!stored.autoPlay;
  if (stored.adaptiveOpponent != null) settings.adaptiveOpponent = !!stored.adaptiveOpponent;
  if (stored.multiPv) settings.multiPv = stored.multiPv;
  if (stored.sound != null) settings.sound = stored.sound;
  if (stored.classify != null) settings.classify = stored.classify;
  if (stored.geminiPrompt != null) settings.geminiPrompt = stored.geminiPrompt;
  if (stored.autoTimingMode === 'match' || stored.autoTimingMode === 'random' || stored.autoTimingMode === 'balance') settings.autoTimingMode = stored.autoTimingMode;
  for (const key of Object.keys(AUTO_DEFAULTS)) {
    const v = parseInt(stored[key], 10);
    if (!isNaN(v) && v > 0) settings[key] = v;
    // A frequency of exactly 0 is meaningful ("never") - everything else
    // must stay positive so e.g. a 0ms move time cannot hang the engine.
    else if (!isNaN(v) && v === 0 && /OneIn$/.test(key)) settings[key] = 0;
  }
  await loadMaiaSettings(stored);
}

// Maia keys need their own validation because they are booleans, a choice from
// a fixed model list, and numbers that legitimately allow 0 or values below 1.
async function loadMaiaSettings(stored) {
  if (stored.maiaEnabled != null) settings.maiaEnabled = !!stored.maiaEnabled;
  if (stored.maiaAutoPlay != null) settings.maiaAutoPlay = !!stored.maiaAutoPlay;
  if (stored.maiaShow != null) settings.maiaShow = !!stored.maiaShow;
  if (MAIA_MODELS.indexOf(stored.maiaModel) !== -1) settings.maiaModel = stored.maiaModel;
  // A pre-3.0 install stored maiaElo as one of 1100/1300/1500/1700/1900. Those
  // are all valid Maia-3 ratings, so the value carries over unchanged and the
  // migration is invisible - which is the only reason reusing the key is safe.
  const elo = parseInt(stored.maiaElo, 10);
  if (!isNaN(elo)) settings.maiaElo = clampElo(elo);
  const oppo = parseInt(stored.maiaOpponentElo, 10);
  if (!isNaN(oppo) && oppo >= 0) settings.maiaOpponentElo = Math.min(oppo, MAIA_ELO_MAX);
  const loss = parseInt(stored.maiaMaxLossCp, 10);
  if (!isNaN(loss) && loss >= 0) settings.maiaMaxLossCp = Math.min(loss, 1000);
  const pool = parseInt(stored.maiaCandidatePool, 10);
  if (!isNaN(pool) && pool >= 1) settings.maiaCandidatePool = Math.min(pool, 10);
  const temp = parseFloat(stored.maiaTemperature);
  if (!isNaN(temp) && temp > 0) settings.maiaTemperature = Math.min(Math.max(temp, 0.05), 5);
  const lines = parseInt(stored.maiaSearchLines, 10);
  if (!isNaN(lines) && lines >= 1) settings.maiaSearchLines = Math.min(lines, 10);
}

function detectOpening(fen) {
  return OPENINGS[fen.split(' ')[0]] || null;
}

// Numeric semver-style comparison: 1 if a newer than b, -1 older, 0 equal.
function compareVersions(a, b) {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10) || 0;
    const nb = parseInt(pb[i], 10) || 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

// Fetches the latest GitHub release and stores its version + URL. Cached for
// UPDATE_CHECK_INTERVAL_MS unless forced (the popup's "Check now" forces).
// When GitHub is unreachable or rate-limited, falls back to the last cached
// result instead of failing outright.
async function checkForUpdate(force) {
  const data = await chrome.storage.local.get('updateCheck');
  const cached = data.updateCheck || null;
  if (!force && cached && cached.lastChecked &&
      Date.now() - cached.lastChecked < UPDATE_CHECK_INTERVAL_MS) {
    return cached;
  }
  try {
    const resp = await fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest');
    if (!resp.ok) throw new Error('GitHub API HTTP ' + resp.status);
    const release = await resp.json();
    const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
    const status = {
      lastChecked: Date.now(),
      latestVersion: latestVersion,
      releaseUrl: release.html_url || ('https://github.com/' + UPDATE_REPO + '/releases/latest'),
      updateAvailable: compareVersions(latestVersion, chrome.runtime.getManifest().version) > 0
    };
    await chrome.storage.local.set({ updateCheck: status });
    return status;
  } catch (e) {
    if (cached && cached.lastChecked) {
      return Object.assign({}, cached, { stale: true });
    }
    throw e;
  }
}

async function ensureOffscreen() {
  if (offscreenCreated) { logEngine('offscreen already created'); return; }
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts && contexts.length) {
        offscreenCreated = true;
        logEngine('offscreen found existing context');
        return;
      }
    }
    logEngine('creating offscreen document...');
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Running Stockfish chess engine'
    });
    offscreenCreated = true;
    logEngine('offscreen document created');
  } catch (e) {
    if (/already exists|single offscreen document/i.test(e.message || '')) {
      offscreenCreated = true;
      logEngine('offscreen already exists (caught)');
    } else {
      logEngine('offscreen creation FAILED: ' + e.message);
      throw e;
    }
  }
}

function waitForEngine(timeoutMs) {
  if (engineReady) { logEngine('engine already ready'); return Promise.resolve(); }
  logEngine('waiting for engine, timeout=' + (timeoutMs || 15000) + 'ms');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = engineReadyWaiters.indexOf(waiter);
      if (idx !== -1) engineReadyWaiters.splice(idx, 1);
      logEngine('ENGINE INIT TIMEOUT after ' + (timeoutMs || 15000) + 'ms');
      reject(new Error('Engine init timeout'));
    }, timeoutMs || 15000);
    const waiter = { resolve: function() { clearTimeout(timer); resolve(); }, reject: reject };
    engineReadyWaiters.push(waiter);
  });
}

function sfCommand(cmd) {
  // Make search-relevant commands visible so truncation can be diagnosed
  // from the console alone.
  if (/^go |^setoption|^ucinewgame/.test(cmd)) logEngine('cmd: ' + cmd);
  chrome.runtime.sendMessage({ type: 'sf-cmd', cmd }).catch(function() {});
}

async function queryTablebase(fen) {
  try {
    const resp = await fetch(TABLEBASE_URL + '?fen=' + encodeURIComponent(fen));
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.category === 'draw' || data.category === 'blessed-loss' || data.category === 'cursed-win') {
      return { category: data.category, dtm: data.dtm, moves: (data.moves || []).slice(0, settings.multiPv).map(m => ({
        move: m.san, uci: m.uci, category: m.category, dtm: m.dtm
      }))};
    }
    return { category: data.category, dtm: data.dtm, moves: (data.moves || []).slice(0, settings.multiPv).map(m => ({
      move: m.san, uci: m.uci, category: m.category, dtm: m.dtm
    }))};
  } catch (e) {
    return null;
  }
}

function evaluateWithStockfish(fen, multiPv, movetimeOverride) {
  return new Promise((resolve, reject) => {
    if (pendingEval) {
      const old = pendingEval;
      pendingEval = null;
      clearTimeout(old.timeout);
      old.reject(new Error('Superseded by new request'));
    }
    // Matched timing hands us a smaller budget so the search finishes before
    // the reply deadline; otherwise the configured move time applies.
    const movetime = Math.max(400, Math.min(settings.engineMoveTimeMs, movetimeOverride || settings.engineMoveTimeMs));
    const info = { lines: [], resolve: resolve, reject: reject, timeout: null };
    pendingEval = info;
    info.timeout = setTimeout(function() {
      if (pendingEval === info) {
        pendingEval = null;
        reject(new Error('Engine evaluation timeout'));
      }
    }, Math.max(18000, settings.depth * 1200, movetime + 3000));
    // Only send 'stop' when something is actually running - a stray stop
    // racing a fresh 'go' could truncate the new search.
    if (pendingEval) sfCommand('stop');
    sfCommand('position fen ' + fen);
    // movetime caps the search so a position never hangs the UI; depth is
    // the usual stopping criterion on easy positions. Complex middlegames
    // will legitimately stop at a lower reached-depth - that is the time
    // budget doing its job, not a bug.
    sfCommand('go depth ' + settings.depth + ' movetime ' + movetime + ' multipv ' + multiPv);
    searchesStarted += 1;
  });
}

// Transposition-table warming ("pondering"): while the opponent thinks, run
// a shallow search of their position so the shared hash is primed when the
// user's move arrives. Never displayed and never cached - purely speed.
function warmEngine(fen) {
  if (!engineReady || pendingEval) return;
  const info = { lines: [], warm: true, resolve: function() {}, reject: function() {}, timeout: null };
  pendingEval = info;
  info.timeout = setTimeout(function() {
    if (pendingEval === info) pendingEval = null;
  }, 6000);
  sfCommand('position fen ' + fen);
  sfCommand('go depth 10 movetime 1200');
  searchesStarted += 1;
}

// ---- Maia ----
// Inference happens in the offscreen document; this side only brokers the
// request. A missing/failed Maia is never fatal - callers get null and carry on
// with the Stockfish-only path.
let maiaUnavailable = false;

function normalizeMaiaElo(value) {
  const elo = parseInt(value, 10);
  return isNaN(elo) ? settings.maiaElo : clampElo(elo);
}

// Maia-3 conditions on both players' ratings. When no opponent rating is
// configured the model is told both sides are the same strength, which is the
// right default for the extension's own use (Maia playing either colour) and
// matches the upstream UCI default of a single shared Elo.
function maiaOpponentElo() {
  return settings.maiaOpponentElo > 0 ? settings.maiaOpponentElo : settings.maiaElo;
}

async function maiaPredict(fen, legal, opts) {
  if (!settings.maiaEnabled || maiaUnavailable) return null;
  const options = opts || {};
  const elo = normalizeMaiaElo(options.elo);
  const model = MAIA_MODELS.indexOf(options.model) !== -1 ? options.model : settings.maiaModel;
  const limit = options.limit || 6;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'maia-predict',
      fen: fen,
      legal: legal,
      model: model,
      elo: elo,
      opponentElo: maiaOpponentElo(),
      repetition: options.repetition || 0,
      limit: limit
    });
    if (!response || !response.ok) {
      // A model that cannot load disables Maia for this session rather than
      // retrying a doomed ~11MB fetch on every single position.
      if (response && /load|session|fetch|backend|wasm|onnx/i.test(response.error || '')) {
        maiaUnavailable = true;
        console.warn('[maia] disabled for this session:', response.error);
      }
      return null;
    }
    return {
      model: response.model,
      elo: elo,
      opponentElo: response.opponentElo,
      scoreCp: response.scoreCp,
      wdl: response.wdl,
      moves: response.moves,
      // Legal moves Maia's policy vocabulary has no slot for. With the
      // 4352-entry Maia-3 vocabulary this set is always empty: the 4096
      // from/to pairs plus the rank-7-to-rank-8 promotion block cover every
      // legal move of either colour, because the board is mirrored for Black
      // and a Black promotion therefore lands in the same block. It is
      // reported rather than assumed, and excluded from selection, so a
      // vocabulary that stopped covering a move could not start playing one.
      unmapped: response.unmapped || [],
      unmappedCount: response.unmappedCount || 0
    };
  } catch (e) {
    if (!/Receiving end does not exist/i.test(e.message || '')) {
      console.warn('[maia] request failed:', e.message);
    }
    return null;
  }
}

// Engine lines are inconsistent by design: tablebase and UCI paths use
// `.uci`, the parsed multiPV path uses a `.move` string plus a `.line` PV.
// Normalising here keeps every consumer from having to know.
function lineUci(line) {
  if (!line) return '';
  if (line.uci && /^[a-h][1-8][a-h][1-8]/.test(line.uci)) return line.uci;
  if (typeof line.move === 'string' && /^[a-h][1-8][a-h][1-8]/.test(line.move)) return line.move;
  if (typeof line.move === 'object' && line.move && /^[a-h][1-8][a-h][1-8]/.test(line.move.uci || '')) {
    return line.move.uci;
  }
  if (line.line) {
    const first = String(line.line).split(' ')[0];
    if (/^[a-h][1-8][a-h][1-8]/.test(first)) return first;
  }
  return '';
}

// Puts Maia's pick on the same footing as the engine line, then samples from
// the survivors. The blunder guard is the point of the whole feature: Maia
// models a *weak* player, so at a 1200 rating it will happily hang a queen,
// and the user asked for a human, not a patzer that throws the game.
function chooseMaiaMove(maia, engine, fen, legal) {
  if (!maia || !maia.moves || !maia.moves.length) return null;
  const legalSet = new Set(legal);
  // A move Maia's policy vocabulary has no slot for cannot be chosen on its
  // account, even if the worker somehow offered it. Being explicit here means
  // the extension can never play a move that was excluded from the distribution
  // without also being excluded from the selection.
  const unsupported = new Set(maia.unmapped || []);
  let candidates = maia.moves.filter(function(move) {
    return legalSet.has(move.uci) && !unsupported.has(move.uci);
  });
  if (!candidates.length) return null;
  candidates = candidates.slice(0, Math.max(1, settings.maiaCandidatePool));

  // A centipawn gap only means something if the engine actually searched. On
  // trivial positions (and whenever the move-time cap cuts a search short) a
  // shallow line can report a "100cp blunder" that is pure noise, and a guard
  // that acts on it replaces Maia's correct move with the engine's - so the
  // guard stands down below this depth.
  const guard = settings.maiaMaxLossCp;
  if (guard > 0 && engine && engine.moves && engine.moves.length) {
    const bestUci = lineUci(engine.moves[0]);
    const bestEval = typeof engine.moves[0].evaluation === 'number' ? engine.moves[0].evaluation : null;
    const reached = engine.moves[0].depth;
    // A mate score is terminal and always trustworthy; anything else needs a
    // search deep enough for the gap between lines to mean something.
    const mateInPlay = engine.moves.some(function(line) { return line.mate != null; });
    const deepEnough = reached == null || reached >= MAIA_GUARD_MIN_DEPTH;
    if (bestEval !== null && bestUci && (mateInPlay || deepEnough)) {
      const evalByKey = new Map();
      for (const line of engine.moves) {
        const uci = lineUci(line);
        if (uci && typeof line.evaluation === 'number') evalByKey.set(uci.substring(0, 4), line.evaluation);
      }
      const scored = candidates.filter(function(move) {
        return typeof evalByKey.get(move.uci.substring(0, 4)) === 'number';
      });
      // Maia's favourite move is frequently outside a 3-line window, which says
      // nothing about its quality. Only judge what the engine actually scored,
      // and only override Maia when the engine did score its candidates and
      // rejected every one of them.
      if (scored.length) {
        const safe = scored.filter(function(move) {
          return bestEval - evalByKey.get(move.uci.substring(0, 4)) <= guard;
        });
        if (safe.length) candidates = safe;
        else return { uci: bestUci, fromMaia: false, reason: 'guarded' };
      }
    }
  }

  const temperature = settings.maiaTemperature;
  let move = candidates[0];
  if (candidates.length > 1 && temperature > 0) {
    // Tempering the renormalised probabilities is equivalent to a softmax of
    // the raw logits at 1/temperature, so no logits need to leave the worker.
    const weights = candidates.map(function(c) { return Math.pow(Math.max(c.prob, 1e-9), 1 / temperature); });
    const total = weights.reduce(function(a, b) { return a + b; }, 0);
    let target = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      target -= weights[i];
      if (target <= 0) { move = candidates[i]; break; }
    }
  }
  return { uci: move.uci, prob: move.prob, fromMaia: true, reason: 'maia' };
}

function processEngineLine(text) {
  if (/^info string/.test(text)) {
    logEngine(text.replace(/^info string\s*/, ''));
    if (/falling back|failed to load|init failed|worker error/.test(text)) console.warn('[engine]', text);
  }
  if (text === 'uciok') {
    engineReady = true;
    searchesStarted = 0;
    bestmovesSeen = 0;
    logEngine('ready (uciok)');
    // Stockfish defaults to ONE search thread regardless of what the build
    // supports - opt into the cores this machine actually has. Unknown
    // options (single-threaded fallback builds) are ignored by the engine.
    const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    logEngine('using ' + threads + ' thread(s), hash 128 MB');
    sfCommand('setoption name Threads value ' + threads);
    sfCommand('setoption name Hash value 128');
    // Reset transposition tables exactly once per engine boot, AFTER options.
    // Never between searches: keeping the hash warm across moves is a major
    // speed win.
    sfCommand('ucinewgame');
    loadSettings().then(function() {
      logEngine('search limits: depth cap ' + settings.depth + ', movetime ' + settings.engineMoveTimeMs + 'ms, multipv ' + settings.multiPv);
    });
    for (const w of engineReadyWaiters) w.resolve();
    engineReadyWaiters = [];
    return;
  }
  if (text.startsWith('bestmove')) {
    const outstanding = searchesStarted - bestmovesSeen;
    bestmovesSeen += 1;
    // More than one outstanding search means this bestmove belongs to a
    // superseded (stopped) evaluation - ignore it.
    if (!pendingEval || outstanding !== 1) return;
    const info = pendingEval;
    pendingEval = null;
    clearTimeout(info.timeout);
    const move = text.split(' ')[1];
    const parsed = parseInfoLines(info.lines);
    if (!parsed.length && move) {
      parsed.push({ move: move, line: move, evaluation: null, mate: null, depth: null });
    }
    const maxDepth = parsed.reduce(function(d, p) { return p.depth && p.depth > d ? p.depth : d; }, 0);
    info.resolve({ bestMove: move, moves: parsed, depth: maxDepth || null });
    return;
  }
  if (text.startsWith('info ') && pendingEval && text.includes(' pv ')) {
    pendingEval.lines.push(text);
  }
}

function parseInfoLines(lines) {
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    const pvMatch = line.match(/ pv (\S+(?:\s+\S+)*)/);
    const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
    const depthMatch = line.match(/ depth (\d+)/);
    if (!pvMatch) continue;
    const move = pvMatch[1].split(' ')[0];
    if (seen.has(move)) continue;
    seen.add(move);
    result.push({
      move: move, line: pvMatch[1],
      evaluation: scoreMatch && scoreMatch[1] === 'cp' ? parseInt(scoreMatch[2]) : null,
      mate: scoreMatch && scoreMatch[1] === 'mate' ? parseInt(scoreMatch[2]) : null,
      depth: depthMatch ? parseInt(depthMatch[1]) : null
    });
  }
  return result;
}

async function explainWithGemini(fen, engine) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  // No key, no panel noise - the popup hides the explanation section when
  // this returns empty.
  if (!geminiApiKey) return '';
  const topMove = engine.moves[0];
  const customPrompt = settings.geminiPrompt;
  const prompt = customPrompt
    ? customPrompt.replace('{fen}', fen).replace('{move}', topMove.move).replace('{line}', topMove.line)
    : [
      'You are a chess coach. Explain this position briefly.',
      'FEN: ' + fen,
      'Best move: ' + topMove.move,
      'Line: ' + topMove.line,
      'Explain in 2-3 sentences why it is strong.'
    ].join('\n');
  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    if (!response.ok) return '';
    const data = await response.json();
    return (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
  } catch (e) {
    return '';
  }
}

async function analyzePosition(fen, opts) {
  const explainMode = (opts && opts.explain) || 'await';
  await loadSettings();
  await ensureOffscreen();
  logEngine('waiting for engine (ready=' + engineReady + ')...');
  await waitForEngine(30000);
  logEngine('engine ready, analyzing');
  const validated = validateFen(fen);
  const pieceCount = countPieces(validated);

  let engine;
  let opening = detectOpening(validated);
  let classification = null;

  // Tablebase lines carry no centipawn evaluation, so the Maia blunder guard
  // cannot score anything there; Maia is still shown, just never auto-played.
  if (pieceCount <= 7) {
    const tb = await queryTablebase(validated);
    if (tb) {
      engine = {
        moves: tb.moves.map(function(m) {
          return { move: m.move, line: m.uci, evaluation: null, mate: m.dtm, depth: null, tablebase: m.category };
        }),
        depth: 100, fen: validated, tablebase: true, category: tb.category
      };
    }
  }

  // The guard needs more than the displayed lines to judge Maia's candidates.
  const wantMaia = settings.maiaEnabled && !engine;
  const lines = wantMaia && settings.maiaAutoPlay && settings.autoPlay
    ? Math.max(settings.multiPv, settings.maiaSearchLines)
    : settings.multiPv;

  if (!engine) {
    const cached = getCached(validated);
    engine = cached || await evaluateWithStockfish(validated, lines, opts && opts.movetimeMs);
    if (!cached) setCache(validated, engine);
  }

  if (lastEval != null && settings.classify) {
    const currCp = engine.moves[0].evaluation;
    const isMate = engine.moves[0].mate != null;
    classification = classifyMove(lastEval, currCp, isMate);
  }
  const currCp = engine.moves[0].evaluation;
  if (currCp != null) lastEval = currCp;

  // Maia runs after the engine line so the guard can use it as the yardstick.
  // Needed whenever the popup shows it OR auto-play will play it.
  let maia = null;
  if (settings.maiaEnabled && (settings.maiaShow || (settings.autoPlay && settings.maiaAutoPlay))) {
    const legal = legalMovesFromFen(validated);
    const raw = await maiaPredict(validated, legal, { limit: 6 });
    if (raw) maia = Object.assign({}, raw, { selection: chooseMaiaMove(raw, engine, validated, legal) });
  }

  // In 'async' mode the caller wants the engine result immediately and will
  // fetch the Gemini explanation separately - the arrow must not wait on a
  // network round-trip.
  let explanation = null;
  if (explainMode !== 'async') {
    try { explanation = await explainWithGemini(validated, engine); }
    catch (e) { explanation = ''; }
  }

  gameHistory.push({
    fen: validated, bestMove: engine.moves[0].move, eval: currCp,
    timestamp: Date.now(), classification: classification
  });
  if (gameHistory.length > 200) gameHistory = gameHistory.slice(-200);

  return {
    ok: true, fen: validated, engine: engine, explanation: explanation, opening: opening,
    classification: classification, classifyLabel: classifyLabel(classification),
    tablebase: !!engine.tablebase, category: engine.category || null,
    maia: maia, maiaElo: settings.maiaElo
  };
}

function sendAnalysisToPopup(result) {
  chrome.runtime.sendMessage(Object.assign({ type: 'analysis-result' }, result)).catch(function() {});
}

// Trusted input injection: chess.com ignores synthetic DOM events for moves,
// so auto-play goes through the debugger protocol (same as real user input).
const attachedTabs = new Set();
let lastAutoDebug = {};

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function dbgSend(target, cmd, params) {
  return new Promise(function(resolve, reject) {
    chrome.debugger.sendCommand(target, cmd, params, function(r) {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });
}

function dbgAttach(target) {
  return new Promise(function(resolve, reject) {
    chrome.debugger.attach(target, '1.3', function() {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

chrome.debugger.onDetach.addListener(function(target) {
  if (target && typeof target.tabId === 'number') attachedTabs.delete(target.tabId);
});

// Attaching shows Chrome's debugger infobar, which shrinks the viewport and
// shifts the board. Coordinates captured before attach would land off-target,
// so ask the content script for square centers only AFTER attaching.
async function requestSquarePoints(tabId, from, to) {
  try {
    const resp = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'get-square-points', from: from, to: to }),
      sleep(1500).then(function() { return null; })
    ]);
    if (resp && resp.ok && Array.isArray(resp.points) &&
        resp.points.every(function(p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y); })) {
      return resp.points;
    }
  } catch (e) {}
  return null;
}

async function debuggerPlay(tabId, from, to, fallbackPoints) {
  lastAutoDebug = { ts: Date.now(), tabId: tabId, steps: [] };
  const dbg = function(m) { lastAutoDebug.steps.push(m); };
  const validSq = /^[a-h][1-8]$/;
  if (!chrome.debugger || !tabId || !validSq.test(from || '') || !validSq.test(to || '')) {
    return { ok: false, reason: 'unavailable' };
  }
  const target = { tabId: tabId };
  let attachedHere = false;
  try {
    await dbgAttach(target);
    attachedHere = true;
    attachedTabs.add(tabId);
    dbg('attached');
    await sleep(400);
    let points = await requestSquarePoints(tabId, from, to);
    if (!points && Array.isArray(fallbackPoints) &&
        fallbackPoints.every(function(p) { return p && Number.isFinite(p.x) && Number.isFinite(p.y); })) {
      points = fallbackPoints;
      dbg('stale pre-attach coordinates used');
    }
    if (!points) return { ok: false, reason: 'no coordinates for ' + from + to };
    async function press(label, p) {
      await dbgSend(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', pointerType: 'mouse' });
      await sleep(60);
      await dbgSend(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      await sleep(70);
      await dbgSend(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
      dbg('pressed ' + label + ' @' + Math.round(p.x) + ',' + Math.round(p.y));
    }
    await press('from', points[0]);
    await sleep(250);
    await press('to', points[1]);
    return { ok: true };
  } catch (e) {
    dbg('error: ' + (e.message || e));
    return { ok: false, reason: e.message || String(e) };
  } finally {
    if (attachedHere) {
      try { chrome.debugger.detach(target, function() {}); } catch (e) {}
      attachedTabs.delete(tabId);
      dbg('detached');
    }
  }
}

// ---- BEGIN LEGAL MOVE GENERATION ----
// Pure chess logic used only by the auto-play randomiser to enumerate every
// legal move in the current position. No chrome.* dependencies so it can be
// unit-tested standalone (perft-checked against known node counts).

const SLIDER_RAYS = {
  r: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  b: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  q: [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]
};
const LEAP_DELTAS = {
  n: [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]],
  k: [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]]
};

function parseGrid(fen) {
  const fields = fen.split(' ');
  const grid = fields[0].split('/').map(function(row) {
    const cells = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch, 10); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    return cells;
  });
  return {
    grid: grid,
    turn: fields[1],
    castling: fields[2] || '-',
    ep: fields[3] && fields[3] !== '-' ? fields[3] : null
  };
}

function squareName(r, f) { return String.fromCharCode(97 + f) + String(8 - r); }
function pieceSide(p) { return p === p.toUpperCase() ? 'w' : 'b'; }
function onBoard(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }

function isAttacked(grid, r, f, by) {
  // Pawns attack one rank "forward" from their own side.
  const pr = by === 'w' ? r + 1 : r - 1;
  for (const df of [-1, 1]) {
    if (onBoard(pr, f + df)) {
      const p = grid[pr][f + df];
      if (p && pieceSide(p) === by && p.toLowerCase() === 'p') return true;
    }
  }
  for (const kind of ['n', 'k']) {
    for (const d of LEAP_DELTAS[kind]) {
      const rr = r + d[0], ff = f + d[1];
      if (!onBoard(rr, ff)) continue;
      const p = grid[rr][ff];
      if (p && pieceSide(p) === by && p.toLowerCase() === kind) return true;
    }
  }
  const raySets = [
    { dirs: SLIDER_RAYS.r, hit: 'r' },
    { dirs: SLIDER_RAYS.b, hit: 'b' }
  ];
  for (const set of raySets) {
    for (const d of set.dirs) {
      let rr = r + d[0], ff = f + d[1];
      while (onBoard(rr, ff)) {
        const p = grid[rr][ff];
        if (p) {
          if (pieceSide(p) === by) {
            const t = p.toLowerCase();
            if (t === set.hit || t === 'q') return true;
          }
          break;
        }
        rr += d[0]; ff += d[1];
      }
    }
  }
  return false;
}

function findKing(grid, side) {
  const target = side === 'w' ? 'K' : 'k';
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      if (grid[r][f] === target) return [r, f];
    }
  }
  return null;
}

// Returns UCI strings ('e2e4', promotions as '...q'). Empty array on any
// parse problem - callers must treat that as "no randomisation possible".
function legalMovesFromFen(fen) {
  try {
    const pos = parseGrid(fen);
    const grid = pos.grid;
    const me = pos.turn;
    const opp = me === 'w' ? 'b' : 'w';
    const moves = [];
    const add = function(fr, ff, tr, tf, extra) {
      const m = Object.assign({ fr: fr, ff: ff, tr: tr, tf: tf, ep: false, castle: false, promo: null }, extra);
      moves.push(m);
    };

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (!p || pieceSide(p) !== me) continue;
        const t = p.toLowerCase();
        if (t === 'p') {
          const dir = me === 'w' ? -1 : 1;
          const startRank = me === 'w' ? 6 : 1;
          const promoRank = me === 'w' ? 0 : 7;
          if (onBoard(r + dir, f) && !grid[r + dir][f]) {
            if (r + dir === promoRank) {
              for (const pc of ['q', 'r', 'b', 'n']) add(r, f, r + dir, f, { promo: pc });
            } else {
              add(r, f, r + dir, f);
              if (r === startRank && !grid[r + 2 * dir][f]) add(r, f, r + 2 * dir, f);
            }
          }
          for (const df of [-1, 1]) {
            const tr = r + dir, tf = f + df;
            if (!onBoard(tr, tf)) continue;
            if (grid[tr][tf] && pieceSide(grid[tr][tf]) === opp) {
              if (tr === promoRank) {
                for (const pc of ['q', 'r', 'b', 'n']) add(r, f, tr, tf, { promo: pc });
              } else {
                add(r, f, tr, tf);
              }
            } else if (!grid[tr][tf] && pos.ep === squareName(tr, tf)) {
              add(r, f, tr, tf, { ep: true });
            }
          }
        } else if (LEAP_DELTAS[t]) {
          for (const d of LEAP_DELTAS[t]) {
            const tr = r + d[0], tf = f + d[1];
            if (!onBoard(tr, tf)) continue;
            const q = grid[tr][tf];
            if (!q || pieceSide(q) === opp) add(r, f, tr, tf, null);
          }
        } else {
          const rays = t === 'r' ? SLIDER_RAYS.r : t === 'b' ? SLIDER_RAYS.b : SLIDER_RAYS.q;
          for (const d of rays) {
            let tr = r + d[0], tf = f + d[1];
            while (onBoard(tr, tf)) {
              const q = grid[tr][tf];
              if (!q) {
                add(r, f, tr, tf, null);
              } else {
                if (pieceSide(q) === opp) add(r, f, tr, tf, null);
                break;
              }
              tr += d[0]; tf += d[1];
            }
          }
        }
      }
    }

    // Castling: rights present, king and rook on home squares, path clear and
    // the king never passes through or lands on an attacked square.
    const home = me === 'w' ? 7 : 0;
    const king = me === 'w' ? 'K' : 'k';
    const rook = me === 'w' ? 'R' : 'r';
    if (grid[home][4] === king) {
      if ((pos.castling.indexOf(me === 'w' ? 'K' : 'k') !== -1) && grid[home][7] === rook &&
          !grid[home][5] && !grid[home][6] &&
          !isAttacked(grid, home, 4, opp) && !isAttacked(grid, home, 5, opp) && !isAttacked(grid, home, 6, opp)) {
        add(home, 4, home, 6, { castle: true });
      }
      if ((pos.castling.indexOf(me === 'w' ? 'Q' : 'q') !== -1) && grid[home][0] === rook &&
          !grid[home][1] && !grid[home][2] && !grid[home][3] &&
          !isAttacked(grid, home, 4, opp) && !isAttacked(grid, home, 3, opp) && !isAttacked(grid, home, 2, opp)) {
        add(home, 4, home, 2, { castle: true });
      }
    }

    const legal = [];
    for (const m of moves) {
      const g = grid.map(function(row) { return row.slice(); });
      g[m.tr][m.tf] = m.promo ? (me === 'w' ? m.promo.toUpperCase() : m.promo) : g[m.fr][m.ff];
      g[m.fr][m.ff] = null;
      if (m.ep) g[m.fr][m.tf] = null; // captured pawn sits beside the mover
      if (m.castle) {
        if (m.tf === 6) { g[m.tr][5] = g[m.tr][7]; g[m.tr][7] = null; }
        else { g[m.tr][3] = g[m.tr][0]; g[m.tr][0] = null; }
      }
      const ks = findKing(g, me);
      if (ks && !isAttacked(g, ks[0], ks[1], opp)) {
        legal.push(squareName(m.fr, m.ff) + squareName(m.tr, m.tf) + (m.promo || ''));
      }
    }
    return legal;
  } catch (e) {
    return [];
  }
}
// ---- END LEGAL MOVE GENERATION ----

// Think time for every auto-played move. In 'match' mode the TOTAL wall-clock
// time from the opponent's move to our click should be their smoothed pace
// minus autoBeatByMs (adjusted adaptively by rating) - so analysis time is
// subtracted, and if the engine already burned past the deadline we fire
// almost immediately. Clamped to a safe floor so we never answer instantly,
// capped at maxAutoPlayMs. In 'balance' mode the target is the opponent's
// pace minus beat, so the engine is always faster than the opponent. When no
// pace data exists yet, a random baseline window is used, with one move in
// autoSlowOneIn crossing the slow band instead (0 disables the slow band).
function autoPlayDelay() {
  const maxCap = settings.maxAutoPlayMs || 9000;
  if ((settings.autoTimingMode === 'match' || settings.autoTimingMode === 'balance') && opponentMovedAtMs > 0) {
    const beat = (settings.autoBeatByMs || 0) + adaptiveParams().beatDeltaMs;
    // Always base on opponent pace so the engine is faster than them.
    // user pace is tracked but not used for the delay — it's available for
    // future features (e.g. pacing announcements).
    const basePace = opponentPaceMs;
    if (basePace > 0) {
      const target = Math.max(700, Math.min(maxCap, basePace - beat));
      const elapsed = Date.now() - opponentMovedAtMs;
      logAnalysis('[' + settings.autoTimingMode + '] base=' + (basePace / 1000).toFixed(1) + 's' +
        ' opp=' + (opponentPaceMs / 1000).toFixed(1) + 's user=' + (userPaceMs / 1000).toFixed(1) + 's' +
        ' beat=' + beat + 'ms target=' + (target / 1000).toFixed(1) + 's elapsed=' + (elapsed / 1000).toFixed(1) + 's' +
        ' delay=' + Math.max(200, target - elapsed) + 'ms');
      return Math.max(200, target - elapsed);
    }
    logAnalysis('[' + settings.autoTimingMode + '] no pace data yet, falling back to random');
  }
  const slowOneIn = settings.autoSlowOneIn;
  if (slowOneIn >= 1 && Math.floor(Math.random() * slowOneIn) === 0) {
    return randMs(settings.autoSlowMinMs, settings.autoSlowMaxMs);
  }
  return randMs(settings.autoDelayMinMs, settings.autoDelayMaxMs);
}

// Rolls the 1-in-N chance and, on a hit, returns one of the engine's
// alternative lines (its 2nd/3rd choice - a "normal" move). Returns null
// whenever anything about the situation says "play the best move". Every
// skip reason is logged so the console explains why the best move was kept.
function decideAutoPlayDeviation(result, bestUci) {
  const engine = result.engine;
  const skip = function(reason) { logAnalysis('deviation skipped: ' + reason); return null; };
  if (!engine || !Array.isArray(engine.moves) || !engine.moves.length) return skip('no engine lines');
  if (engine.tablebase) return skip('tablebase position');
  for (const line of engine.moves) {
    if (line.mate != null) return skip('mate on the board');
  }
  const topCp = engine.moves[0].evaluation;
  if (topCp == null) return skip('unknown evaluation');
  const params = adaptiveParams();
  if (Math.abs(topCp) > params.evalCp) {
    return skip('eval ' + (topCp / 100).toFixed(1) + ' outside quiet band +-' + (params.evalCp / 100).toFixed(1));
  }
  if (params.oneIn < 1 || Math.floor(Math.random() * params.oneIn) !== 0) {
    return skip('roll missed (1 in ' + params.oneIn + ')' +
      (opponentElo ? ' vs elo ' + opponentElo : ''));
  }
  const legal = new Set(legalMovesFromFen(result.fen));
  if (legal.size < 2) return skip('only one legal move');
  const bestKey = bestUci.substring(0, 4);
  const seen = new Set();
  const alternatives = [];
  for (const line of engine.moves.slice(1)) {
    let u = (line.move || '').trim();
    if (!/^[a-h][1-8][a-h][1-8]/.test(u)) u = (line.line || '').split(' ')[0];
    u = (u || '').substring(0, 5);
    if (!legal.has(u) || u.substring(0, 4) === bestKey || seen.has(u)) continue;
    seen.add(u);
    alternatives.push(u);
  }
  if (!alternatives.length) return skip('no legal alternative among engine lines');
  const uci = alternatives[Math.floor(Math.random() * alternatives.length)];
  logAnalysis('DEVIATING to ' + uci + ' (engine best ' + bestKey + ')' +
    (opponentElo ? ' vs elo ' + opponentElo : ''));
  return { uci: uci };
}

async function handleBoardUpdate(fen, senderTabId) {
  if (analysisTimeout) clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(async function() {
    const t0 = Date.now();
    logAnalysis('[board-update] pace snapshot: opp=' + (opponentPaceMs / 1000).toFixed(1) + 's you=' + (userPaceMs / 1000).toFixed(1) + 's mode=' + settings.autoTimingMode + ' autoPlay=' + settings.autoPlay);
    try {
      if (fen.split(' ')[0] === START_PLACEMENT) {
        lastTickAt = 0;
        lastTickTurn = '';
        opponentPaceMs = 0;
        opponentMovedAtMs = 0;
        userPaceMs = 0;
        lastUserTickAt = 0;
      }
      // In matched or balanced mode, shrink the engine's time budget so the
      // search can finish inside the reply deadline instead of blowing past it.
      let movetimeMs;
      const maxCap = settings.maxAutoPlayMs || 9000;
      if ((settings.autoTimingMode === 'match' || settings.autoTimingMode === 'balance') &&
          settings.autoPlay && opponentMovedAtMs > 0) {
        const beat = (settings.autoBeatByMs || 0) + adaptiveParams().beatDeltaMs;
        const basePace = opponentPaceMs;
        if (basePace > 0) {
          const target = Math.max(700, Math.min(maxCap, basePace - beat));
          movetimeMs = Math.max(500, Math.min(settings.engineMoveTimeMs,
            target - (Date.now() - opponentMovedAtMs) - 250));
          logAnalysis(settings.autoTimingMode + ' budget ' + Math.round(movetimeMs) + 'ms' +
            ' (target ' + (target / 1000).toFixed(1) + 's)');
        }
      }
      const result = await analyzePosition(fen, { explain: 'async', movetimeMs: movetimeMs });
      logAnalysis(result.fen.split(' ')[0] + ' depth ' + result.engine.depth + ' in ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's' +
        (result.engine.tablebase ? ' (tablebase)' : ' (budget ' + settings.engineMoveTimeMs + 'ms, cap depth ' + settings.depth + ')'));
      sendAnalysisToPopup(result);
      const top = result.engine.moves[0];
      let uci = top.uci || top.move || '';
      if (!/^[a-h][1-8][a-h][1-8]/.test(uci)) {
        uci = (top.line || '').split(' ')[0];
      }
      // Auto-play humaniser: every played move gets a humanised think time -
      // matched to the opponent's pace or a random window - and one move in
      // autoNormalOneIn quiet positions swaps in an alternative (2nd/3rd
      // best) move. The deviation applies in BOTH timing modes; the popup
      // keeps showing the engine's real best line.
      let playDelayMs = 0;
      let playedRankLabel = 'BEST';
      // Maia and the 2nd/3rd-best humaniser are alternative ways to pick a
      // less-than-perfect move, so only one of them runs - stacking both would
      // undo whatever Maia chose.
      const maiaSelection = result.maia && result.maia.selection;
      const useMaia = settings.autoPlay && settings.maiaAutoPlay && maiaSelection && maiaSelection.uci;
      if (settings.autoPlay && /^[a-h][1-8][a-h][1-8]/.test(uci)) {
        playDelayMs = autoPlayDelay();
        const deviation = useMaia ? maiaSelection : decideAutoPlayDeviation(result, uci);
        if (deviation) {
          // Find the deviated move's true rank so the board shows an honest
          // badge for what is actually about to be played.
          const playedKey = deviation.uci.substring(0, 4);
          for (let i = 1; i < result.engine.moves.length && i < 3; i++) {
            let u = result.engine.moves[i].uci || result.engine.moves[i].move || '';
            if (u.substring(0, 4) === playedKey) { playedRankLabel = ['BEST', '2ND', '3RD'][i]; break; }
          }
          uci = deviation.uci;
        }
        if (useMaia) playedRankLabel = maiaSelection.fromMaia ? 'MAIA' : 'GUARDED';
        logAnalysis('auto-play in ' + (playDelayMs / 1000).toFixed(1) + 's' +
          ' (' + settings.autoTimingMode + ' mode, opp=' +
          (opponentPaceMs / 1000).toFixed(1) + 's, you=' +
          (userPaceMs / 1000).toFixed(1) + 's, elo ' +
          (opponentElo || '?') + ', playing ' + playedRankLabel +
          (useMaia && maiaSelection.fromMaia
            ? ' maia-' + result.maia.elo + ' p=' + Math.round((maiaSelection.prob || 0) * 100) + '%'
            : '') + ')');
      }
      if (/^[a-h][1-8][a-h][1-8]/.test(uci)) {
        // Ranked arrows: best (orange) plus 2nd/3rd choices in their own
        // colours, each badged over the line. Auto-play always rides the
        // best move via the from/to/play fields regardless of deviations.
        const RANK_STYLES = [
          { color: '#ff6b35', label: 'BEST' },
          { color: '#2ecc71', label: '2ND' },
          { color: '#3498db', label: '3RD' }
        ];
        const arrows = [];
        const seenSquares = new Set();
        for (let i = 0; i < Math.min(3, result.engine.moves.length); i++) {
          const line = result.engine.moves[i];
          let u = line.uci || line.move || '';
          if (!/^[a-h][1-8][a-h][1-8]/.test(u)) u = (line.line || '').split(' ')[0];
          if (!/^[a-h][1-8][a-h][1-8]/.test(u)) continue;
          const key = u.substring(0, 4);
          if (seenSquares.has(key)) continue;
          seenSquares.add(key);
          arrows.push({
            from: u.substring(0, 2),
            to: u.substring(2, 4),
            color: RANK_STYLES[i].color,
            label: RANK_STYLES[i].label
          });
        }
        if (!arrows.some(a => a.from + a.to === uci.substring(0, 4))) {
          arrows.unshift({
            from: uci.substring(0, 2), to: uci.substring(2, 4),
            color: playedRankLabel === 'BEST' ? '#ff6b35' : '#9b59b6',
            label: playedRankLabel
          });
        }
        const sendArrow = function(tabId) {
          if (!tabId) return;
          chrome.tabs.sendMessage(tabId, {
            type: 'draw-arrow',
            from: uci.substring(0, 2), to: uci.substring(2, 4),
            color: '#ff6b35',
            arrows: arrows,
            play: !!settings.autoPlay,
            playDelayMs: playDelayMs
          }).catch(function() {});
        };
        if (senderTabId) {
          sendArrow(senderTabId);
        } else {
          chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            sendArrow(tabs[0] && tabs[0].id);
          });
        }
      }
      // Explanation trails the engine result so the network never delays
      // arrows or the popup.
      explainWithGemini(result.fen, result.engine).then(function(explanation) {
        chrome.runtime.sendMessage({ type: 'analysis-explanation', fen: result.fen, explanation: explanation }).catch(function() {});
      }).catch(function() {});
    } catch (error) {
      if (/Superseded/i.test(error.message || '')) return;
      console.warn('[analysis] failed after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's:', error.message);
      sendAnalysisToPopup({ ok: false, error: error.message });
    }
  }, settings.debounceMs);
}

// ---- Full-game PGN reconstruction ----
// History snapshots only exist for the user's turns; consecutive snapshots
// are exactly one full move apart (ours + theirs), so both sides' moves can
// be recovered by searching legal moves whose resulting placement matches
// the next snapshot - then rendered in SAN.

function placementKey(fen) { return fen.split(' ')[0]; }

function gridToFen(grid, turn) {
  let rows = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = grid[r][f];
      if (!p) { empty += 1; continue; }
      if (empty) { rows += empty; empty = 0; }
      rows += p;
    }
    if (empty) rows += empty;
    if (r < 7) rows += '/';
  }
  return rows + ' ' + turn + ' - - 0 1';
}

function applyUciToGrid(grid, uci) {
  const g = grid.map(function(row) { return row.slice(); });
  const ff = uci.charCodeAt(0) - 97;
  const fr = 8 - parseInt(uci[1], 10);
  const tf = uci.charCodeAt(2) - 97;
  const tr = 8 - parseInt(uci[3], 10);
  const piece = g[fr][ff];
  if (!piece) return g;
  const promo = uci[4];
  g[tr][tf] = promo ? (pieceSide(piece) === 'w' ? promo.toUpperCase() : promo) : piece;
  g[fr][ff] = null;
  const t = piece.toLowerCase();
  if ((t === 'p') && ff !== tf && !g[tr][tf]) g[fr][tf] = null; // en passant capture
  if (t === 'k' && Math.abs(tf - ff) === 2) {
    if (tf === 6) { g[tr][5] = g[tr][7]; g[tr][7] = null; }
    else { g[tr][3] = g[tr][0]; g[tr][0] = null; }
  }
  return g;
}

function sanFor(fen, uci) {
  try {
    const pos = parseGrid(fen);
    const grid = pos.grid;
    const ff = uci.charCodeAt(0) - 97;
    const fr = 8 - parseInt(uci[1], 10);
    const tf = uci.charCodeAt(2) - 97;
    const tr = 8 - parseInt(uci[3], 10);
    const piece = grid[fr] && grid[fr][ff];
    if (!piece) return uci;
    const t = piece.toLowerCase();
    const isCapture = !!grid[tr][tf] || (t === 'p' && ff !== tf);
    let san;
    if (t === 'k' && Math.abs(tf - ff) === 2) {
      san = tf === 6 ? 'O-O' : 'O-O-O';
    } else if (t === 'p') {
      san = (isCapture ? String.fromCharCode(97 + ff) + 'x' : '') + squareName(tr, tf);
      if (uci[4]) san += '=' + uci[4].toUpperCase();
    } else {
      // Disambiguation: other identical pieces with a legal move to the same
      // target square. File beats rank in SAN precedence.
      const rivals = [];
      for (const u of legalMovesFromFen(fen)) {
        if (u.substring(2, 4) !== uci.substring(2, 4)) continue;
        if (u === uci || u.substring(0, 4) === uci.substring(0, 4)) continue;
        const of = u.charCodeAt(0) - 97;
        const or = 8 - parseInt(u[1], 10);
        if (grid[or][of] === piece) rivals.push(u);
      }
      san = piece.toUpperCase();
      if (rivals.length) {
        const sharesFile = rivals.some(function(u) { return (u.charCodeAt(0) - 97) === ff; });
        const sharesRank = rivals.some(function(u) { return (8 - parseInt(u[1], 10)) === fr; });
        if (!sharesFile) san += String.fromCharCode(97 + ff);
        else if (!sharesRank) san += String(8 - fr);
        else san += squareName(fr, ff);
      }
      if (isCapture) san += 'x';
      san += squareName(tr, tf);
    }
    const after = applyUciToGrid(grid, uci);
    const enemyKing = findKing(after, pos.turn === 'w' ? 'b' : 'w');
    if (enemyKing && isAttacked(after, enemyKing[0], enemyKing[1], pos.turn)) san += '+';
    return san;
  } catch (e) {
    return uci;
  }
}

// Finds the one or two plies that turn prevFen into curFen (our move plus,
// usually, the opponent's reply). Returns [{fen, uci, mover}, ...].
function derivePliesBetween(prevFen, curFen) {
  try {
    const startGrid = parseGrid(prevFen).grid;
    const turn1 = parseGrid(prevFen).turn;
    const turn2 = turn1 === 'w' ? 'b' : 'w';
    const targetKey = placementKey(curFen);
    for (const u1 of legalMovesFromFen(prevFen)) {
      const g1 = applyUciToGrid(startGrid, u1);
      if (placementKey(gridToFen(g1, turn2)) === targetKey) {
        return [{ fen: prevFen, uci: u1, mover: turn1 }];
      }
      const midFen = gridToFen(g1, turn2);
      for (const u2 of legalMovesFromFen(midFen)) {
        if (placementKey(gridToFen(applyUciToGrid(g1, u2), turn1)) === targetKey) {
          return [
            { fen: prevFen, uci: u1, mover: turn1 },
            { fen: midFen, uci: u2, mover: turn2 }
          ];
        }
      }
    }
  } catch (e) {}
  return null;
}

function buildGamePlies() {
  const plies = [];
  let prev = null;
  for (const entry of gameHistory) {
    if (!prev) {
      // As Black the first snapshot misses White's opening move - seed from
      // the initial position so the export starts at ply one.
      if (userColor === 'b') {
        const pair = derivePliesBetween(START_PLACEMENT + ' w KQkq - 0 1', entry.fen);
        if (pair) Array.prototype.push.apply(plies, pair);
      }
    } else {
      const pair = derivePliesBetween(prev, entry.fen);
      if (pair) Array.prototype.push.apply(plies, pair);
    }
    prev = entry.fen;
  }
  return plies;
}

function generatePGN() {
  const plies = buildGamePlies();
  if (!plies.length) return '';
  let text = '';
  let moveNo = 1;
  let awaitingBlack = false;
  for (const ply of plies) {
    const san = sanFor(ply.fen, ply.uci);
    if (ply.mover === 'w') {
      text += (text ? ' ' : '') + moveNo + '. ' + san;
      awaitingBlack = true;
    } else if (awaitingBlack) {
      text += ' ' + san;
      moveNo += 1;
      awaitingBlack = false;
    } else {
      text += (text ? ' ' : '') + moveNo + '... ' + san;
      moveNo += 1;
    }
  }
  const playerName = 'Player';
  const opponentName = 'Opponent';
  return '[Event "Live Analysis"]\n[Site "Chess Analyst"]\n[Date "' +
    new Date().toISOString().split('T')[0] + '"]\n' +
    '[White "' + (userColor === 'b' ? opponentName : playerName) + '"]\n' +
    '[Black "' + (userColor === 'b' ? playerName : opponentName) + '"]\n\n' +
    text.trim();
}

function calculateAccuracy() {
  if (gameHistory.length < 2) return null;
  let totalDiff = 0;
  let count = 0;
  for (let i = 1; i < gameHistory.length; i++) {
    const prev = gameHistory[i - 1].eval;
    const curr = gameHistory[i].eval;
    if (prev != null && curr != null) {
      const diff = Math.abs(prev - curr);
      totalDiff += Math.max(0, 100 - diff / 10);
      count++;
    }
  }
  return count > 0 ? totalDiff / count : null;
}

async function saveGameToArchive() {
  if (gameHistory.length < 2) return;
  const accuracy = calculateAccuracy();
  const plies = buildGamePlies();
  const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
  gameArchive.push({
    timestamp: Date.now(),
    moves: plies.map(function(p) { return sanFor(p.fen, p.uci); }),
    evals: gameHistory.map(function(g) { return g.eval; }),
    accuracy: accuracy
  });
  if (gameArchive.length > 50) gameArchive.splice(0, gameArchive.length - 50);
  await chrome.storage.local.set({ gameArchive: gameArchive });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'sf-line') {
    processEngineLine(message.text);
    return false;
  }
  if (message.type === 'sf-engine-loaded') {
    logEngine('worker booting (' + (engineReady ? 'already ready?' : 'awaiting uci') + ')');
    if (!engineReady) sfCommand('uci');
    return false;
  }
  if (message.type === 'maia-line') {
    logEngine(message.text);
    return false;
  }
  if (message.type === 'warm-position') {
    try { validateFen(message.fen); } catch (e) { return false; }
    warmEngine(message.fen);
    return false;
  }
  if (message.type === 'analyze-position') {
    (async function() {
      try { sendResponse(await analyzePosition(message.fen)); }
      catch (error) { sendResponse({ ok: false, error: error.message }); }
    })();
    return true;
  }
  if (message.type === 'maia-analyze') {
    // On-demand Maia read for the popup. Never throws - a failure just hides
    // the panel, so a broken model can never take the popup down with it.
    (async function() {
      try {
        await loadSettings();
        const validated = validateFen(message.fen);
        const legal = legalMovesFromFen(validated);
        if (!legal.length) { sendResponse({ ok: false, error: 'no legal moves' }); return; }
        const maia = await maiaPredict(validated, legal, {
          elo: message.elo, limit: message.limit || 5
        });
        if (!maia) { sendResponse({ ok: false, error: 'maia unavailable' }); return; }
        sendResponse({ ok: true, maia: maia });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }
  if (message.type === 'maia-warm') {
    // Fired after Maia is enabled so the first real position does not pay the
    // model load. Warm-up is best-effort; a failure is invisible to the user.
    (async function() {
      try {
        await loadSettings();
        await ensureOffscreen();
        await chrome.runtime.sendMessage({ type: 'maia-warm', elo: normalizeMaiaElo(message.elo) });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }
  if (message.type === 'board-update') {
    handleBoardUpdate(message.fen, _sender && _sender.tab && _sender.tab.id);
    return false;
  }
  if (message.type === 'auto-play-move') {
    (async function() {
      const tabId = _sender && _sender.tab && _sender.tab.id;
      let result = { ok: false, reason: 'no tab' };
      try { result = await debuggerPlay(tabId, message.from, message.to, message.points); }
      catch (e) { result = { ok: false, reason: e.message }; }
      try { sendResponse(result); } catch (e) {}
    })();
    return true;
  }
  if (message.type === 'auto-play-failed') {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    if (tabId != null && chrome.action) {
      Promise.all([
        chrome.action.setBadgeBackgroundColor({ color: '#d64545', tabId: tabId }),
        chrome.action.setBadgeText({ text: '!', tabId: tabId })
      ]).then(function() {
        setTimeout(function() {
          chrome.action.setBadgeText({ text: '', tabId: tabId }).catch(function() {});
        }, 6000);
      }).catch(function() {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === 'export-pgn') {
    sendResponse({ ok: true, pgn: generatePGN() });
    return true;
  }
  if (message.type === 'engine-status') {
    sendResponse({ ok: true, ready: engineReady });
    return true;
  }
  if (message.type === 'get-history') {
    sendResponse({ ok: true, history: gameHistory });
    return true;
  }
  if (message.type === 'save-game') {
    saveGameToArchive().then(function() { sendResponse({ ok: true }); });
    return true;
  }
  if (message.type === 'get-evals') {
    const evals = gameHistory.map(function(g) { return g.eval; });
    sendResponse({ ok: true, evals: evals });
    return true;
  }
  if (message.type === 'turn-tick') {
    trackTurnTick(message.userColor, message.turn, message.fen, message.oppElo);
    return false;
  }
  if (message.type === 'check-update') {
    (async function() {
      try { sendResponse({ ok: true, update: await checkForUpdate(!!message.force) }); }
      catch (error) { sendResponse({ ok: false, error: error.message }); }
    })();
    return true;
  }
  return undefined;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-analysis') {
    chrome.storage.local.get('monitoring', function(data) {
      const newState = !data.monitoring;
      chrome.storage.local.set({ monitoring: newState });
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: newState ? 'start-monitoring' : 'stop-monitoring'
          }).catch(function() {});
        }
      });
      chrome.runtime.sendMessage({ type: 'monitoring-toggled', monitoring: newState }).catch(function() {});
    });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && tab.url.includes('chess.com')) {
      chrome.tabs.sendMessage(activeInfo.tabId, { type: 'start-monitoring' }).catch(function() {});
    }
  } catch (e) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.includes('chess.com')) {
    chrome.tabs.sendMessage(tabId, { type: 'start-monitoring' }).catch(function() {});
  }
});

ensureOffscreen().catch(function(e) {
  console.error('Chess Analyst: offscreen setup failed:', e.message);
});
loadSettings();
checkForUpdate(false).catch(function(e) {
  logEngine('update check failed: ' + e.message);
});
