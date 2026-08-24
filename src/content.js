let lastFen = '';
let lastWarmFen = '';
let observer = null;
let observedBoard = null;
let coordsOverlay = null;
let coordsVisible = false;
let lastErrorLogged = '';

const BOARD_SELECTORS = '[data-board], chess-board, wc-chess-board, .board, [class*="board"]';

const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function isBlackOrientation(board) {
  let el = board;
  for (let depth = 0; el && depth < 10; depth += 1, el = el.parentElement) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)orientation-black(\s|$)/.test(cls) || /(^|\s)flipped(\s|$)/.test(cls)) return true;
    if (/(^|\s)orientation-white(\s|$)/.test(cls)) return false;
    if (el.hasAttribute && el.getAttribute) {
      const orient = el.getAttribute('data-orientation') || el.getAttribute('orientation');
      if (orient) return /black/i.test(orient);
      const flippedAttr = el.getAttribute('flipped');
      if (flippedAttr === '' || flippedAttr === 'true') return true;
      if (flippedAttr === 'false') return false;
    }
  }
  return false;
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
  // Modern chess.com renders the real board as <wc-chess-board> nested inside
  // layout wrappers; prefer it over bigger container divs.
  const direct = document.querySelector('wc-chess-board, chess-board');
  if (direct && isValidBoard(direct)) return direct;
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
  if (best) {
    const inner = best.querySelector('wc-chess-board, chess-board');
    if (inner && isValidBoard(inner)) return inner;
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
  // If more than one highlighted square holds a piece (selection, premove,
  // stale overlays) the evidence is ambiguous -> report unknown.
  const movers = new Set();
  for (const el of board.querySelectorAll('.highlight')) {
    const m = (el.className || '').match(/square-(\d{1,2})/);
    if (!m) continue;
    const key = squareFromToken(m[1]);
    const piece = key && squares.get(key);
    if (piece) movers.add(piece[0]);
  }
  if (movers.size === 1) return movers.has('w') ? 'b' : 'w';
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
let prevPlacement = '';
let lastMoveBy = '';

function placementToMap(placement) {
  const map = new Map();
  const rows = placement.split('/');
  for (let r = 0; r < 8; r += 1) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += parseInt(ch, 10);
      } else {
        map.set(String.fromCharCode(97 + file) + (8 - r), ch);
        file += 1;
      }
    }
  }
  return map;
}

// Infer who made the most recent move by diffing consecutive settled
// placements. Independent of any DOM highlight markup. A messy diff
// (game reset, multi-piece scramble) clears the signal instead of guessing.
function trackTurnFromDiff(placement) {
  if (prevPlacement && prevPlacement !== placement) {
    const before = placementToMap(prevPlacement);
    const afterMap = placementToMap(placement);
    const addedColors = new Set();
    for (const [sq, pc] of afterMap) {
      if (before.get(sq) !== pc) addedColors.add(pc === pc.toUpperCase() ? 'w' : 'b');
    }
    lastMoveBy = addedColors.size === 1 ? [...addedColors][0] : '';
  }
  prevPlacement = placement;
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
    if (!isPlausible(position.fen)) {
      if (!implausibleLogged) {
        implausibleLogged = true;
        console.warn('Chess extension: captured an impossible position, skipping analysis.');
      }
      return;
    }
    implausibleLogged = false;

    // Only analyze the side the user is playing (board orientation = user
    // color). Turn evidence, most reliable first:
    //   1. explicit data-side-to-move attribute (test pages)
    //   2. last-move highlight markup when unambiguous
    //   3. diff of consecutive captures: whoever just moved, it is the
    //      other side's turn - this blocks analysis of the user's own
    //      fresh move even when the site renders no highlight markers
    //   4. exact initial placement is always white's move
    // When nothing is conclusive, do NOT analyze: a wrong guess recommends
    // moves for the enemy or fires before the opponent has replied.
    const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
    if (board) {
      trackTurnFromDiff(position.fen.split(' ')[0]);
      const userColor = isBlackOrientation(board) ? 'b' : 'w';
      const parts = position.fen.split(' ');
      let stm = detectSideToMove(board, collectPieces(board));
      if (!stm && lastMoveBy) stm = lastMoveBy === 'w' ? 'b' : 'w';
      if (!stm && parts[0] === START_PLACEMENT) stm = 'w';
      if (!stm || stm !== userColor) {
        // Opponent's turn: keep the engine's transposition table warm with a
        // shallow background search so the next user-side analysis is fast.
        if (stm && position.fen !== lastWarmFen) {
          lastWarmFen = position.fen;
          trySend({ type: 'warm-position', fen: position.fen });
        }
        clearArrow();
        return;
      }
      if (parts[1] !== stm) {
        parts[1] = stm;
        position.fen = parts.join(' ');
      }
    }

    if (position.fen !== lastFen) {
      lastFen = position.fen;
      trySend({ type: 'board-update', fen: position.fen });
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
  for (const el of document.querySelectorAll('.chess-ext-arrow, .chess-ext-arrow-label')) {
    el.remove();
  }
}

// Opt-in (options > Auto-play recommended move): simulate press+release on
// the from and to squares so the site plays the suggested move. Only ever
// invoked right after an analysis that passed turn gating, so it can only
// fire when it is genuinely the user's move.
function firePointer(el, type, x, y) {
  const Ev = window.PointerEvent || MouseEvent;
  el.dispatchEvent(new Ev(type, {
    bubbles: true, cancelable: true, view: window,
    clientX: x, clientY: y, button: 0,
    buttons: /down$/.test(type) ? 1 : 0,
    pointerId: 1, pointerType: 'mouse', isPrimary: true
  }));
}

function pressAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
    try { firePointer(el, t, x, y); } catch (e) { /* PointerEvent unsupported */ }
  });
}

