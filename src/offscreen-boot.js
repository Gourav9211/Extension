try {
  Module._main();
} catch (e) {}

chrome.runtime.sendMessage({ type: 'sf-engine-loaded' }).catch(function() {});
