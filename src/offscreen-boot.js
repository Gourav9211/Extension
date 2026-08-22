function notifyEngineReady() {
  if (typeof Module !== 'undefined' && typeof Module._uci_command === 'function') {
    chrome.runtime.sendMessage({ type: 'sf-engine-loaded' }).catch(function() {});
    return true;
  }
  return false;
}

try {
  Module._main();
} catch (e) {}

let engineReadyAttempts = 0;
function waitForEngineReady() {
  if (notifyEngineReady()) return;
  engineReadyAttempts += 1;
  if (engineReadyAttempts < 50) {
    setTimeout(waitForEngineReady, 100);
  }
}

waitForEngineReady();
