const GEMINI_MODEL = 'gemini-2.0-flash';
const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard';
const CACHE_TTL = 60000;
const MAX_CACHE_SIZE = 50;

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
let settings = { depth: 22, multiPv: 3, sound: true, debounceMs: 500, classify: true, autoPlay: false, geminiPrompt: '' };

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
  const stored = await chrome.storage.local.get(['depth', 'multiPv', 'sound', 'debounceMs', 'classify', 'autoPlay', 'geminiPrompt']);
  if (stored.depth) settings.depth = stored.depth;
  if (stored.autoPlay != null) settings.autoPlay = !!stored.autoPlay;
  if (stored.multiPv) settings.multiPv = stored.multiPv;
  if (stored.sound != null) settings.sound = stored.sound;
  if (stored.debounceMs) settings.debounceMs = stored.debounceMs;
  if (stored.classify != null) settings.classify = stored.classify;
  if (stored.geminiPrompt != null) settings.geminiPrompt = stored.geminiPrompt;
}

function detectOpening(fen) {
  return OPENINGS[fen.split(' ')[0]] || null;
}

async function ensureOffscreen() {
  if (offscreenCreated) return;
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (contexts && contexts.length) {
        offscreenCreated = true;
        return;
      }
    }
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Running Stockfish chess engine'
    });
    offscreenCreated = true;
  } catch (e) {
    if (/already exists|single offscreen document/i.test(e.message || '')) {
      offscreenCreated = true;
    } else {
      throw e;
    }
  }
}

function waitForEngine(timeoutMs) {
  if (engineReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = engineReadyWaiters.indexOf(waiter);
      if (idx !== -1) engineReadyWaiters.splice(idx, 1);
      reject(new Error('Engine init timeout'));
    }, timeoutMs || 15000);
    const waiter = { resolve: function() { clearTimeout(timer); resolve(); }, reject: reject };
    engineReadyWaiters.push(waiter);
  });
}

function sfCommand(cmd) {
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

function evaluateWithStockfish(fen, multiPv) {
  return new Promise((resolve, reject) => {
    if (pendingEval) {
      const old = pendingEval;
      pendingEval = null;
      clearTimeout(old.timeout);
      old.reject(new Error('Superseded by new request'));
    }
    const info = { lines: [], resolve: resolve, reject: reject, timeout: null };
    pendingEval = info;
    info.timeout = setTimeout(function() {
      if (pendingEval === info) {
        pendingEval = null;
        reject(new Error('Engine evaluation timeout'));
      }
    }, Math.max(18000, settings.depth * 1200));
    sfCommand('stop');
    sfCommand('position fen ' + fen);
    // movetime caps the search so a position never hangs the UI; depth is
    // the usual stopping criterion on easy positions.
    sfCommand('go depth ' + settings.depth + ' movetime 5000 multipv ' + multiPv);
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
    // Reset transposition tables exactly once per engine boot. Never between
    // searches: keeping the hash warm across moves is a major speed win.
    sfCommand('ucinewgame');
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
  if (!geminiApiKey) return 'Add a Gemini API key in settings for explanations.';
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
    if (!response.ok) return 'Explanation unavailable.';
    const data = await response.json();
    return (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || 'No explanation.';
  } catch (e) {
    return 'Explanation unavailable.';
  }
}

async function analyzePosition(fen, opts) {
  const explainMode = (opts && opts.explain) || 'await';
  await loadSettings();
  await waitForEngine(30000);
  const validated = validateFen(fen);
  const pieceCount = countPieces(validated);

  let engine;
  let opening = detectOpening(validated);
  let classification = null;

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

  if (!engine) {
    const cached = getCached(validated);
    engine = cached || await evaluateWithStockfish(validated, settings.multiPv);
    if (!cached) setCache(validated, engine);
  }

  if (lastEval != null && settings.classify) {
    const currCp = engine.moves[0].evaluation;
    const isMate = engine.moves[0].mate != null;
    classification = classifyMove(lastEval, currCp, isMate);
  }
  const currCp = engine.moves[0].evaluation;
  if (currCp != null) lastEval = currCp;

  // In 'async' mode the caller wants the engine result immediately and will
  // fetch the Gemini explanation separately - the arrow must not wait on a
  // network round-trip.
  let explanation = null;
  if (explainMode !== 'async') {
    try { explanation = await explainWithGemini(validated, engine); }
    catch (e) { explanation = 'Explanation unavailable.'; }
  }

  gameHistory.push({
    fen: validated, bestMove: engine.moves[0].move, eval: currCp,
    timestamp: Date.now(), classification: classification
  });
  if (gameHistory.length > 200) gameHistory = gameHistory.slice(-200);

  return {
    ok: true, fen: validated, engine: engine, explanation: explanation, opening: opening,
    classification: classification, classifyLabel: classifyLabel(classification),
    tablebase: !!engine.tablebase, category: engine.category || null
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

async function handleBoardUpdate(fen, senderTabId) {
  if (analysisTimeout) clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(async function() {
    const t0 = Date.now();
    try {
      const result = await analyzePosition(fen, { explain: 'async' });
      logAnalysis(result.fen.split(' ')[0] + ' depth ' + result.engine.depth + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      sendAnalysisToPopup(result);
      const top = result.engine.moves[0];
      let uci = top.uci || top.move || '';
      if (!/^[a-h][1-8][a-h][1-8]/.test(uci)) {
        uci = (top.line || '').split(' ')[0];
      }
      if (/^[a-h][1-8][a-h][1-8]/.test(uci)) {
        const sendArrow = function(tabId) {
          if (!tabId) return;
          chrome.tabs.sendMessage(tabId, {
            type: 'draw-arrow',
            from: uci.substring(0, 2), to: uci.substring(2, 4),
            color: '#ff6b35',
            play: !!settings.autoPlay
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

function generatePGN() {
  if (!gameHistory.length) return '';
  const dateStr = new Date().toISOString().split('T')[0];
  let pgn = '[Event "Live Analysis"]\n[Site "Chess Analyst"]\n[Date "' + dateStr + '"]\n[White "User"]\n[Black "Engine"]\n\n';
  const moves = gameHistory.filter(function(g) { return g.bestMove; });
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) pgn += (Math.floor(i / 2) + 1) + '. ';
    pgn += moves[i].bestMove + ' ';
  }
  return pgn.trim();
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
  const { gameArchive = [] } = await chrome.storage.local.get('gameArchive');
  gameArchive.push({
    timestamp: Date.now(),
    moves: gameHistory.map(function(g) { return g.bestMove; }),
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
