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

// The user inspects the service-worker console, not this offscreen document's,
// so every offscreen lifecycle line is mirrored there with the same tag. Only
// explicit calls to console.* are forwarded - the raw engine UCI stream already
// reaches the worker via sf-line and is filtered there, so nothing is doubled.
function forwardConsole(level, args) {
  const text = Array.prototype.map.call(args, function(a) {
    if (typeof a === 'string') return a;
    if (a && a.stack && a.message) return a.message + ' (' + String(a).split('\n')[0] + ')';
    if (a && a.message) return a.message;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  chrome.runtime.sendMessage({ type: 'offscreen-log', level: level, text: text }).catch(function() {});
}
for (const k of ['log', 'warn', 'error', 'info']) {
  const orig = console[k];
  console[k] = function() {
    const args = Array.prototype.slice.call(arguments);
    try { forwardConsole(k, args); } catch (e) {}
    if (orig) return orig.apply(console, args);
  };
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

// Stockfish does NOT boot automatically anymore. The service worker decides
// when it is wanted: analysis sends 'sf-ensure' whenever the analyse engine is
// Stockfish, so in Maia-only mode the engine is never even loaded. Keeping the
// decision on the SW side avoids a storage round-trip in this document's boot
// path.

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
      // The model worker logs to its own console too, but the interesting
      // line (model name + load time) is forwarded so it lands in the service
      // worker's console like everything else.
      if (data.type === 'maia-console') {
        reportMaia(data.text || '');
        return;
      }
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
  if (message.type === 'sf-ensure') {
    // Analyse position has decided Stockfish is wanted; start it if the boot
    // check skipped it (Maia-only was on). startEngine is idempotent.
    startEngine();
    sendResponse({ ok: true, started: !!engine });
    return true;
  }
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
