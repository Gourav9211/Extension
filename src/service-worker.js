const GEMINI_MODEL = 'gemini-2.0-flash';
const CACHE_TTL = 60000;
const MAX_CACHE_SIZE = 50;
const ENGINE_DEPTH = 18;

let analysisTimeout = null;
let positionCache = new Map();
let gameHistory = [];
let offscreenCreated = false;
let engineReady = false;
let engineReadyPromise = null;
let engineReadyResolve = null;
let pendingEval = null;

const OPENINGS = {
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR': 'King\'s Pawn',
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR': 'Queen\'s Pawn',
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR': 'English',
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R': 'Reti',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR': 'Open Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR': 'Scandinavian',
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR': 'Sicilian',
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R': 'French',
  'rnbqkbnr/pppp1ppp/8/8/3nP2N/8/PPPP1PPP/RNBQKB1R': 'Scotch'
};

function validateFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error('Invalid FEN');
  if (!/^[prnbqkPRNBQK1-8/]+$/.test(fields[0]) || fields[0].split('/').length !== 8) {
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

function waitForEngine(timeoutMs = 10000) {
  if (engineReady) return Promise.resolve();
  if (engineReadyPromise) return engineReadyPromise;
  engineReadyPromise = new Promise((resolve, reject) => {
    engineReadyResolve = resolve;
    setTimeout(() => reject(new Error('Engine init timeout')), timeoutMs);
  });
  return engineReadyPromise;
}

function sfCommand(cmd) {
  chrome.runtime.sendMessage({ type: 'sf-cmd', cmd }).catch(() => {});
}

function evaluateWithStockfish(fen, multiPv = 3) {
  return new Promise((resolve, reject) => {
    if (pendingEval) {
      pendingEval.reject(new Error('Superseded'));
    }

    const info = { lines: [], bestMove: null, resolve, reject };
    pendingEval = info;

    const timeout = setTimeout(() => {
      if (pendingEval === info) {
        pendingEval = null;
        reject(new Error('Engine evaluation timeout'));
      }
    }, 30000);

    info.timeout = timeout;
    sfCommand('stop');
    sfCommand('ucinewgame');
    sfCommand('position fen ' + fen);
    sfCommand('go depth ' + ENGINE_DEPTH + ' multipv ' + multiPv);
  });
}

function processEngineLine(text) {
  if (text === 'uciok') {
    engineReady = true;
    if (engineReadyResolve) {
      engineReadyResolve();
      engineReadyResolve = null;
    }
    return;
  }

  if (text.startsWith('bestmove') && pendingEval) {
    const info = pendingEval;
    pendingEval = null;
    clearTimeout(info.timeout);

    const move = text.split(' ')[1];
    const parsed = parseInfoLines(info.lines);
    if (!parsed.length && move) {
      parsed.push({ move, line: move, evaluation: null, mate: null, depth: null });
    }
    info.resolve({ bestMove: move, moves: parsed });
    return;
  }

  if (text.startsWith('info') && pendingEval) {
    const line = text;
    if (line.includes(' pv ')) {
      pendingEval.lines.push(line);
    }
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
      move,
      line: pvMatch[1],
      evaluation: scoreMatch?.[1] === 'cp' ? parseInt(scoreMatch[2]) : null,
      mate: scoreMatch?.[1] === 'mate' ? parseInt(scoreMatch[2]) : null,
      depth: depthMatch ? parseInt(depthMatch[1]) : null
    });
  }
  return result;
}

async function explainWithGemini(fen, engine) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return 'Add a Gemini API key in settings for explanations.';
  const topMove = engine.moves[0];
  const prompt = [
    'You are a chess coach. Explain this position briefly.',
    'FEN: ' + fen,
    'Best move: ' + topMove.move,
    'Line: ' + topMove.line,
    'Explain in 2-3 sentences why it is strong.'
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
  } catch { return 'Explanation unavailable.'; }
}

async function analyzePosition(fen) {
  await waitForEngine();
  const cached = getCached(fen);
  const engine = cached || await evaluateWithStockfish(fen, 3);
  if (!cached) setCache(fen, engine);

  let explanation = null;
  try { explanation = await explainWithGemini(fen, engine); }
  catch { explanation = 'Explanation unavailable.'; }

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
  let pgn = '[Event Live Analysis]\n[Site Chess Analyst]\n[Date  + new Date().toISOString().split(T)[0] + ]\n[White User]\n[Black Engine]\n\n';
  const moves = gameHistory.filter(g => g.bestMove);
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) pgn += (Math.floor(i / 2) + 1) + '. ';
    pgn += moves[i].bestMove + ' ';
  }
  return pgn.trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'sf-line') {
    processEngineLine(message.text);
    return false;
  }

  if (message.type === 'analyze-position') {
    (async () => {
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

(async () => {
  await ensureOffscreen();
  sfCommand('uci');
})();
