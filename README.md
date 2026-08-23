# Chess Position Analyst

A Chrome Manifest V3 extension that analyzes Chess.com positions in real time using a locally running Stockfish engine (in an offscreen document), with optional Gemini AI explanations, board highlights, eval graph, move classification, and a game archive with accuracy stats.

## Features

- Real-time board monitoring on chess.com pages
- Local Stockfish analysis (MultiPV, configurable depth) — no server needed
- Lichess tablebase lookup for positions with ≤ 7 pieces
- Best-move arrow drawn on the board + move classifications (!!, ?, ??)
- Win-probability graph and move history with accuracy estimate in the popup
- PGN export and game archive (options page)
- FEN analyzer, dark mode, board coordinates overlay
- Toggle live analysis with `Cmd+Shift+A` (`Ctrl+Shift+A` on Windows/Linux)

## Run locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open a game or analysis board on chess.com.
5. Click the extension icon to see live analysis.

## Configuration

Open the popup → **Settings** (or right-click the extension icon → Options):

- Analysis depth and MultiPV lines
- UI toggles: sound, dark mode, coordinates, graph, history, classifications
- Gemini API key + optional custom prompt for plain-language explanations

The API key is stored only in your browser's extension storage.

## Architecture

```
manifest.json            MV3 manifest (storage, offscreen, downloads, tabs)
src/content.js           Reads the chess.com board, sends FEN updates, draws arrows/coords
src/service-worker.js    Debounces positions, caches results, talks to engine + Gemini
src/offscreen.html/js    Offscreen document hosting Stockfish as a Web Worker (CSP-safe)
engine/stockfish.js      Self-contained asm.js Stockfish build (no wasm needed)
src/popup.html/css/js    Live analysis UI
src/options.html/js      Settings, archive, accuracy stats
```

Use responsibly — for post-game review and training, not cheating in rated games.
