const ENGINE_URL = 'https://lichess.org/api/cloud-eval';
const GEMINI_MODEL = 'gemini-2.0-flash';
const OPENING_DB_URL = 'https://explorer.lichess.ovh/masters';
const CACHE_TTL = 60000;
const MAX_CACHE_SIZE = 50;

let analysisTimeout = null;
let positionCache = new Map();
let gameHistory = [];

const OPENINGS = {
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR': 'King\'s Pawn Opening',
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR': 'Queen\'s Pawn Opening',
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR': 'English Opening',
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R': 'Reti Opening',
  'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR': 'Larsen Opening',
  'rnbqkbnr/pppppppp/8/8/8/1P6/P1PPPPPP/RNBQKBNR': 'Sokolsky Opening',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR': 'Open Game',
  'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR': 'Center Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR': 'Center Game',
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R': 'French Defense',
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR': 'Sicilian Defense',
  'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR': 'Scandinavian Defense',
  'rnbqkbnr/pppp1ppp/8/8/3nP2N/8/PPPP1PPP/RNBQKB1R': 'Scotch Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/3P4/PPP2PPP/RNBQK1NR': 'Italian Game: Giuoco Piano',
  'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R': 'Italian Game',
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR': 'Queen\'s Pawn Opening',
  'rnbqkbnr/pppppppp/8/8/1P6/8/P1PPPPPP/RNBQKBNR': 'Sokolsky Opening',
  'rnbqkbnr/pppppppp/8/8/8/7N/PPPPPPPP/RNBQKB1R': 'Van\'t Kruijs Opening',
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR': 'English Opening',
  'rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR': 'Vienna Game',
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/5N2/PPPP1PPP/RNBQKB1R': 'French Defense',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKBNR': 'Open Game',
  'rnbqkbnr/pppppppp/8/8/8/3P4/PPP1PPPP/RNBQKBNR': 'General',
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/4N2/PPPP1PPP/RNBQKB1R': 'Bongcloud Attack'
};

function validateFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error('Invalid FEN: too few fields.');
  const ranks = fields[0].split('/');
  if (ranks.length !== 8 || !/^[prnbqkPRNBQK1-8/]+$/.test(fields[0])) {
    throw new Error('Invalid FEN: bad board layout.');
  }
  if (!/^[wb]$/.test(fields[1])) throw new Error('Invalid FEN: bad side to move.');
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

async function findBestMoves(fen) {
  const cached = getCached(fen);
  if (cached) return cached;

  const response = await fetch(`${ENGINE_URL}?fen=${encodeURIComponent(validateFen(fen))}&multiPv=3`);
  if (response.status === 429) throw new Error('Engine rate limit reached. Try again shortly.');
  if (!response.ok) throw new Error(`Engine request failed (${response.status}).`);

  const data = await response.json();
  if (!data.pvs?.length) throw new Error('No engine evaluation available for this position.');

  const moves = data.pvs.map(pv => ({
    move: pv.moves.split(' ')[0],
    line: pv.moves,
    evaluation: pv.cp ?? null,
    mate: pv.mate ?? null
  }));

  const result = {
    moves,
    depth: data.depth ?? null,
    fen
  };

  setCache(fen, result);
  return result;
}

async function explainWithGemini(fen, engine) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return 'Add a Gemini API key in extension settings for explanations.';

  const topMove = engine.moves[0];
  const prompt = [
    'You are a chess coach explaining a position to a student.',
    `Position FEN: ${fen}`,
    `Top move: ${topMove.move}`,
    `Engine line: ${topMove.line}`,
    `Other candidates: ${engine.moves.slice(1).map(m => m.move).join(', ') || 'none'}`,
    'Explain why the top move is strong. Mention tactics/strategy, opponent response, and one practical caution. Keep it under 3 sentences.'
  ].join('\n');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (response.status === 429) throw new Error('Gemini rate limit reached.');
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No explanation available.';
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
      const from = bestMove.substring(0, 2);
      const to = bestMove.substring(2, 4);
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'draw-arrow', from, to, color: '#ff6b35' }).catch(() => {});
        }
      });
    } catch (error) {
      sendAnalysisToPopup({ ok: false, error: error.message });
    }
  }, 300);
}

function generatePGN() {
  if (!gameHistory.length) return '';
  let pgn = '[Event "Live Analysis"]\n';
  pgn += '[Site "Chess Position Analyst"]\n';
  pgn += '[Date "' + new Date().toISOString().split('T')[0] + '"]\n';
  pgn += '[Round "1"]\n';
  pgn += '[White "User"]\n';
  pgn += '[Black "Engine"]\n\n';

  const moves = gameHistory.filter(g => g.bestMove);
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) pgn += `${Math.floor(i / 2) + 1}. `;
    pgn += `${moves[i].bestMove} `;
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
    const pgn = generatePGN();
    sendResponse({ ok: true, pgn });
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
