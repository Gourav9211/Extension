// Bridge worker: lila-stockfish-web (Stockfish 17.1, lichess build) exposes an
// ES-module API (uci()/listen/setNnueBuffer), while offscreen.js talks classic-
// worker postMessage. This module worker translates between the two.
//
// The lichess WASM ships WITHOUT neural nets (that is why it is <1MB) and
// evaluates garbage until nets are provided - so we load the bundled official
// Stockfish nets BEFORE flushing any queued UCI commands.
import Sf17179Web from './sf171-79.js';

const pending = [];
onmessage = function(e) {
  if (typeof e.data === 'string') pending.push(e.data);
};

function report(msg) { postMessage('info string [bridge] ' + msg); }

// Module workers do NOT receive the 'chrome' namespace, so resolve nets
// relative to this script's own URL instead of chrome.runtime.getURL().
async function loadNet(name) {
  const resp = await fetch(new URL(name, import.meta.url));
  if (!resp.ok) throw new Error(name + ': HTTP ' + resp.status);
  return new Uint8Array(await resp.arrayBuffer());
}

try {
  const mod = await Sf17179Web({
    listen: function(line) { postMessage(String(line)); },
    onError: function(msg) { report('error: ' + msg); }
  });

  try {
    // Dual-net build: slot 0 = big net, slot 1 = small net. Load sequentially
    // so each load is individually visible in the service worker console.
    const nets = [
      { name: 'nn-1c0000000000.nnue', label: 'big', index: 0 },
      { name: 'nn-37f18f62d772.nnue', label: 'small', index: 1 }
    ];
    const start = Date.now();
    for (const n of nets) {
      const t0 = Date.now();
      const buf = await loadNet(n.name);
      mod.setNnueBuffer(buf, n.index);
      const mb = Math.round((buf.length / 1048576) * 10) / 10;
      report(n.label + ' net ACTIVE: ' + n.name + ' (' + mb + ' MB, ' +
        ((Date.now() - t0) / 1000).toFixed(1) + 's) -> slot ' + n.index);
    }
    report('NNUE ready (' + ((Date.now() - start) / 1000).toFixed(1) + 's total)');
  } catch (err) {
    report('NNUE LOAD FAILED (' + (err && err.message) + ') - moves will be weak!');
  }

  onmessage = function(e) {
    if (typeof e.data !== 'string') return;
    try { mod.uci(e.data); }
    catch (err) { postMessage('info string uci error: ' + (err && err.message)); }
  };
  while (pending.length) mod.uci(pending.shift());
} catch (err) {
  postMessage('info string lsf init failed: ' + (err && err.message));
}
