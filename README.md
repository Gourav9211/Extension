# Chess Position Analyst

A Chrome/Edge Manifest V3 extension for post-game Chess.com analysis. It reads the visible board position, asks the Lichess cloud engine for a strong continuation, and asks Gemini to explain the idea.

## Run locally

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open a visible Chess.com game or analysis board.
5. Open the extension, choose **Set Gemini API key**, save the key, and choose **Analyze position**.

The Gemini key is stored in browser extension storage. Browser extensions cannot safely read a host shell environment variable, and putting a key in source code would expose it. The engine fallback still returns a move when no Gemini key is configured.

Use this for post-game analysis and review, not during a live rated game.