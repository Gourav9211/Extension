let engine = null;

function startEngine() {
  if (engine) return;
  engine = new Worker(chrome.runtime.getURL('engine/stockfish.js'));
  engine.onmessage = function(e) {
    const text = typeof e.data === 'string' ? e.data : (e.data && e.data.line);
    if (typeof text !== 'string') return;
    chrome.runtime.sendMessage({ type: 'sf-line', text: text }).catch(function() {});
  };
  engine.onerror = function(e) {
    chrome.runtime.sendMessage({ type: 'sf-line', text: 'info string worker error: ' + (e.message || 'load failed') }).catch(function() {});
  };
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