let playBusy = false;

// The service worker can schedule a move seconds ahead (randomised think
// time); any newer instruction or teardown must supersede a pending one.
let pendingPlayTimer = null;
function cancelPendingPlay() {
  if (pendingPlayTimer) {
    clearTimeout(pendingPlayTimer);
    pendingPlayTimer = null;
  }
}

function currentPlacement() {
  try { return capturePosition().fen.split(' ')[0]; } catch (e) { return null; }
}

// Re-verify RIGHT NOW that it is genuinely the user's turn. Popup-initiated
// board updates bypass sendFenUpdate's gating, so without this check an
// enemy-turn analysis could trigger auto-play of the opponent's pieces.
function isUsersTurnNow() {
  try {
    const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
    if (!board) return false;
    const userColor = isBlackOrientation(board) ? 'b' : 'w';
    const pos = capturePosition();
    trackTurnFromDiff(pos.fen.split(' ')[0]);
    let stm = detectSideToMove(board, collectPieces(board));
    if (!stm && lastMoveBy) stm = lastMoveBy === 'w' ? 'b' : 'w';
    if (!stm && pos.fen.split(' ')[0] === START_PLACEMENT) stm = 'w';
    return stm === userColor;
  } catch (e) { return false; }
}

// The extension can be reloaded while this tab stays open; after that every
// runtime call throws. Detect it once, disconnect cleanly, and tell the user.
let extensionDead = false;
function markExtensionDead() {
  if (extensionDead) return true;
  extensionDead = true;
  stopMonitoringAndReset();
  console.warn('Chess extension: extension was reloaded - refresh this page to reconnect.');
  return true;
}
function contextDead(err) {
  return /context invalidated/i.test((err && err.message) || '');
}
function trySend(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(function(e) { if (contextDead(e)) markExtensionDead(); });
  } catch (e) {
    if (contextDead(e)) markExtensionDead();
  }
}

function syntheticFallback(pts) {
  pressAt(pts[0].x, pts[0].y);
  setTimeout(() => pressAt(pts[1].x, pts[1].y), 150);
}

// One auto-play attempt: trusted CDP input via the service worker, with a
// synthetic-click fallback. After every attempt we re-read the board; if the
// placement did not change we retry once, then surface a visible failure
// (console + toolbar badge) instead of silently freezing.
function attemptAutoPlay(from, to, pts, before, attempt) {
  if (playBusy) return;
  playBusy = true;
  const verify = function(cdpWorked) {
    playBusy = false;
    const after = currentPlacement();
    if (cdpWorked && after && before && after !== before) {
      console.warn('Chess extension: auto-play verified (' + from + to + ')');
      return;
    }
    if (!cdpWorked && after && before && after !== before) {
      console.warn('Chess extension: synthetic clicks moved the board (unexpected)');
      return;
    }
    if (attempt < 2) {
      console.warn('Chess extension: auto-play attempt ' + attempt + ' left the board unchanged, retrying');
      setTimeout(function() { attemptAutoPlay(from, to, pts, after || before, attempt + 1); }, 400);
      return;
    }
    console.warn('Chess extension: auto-play failed - board did not change. Reload the extension, then check chrome://extensions for errors.');
    trySend({ type: 'auto-play-failed' });
  };
  let resp = null;
  try {
    resp = chrome.runtime.sendMessage({ type: 'auto-play-move', from: from, to: to, points: pts });
  } catch (e) {
    if (contextDead(e)) { markExtensionDead(); return; }
    resp = null;
  }
  Promise.resolve(resp)
    .then((r) => {
      if (contextDead(r)) return;
      if (!resp || !resp.ok) {
        console.warn('Chess extension: CDP auto-play unavailable (' + ((resp && resp.reason) || 'no response') + '), using synthetic clicks');
        syntheticFallback(pts);
        setTimeout(() => verify(false), 700);
        return;
      }
      setTimeout(() => verify(true), 900);
    })
    .catch((err) => {
      if (contextDead(err)) { markExtensionDead(); return; }
      console.warn('Chess extension: CDP auto-play unavailable (' + (err && err.message) + '), using synthetic clicks');
      syntheticFallback(pts);
      setTimeout(() => verify(false), 700);
    });
}

