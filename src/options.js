const keyInput = document.querySelector('#key');
const status = document.querySelector('#status');

chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => {
  if (geminiApiKey) keyInput.value = geminiApiKey;
});

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.local.set({ geminiApiKey: keyInput.value.trim() });
  status.textContent = keyInput.value.trim() ? 'Key saved locally.' : 'Key cleared.';
});
