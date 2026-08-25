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
  return undefined;
});
