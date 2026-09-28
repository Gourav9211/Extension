// Maia-3 inference worker.
//
// Runs the bundled Chessformer ONNX exports through onnxruntime-web, entirely
// offline. The offscreen document owns one of these and relays requests to it;
// legal moves are supplied by the caller so the network's raw 4352-way policy
// is always masked against the real move generator.
//
// Two things changed fundamentally from the previous per-Elo networks:
//
//   * The rating is an *input*, not a choice of weights. One network covers the
//     whole range, so there is a single session per model size and both the
//     player's and the opponent's rating are fed in on every position.
//   * The input is a 64x12 tokenized board rather than 112 planes, and the
//     output policy is a 4352-entry from/to(+promotion) vocabulary instead of
//     the lc0-style move list.
importScripts('maia3-encoder.js', 'maia3-moves.js', 'ort/ort.min.js');

var ORT_READY = false;
var sessions = {};      // model id -> session
var loading = {};       // model id -> promise
var lastModel = null;
var seq = 0;

// Resolves a path inside the extension. Falls back to the worker's own base URL
// so the exact same worker file can be exercised outside the extension.
function assetUrl(path) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(path, self.location.href).href;
}

function configure() {
  if (ORT_READY) return;
  ort.env.wasm.wasmPaths = assetUrl('ort/');
  ort.env.wasm.numThreads = 1;   // MV3: avoid nested workers
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
  ORT_READY = true;
}

function modelFile(model) {
  return 'maia3-' + model + '.onnx';
}

// Keeps both networks resident but never more: the 3M and 5M exports are 6.4 MB
// and 10.3 MB as fp16, so holding both is cheaper than re-fetching on a toggle.
function load(model) {
  configure();
  if (sessions[model]) return Promise.resolve(sessions[model]);
  if (loading[model]) return loading[model];
  var file = modelFile(model);
  var url = assetUrl(file);
  var startedAt = Date.now();
  var job = fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + file);
      return res.arrayBuffer();
    })
    .then(function (buf) {
      // 'basic' is required: the exported graph fails ORT's full graph
      // optimizer, and the session is rejected outright if you let it run.
      return ort.InferenceSession.create(buf, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'basic'
      });
    })
    .then(function (session) {
      sessions[model] = session;
      delete loading[model];
      lastModel = model;
      const loadedFor = (file === 'maia3-5m.onnx' ? '10.3 MB' : '6.4 MB') +
        ', ' + ((Date.now() - startedAt) / 1000).toFixed(2) + 's';
      console.log('[maia] loaded maia3-' + model + ' (' + loadedFor + ')');
      // Forward the one interesting line to the offscreen document, which
      // relays it into the service-worker console.
      try { self.postMessage({ type: 'maia-console', text: 'loaded maia3-' + model + ' (' + loadedFor + ')' }); } catch (e) {}
      return session;
    })
    .catch(function (err) {
      delete loading[model];
      throw err;
    });
  loading[model] = job;
  return job;
}

function clampRating(value, fallback) {
  var n = Math.round(Number(value));
  if (!isFinite(n)) return fallback;
  return Math.min(5000, Math.max(0, n));
}

// UCI -> vocabulary index for every legal move, with the policy renormalised
// over that set so callers get directly comparable percentages. Moves with no
// slot in the vocabulary are reported separately rather than silently dropped;
// with the 4352-entry vocabulary that set is empty for every position, but the
// count is reported rather than assumed so a future vocabulary change cannot
// quietly start dropping moves.
function scoreLegalMoves(logits, legal, blackToMove) {
  var out = [];
  var unmapped = [];
  for (var i = 0; i < legal.length; i++) {
    var uci = legal[i];
    var index = Maia3Moves.indexOf(Maia3Moves.toModelFrame(uci, blackToMove));
    if (index < 0) { unmapped.push(uci); continue; }
    out.push({ uci: uci, index: index, logit: logits[index] });
  }
  if (!out.length) return { moves: [], unmapped: unmapped };
  var top = -Infinity;
  for (var k = 0; k < out.length; k++) top = Math.max(top, out[k].logit);
  var sum = 0;
  for (var m = 0; m < out.length; m++) { out[m].prob = Math.exp(out[m].logit - top); sum += out[m].prob; }
  out.sort(function (a, b) { return b.prob - a.prob; });
  for (var n = 0; n < out.length; n++) out[n].prob /= sum;
  return { moves: out, unmapped: unmapped };
}

