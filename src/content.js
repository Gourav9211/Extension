let lastFen = '';
let observer = null;
let monitoring = false;
let arrowOverlay = null;

function findBoard() {
  return document.querySelector('[data-board], .board, chess-board, [class*="board"]');
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
  if (!board) throw new Error('No Chess.com board was found on this page.');

  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen) return { fen: directFen, source: 'Chess.com board FEN' };

  const isBlackOrientation = /orientation-black/.test(board.className) || /orientation-black/.test(board.parentElement?.className || '');
  const pieces = [...board.querySelectorAll('.piece')];
  const squares = new Map();
  const piecePattern = /\b([wb])([prnbqk])\b/;

  for (const piece of pieces) {
    const pieceMatch = piece.className.match(piecePattern);
    const squareMatch = piece.className.match(/square-(\d+)/);
    if (!pieceMatch || !squareMatch) continue;
    squares.set(squareFromClass(Number(squareMatch[1]), isBlackOrientation), pieceMatch[1] + pieceMatch[2]);
  }

  if (!squares.size) throw new Error('Board found but pieces could not be read.');

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

function squareToCoords(square) {
  const board = findBoard();
  if (!board) return null;
  const rect = board.getBoundingClientRect();
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1]) - 1;
  const isBlack = /orientation-black/.test(board.className) || /orientation-black/.test(board.parentElement?.className || '');
  const f = isBlack ? 7 - file : file;
  const r = isBlack ? rank : 7 - rank;
  const sqW = rect.width / 8;
  const sqH = rect.height / 8;
  return {
    x: rect.left + f * sqW + sqW / 2 + window.scrollX,
    y: rect.top + r * sqH + sqH / 2 + window.scrollY,
    w: sqW,
    h: sqH
  };
}

function drawArrow(fromSq, toSq, color = '#ff6b35') {
  removeArrow();
  const from = squareToCoords(fromSq);
  const to = squareToCoords(toSq);
  if (!from || !to) return;

  arrowOverlay = document.createElement('div');
  arrowOverlay.id = 'chess-ext-arrow';
  arrowOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.cssText = 'position:absolute;top:0;left:0;';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowhead');
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', '0 0, 10 4, 0 8');
  polygon.setAttribute('fill', color);
  marker.appendChild(polygon);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', from.x);
  line.setAttribute('y1', from.y);
  line.setAttribute('x2', to.x);
  line.setAttribute('y2', to.y);
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', Math.max(from.w * 0.2, 6));
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('marker-end', 'url(#arrowhead)');
  line.setAttribute('opacity', '0.85');
  svg.appendChild(line);

  arrowOverlay.appendChild(svg);
  document.body.appendChild(arrowOverlay);
}

function removeArrow() {
  if (arrowOverlay) {
    arrowOverlay.remove();
    arrowOverlay = null;
  }
}

function sendFenUpdate() {
  try {
    const position = capturePosition();
    if (position.fen !== lastFen) {
      lastFen = position.fen;
      chrome.runtime.sendMessage({ type: 'board-update', fen: position.fen });
    }
  } catch (error) {
    console.error('Chess extension:', error.message);
  }
}

function startObserving() {
  if (monitoring) return;
  const board = findBoard();
  if (!board) {
    setTimeout(startObserving, 1000);
    return;
  }
  observer = new MutationObserver(() => sendFenUpdate());
  observer.observe(board, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'data-fen'] });
  monitoring = true;
  sendFenUpdate();
}

function stopObserving() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  monitoring = false;
  removeArrow();
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

  if (message.type === 'stop-monitoring') {
    stopObserving();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'draw-arrow') {
    if (message.from && message.to) {
      drawArrow(message.from, message.to, message.color);
    } else {
      removeArrow();
    }
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

startObserving();
