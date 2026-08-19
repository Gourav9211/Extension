const GEMINI_MODEL = 'gemini-2.0-flash';
const CACHE_TTL = 60000;
const MAX_CACHE_SIZE = 50;

let analysisTimeout = null;
let positionCache = new Map();
let gameHistory = [];
let engineReady = false;
let offscreenCreated = false;
let pendingEvaluations = new Map();

const OPENINGS = {
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR': 'King\'s Pawn Opening',
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR': 'Queen\'s Pawn Opening',
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR': 'English Opening',
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R': 'Reti Opening',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR': 'Open Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR': 'Scandinavian Defense',
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR': 'Sicilian Defense',
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R': 'French Defense',
  'rnbqkbnr/pppp1ppp/8/8/3nP2N/8/PPPP1PPP/RNBQKB1R': 'Scotch Game'
};

function validateFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error('Invalid FEN');
  const ranks = fields[0].split('/');
  if (ranks.length !== 8 || !/^[prnbqkPRNBQK1-8/]+$/.test(fields[0])) {
    throw new Error('Invalid FEN board');
  }
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

function detectOpening(fen) {
  const board = fen.split(' ')[0];
  return OPENINGS[board] || null;
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

async function initEngine() {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ type: 'init-engine' });
}

function evaluateWithStockfish(fen, multiPv = 3) {
  return new Promise((resolve, reject) => {
    const id = Date.now();
    pendingEvaluations.set(id, { resolve, reject });
    chrome.runtime.sendMessage({ type: 'evaluate', fen, depth: 18, multiPv });

    const timeout = setTimeout(() => {
      pendingEvaluations.delete(id);
      reject(new Error('Stockfish evaluation timeout'));
    }, 15000);

    const listener = (message) => {
      if (message.type === 'engine-result') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        const pending = pendingEvaluations.get(id);
        if (pending) {
          pendingEvaluations.delete(id);
          pending.resolve(message);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
  });
}

async function findBestMoves(fen) {
  const cached = getCached(fen);
  if (cached) return cached;

  const result = await evaluateWithStockfish(fen, 3);
  const moves = result.moves.map(m => ({
    move: m.move,
    line: m.line,
    evaluation: m.evaluation,
    mate: m.mate
  }));

  const output = { moves, depth: result.moves[0]?.depth ?? 18, fen };
  setCache(fen, output);
  return output;
}

async function explainWithGemini(fen, engine) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return 'Add a Gemini API key in settings for explanations.';

  const topMove = engine.moves[0];
  const prompt = [
    'You are a chess coach explaining a position.',
    'FEN: ' + fen,
    'Top move: ' + topMove.move,
    'Engine line: ' + topMove.line,
    'Explain why this move is strong in 2-3 sentences.'
  ].join('\n');

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!response.ok) return 'Explanation unavailable.';
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No explanation.';
  } catch {
    return 'Explanation unavailable.';
  }
}

async function analyzePosition(fen) {
  const engine = await findBestMoves(fen);
  let explanation = null;
  try {
    explanation = await explainWithGemini(fen, engine);
  } catch {
    explanation = 'Explanation unavailable.';
  }

  const opening = detectOpening(fen);
  gameHistory.push({ fen, bestMove: engine.moves[0].move, timestamp: Date.now() });
  if (gameHistory.length > 200) gameHistory = gameHistory.slice(-200);

  return { ok: true, engine, explanation, opening };
}

function sendAnalysisToPopup(result) {
  chrome.runtime.sendMessage({ type: 'analysis-result', ...result }).catch(() => {});
}

async function handleBoardUpdate(fen) {
  if (analysisTimeout) clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(async () => {
    try {
      const result = await analyzePosition(fen);
      sendAnalysisToPopup(result);
      const bestMove = result.engine.moves[0].move;
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'draw-arrow',
            from: bestMove.substring(0, 2),
            to: bestMove.substring(2, 4),
            color: '#ff6b35'
          }).catch(() => {});
        }
      });
    } catch (error) {
      sendAnalysisToPopup({ ok: false, error: error.message });
    }
  }, 500);
}

function generatePGN() {
  if (!gameHistory.length) return '';
  let pgn = '[Event "Live Analysis"]\n';
  pgn += '[Site "Chess Position Analyst"]\n';
  pgn += '[Date "' + new Date().toISOString().split('T')[0] + '"]\n';
  pgn += '[White "User"]\n';
  pgn += '[Black "Engine"]\n\n';
  const moves = gameHistory.filter(g => g.bestMove);
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) pgn += (Math.floor(i / 2) + 1) + '. ';
    pgn += moves[i].bestMove + ' ';
  }
  return pgn.trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'analyze-position') {
    (async () => {
      try {
        const result = await analyzePosition(message.fen);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
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

  if (message.type === 'toggle-monitoring') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: message.monitoring ? 'start-monitoring' : 'stop-monitoring' }).catch(() => {});
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'engine-ready') {
    engineReady = true;
    return false;
  }

  if (message.type === 'engine-result') {
    const pending = pendingEvaluations.values().next().value;
    if (pending) {
      pendingEvaluations.clear();
      pending.resolve(message);
    }
    return false;
  }

  return undefined;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-analysis') {
    chrome.storage.local.get('monitoring', ({ monitoring }) => {
      const newState = !monitoring;
      chrome.storage.local.set({ monitoring: newState });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: newState ? 'start-monitoring' : 'stop-monitoring' }).catch(() => {});
        }
      });
      chrome.runtime.sendMessage({ type: 'monitoring-toggled', monitoring: newState }).catch(() => {});
    });
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.includes('chess.com')) {
      chrome.tabs.sendMessage(activeInfo.tabId, { type: 'start-monitoring' }).catch(() => {});
    }
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('chess.com')) {
    chrome.tabs.sendMessage(tabId, { type: 'start-monitoring' }).catch(() => {});
  }
});

initEngine();
