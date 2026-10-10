# Bitcoin Net Worth Tracker

A local-first dashboard for tracking assets, liabilities, and net worth in both BTC and USD.

Repository: https://github.com/w-s-bitcoin/webapps-bitcoin-net-worth

## Quick Start

- **macOS:** double-click `launch_macos.command`
- **Linux:** run `./launch_linux.sh`
- **Windows:** double-click `launch_windows.bat` (or run `launch_windows.ps1`)

Requires Python 3 on PATH. Opens the app at `http://127.0.0.1:8081/`.

> Set an idle auto-stop timeout (in seconds) via the `IDLE_TIMEOUT` environment variable (default: 180). Use `IDLE_TIMEOUT=0` to disable.
>
> - **macOS / Linux:** `IDLE_TIMEOUT=300 /path/to/launcher`
> - **Windows:** `$env:IDLE_TIMEOUT=300; .\launch_windows.ps1`

## What It Does

- Tracks assets and liabilities in configurable units of account, defaulting to USD, BTC, and sats.
- Settings beside the title enables major currencies, cryptocurrencies, Bitcoin-related stocks, and broad-market, bond, commodity, and Bitcoin ETFs. Click a category heading to expand or collapse it; its count shows selected units.
- Stock and ETF amounts are share counts, including fractional shares. Hiding a unit keeps existing holdings intact.
- BTCFX uses CNBC’s latest daily NAV automatically, with its pricing date displayed and its last price retained during outages.
- Public crypto spot/date quotes and delayed stock/ETF quotes support valuations. Historical stock valuations use saved or manually entered prices; unavailable prices show an em dash and omit affected chart dates.
- Saved CSV and encrypted files retain share quantities, BTC/USD rates, and dated market prices. Older files remain readable.
- Supports demo mode and live mode.
- Fetches BTCUSD from Kraken, with optional manual BTCUSD override. For today’s holdings, a manual Bitcoin price applies the same percentage change to estimated MSTR and Bitcoin fund prices (including BTCFX and Bitcoin ETFs). Other stocks and funds keep their own prices. Estimates use automatic or manually set share prices as the base; saved quotes and history retain their original prices.
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

## Project Files

- `index.html`: app layout and controls
- `styles.css`: theme and component styles
- `app.js`: app state, calculations, persistence, chart rendering, undo/redo
- `market_units.js`: unit catalogue and public cryptocurrency/stock/ETF quote feed
- `standalone_server.py`: local API and static file server
- `history_files/`: demo and live history files
- `launch_macos.command`: macOS launcher
- `launch_linux.sh`: Linux launcher
- `launch_windows.bat`: Windows launcher entrypoint
- `launch_windows.ps1`: Windows launcher implementation

## Validation

Run `node tests/test_market_units.mjs` for isolated public quote fixtures. Run
`python3 tests/test_units_browser.py` for settings, quantities, valuations,
CSV/encryption, native file API, and mobile browser checks. Set `CHROME_BIN`
when Chrome is not at its default macOS location. Browser checks copy the app
and demo fixture to a temporary directory and never read or edit personal history.
