var Module = {
  print: function(text) {
    chrome.runtime.sendMessage({ type: 'sf-line', text: text }).catch(function() {});
  },
  printErr: function(text) {},
  locateFile: function(path) {
    return chrome.runtime.getURL('engine/' + path);
  },
  noInitialRun: true,
  noExitRuntime: true
};

chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
  if (message.type === 'sf-cmd') {
    if (typeof Module._uci_command === 'function') {
      Module._uci_command(message.cmd);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'Engine not ready' });
    }
    return true;
  }
});
