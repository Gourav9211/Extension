const ENGINE_URL = 'https://lichess.org/api/cloud-eval';
const GEMINI_MODEL = 'gemini-2.0-flash';

async function findBestMove(fen) {
  const response = await fetch(`${ENGINE_URL}?fen=${encodeURIComponent(fen)}&multiPv=1`);
  if (!response.ok) throw new Error(`Chess engine request failed (${response.status}).`);
  const data = await response.json();
  const topLine = data.pvs?.[0];
  if (!topLine?.moves) throw new Error('No cloud-engine evaluation is available for this position.');
  return {
    move: topLine.moves.split(' ')[0],
    line: topLine.moves,
    evaluation: topLine.cp ?? null,
    depth: data.depth ?? null
  };
}

async function explainWithGemini(fen, engine) {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) return 'Add a Gemini API key in the extension options to receive a natural-language explanation.';

  const prompt = [
    'You are explaining a chess position for post-game analysis, not live play.',
    `Position FEN: ${fen}`,
    `Engine suggestion: ${engine.move}`,
    `Principal variation: ${engine.line}`,
    'Explain why this move is strong in plain language. Mention the tactical or strategic idea, the opponent response, and one practical caution. Do not invent pieces or legal moves.'
  ].join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Gemini returned no explanation.';
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'analyze-position') return undefined;
  (async () => {
    try {
      const engine = await findBestMove(message.fen);
      const explanation = await explainWithGemini(message.fen, engine);
      sendResponse({ ok: true, engine, explanation });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();
  return true;
});
