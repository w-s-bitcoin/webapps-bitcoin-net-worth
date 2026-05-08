# Bitcoin Net Worth Tracker

A local-first dashboard for tracking assets, liabilities, and net worth in both BTC and USD.

Repository: https://github.com/w-s-bitcoin/webapps-bitcoin-net-worth

## What It Does

- Tracks assets and liabilities in BTC and USD.
- Supports demo mode and live mode.
- Fetches BTCUSD from Kraken, with optional manual BTCUSD override.
- Saves and edits snapshot history.
- Draws two built-in charts:
   - Net worth change in BTC vs USD
   - Assets vs liabilities in BTC
- Supports multi-select chart filters (assets/liabilities), persisted per mode.
- Supports undo/redo for dashboard edits (including manual quote changes and chart control changes).
- Exports CSV files:
   - `total_net_worth_usd_vs_btc.csv`
   - `historic_net_worth.csv`

## Storage Model

- Demo mode data is loaded from `history_files/demo_history.csv` and cached in browser localStorage for UI state.
- Live mode data is stored in local files under `history_files/` via the local API server.
- Live files support plaintext (`.csv`) or encrypted (`.enc`) storage.

## Recommended Run (With Live Mode APIs)

These launchers start the local server and open the app:

- macOS: `launch_macos.command`
- Linux: `launch_linux.sh`
- Windows: `launch_windows.bat` (which invokes `launch_windows.ps1`)

Requirements:

- Python 3 available on PATH (`python3`, `python`, or `py` on Windows).

Server defaults:

- Host: `127.0.0.1`
- Port: `8081`
- URL: `http://127.0.0.1:8081/`

macOS launcher supports idle auto-stop:

```bash
IDLE_TIMEOUT=180 /path/to/launch_macos.command
```

Set `IDLE_TIMEOUT=0` to disable auto-shutdown.

## Alternate Run (Static Only)

You can open `index.html` directly or use any static server, but live file APIs (`/api/live-history*`) require `standalone_server.py`.

Example static servers:

```bash
npx serve .
```

```bash
npx http-server .
```

## Local API Endpoints

When running `standalone_server.py`, the app uses:

- `GET /api/live-history/files`
- `GET /api/live-history`
- `POST /api/live-history`
- `GET /api/heartbeat`
- `POST /api/heartbeat`

## Project Files

- `index.html`: app layout and controls
- `styles.css`: theme and component styles
- `app.js`: app state, calculations, persistence, chart rendering, undo/redo
- `standalone_server.py`: local API and static file server
- `history_files/`: demo and live history files
- `launch_macos.command`: macOS launcher
- `launch_linux.sh`: Linux launcher
- `launch_windows.bat`: Windows launcher entrypoint
- `launch_windows.ps1`: Windows launcher implementation
