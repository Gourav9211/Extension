const ENGINE_URL = 'https://lichess.org/api/cloud-eval';
const GEMINI_MODEL = 'gemini-2.0-flash';

function validateFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length < 4) throw new Error('The captured position is not a complete FEN.');

  const ranks = fields[0].split('/');
  if (ranks.length !== 8 || !/^[prnbqkPRNBQK1-8/]+$/.test(fields[0])) {
    throw new Error('The captured board layout is not valid FEN.');
  }
  if (!/^[wb]$/.test(fields[1])) throw new Error('The captured side to move is invalid.');
  return fields.join(' ');
}

async function findBestMove(fen) {
  const response = await fetch(`${ENGINE_URL}?fen=${encodeURIComponent(validateFen(fen))}&multiPv=1`);
  if (response.status === 429) throw new Error('Chess engine rate limit reached. Try again shortly.');
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
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  if (response.status === 429) throw new Error('Gemini rate limit reached. Try again shortly.');
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Gemini returned no explanation.';
}

async function analyzePosition(fen) {
  const engine = await findBestMove(fen);
  let explanation = null;
  try {
    explanation = await explainWithGemini(fen, engine);
  } catch {
    explanation = 'Gemini explanation unavailable.';
  }
  return { ok: true, engine, explanation };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'analyze-position') {
    (async () => {
      try {
        const result = await analyzePosition(message.fen);
        sendResponse(result);
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  return undefined;
});
