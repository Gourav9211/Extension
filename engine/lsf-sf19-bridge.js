// Bridge worker: lila-stockfish-web (Stockfish 19, lichess build) exposes an
// ES-module API (uci()/listen/setNnueBuffer), while offscreen.js talks classic-
// worker postMessage. This module worker translates between the two.
//
// The lichess WASM ships WITHOUT a neural net (that is why it is <1MB) and
// evaluates garbage until a net is provided - so we load the bundled official
// Stockfish 19 net BEFORE flushing any queued UCI commands.
//
// This build is single-net: only slot 0 (big net) is honoured
// (getRecommendedNnue(1) is undefined), so we no longer load a second net.
import Sf19Web from './sf_19.js';

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
  const mod = await Sf19Web({
    listen: function(line) { postMessage(String(line)); },
    onError: function(msg) { report('error: ' + msg); }
  });

  try {
    const start = Date.now();
    const t0 = Date.now();
    const buf = await loadNet('nn-1a298aa575a0.nnue');
    mod.setNnueBuffer(buf, 0);
    const mb = Math.round((buf.length / 1048576) * 10) / 10;
    report('net ACTIVE: nn-1a298aa575a0.nnue (' + mb + ' MB, ' +
      ((Date.now() - t0) / 1000).toFixed(1) + 's) -> slot 0');
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