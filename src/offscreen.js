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

const pendingSfCommands = [];

function flushPendingSfCommands() {
  if (typeof Module === 'undefined' || typeof Module._uci_command !== 'function') return false;
  while (pendingSfCommands.length) {
    const cmd = pendingSfCommands.shift();
    Module._uci_command(cmd);
  }
  return true;
}

chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
  if (message.type === 'sf-cmd') {
    if (typeof Module._uci_command === 'function') {
      Module._uci_command(message.cmd);
      sendResponse({ ok: true });
      return true;
    }

    pendingSfCommands.push(message.cmd);
    sendResponse({ ok: true, queued: true });
    setTimeout(function() {
      flushPendingSfCommands();
    }, 100);
    return true;
  }
});

setInterval(function() {
  flushPendingSfCommands();
}, 250);
