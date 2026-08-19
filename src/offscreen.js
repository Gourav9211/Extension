let engineReady = false;
let currentResolve = null;
let lines = [];

function postToServiceWorker(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function onMessage(event) {
  const msg = event.data?.type === 'message' ? event.data?.msg : event.data;
  if (!msg) return;

  if (msg === 'uciok') {
    engineReady = true;
    postToServiceWorker({ type: 'engine-ready' });
    return;
  }

  if (msg.startsWith('bestmove')) {
    const bestMove = msg.split(' ')[1];
    const pvLines = [];
    for (const line of lines) {
      const pvMatch = line.match(/ pv (.+)/);
      const scoreMatch = line.match(/ score (cp|mate) (-?\d+)/);
      const depthMatch = line.match(/ depth (\d+)/);
      if (pvMatch) {
        pvLines.push({
          move: pvMatch[1].split(' ')[0],
          line: pvMatch[1],
          evaluation: scoreMatch?.[1] === 'cp' ? parseInt(scoreMatch[2]) : null,
          mate: scoreMatch?.[1] === 'mate' ? parseInt(scoreMatch[2]) : null,
          depth: depthMatch ? parseInt(depthMatch[1]) : null
        });
      }
    }

    postToServiceWorker({
      type: 'engine-result',
      bestMove,
      moves: pvLines.length ? pvLines : [{ move: bestMove, line: bestMove, evaluation: null, mate: null, depth: null }]
    });
    lines = [];
    return;
  }

  if (msg.startsWith('info')) {
    lines.push(msg);
  }
}

function sendCommand(cmd) {
  if (typeof Stockfish === 'function') {
    Stockfish.postMessage(cmd);
  } else if (typeof Stockfish === 'object' && Stockfish.postMessage) {
    Stockfish.postMessage(cmd);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'init-engine') {
    sendCommand('uci');
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'evaluate') {
    lines = [];
    const depth = message.depth || 18;
    sendCommand('stop');
    sendCommand('ucinewgame');
    sendCommand('position fen ' + message.fen);
    sendCommand('go depth ' + depth + ' multipv ' + (message.multiPv || 3));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'stop-engine') {
    sendCommand('stop');
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

if (typeof Stockfish === 'function' || typeof Stockfish === 'object') {
  Stockfish.onmessage = onMessage;
  sendCommand('uci');
} else {
  console.error('Stockfish not loaded');
}
