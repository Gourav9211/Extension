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

function squareFromToken(token) {
  // chess.com uses square-XY (file digit 1-8, rank digit 1-8): square-58 -> e8
  let m = token.match(/^([1-8])([1-8])$/);
  if (m) return String.fromCharCode(96 + parseInt(m[1], 10)) + m[2];
  // legacy fallback: linear index 1-64, white-bottom numbering
  m = token.match(/^([1-9]|[1-5]\d|6[0-4])$/);
  if (m) {
    const index = parseInt(m[1], 10) - 1;
    const file = index % 8;
    const row = Math.floor(index / 8);
    return `${String.fromCharCode(97 + file)}${8 - row}`;
  }
  return null;
}

function isPlausible(fen) {
  const boardPart = fen.split(' ')[0];
  if (!boardPart) return false;
  const rows = boardPart.split('/');
  if (rows.length !== 8) return false;
  let wk = 0, bk = 0, wp = 0, bp = 0;
  for (let i = 0; i < rows.length; i++) {
    let rankPawns = 0;
    for (const ch of rows[i]) {
      if (ch === 'P') { wp++; rankPawns++; }
      else if (ch === 'p') { bp++; rankPawns++; }
      else if (ch === 'K') wk++;
      else if (ch === 'k') bk++;
    }
    if ((i === 0 || i === 7) && rankPawns > 0) return false;
  }
  return wk === 1 && bk === 1 && wp <= 8 && bp <= 8;
}

function pieceAt(rows, fileIdx, rankIdx) {
  let col = 0;
  for (const ch of rows[rankIdx]) {
    if (ch >= '1' && ch <= '8') col += parseInt(ch);
    else { if (col === fileIdx) return ch; col++; }
  }
  return null;
}

function inferCastling(rows) {
  let rights = '';
  if (pieceAt(rows, 4, 7) === 'K') {
    if (pieceAt(rows, 7, 7) === 'R') rights += 'K';
    if (pieceAt(rows, 0, 7) === 'R') rights += 'Q';
  }
  if (pieceAt(rows, 4, 0) === 'k') {
    if (pieceAt(rows, 7, 0) === 'r') rights += 'k';
    if (pieceAt(rows, 0, 0) === 'r') rights += 'q';
  }
  return rights || '-';
}

function collectPieces(board) {
  const squares = new Map();
  const piecePattern = /\b([wb])([prnbqk])\b/;

  for (const piece of board.querySelectorAll('.piece')) {
    if (/dragging|drag-overlay|ghost/i.test(piece.className)) continue;
    const pieceMatch = piece.className.match(piecePattern);
    if (!pieceMatch) continue;
    let key = null;
    for (const cls of piece.className.split(/\s+/)) {
      if (cls.startsWith('square-')) {
        key = squareFromToken(cls.slice(7));
        if (key) break;
      }
    }
    if (key) squares.set(key, pieceMatch[1] + pieceMatch[2]);
  }
  return squares;
}

function detectSideToMove(board, squares) {
  const attrEl = board.closest('[data-side-to-move]');
  if (attrEl) {
    const v = (attrEl.getAttribute('data-side-to-move') || '').toLowerCase();
    if (v === 'w' || v === 'white') return 'w';
    if (v === 'b' || v === 'black') return 'b';
  }
  // chess.com marks the last move with .highlight squares; the highlighted
  // square that currently holds a piece is the destination of that move.
  for (const el of board.querySelectorAll('.highlight')) {
    const m = (el.className || '').match(/square-(\d{1,2})/);
    if (!m) continue;
    const key = squareFromToken(m[1]);
    const piece = key && squares.get(key);
    if (piece) return piece[0] === 'w' ? 'b' : 'w';
  }
  return null;
}

function capturePosition() {
  const board = findBoard();
  if (!board) {
    throw new Error('No Chess.com board was found on this page.');
  }

  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen && isPlausible(directFen)) {
    return { fen: directFen, source: 'Chess.com board FEN' };
  }

  const squares = collectPieces(board);

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

  const sideToMove = detectSideToMove(board, squares) || 'w';
  return { fen: `${rows.join('/')} ${sideToMove} ${inferCastling(rows)} - 0 1`, source: 'Chess.com board pieces' };
}

let captureTimer = null;
let implausibleLogged = false;

