# Chess Position Analyst

A Chrome Manifest V3 extension that analyzes Chess.com positions in real time using a locally running Stockfish engine (in an offscreen document), with optional Gemini AI explanations, board highlights, eval graph, move classification, and a game archive with accuracy stats.

## Features

- Real-time board monitoring on chess.com pages
- Local Stockfish analysis (MultiPV, configurable depth) — no server needed
- Optional local **Maia-3** network (any rating, 100–3000) that plays like a human of that strength instead of always picking the best move
- Lichess tablebase lookup for positions with ≤ 7 pieces
- Best-move arrow drawn on the board + move classifications (!!, ?, ??)
- Win-probability graph and move history with accuracy estimate in the popup
- PGN export and game archive (options page)
- Update checker against the repo's GitHub releases with an in-popup banner
- FEN analyzer, dark mode, board coordinates overlay
- Live-analysis master switch (popup and options) that stops watching immediately
- Redesigned dark-first interface with animated eval meter, depth badge, and a
  reduced-motion ready palette
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
- Maia: master switch, player and opponent strength (Elo), model size, use for
  auto-play, popup panel, and the settings that shape its play

The API key is stored only in your browser's extension storage.

## Maia

Maia is a chess network trained on real human games, so it predicts the move a
player of a given strength would actually choose — including the mistakes. It is
bundled with the extension and runs locally through onnxruntime-web (WebAssembly,
single-threaded); no position is ever sent anywhere.

This build uses **Maia-3**, where strength is an input to the network rather than
a choice between separate networks. One model covers the whole rating range, so
any Elo from 100 to 3000 works and changes the prediction directly.

Settings live in the **Maia** section of the options page:

| Setting | Meaning |
| --- | --- |
| Enable Maia | Master switch. When off, nothing is loaded. |
| Player strength (Elo) | Strength of the player being modelled, 100–3000. |
| Opponent strength (Elo) | Strength of the opponent, 100–3000. Leave at `0` to assume an equally strong opponent. |
| Model | Which bundled network to run: `5M` (default, 10 MB, stronger) or `3M` (6 MB, faster, no positional-bias components). |
| Play Maia's move in auto-play | Replaces the 2nd/3rd-best "alternative move" logic. The two never stack. |
| Show Maia in the popup | Adds a Maia panel with its move distribution and a win/loss read-out. |
| Blunder guard (± cp) | Rejects Maia moves that cost more than this many centipawns against Stockfish. `0` disables the guard. |
| Maia candidate moves | How many of Maia's top moves are eligible to be played. |
| Temperature | `1` follows Maia's own probabilities; higher plays more varied moves, lower is more deterministic. |
| Engine lines for the guard | Extra Stockfish lines searched while Maia drives auto-play, so its candidates can be scored. |

Maia plays sub-optimally by design, so the blunder guard is on by default
(120 cp) — otherwise a 1000-rated model will hang pieces at the first opportunity.
The guard only acts once Stockfish has searched to a meaningful depth, because a
shallow line reports large centipawn gaps that are just move-ordering noise.

Maia-3 is an encoder-only transformer that reads the board as 64 square tokens
over 12 piece channels. Two things follow from that, and both are visible in the
code:

- The position the network sees is the one on the board. Castling rights, the
  en-passant square and the clocks are **not** tokenized, so Maia will not
  deliberately castle for safety, will not take an en-passant capture when it
  should, and has no notion of move-count urgency. Its eight game-history slots
  are filled by the upstream exporter repeating the current position.
- Black is evaluated on a mirrored board (ranks flipped, colours swapped), so
  channels 0–5 are always "the side to move". This is also why promotions work
  for both colours: a Black promotion lands in the same rank-7-to-rank-8
  vocabulary block once the board is mirrored. Unlike the older Maia networks,
  its 4352-entry move vocabulary covers **every** legal move — verified at 0
  unmapped moves across 1125 positions and 35,501 legal moves, and again over
  1371 legal moves of a full self-play game.

The bundled networks are fp16 ONNX exports of
[UofTCSSLab/Maia3-5M](https://huggingface.co/UofTCSSLab/Maia3-5M) and the 3M
ablation, converted by [bqrio/maia3-onnx](https://huggingface.co/bqrio/maia3-onnx).
The reference implementation is [CSSLab/maia3](https://github.com/CSSLab/maia3).
The inference runtime is [onnxruntime-web](https://github.com/microsoft/onnxruntime) (MIT).

> **Licensing.** The Maia-3 code and the ONNX conversions are licensed
> **AGPL-3.0** (upstream `maia3` and `bqrio/maia3-onnx` both carry that licence).
> Because the exports are AGPL, a distributed build of this extension is subject
> to AGPL-3.0's source-offer obligations for those components. This matters if
> you redistribute the packaged extension as a binary.

Both models are available and nothing is fetched at runtime. A model is loaded
lazily the first time it is selected and then kept resident, so switching between
3M and 5M costs one local read on first use. Measured in Chromium on an M-series
Mac: median 20 ms per position, p95 25 ms, plus a one-off load of a few hundred
milliseconds.

The 3M ablation leaves out the positional-bias components, so it is the smaller
and faster option but a little weaker tactically.

## Architecture

```
manifest.json            MV3 manifest (storage, offscreen, downloads, tabs)
src/content.js           Reads the chess.com board, sends FEN updates, draws arrows/coords
src/service-worker.js    Debounces positions, caches results, talks to engine + Gemini
src/offscreen.html/js    Offscreen document hosting Stockfish + Maia workers (CSP-safe)
engine/stockfish.js      Self-contained asm.js Stockfish build (no wasm needed)
engine/maia/maia-worker.js     onnxruntime-web inference, lazy per-model session cache
engine/maia/maia3-encoder.js   FEN -> 64x12 square tokens (black-to-move mirrored)
engine/maia/maia3-moves.js     4352-entry policy vocabulary (move -> index and back)
engine/maia/maia3-3m.onnx      Bundled Maia-3 3M fp16 network
engine/maia/maia3-5m.onnx      Bundled Maia-3 5M fp16 network
engine/maia/ort/                onnxruntime-web 1.23.0, wasm-only build
src/popup.html/css/js    Live analysis UI
src/options.html/js      Settings, archive, accuracy stats
```

Use responsibly — for post-game review and training, not cheating in rated games.
