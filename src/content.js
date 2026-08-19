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
  if (!board) {
    throw new Error('No Chess.com board was found on this page.');
  }

  const directFen = board.getAttribute('data-fen') || board.closest('[data-fen]')?.getAttribute('data-fen');
  if (directFen) {
    return { fen: directFen, source: 'Chess.com board FEN' };
  }

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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'capture-position') return undefined;
  try {
    sendResponse({ ok: true, position: capturePosition() });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return true;
});