function sendFenUpdate() {
  if (observer && observedBoard && !observedBoard.isConnected) {
    stopObserving();
    startObserving();
    return;
  }
  try {
    const position = capturePosition();
    lastErrorLogged = '';
    if (!isPlausible(position.fen)) {
      if (!implausibleLogged) {
        implausibleLogged = true;
        console.warn('Chess extension: captured an impossible position, skipping analysis.');
      }
      return;
    }
    implausibleLogged = false;

    // Only analyze the side the user is playing (board orientation = user color)
    const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
    if (board) {
      const userColor = isBlackOrientation(board) ? 'b' : 'w';
      const stm = detectSideToMove(board, collectPieces(board)) || 'w';
      if (stm !== userColor) {
        clearArrow();
        return;
      }
    }

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

function queueFenUpdate() {
  clearTimeout(captureTimer);
  captureTimer = setTimeout(sendFenUpdate, 300);
}

function boardGeometry(board) {
  const flipped = isBlackOrientation(board);
  const cells = [];
  for (const p of board.querySelectorAll('.piece')) {
    if (/dragging|drag-overlay|ghost/i.test(p.className)) continue;
    let tok = null;
    for (const cls of p.className.split(/\s+/)) {
      if (cls.startsWith('square-')) { tok = cls.slice(7); break; }
    }
    const key = tok && squareFromToken(tok);
    if (!key) continue;
    const r = p.getBoundingClientRect();
    if (r.width < 4 || !r.width) continue;
    const file = key.charCodeAt(0) - 97 + 1;
    const rank = parseInt(key.slice(1), 10);
    const col = flipped ? 8 - file : file - 1;
    const rowTop = flipped ? rank - 1 : 8 - rank;
    cells.push({ r, col, rowTop });
  }
  if (!cells.length) {
    const rect = board.getBoundingClientRect();
    return { left: rect.left, top: rect.top, sq: rect.width / 8, flipped };
  }
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const sq = med(cells.map(c => c.r.width));
  const left = med(cells.map(c => c.r.left - c.col * sq));
  const top = med(cells.map(c => c.r.top - c.rowTop * sq));
  return { left, top, sq, flipped };
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

  const geo = boardGeometry(board);
  if (!geo || !(geo.sq > 0)) return;
  const p1 = squareToUnit(from, geo.flipped);
  const p2 = squareToUnit(to, geo.flipped);

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 0.36;
  const headWidth = 0.34;
  const shaftEndX = p2.x - ux * headLen * 0.6;
  const shaftEndY = p2.y - uy * headLen * 0.6;
  const tipX = p2.x - ux * 0.1;
  const tipY = p2.y - uy * 0.1;
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
    'left:' + (geo.left + window.scrollX) + 'px;top:' + (geo.top + window.scrollY) + 'px;' +
    'width:' + (geo.sq * 8) + 'px;height:' + (geo.sq * 8) + 'px;';

  const line = document.createElementNS(svgNS, 'line');
  line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y);
  line.setAttribute('x2', shaftEndX); line.setAttribute('y2', shaftEndY);
  line.setAttribute('stroke', color || '#ff6b35');
  line.setAttribute('stroke-width', '0.12');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('opacity', '0.72');

  const head = document.createElementNS(svgNS, 'polygon');
  head.setAttribute('points',
    tipX + ',' + tipY + ' ' + wingX + ',' + wingY + ' ' + wing2X + ',' + wing2Y);
  head.setAttribute('fill', color || '#ff6b35');
  head.setAttribute('opacity', '0.75');

  svg.appendChild(line);
  svg.appendChild(head);
  document.body.appendChild(svg);
  arrowOverlay = svg;
}

function showCoords() {
  if (coordsOverlay) return;
  const board = findBoard();
  if (!board) return;
  const geo = boardGeometry(board);
  if (!geo || !(geo.sq > 0)) return;
  const black = geo.flipped;

  coordsOverlay = document.createElement('div');
  coordsOverlay.className = 'chess-ext-coords';
  coordsOverlay.style.cssText = 'position:absolute;pointer-events:none;z-index:99999;left:' + (geo.left + window.scrollX) + 'px;top:' + (geo.top + window.scrollY) + 'px;width:' + (geo.sq * 8) + 'px;height:' + (geo.sq * 8) + 'px;';

  const files = black ? 'hgfedcba' : 'abcdefgh';
  const ranks = black ? '12345678' : '87654321';
  const sqSize = geo.sq;

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
  observer = new MutationObserver(() => queueFenUpdate());
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
