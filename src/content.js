let lastFen = '';
let observer = null;
let observedBoard = null;
let coordsOverlay = null;
let coordsVisible = false;
let lastErrorLogged = '';
let arrowOverlay = null;

const BOARD_SELECTORS = '[data-board], chess-board, wc-chess-board, .board, [class*="board"]';

function isBlackOrientation(board) {
  return /orientation-black/.test(board.className || '') ||
    /orientation-black/.test(board.parentElement?.className || '');
}

function isValidBoard(el) {
  if (!el || !el.getBoundingClientRect || !el.querySelectorAll) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 160 || rect.height < 160) return false;
  const ratio = rect.width / Math.max(1, rect.height);
  if (ratio < 0.75 || ratio > 1.33) return false;
  return el.hasAttribute('data-fen') || el.querySelectorAll('.piece').length > 0;
}

function findBoard() {
  let best = null;
  let bestArea = 0;
  for (const el of document.querySelectorAll(BOARD_SELECTORS)) {
    if (!isValidBoard(el)) continue;
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
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
    throw new Error('No Chess.com board was found on this page.');
  }

  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen) {
    return { fen: directFen, source: 'Chess.com board FEN' };
  }

  const flipped = isBlackOrientation(board);
  const pieces = [...board.querySelectorAll('.piece')];
  const squares = new Map();
  const piecePattern = /\b([wb])([prnbqk])\b/;

  for (const piece of pieces) {
    const pieceMatch = piece.className.match(piecePattern);
    const squareMatch = piece.className.match(/square-(\d+)/);
    if (!pieceMatch || !squareMatch) continue;
    squares.set(squareFromClass(Number(squareMatch[1]), flipped), pieceMatch[1] + pieceMatch[2]);
  }

  if (!squares.size) {
    throw new Error('The board was found, but its pieces could not be read. Open a visible game or analysis board.');
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
  if (observer && observedBoard && !observedBoard.isConnected) {
    stopObserving();
    startObserving();
    return;
  }
  try {
    const position = capturePosition();
    lastErrorLogged = '';
    if (position.fen !== lastFen) {
      lastFen = position.fen;
      chrome.runtime.sendMessage({ type: 'board-update', fen: position.fen });
    }
  } catch (error) {
    if (error.message !== lastErrorLogged) {
      lastErrorLogged = error.message;
      console.warn('Chess extension:', error.message);
    }
  }
}

function clearArrow() {
  if (arrowOverlay) {
    arrowOverlay.remove();
    arrowOverlay = null;
  }
}

function squareToUnit(square, flipped) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10);
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank - 1 : 8 - rank;
  return { x: col + 0.5, y: row + 0.5 };
}

function drawArrow(from, to, color) {
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return;
  clearArrow();
  const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
  if (!board) return;

  const rect = board.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const flipped = isBlackOrientation(board);
  const p1 = squareToUnit(from, flipped);
  const p2 = squareToUnit(to, flipped);

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 0.45;
  const headWidth = 0.44;
  const shaftEndX = p2.x - ux * headLen * 0.6;
  const shaftEndY = p2.y - uy * headLen * 0.6;
  const tipX = p2.x - ux * 0.12;
  const tipY = p2.y - uy * 0.12;
  const baseX = tipX - ux * headLen;
  const baseY = tipY - uy * headLen;
  const wingX = baseX - uy * (headWidth / 2);
  const wingY = baseY + ux * (headWidth / 2);
  const wing2X = baseX + uy * (headWidth / 2);
  const wing2Y = baseY - ux * (headWidth / 2);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 8 8');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chess-ext-arrow');
  svg.style.cssText = 'position:absolute;pointer-events:none;z-index:99998;' +
    'left:' + (rect.left + window.scrollX) + 'px;top:' + (rect.top + window.scrollY) + 'px;' +
    'width:' + rect.width + 'px;height:' + rect.height + 'px;';

  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
  line.setAttribute('x2', shaftEndX); line.setAttribute('y2', shaftEndY);
  line.setAttribute('stroke', color || '#ff6b35');
  line.setAttribute('stroke-width', '0.17');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('opacity', '0.75');

  const head = document.createElementNS(svgNS, 'polygon');
  head.setAttribute('points',
    tipX + ',' + tipY + ' ' + wingX + ',' + wingY + ' ' + wing2X + ',' + wing2Y);
  head.setAttribute('fill', color || '#ff6b35');
  head.setAttribute('opacity', '0.78');

  svg.appendChild(line);
  svg.appendChild(head);
  document.body.appendChild(svg);
  arrowOverlay = svg;
}

function showCoords() {
  if (coordsOverlay) return;
  const board = findBoard();
  if (!board) return;
  const rect = board.getBoundingClientRect();
  const black = isBlackOrientation(board);

  coordsOverlay = document.createElement('div');
  coordsOverlay.className = 'chess-ext-coords';
  coordsOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:99999;left:' + rect.left + 'px;top:' + rect.top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';

  const files = black ? 'hgfedcba' : 'abcdefgh';
  const ranks = black ? '12345678' : '87654321';
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

  const board = findBoard();
  if (!board) {
    setTimeout(startObserving, 1500);
    return;
  }

  observedBoard = board;
  observer = new MutationObserver(() => sendFenUpdate());
  observer.observe(board, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'data-fen'] });

  sendFenUpdate();
  console.log('Chess extension: monitoring board changes');
}

function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
    observedBoard = null;
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
      sendResponse({ ok: true, position: capturePosition() });
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

  if (message.type === 'draw-arrow') {
    drawArrow(message.from, message.to, message.color);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stop-monitoring') {
    stopObserving();
    clearArrow();
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
