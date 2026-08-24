// Bridge worker: lila-stockfish-web (Stockfish 17.1, lichess build) exposes an
// ES-module API (uci()/listen), while offscreen.js talks classic-worker
// postMessage. This module worker translates between the two.
// The queuing handler is installed synchronously so commands sent before the
// engine finishes initializing are never dropped.
import Sf17179Web from './sf171-79.js';

const pending = [];
onmessage = function(e) {
  if (typeof e.data === 'string') pending.push(e.data);
};

try {
  const mod = await Sf17179Web({
    listen: function(line) { postMessage(String(line)); },
    onError: function(msg) { postMessage('info string lsf error: ' + msg); }
  });
  onmessage = function(e) {
    if (typeof e.data !== 'string') return;
    try { mod.uci(e.data); }
    catch (err) { postMessage('info string uci error: ' + (err && err.message)); }
  };
  while (pending.length) mod.uci(pending.shift());
} catch (err) {
  postMessage('info string lsf init failed: ' + (err && err.message));
}