function playMove(from, to) {
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return;
  // hard gate: never touch the board unless it is verifiably the user's turn
  if (!isUsersTurnNow()) {
    console.warn('Chess extension: auto-play blocked - not the user\'s turn.');
    return;
  }
  const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
  if (!board) return;
  const geo = boardGeometry(board);
  if (!geo || !(geo.sq > 0)) return;
  // never click blind: a piece must actually sit on the from square
  const originPiece = collectPieces(board).get(from);
  if (!originPiece) {
    console.warn('Chess extension: auto-play skipped, no piece on ' + from);
    return;
  }
  const a = squareCenter(geo, from);
  const b = squareCenter(geo, to);
  console.warn('Chess extension: auto-playing ' + from + to + ' (' + Math.round(a.x) + ',' + Math.round(a.y) + ')->(' + Math.round(b.x) + ',' + Math.round(b.y) + ')');
  const before = currentPlacement();
  // chess.com ignores untrusted (synthetic) input for moves, so route
  // through the service worker's chrome.debugger for real CDP events.
  attemptAutoPlay(from, to, [a, b], before, 1);
}

function squareToUnit(square, flipped) {
  const file = square.charCodeAt(0) - 97;
  const rank = parseInt(square[1], 10);
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank - 1 : 8 - rank;
  return { x: col + 0.5, y: row + 0.5 };
}

function squareCenter(geo, sq) {
  const p = squareToUnit(sq, geo.flipped);
  return { x: geo.left + p.x * geo.sq, y: geo.top + p.y * geo.sq };
}

function drawArrow(from, to, color, label) {
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return;
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

  // Optional rank badge ("BEST" / "2ND" / "3RD") floating over the shaft,
  // nudged perpendicular so it never sits exactly on the line.
  if (label) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const off = 0.55;
    const lx = geo.left + (mx - uy * off) * geo.sq + window.scrollX;
    const ly = geo.top + (my + ux * off) * geo.sq + window.scrollY;
    const tag = document.createElement('div');
    tag.className = 'chess-ext-arrow-label';
    tag.textContent = label;
    tag.style.cssText = 'position:absolute;pointer-events:none;z-index:99999;' +
      'left:' + Math.round(lx) + 'px;top:' + Math.round(ly) + 'px;' +
      'transform:translate(-50%,-50%);' +
      'font:bold 10px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.5px;' +
      'color:#fff;background:' + (color || '#ff6b35') + ';' +
      'padding:2px 6px;border-radius:8px;opacity:0.92;' +
      'box-shadow:0 1px 3px rgba(0,0,0,0.4);';
    document.body.appendChild(tag);
  }
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

function stopMonitoringAndReset() {
  cancelPendingPlay();
  stopObserving();
  clearArrow();
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

  if (message.type === 'get-square-points') {
    try {
      const from = message.from;
      const to = message.to;
      if (!/^[a-h][1-8]$/.test(from || '') || !/^[a-h][1-8]$/.test(to || '')) throw new Error('bad squares');
      const board = (observedBoard && observedBoard.isConnected) ? observedBoard : findBoard();
      if (!board) throw new Error('no board');
      const geo = boardGeometry(board);
      if (!geo || !(geo.sq > 0)) throw new Error('no board geometry');
      if (!collectPieces(board).get(from)) throw new Error('no piece on ' + from);
      sendResponse({ ok: true, points: [squareCenter(geo, from), squareCenter(geo, to)] });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }

  if (message.type === 'draw-arrow') {
    // One message can now carry several ranked arrows; the plain from/to/
    // color fields remain the best move and keep driving auto-play.
    clearArrow();
    const arrows = Array.isArray(message.arrows) && message.arrows.length
      ? message.arrows
      : [{ from: message.from, to: message.to, color: message.color }];
    for (const a of arrows) {
      if (a && /^[a-h][1-8]$/.test(a.from || '') && /^[a-h][1-8]$/.test(a.to || '')) {
        drawArrow(a.from, a.to, a.color, a.label);
      }
    }
    if (message.play && !extensionDead && isUsersTurnNow()) {
      cancelPendingPlay();
      const delayMs = Number.isFinite(message.playDelayMs) ? Math.max(0, message.playDelayMs) : 0;
      if (delayMs > 0) {
        console.warn('Chess extension: auto-play of ' + message.from + message.to + ' scheduled in ' + (delayMs / 1000).toFixed(1) + 's');
      }
      pendingPlayTimer = setTimeout(function() {
        pendingPlayTimer = null;
        playMove(message.from, message.to);
      }, delayMs);
    } else {
      cancelPendingPlay();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stop-monitoring') {
    stopMonitoringAndReset();
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