// Maia-3's value head is ordered [loss, draw, win] for the side to move, the
// same convention as the old networks. Softmaxed here rather than in the popup
// so every consumer gets real probabilities; the raw logits are a detail of the
// graph and reading a percentage off a logit is meaningless.
function softmax3(data) {
  var max = Math.max(data[0], data[1], data[2]);
  var e0 = Math.exp(data[0] - max);
  var e1 = Math.exp(data[1] - max);
  var e2 = Math.exp(data[2] - max);
  var sum = e0 + e1 + e2;
  return [e0 / sum, e1 / sum, e2 / sum];
}

// Inverting the usual win-probability-to-centipawns curve gives
// 400 * log10(win / loss), so the number is directly comparable with the
// Stockfish evaluations the extension already shows. Draws never enter the
// ratio, which is the piece of information a WDL read-out is able to discard.
// This is deliberately not the upstream UCI's flat permille difference: that
// reports a 60%-win position as +600cp, which is a fine integer and a
// ridiculous pawn count.
function wdlToCp(wdl) {
  var win = Math.max(wdl[2], 1e-6);
  var loss = Math.max(wdl[0], 1e-6);
  var cp = 400 * Math.log10(win / loss);
  return Math.max(-10000, Math.min(10000, cp));
}

function predict(request) {
  var id = ++seq;
  var started = Date.now();
  var model = String(request.model || '5m');
  var legal = request.legal || [];
  var eloSelf = clampRating(request.elo, 1500);
  var eloOppo = clampRating(request.opponentElo == null ? eloSelf : request.opponentElo, eloSelf);
  var encoded;
  var session;
  return load(model)
    .then(function (s) {
      session = s;
      encoded = Maia3Encoder.encode(request.fen);
      return session.run({
        tokens: new ort.Tensor('float32', encoded.tokens, [1, 64, 12]),
        elo_self: new ort.Tensor('float32', Float32Array.from([eloSelf]), [1]),
        elo_oppo: new ort.Tensor('float32', Float32Array.from([eloOppo]), [1])
      });
    })
    .then(function (result) {
      var logits = result.logits_move.data;
      var wdl = softmax3(result.logits_value.data);
      var scored = scoreLegalMoves(logits, legal, encoded.blackToMove);
      var limit = request.limit || 8;
      return {
        type: 'maia-result',
        id: id,
        requestId: request.id,
        ok: true,
        model: model,
        elo: eloSelf,
        opponentElo: eloOppo,
        fen: request.fen,
        blackToMove: encoded.blackToMove,
        moves: scored.moves.slice(0, limit),
        unmapped: scored.unmapped.slice(0, 12),
        unmappedCount: scored.unmapped.length,
        // Value-head probabilities, ordered [loss, draw, win] for the side to
        // move.
        wdl: wdl,
        scoreCp: wdlToCp(wdl),
        ms: Date.now() - started
      };
    }).catch(function (err) {
      return {
        type: 'maia-result',
        id: id,
        requestId: request.id,
        ok: false,
        model: model,
        error: (err && err.message) || String(err)
      };
    });
}

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.type === 'maia-warm') {
    load(String(msg.model || '5m')).then(function () {
      self.postMessage({ type: 'maia-warmed', requestId: msg.id, ok: true, model: msg.model });
    }).catch(function (err) {
      self.postMessage({ type: 'maia-warmed', requestId: msg.id, ok: false, model: msg.model, error: (err && err.message) || String(err) });
    });
    return;
  }
  if (msg.type === 'maia-predict') {
    predict(msg).then(function (result) { self.postMessage(result); });
    return;
  }
  if (msg.type === 'maia-release') {
    Object.keys(sessions).forEach(function (model) {
      if (model === String(msg.model)) return;
      try { sessions[model].release(); } catch (e) {}
      delete sessions[model];
    });
  }
};
