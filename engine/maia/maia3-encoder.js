// FEN -> Maia-3 board tokens, in the side-to-move's own frame.
//
// Maia-3 is a Chessformer, not the old lc0-style network, so the input is a
// 64x12 one-hot board instead of 112 planes. Per square there is exactly one
// active channel, laid out as the upstream tokenizer does:
//
//   0-5    the side to move          P N B R Q K
//   6-11   the opponent              P N B R Q K
//
// When Black is to move the board is flipped vertically *and the piece colours
// are swapped* - that is what python-chess's Board.mirror() does, and the
// network relies on both halves. The combined effect is that the mover's army
// ends up on ranks 1-2 in channels 0-5, exactly as if the mover were White.
// Getting this wrong is silent rather than fatal: the tensors are still the
// right shape and the model still answers, it just plays from the wrong side
// of the board, so the parity test against the upstream tokenizer is the thing
// that has to stay green.
//
// The policy vocabulary is defined in that same flipped frame (see
// maia3-moves.js), which is what makes the mover's promotions rank-7-to-rank-8
// and therefore representable at all.
//
// The tokenizer deliberately carries no castling rights, no en-passant square
// and no clocks: the 64x12 export consumes the current position only and
// replicates it across the model's 8-slot history internally.
(function (root, factory) {
  root.Maia3Encoder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var PIECE_CHANNELS = {
    p: 0, n: 1, b: 2, r: 3, q: 4, k: 5
  };
  var TOKEN_COUNT = 64 * 12;

  // FEN square indices are rank-major: a1=0 ... h1=7, a2=8 ... h8=63.
  function parseFen(fen) {
    var parts = String(fen).trim().split(/\s+/);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('bad FEN placement: ' + fen);
    var board = new Array(64);
    // The FEN lists rank 8 first; index from the top so row 0 lands on
    // square index 56.
    for (var r = 0; r < 8; r++) {
      var file = 0;
      var row = rows[r];
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch >= '1' && ch <= '8') {
          file += +ch;
        } else {
          if (file > 7) throw new Error('bad FEN rank: ' + row);
          board[(7 - r) * 8 + file] = ch;
          file++;
        }
      }
      if (file !== 8) throw new Error('bad FEN rank: ' + row);
    }
    return { board: board, blackToMove: parts[1] === 'b' };
  }

  // Vertical flip only; ranks 1 and 8 trade places, files stay put.
  function mirrorSquare(square) {
    return 56 - ((square >> 3) << 3) + (square & 7);
  }

  function encode(fen) {
    var parsed = parseFen(fen);
    var tokens = new Float32Array(TOKEN_COUNT);
    for (var square = 0; square < 64; square++) {
      var piece = parsed.board[square];
      if (!piece) continue;
      var base = PIECE_CHANNELS[piece.toLowerCase()];
      if (base === undefined) continue;
      var isWhite = piece >= 'A' && piece <= 'Z';
      // The mirror swaps colours, so "is this piece the mover's?" is answered
      // against the pre-move board, and the channel offset falls out of it.
      var isMover = parsed.blackToMove ? !isWhite : isWhite;
      if (!isMover) base += 6;
      tokens[(parsed.blackToMove ? mirrorSquare(square) : square) * 12 + base] = 1;
    }
    return { tokens: tokens, blackToMove: parsed.blackToMove };
  }

  return {
    encode: encode,
    mirrorSquare: mirrorSquare,
    tokenCount: TOKEN_COUNT
  };
});
