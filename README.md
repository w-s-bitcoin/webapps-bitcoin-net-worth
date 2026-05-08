# Bitcoin Net Worth Tracker (Static Web App)

This project is now a pure HTML/CSS/JavaScript local web app with no Python dependencies.

## What it does

- Tracks assets and liabilities in BTC and USD terms.
- Fetches BTCUSD from Kraken (or lets you set a manual quote).
- Saves snapshot history in browser localStorage.
- Draws two built-in charts:
   - assets and liabilities valued in BTC
   - net worth performance in BTC vs USD
- Exports notebook-compatible CSV files:
   - total_net_worth_usd_vs_btc.csv
   - historic_net_worth.csv

## Run locally

Option 1 (quickest):

1. Open `index.html` in your browser.

Option 2 (recommended for API compatibility):

1. Serve the folder with any static web server.
2. Open the local URL from that server.

Examples:

```bash
npx serve .
```

or

```bash
npx http-server .
```

No package install is required for the app itself.

## File overview

- `index.html`: app structure
- `styles.css`: visual theme and responsive layout
- `app.js`: state management, math logic, history persistence, chart rendering, CSV export
