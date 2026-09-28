// Engine loading with automatic failover. Preference order:
//   1. lila-stockfish-web Stockfish 17.1 (lichess build, ES-module worker,
//      may use shared-memory threads - needs a bridge worker)
//   2. Stockfish 16 NNUE single-threaded WASM
//   3. legacy asm build
// If a build fails to reach uciok within 12s it is terminated and the next
// candidate starts, so analysis keeps working no matter what.
const ENGINE_CANDIDATES = [
  { url: 'engine/lsf-sf171-bridge.js', type: 'module' },
  { url: 'engine/stockfish-nnue-16-single.js' },
  { url: 'engine/stockfish.js' }
];

let engine = null;
let candidateIndex = 0;
let gotUciOk = false;
let readyTimer = null;

function report(text) {
  chrome.runtime.sendMessage({ type: 'sf-line', text: text }).catch(function() {});
}

function failover() {
  clearTimeout(readyTimer);
  readyTimer = null;
  try { if (engine) engine.terminate(); } catch (e) {}
  engine = null;
  if (candidateIndex < ENGINE_CANDIDATES.length - 1) {
    candidateIndex += 1;
    report('info string engine build failed, falling back to ' + ENGINE_CANDIDATES[candidateIndex].url);
    startEngine();
  } else {
    report('info string all engine builds failed to load');
  }
}

function startEngine() {
  if (engine) return;
  const candidate = ENGINE_CANDIDATES[candidateIndex];
  const url = chrome.runtime.getURL(candidate.url);
  console.log('[offscreen] starting engine #' + candidateIndex + ': ' + candidate.url + ' type=' + (candidate.type || 'classic'));
  console.log('[offscreen] resolved URL: ' + url);
  try {
    engine = new Worker(url, candidate.type ? { type: candidate.type } : undefined);
  } catch (e) {
    console.error('[offscreen] Worker() constructor failed:', e);
    failover();
    return;
  }
  gotUciOk = false;
  engine.onmessage = function(e) {
    const text = typeof e.data === 'string' ? e.data : (e.data && e.data.line);
    if (typeof text !== 'string') {
      console.log('[offscreen] non-string message:', typeof e.data, e.data);
      return;
    }
    console.log('[offscreen] engine says: ' + text.substring(0, 120));
    if (!gotUciOk && text.indexOf('uciok') === 0) {
      gotUciOk = true;
      clearTimeout(readyTimer);
      readyTimer = null;
      console.log('[offscreen] engine READY');
    }
    report(text);
  };
  engine.onerror = function(e) {
    console.error('[offscreen] worker error (gotUciOk=' + gotUciOk + '):', e.message || e);
    if (!gotUciOk) failover();
    else report('info string worker error: ' + (e.message || 'runtime error'));
  };
  readyTimer = setTimeout(function() {
    if (!gotUciOk) {
      console.warn('[offscreen] timeout after 12s - no uciok from ' + candidate.url);
      failover();
    }
  }, 12000);
  report('info string starting engine: ' + candidate.url);
  chrome.runtime.sendMessage({ type: 'sf-engine-loaded' }).catch(function() {});
}

startEngine();

// ---- Maia (human-move model) ----
// Maia runs as its own worker so onnxruntime-web's WebAssembly work never
// blocks the Stockfish bridge. It is started lazily and kept warm; the service
// worker only ever sees promises, and any failure degrades to "no Maia" rather
// than breaking analysis or auto-play.
let maiaWorker = null;
let maiaBroken = false;
let maiaStarting = null;
const maiaPending = new Map();
let maiaNextId = 0;

// The service worker owns the analysis log, so Maia's own diagnostics are
// forwarded there to end up in the same place as the engine's. Best-effort:
// the popup may be closed, in which case nobody is listening.
function reportMaia(text) {
  chrome.runtime.sendMessage({ type: 'maia-line', text: text }).catch(function() {});
}

function maiaFail(error) {
  if (maiaBroken) return;
  maiaBroken = true;
  console.error('[maia] disabled:', (error && error.message) || error);
  reportMaia('info string maia unavailable: ' + ((error && error.message) || error));
  const pending = Array.from(maiaPending.values());
  maiaPending.clear();
  pending.forEach(function (entry) {
    entry.resolve({ ok: false, error: (error && error.message) || String(error) });
  });
  try { if (maiaWorker) maiaWorker.terminate(); } catch (e) {}
  maiaWorker = null;
}

function startMaia() {
  if (maiaBroken) return Promise.reject(new Error('maia disabled'));
  if (maiaWorker) return Promise.resolve(maiaWorker);
  if (maiaStarting) return maiaStarting;
  // Resolves on the next turn, by which point the assignment below has
  // completed - so cleanup is deliberately left to the .then() chain.
  const started = new Promise(function(resolve, reject) {
    let url;
    try {
      url = chrome.runtime.getURL('engine/maia/maia-worker.js');
      maiaWorker = new Worker(url);
    } catch (e) {
      reject(e);
      return;
    }
    maiaWorker.onmessage = function(event) {
      const data = event.data || {};
      if (data.type !== 'maia-result' && data.type !== 'maia-warmed') return;
      const entry = maiaPending.get(data.requestId);
      if (!entry) return;
      maiaPending.delete(data.requestId);
      entry.resolve(data);
    };
    maiaWorker.onerror = function(e) {
      maiaStarting = null;
      maiaFail(new Error(e.message || 'maia worker error'));
    };
    console.log('[offscreen] maia worker started');
    resolve(maiaWorker);
  });
  maiaStarting = started;
  const done = function() { if (maiaStarting === started) maiaStarting = null; };
  started.then(done, done);
  return started;
}

function askMaia(message) {
  return startMaia().then(function(worker) {
    const id = ++maiaNextId;
    return new Promise(function(resolve) {
      maiaPending.set(id, { resolve: resolve });
      worker.postMessage(Object.assign({}, message, { id: id }));
    });
  });
}

chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
  if (message.type === 'sf-cmd') {
    try {
      startEngine();
      engine.postMessage(message.cmd);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  if (message.type === 'maia-predict') {
    askMaia({
      type: 'maia-predict',
      fen: message.fen,
      legal: message.legal,
      model: message.model,
      elo: message.elo,
      opponentElo: message.opponentElo,
      repetition: message.repetition,
      limit: message.limit
    }).then(sendResponse).catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
  if (message.type === 'maia-warm') {
    askMaia({ type: 'maia-warm', model: message.model })
      .then(function(r) { sendResponse({ ok: r.ok, error: r.error, model: r.model }); })
      .catch(function(e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
  if (message.type === 'maia-status') {
    sendResponse({ ok: !maiaBroken, started: !!maiaWorker, broken: maiaBroken });
    return true;
  }
  return undefined;
});
