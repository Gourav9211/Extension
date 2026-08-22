let lastFen = '';
let observer = null;
let coordsOverlay = null;
let coordsVisible = false;
let observeRetryTimer = null;
let lastCaptureErrorLog = { message: '', ts: 0 };

function findBoard() {
  const candidates = new Set();
  const selectors = ['chess-board', '[data-board]', '[data-fen]', '.board', '[class*="board"]'];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      if (el instanceof Element) candidates.add(el);
    }
  }

  let best = null;
  let bestScore = -1;
  for (const board of candidates) {
    const score = scoreBoardCandidate(board);
    if (score > bestScore) {
      best = board;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function scoreBoardCandidate(board) {
  let score = 0;
  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen) score += 100;

  const pieces = board.querySelectorAll('.piece');
  if (pieces.length) score += 20;

  let squareClassHits = 0;
  const piecePattern = /(?:^|\s)([wb])([prnbqk])(?:\s|$)/i;
  for (const piece of pieces) {
    if (piecePattern.test(piece.className) && /square-(\d+|[a-h][1-8])/i.test(piece.className)) {
      squareClassHits += 1;
      if (squareClassHits >= 4) break;
    }
  }
  if (squareClassHits) score += 40;

  const rect = board.getBoundingClientRect();
  const area = Math.max(0, rect.width * rect.height);
  score += Math.min(20, area / 20000);

  return score;
}

function squareFromClass(squareNumber, isBlackOrientation) {
  const index = squareNumber - 1;
  const file = index % 8;
  const row = Math.floor(index / 8);
  const displayFile = isBlackOrientation ? 7 - file : file;
  const displayRank = isBlackOrientation ? row + 1 : 8 - row;
  return `${String.fromCharCode(97 + displayFile)}${displayRank}`;
}

function capturePosition() {
  const board = findBoard();
  if (!board) {
    return null;
  }

  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen) {
    return { fen: directFen, source: 'Chess.com board FEN' };
  }

  const isBlackOrientation = /orientation-black/.test(board.className) || /orientation-black/.test(board.parentElement?.className || '');
  const pieces = [...board.querySelectorAll('.piece')];
  const squares = new Map();
  const piecePattern = /(?:^|\s)([wb])([prnbqk])(?:\s|$)/i;

  for (const piece of pieces) {
    const pieceMatch = piece.className.match(piecePattern);
    const squareNumberMatch = piece.className.match(/square-(\d+)/);
    const squareCoordMatch = piece.className.match(/square-([a-h][1-8])/i);
    if (!pieceMatch || (!squareNumberMatch && !squareCoordMatch)) continue;
    if (squareNumberMatch) {
      squares.set(squareFromClass(Number(squareNumberMatch[1]), isBlackOrientation), pieceMatch[1].toLowerCase() + pieceMatch[2].toLowerCase());
      continue;
    }
    if (squareCoordMatch) {
      squares.set(squareCoordMatch[1].toLowerCase(), pieceMatch[1].toLowerCase() + pieceMatch[2].toLowerCase());
    }
  }

  if (!squares.size) {
    return null;
  }

  const rows = [];
  for (let rank = 8; rank >= 1; rank -= 1) {
    let empty = 0;
    let row = '';
    for (let file = 0; file < 8; file += 1) {
      const piece = squares.get(`${String.fromCharCode(97 + file)}${rank}`);
      if (!piece) {
        empty += 1;
      } else {
        if (empty) row += empty;
        empty = 0;
        row += piece[0] === 'w' ? piece[1].toUpperCase() : piece[1];
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }

  const sideToMove = board.getAttribute('data-side-to-move') || 'w';
  return { fen: `${rows.join('/')} ${sideToMove} - - 0 1`, source: 'Chess.com board pieces' };
}

function sendFenUpdate() {
  try {
    const position = capturePosition();
    if (!position) return;
    if (position.fen !== lastFen) {
      lastFen = position.fen;
      chrome.runtime.sendMessage({ type: 'board-update', fen: position.fen });
    }
  } catch (error) {
    const now = Date.now();
    const message = error && error.message ? error.message : String(error);
    if (message !== lastCaptureErrorLog.message || now - lastCaptureErrorLog.ts > 10000) {
      console.error('Chess extension error:', message);
      lastCaptureErrorLog = { message, ts: now };
    }
  }
}

function showCoords() {
  if (coordsOverlay) return;
  const board = findBoard();
  if (!board) return;
  const rect = board.getBoundingClientRect();
  const isBlackOrientation = /orientation-black/.test(board.className) || /orientation-black/.test(board.parentElement?.className || '');

  coordsOverlay = document.createElement('div');
  coordsOverlay.className = 'chess-ext-coords';
  coordsOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';

  const files = isBlackOrientation ? 'hgfedcba' : 'abcdefgh';
  const ranks = isBlackOrientation ? '12345678' : '87654321';
  const sqSize = rect.width / 8;

  for (let i = 0; i < 8; i++) {
    const fileLabel = document.createElement('span');
    fileLabel.textContent = files[i];
    fileLabel.style.cssText = 'position:absolute;font:bold 10px sans-serif;color:rgba(0,0,0,0.5);text-shadow:0 0 2px rgba(255,255,255,0.8);bottom:1px;transform:translateX(-50%);left:' + (i * sqSize + sqSize / 2) + 'px;';
    if (i % 2 === 1) fileLabel.style.color = 'rgba(255,255,255,0.6)';
    coordsOverlay.appendChild(fileLabel);

    const rankLabel = document.createElement('span');
    rankLabel.textContent = ranks[i];
    rankLabel.style.cssText = 'position:absolute;font:bold 10px sans-serif;color:rgba(0,0,0,0.5);text-shadow:0 0 2px rgba(255,255,255,0.8);top:1px;transform:translateX(-50%);left:' + (i * sqSize + sqSize / 2) + 'px;';
    if (i % 2 === 0) rankLabel.style.color = 'rgba(255,255,255,0.6)';
    coordsOverlay.appendChild(rankLabel);
  }

  for (let i = 0; i < 8; i++) {
    const rankLabel = document.createElement('span');
    rankLabel.textContent = ranks[i];
    rankLabel.style.cssText = 'position:absolute;font:bold 10px sans-serif;color:rgba(0,0,0,0.5);text-shadow:0 0 2px rgba(255,255,255,0.8);left:2px;transform:translateY(-50%);top:' + (i * sqSize + sqSize / 2) + 'px;';
    if (i % 2 === 1) rankLabel.style.color = 'rgba(255,255,255,0.6)';
    coordsOverlay.appendChild(rankLabel);
  }

  document.body.appendChild(coordsOverlay);
  coordsVisible = true;
}

function hideCoords() {
  if (coordsOverlay) {
    coordsOverlay.remove();
    coordsOverlay = null;
  }
  coordsVisible = false;
}

function toggleCoords() {
  if (coordsVisible) hideCoords();
  else showCoords();
}

function startObserving() {
  if (observer) return;
  if (observeRetryTimer) { clearTimeout(observeRetryTimer); observeRetryTimer = null; }

  const board = findBoard();
  if (!board) {
    observeRetryTimer = setTimeout(startObserving, 1000);
    return;
  }

  observer = new MutationObserver(() => sendFenUpdate());
  observer.observe(board, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'data-fen'] });

  sendFenUpdate();
  console.log('Chess extension: monitoring board changes');
}

function stopObserving() {
  if (observeRetryTimer) { clearTimeout(observeRetryTimer); observeRetryTimer = null; }
  if (observer) {
    observer.disconnect();
    observer = null;
    console.log('Chess extension: stopped monitoring');
  }
}

function refreshCoords() {
  if (!coordsVisible) return;
  hideCoords();
  showCoords();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'capture-position') {
    try {
      const position = capturePosition();
      if (!position) {
        sendResponse({ ok: false, error: 'No active game board detected yet. Open a live game/analysis board and try again.' });
      } else {
        sendResponse({ ok: true, position: position });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  }

  if (message.type === 'start-monitoring') {
    startObserving();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stop-monitoring') {
    stopObserving();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'toggle-coords') {
    toggleCoords();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'update-coords') {
    if (message.visible && !coordsVisible) showCoords();
    else if (!message.visible && coordsVisible) hideCoords();
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

chrome.storage.local.get('coords', (data) => {
  if (data.coords !== false) {
    setTimeout(showCoords, 500);
  }
});

startObserving();
