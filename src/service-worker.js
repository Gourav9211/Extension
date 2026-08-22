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
let settings = { depth: 18, multiPv: 3, sound: true, debounceMs: 500, classify: true, geminiPrompt: '' };

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

const PIECE_TO_SAN = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: '' };

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
  if (isMate) {
    if (diff > 300) return 'brilliant';
    if (diff > 50) return 'good';
    if (diff > -50) return 'inaccuracy';
    if (diff > -300) return 'mistake';
    return 'blunder';
  }
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
  const stored = await chrome.storage.local.get(['depth', 'multiPv', 'sound', 'debounceMs', 'classify', 'geminiPrompt']);
  if (stored.depth) settings.depth = stored.depth;
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
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Running Stockfish chess engine'
    });
    offscreenCreated = true;
  } catch (e) {
    if (!e.message?.includes('already exists')) throw e;
    offscreenCreated = true;
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
    if (engineReady) { waiter.resolve(); }
  });
}

function sfCommand(cmd) {
  chrome.runtime.sendMessage({ type: 'sf-cmd', cmd }).catch(function() {});
}

function uciToSan(uciMove, fen) {
  if (!uciMove || uciMove.length < 4) return uciMove;
  const from = uciMove.substring(0, 2);
  const to = uciMove.substring(2, 4);
  const promo = uciMove.length > 4 ? uciMove[4] : null;
  const board = fen.split(' ')[0];
  const rows = board.split('/');
  const pieceMap = {};
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { c += parseInt(ch); }
      else { pieceMap[String.fromCharCode(97 + c) + (8 - r)] = ch; c++; }
    }
  }
  const piece = pieceMap[from];
  if (!piece) return uciMove;
  const san = PIECE_TO_SAN[piece.toLowerCase()];
  const isCapture = !!pieceMap[to];
  if (piece.toLowerCase() === 'k') {
    if (from === 'e1' && to === 'g1') return 'O-O';
    if (from === 'e1' && to === 'c1') return 'O-O-O';
    if (from === 'e8' && to === 'g8') return 'O-O';
    if (from === 'e8' && to === 'c8') return 'O-O-O';
    return 'K' + (isCapture ? 'x' : '') + to;
  }
  if (piece.toLowerCase() === 'p') {
    let result = '';
    if (isCapture) result = from[0] + 'x';
    result += to;
    if (promo) result += '=' + promo.toUpperCase();
    return result;
  }
  return san + (isCapture ? 'x' : '') + to;
}

async function queryTablebase(fen) {
  try {
    const resp = await fetch(TABLEBASE_URL + '?fen=' + encodeURIComponent(fen));
    if (!resp.ok) return null;
    const data = await resp.json();
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
    }, 30000);
    sfCommand('stop');
    sfCommand('ucinewgame');
    sfCommand('position fen ' + fen);
    sfCommand('go depth ' + settings.depth + ' multipv ' + multiPv);
  });
}

function processEngineLine(text) {
  if (text === 'uciok') {
    engineReady = true;
    for (const w of engineReadyWaiters) w.resolve();
    engineReadyWaiters = [];
    return;
  }
  if (text.startsWith('bestmove') && pendingEval) {
    const info = pendingEval;
    pendingEval = null;
    clearTimeout(info.timeout);
    const move = text.split(' ')[1];
    const parsed = parseInfoLines(info.lines);
    if (!parsed.length && move) {
      parsed.push({ move: move, line: move, evaluation: null, mate: null, depth: null });
    }
    info.resolve({ bestMove: move, moves: parsed });
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

async function analyzePosition(fen) {
  await loadSettings();
  await waitForEngine();
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

  let explanation = null;
  try { explanation = await explainWithGemini(validated, engine); }
  catch (e) { explanation = 'Explanation unavailable.'; }

  gameHistory.push({
    fen: validated, bestMove: engine.moves[0].move, eval: currCp,
    timestamp: Date.now(), classification: classification
  });
  if (gameHistory.length > 200) gameHistory = gameHistory.slice(-200);

  return {
    ok: true, engine: engine, explanation: explanation, opening: opening,
    classification: classification, classifyLabel: classifyLabel(classification),
    tablebase: !!engine.tablebase, category: engine.category || null
  };
}

function sendAnalysisToPopup(result) {
  chrome.runtime.sendMessage(Object.assign({ type: 'analysis-result' }, result)).catch(function() {});
}

async function handleBoardUpdate(fen) {
  if (analysisTimeout) clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(async function() {
    try {
      const result = await analyzePosition(fen);
      sendAnalysisToPopup(result);
      const bestMove = result.engine.moves[0].move;
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'draw-arrow',
            from: bestMove.substring(0, 2), to: bestMove.substring(2, 4),
            color: '#ff6b35'
          }).catch(function() {});
        }
      });
    } catch (error) {
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
    const san = uciToSan(moves[i].bestMove, moves[i].fen);
    pgn += san + ' ';
  }
  return pgn.trim();
}

function calculateAccuracy() {
  if (gameHistory.length < 2) return null;
  let totalScore = 0;
  let count = 0;
  for (let i = 1; i < gameHistory.length; i++) {
    const prev = gameHistory[i - 1].eval;
    const curr = gameHistory[i].eval;
    if (prev != null && curr != null) {
      const swing = Math.abs(prev - curr);
      const clamped = Math.min(swing, 1000);
      totalScore += Math.max(0, 100 - clamped / 15);
      count++;
    }
  }
  return count > 0 ? Math.min(100, Math.max(0, totalScore / count)) : null;
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
    if (!engineReady) sfCommand('uci');
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
    handleBoardUpdate(message.fen);
    return false;
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

chrome.action.onClicked.addListener(function() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/popup.html') });
});

ensureOffscreen();
loadSettings();
