// Maia-3's 4352-move policy vocabulary, in the side-to-move's own frame.
//
// The upstream tokenizer enumerates the vocabulary once, at import time, and
// the order is not something you can guess from the UCI string - it has to be
// reproduced exactly or every logit is read from the wrong move. It is:
//
//   0     .. 4095   every from-square x to-square pair, both enumerated
//                   rank-major (a1=0 .. h8=63), so index = from*64 + to.
//                   These include geometrically impossible pairs, so the
//                   legal-move mask is what keeps them out of play.
//   4096  .. 4351   promotions, and the board is mirrored for Black, so these
//                   are hard-wired to rank 7 -> rank 8 in the *mirrored* frame.
//                   A White pawn promoting on a8 and a Black pawn promoting
//                   on a1 both land on a7->a8 there, which is why a single
//                   block covers both colours. Enumeration is from-file outer,
//                   to-file inner, piece innermost, with the pieces in the
//                   order q, r, b, n.
//
// The practical consequence: between them these two blocks cover every legal
// move in every position, promotions of either colour included. Unlike the
// previous networks, there is no such thing as a legal move Maia-3 cannot
// represent. The callers still report a zero count, because a vocabulary that
// silently stopped covering a move should not be able to do it quietly.
(function (root, factory) {
  root.Maia3Moves = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MOVE_COUNT = 4352;
  var PROMO_BASE = 4096;
  var PROMO_PIECES = 'qrbn';
  var RANK7 = '7';
  var RANK8 = '8';

  function squareIndex(name) {
    var file = name.charCodeAt(0) - 97;
    var rank = +name[1] - 1;
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
    return rank * 8 + file;
  }

  function mirrorSquare(index) {
    return 56 + (index & 7) - ((index >> 3) << 3);
  }

  // "a1" -> 0 ... "h8" -> 63, -1 when the square is not one of the 64.
  function parseSquare(name) {
    if (!name || name.length < 2) return -1;
    return squareIndex(name);
  }

  // UCI in the side-to-move's frame -> vocabulary index, or -1 when the move
  // has no slot. Assumes the caller has already mirrored for Black.
  function indexOf(uci) {
    if (typeof uci !== 'string' || uci.length < 4) return -1;
    var from = parseSquare(uci.substring(0, 2));
    var to = parseSquare(uci.substring(2, 4));
    if (from < 0 || to < 0) return -1;
    if (uci.length === 4) return from * 64 + to;
    var piece = PROMO_PIECES.indexOf(uci.charAt(4));
    if (piece < 0) return -1;
    // Promotion slots are hard-wired to rank 7 -> rank 8 in the mirrored
    // frame, so a promotion that is not there has no slot. Reaching this
    // branch would mean the frame was not mirrored before the call.
    if (uci.charAt(1) !== RANK7 || uci.charAt(3) !== RANK8) return -1;
    return PROMO_BASE + ((from & 7) * 8 + (to & 7)) * 4 + piece;
  }

  function isPromotion(uci) {
    return typeof uci === 'string' && uci.length > 4;
  }

  // Real-board UCI -> the vocabulary's side-to-move frame.
  function toModelFrame(uci, blackToMove) {
    if (!blackToMove) return uci;
    var from = parseSquare(uci.substring(0, 2));
    var to = parseSquare(uci.substring(2, 4));
    if (from < 0 || to < 0) return uci;
    var moved = squareName(mirrorSquare(from)) + squareName(mirrorSquare(to));
    return moved + (isPromotion(uci) ? uci.charAt(4) : '');
  }

  function squareName(index) {
    return String.fromCharCode(97 + (index & 7)) + ((index >> 3) + 1);
  }

  return {
    MOVE_COUNT: MOVE_COUNT,
    indexOf: indexOf,
    toModelFrame: toModelFrame,
    squareIndex: squareIndex,
    squareName: squareName,
    mirrorSquare: mirrorSquare,
    isPromotion: isPromotion
  };
});
