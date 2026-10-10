/* Optional Net Worth units. Personal holdings never leave the dashboard.
 * BTC, fiat and metals retain the dashboard's existing published rate sources.
 * Coinbase spot/date API: https://docs.cdp.coinbase.com/coinbase-app/track-apis/prices
 * Stocks and ETFs use the public, delayed TradingView scanner used by DCA Comparison.
 * BTCFX uses CNBC's public daily NAV quote, with its pricing date kept intact.
 */
(function () {
  "use strict";

  const POLL_MS = 60000;
  const TIMEOUT_MS = 12000;
  const CACHE_KEY = "bitcoinNetWorthTrackerMarketQuotesV1";
  const BTCFX_NAV_URL = "https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=BTCFX&requestMethod=itv&noform=1&fund=1&exthrs=1&output=json";
  const STOCK_TICKERS = Object.freeze({
    MSTR: "NASDAQ:MSTR", COIN: "NASDAQ:COIN", XYZ: "NYSE:XYZ",
    MARA: "NASDAQ:MARA", CLSK: "NASDAQ:CLSK", RIOT: "NASDAQ:RIOT",
    HUT: "NASDAQ:HUT", IREN: "NASDAQ:IREN", CORZ: "NASDAQ:CORZ",
    BTDR: "NASDAQ:BTDR", HOOD: "NASDAQ:HOOD",
    SPY: "AMEX:SPY", VOO: "AMEX:VOO", IVV: "AMEX:IVV", VTI: "AMEX:VTI",
    QQQ: "NASDAQ:QQQ", QQQM: "NASDAQ:QQQM", DIA: "AMEX:DIA", IWM: "AMEX:IWM",
    VT: "AMEX:VT", VXUS: "NASDAQ:VXUS", VEA: "AMEX:VEA", VWO: "AMEX:VWO",
    SCHD: "AMEX:SCHD", VIG: "AMEX:VIG", BND: "NASDAQ:BND", AGG: "AMEX:AGG",
    TLT: "NASDAQ:TLT", SGOV: "NYSE:SGOV", GLD: "AMEX:GLD", IAU: "AMEX:IAU", SLV: "AMEX:SLV",
    IBIT: "NASDAQ:IBIT", FBTC: "CBOE:FBTC", ARKB: "CBOE:ARKB", BITB: "AMEX:BITB",
    GBTC: "AMEX:GBTC", HODL: "CBOE:HODL", BTCO: "CBOE:BTCO", BRRR: "NASDAQ:BRRR",
    EZBC: "CBOE:EZBC", BTCW: "CBOE:BTCW", BITO: "AMEX:BITO",
  });
  const fiat = [
    ["USD", "United States dollar", "$"], ["EUR", "euro", "€"],
    ["JPY", "Japanese yen", "¥", 0], ["GBP", "British pound sterling", "£"],
    ["CNY", "Chinese renminbi yuan", "¥"], ["AUD", "Australian dollar", "A$"],
    ["CAD", "Canadian dollar", "C$"], ["CHF", "Swiss franc", "CHF"],
    ["HKD", "Hong Kong dollar", "HK$"], ["SGD", "Singapore dollar", "S$"],
    ["SEK", "Swedish krona", "kr"], ["KRW", "South Korean won", "₩", 0],
    ["NOK", "Norwegian krone", "kr"], ["NZD", "New Zealand dollar", "NZ$"],
    ["MXN", "Mexican peso", "MX$"], ["INR", "Indian rupee", "₹"],
    ["RUB", "Russian ruble", "₽"], ["ZAR", "South African rand", "R"],
    ["TRY", "Turkish lira", "₺"], ["BRL", "Brazilian real", "R$"],
    ["AED", "United Arab Emirates dirham", "AED"], ["SAR", "Saudi riyal", "SAR"],
    ["DKK", "Danish krone", "kr"], ["PLN", "Polish zloty", "zł"],
    ["TWD", "New Taiwan dollar", "NT$"], ["THB", "Thai baht", "฿"],
    ["IDR", "Indonesian rupiah", "Rp"], ["HUF", "Hungarian forint", "Ft"],
    ["CZK", "Czech koruna", "Kč"], ["ILS", "Israeli new shekel", "₪"],
    ["CLP", "Chilean peso", "CL$", 0], ["PHP", "Philippine peso", "₱"],
    ["MYR", "Malaysian ringgit", "RM"], ["COP", "Colombian peso", "CO$"],
    ["RON", "Romanian leu", "lei"], ["ISK", "Icelandic krona", "kr", 0],
    ["ARS", "Argentine peso", "AR$"], ["PKR", "Pakistani rupee", "PKR"],
    ["BDT", "Bangladeshi taka", "৳"], ["EGP", "Egyptian pound", "E£"],
    ["NGN", "Nigerian naira", "₦"], ["VND", "Vietnamese dong", "₫", 0],
  ].map(([code, name, symbol, decimals = 2]) => ({ code, name, symbol, decimals, kind: "fiat" }));
  const crypto = [
    ["ETH", "Ethereum"], ["USDT", "Tether"], ["BNB", "BNB"], ["XRP", "XRP"],
    ["SOL", "Solana"], ["USDC", "USD Coin"], ["DOGE", "Dogecoin"],
    ["ADA", "Cardano"], ["TRX", "TRON"], ["LINK", "Chainlink"],
    ["AVAX", "Avalanche"], ["BCH", "Bitcoin Cash"], ["LTC", "Litecoin"],
    ["DOT", "Polkadot"], ["SUI", "Sui"], ["TON", "Toncoin"],
    ["XLM", "Stellar"], ["HBAR", "Hedera"], ["SHIB", "Shiba Inu"],
    ["HYPE", "Hyperliquid"],
  ].map(([code, name]) => ({ code, name, decimals: 8, suffix: code, kind: "crypto" }));
  const stocks = [
    ["MSTR", "Strategy"], ["COIN", "Coinbase"], ["XYZ", "Block"],
    ["MARA", "MARA Holdings"], ["CLSK", "CleanSpark"], ["RIOT", "Riot Platforms"],
    ["HUT", "Hut 8"], ["IREN", "IREN"], ["CORZ", "Core Scientific"],
    ["BTDR", "Bitdeer"], ["HOOD", "Robinhood"],
    ["BTCFX", "Bitcoin ProFund (Investor Class)"],
  ].map(([code, name]) => ({ code, name, decimals: 6, suffix: `${code} shares`, kind: "stock" }));
  const etfs = [
    ["SPY", "State Street SPDR S&P 500 ETF Trust"], ["VOO", "Vanguard S&P 500 ETF"],
    ["IVV", "iShares Core S&P 500 ETF"], ["VTI", "Vanguard Morningstar Total Stock Market ETF"],
    ["QQQ", "Invesco QQQ ETF"], ["QQQM", "Invesco NASDAQ 100 ETF"],
    ["DIA", "SPDR Dow Jones Industrial Average ETF"], ["IWM", "iShares Russell 2000 ETF"],
    ["VT", "Vanguard Total World Stock ETF"], ["VXUS", "Vanguard Total International Stock ETF"],
    ["VEA", "Vanguard FTSE Developed Markets ETF"], ["VWO", "Vanguard FTSE Emerging Markets ETF"],
    ["SCHD", "Schwab U.S. Dividend Equity ETF"], ["VIG", "Vanguard Dividend Appreciation ETF"],
    ["BND", "Vanguard Total Bond Market ETF"], ["AGG", "iShares Core U.S. Aggregate Bond ETF"],
    ["TLT", "iShares 20+ Year Treasury Bond ETF"], ["SGOV", "iShares 0-3 Month Treasury Bond ETF"],
    ["GLD", "SPDR Gold Shares"], ["IAU", "iShares Gold Trust"], ["SLV", "iShares Silver Trust"],
    ["IBIT", "iShares Bitcoin Trust ETF"], ["FBTC", "Fidelity Wise Origin Bitcoin Fund"],
    ["ARKB", "ARK 21Shares Bitcoin ETF"], ["BITB", "Bitwise Bitcoin ETF Trust"],
    ["GBTC", "Grayscale Bitcoin Trust ETF"], ["HODL", "VanEck Bitcoin ETF"],
    ["BTCO", "Invesco Galaxy Bitcoin ETF"], ["BRRR", "CoinShares Bitcoin ETF"],
    ["EZBC", "Franklin Bitcoin ETF"], ["BTCW", "WisdomTree Bitcoin Fund"],
    ["BITO", "ProShares Bitcoin ETF (futures)"],
  ].map(([code, name]) => ({ code, name, decimals: 6, suffix: `${code} shares`, kind: "stock", category: "etf" }));
  // These instruments follow the user's Bitcoin what-if percentage adjustment.
  const bitcoinLinkedCodes = new Set([
    "MSTR", "BTCFX", "IBIT", "FBTC", "ARKB", "BITB", "GBTC", "HODL",
    "BTCO", "BRRR", "EZBC", "BTCW", "BITO",
  ]);
  const units = Object.freeze([
    fiat[0],
    { code: "BTC", name: "bitcoin", decimals: 8, kind: "bitcoin", color: "#ff9900" },
    { code: "sats", name: "satoshis", decimals: 0, kind: "bitcoin", suffix: "sats", color: "#ff9900" },
    ...fiat.slice(1), ...crypto, ...stocks, ...etfs,
    { code: "XAU", name: "gold", decimals: 4, kind: "metal", suffix: "oz gold", color: "#ffd21a" },
    { code: "XAG", name: "silver", decimals: 4, kind: "metal", suffix: "oz silver", color: "#c8d2dc" },
    { code: "XPT", name: "platinum", decimals: 4, kind: "metal", suffix: "oz platinum", color: "#d5d8dc" },
    { code: "XPD", name: "palladium", decimals: 4, kind: "metal", suffix: "oz palladium", color: "#b9c8d2" },
  ].map((unit) => Object.freeze({ ...unit, bitcoinLinked: bitcoinLinkedCodes.has(unit.code) })));
  const marketCodes = new Set([...crypto, ...stocks, ...etfs].map((unit) => unit.code));
  const cryptoCodes = new Set(crypto.map((unit) => unit.code));

  function localDay(now = Date.now()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function validDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(day)
      && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
      && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  }

  function positive(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
  }

  function create({ onChange } = {}) {
    const selected = new Set();
    const quotes = new Map();
    const history = new Map();
    const pending = new Map();
    const requests = new Set();
    let started = false;
    let timer = 0;
    let expiryTimer = 0;
    let epoch = 0;

    // Only public quotes are cached; codes selected by the user and holdings
    // belong to the dashboard's existing personal-data storage/encryption.
    try {
      const cached = JSON.parse(window.localStorage?.getItem(CACHE_KEY) || "null");
      for (const [code, quote] of Object.entries(cached?.quotes || {})) {
        if (marketCodes.has(code) && positive(quote.price) && validDay(quote.day)
            && Number.isFinite(quote.checkedAt) && quote.checkedAt <= Date.now()) {
          quotes.set(code, { ...quote, price: Number(quote.price), connected: false });
        }
      }
    } catch (_) { /* Storage may be unavailable or malformed. */ }

    function notify() {
      onChange?.();
    }

    function persist() {
      try {
        window.localStorage?.setItem(CACHE_KEY, JSON.stringify({ quotes: Object.fromEntries(quotes) }));
      } catch (_) { /* Quotes remain available in memory. */ }
    }

    function getQuote(code, isoDate) {
      if (!marketCodes.has(code)) return null;
      const day = isoDate || localDay();
      if (!validDay(day) || day > localDay()) return null;
      if (day !== localDay()) {
        const past = history.get(`${code}:${day}`);
        return past ? { ...past, status: "historical", live: false } : null;
      }
      const quote = quotes.get(code);
      if (!quote) return null;
      const live = quote.connected && Date.now() - quote.checkedAt < POLL_MS;
      return { ...quote, live, status: live ? "current" : "retained" };
    }

    function getUsdPrice(code, isoDate) {
      return getQuote(code, isoDate)?.price ?? null;
    }

    function scheduleExpiry() {
      window.clearTimeout(expiryTimer);
      if (!started || document.visibilityState === "hidden") return;
      const next = [...quotes.values()].filter((q) => q.connected)
        .map((q) => q.checkedAt + POLL_MS - Date.now()).filter((delay) => delay > 0);
      if (next.length) expiryTimer = window.setTimeout(() => {
        notify();
        scheduleExpiry();
      }, Math.min(...next));
    }

    async function fetchJson(url, options = {}) {
      const request = new AbortController();
      requests.add(request);
      const timeout = window.setTimeout(() => request.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(url, { ...options, cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error(`Market quote unavailable (${response.status})`);
        return await response.json();
      } finally {
        window.clearTimeout(timeout);
        requests.delete(request);
      }
    }

    function retain(code) {
      if (quotes.has(code)) quotes.get(code).connected = false;
    }

    function once(key, run) {
      if (pending.has(key)) return pending.get(key);
      const promise = run().finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    }

    async function pollCrypto(code, day, requestEpoch) {
      const historical = day !== localDay();
      const key = `${code}:${historical ? day : "current"}`;
      if (historical && history.has(key)) return;
      return once(`${requestEpoch}:${key}`, async () => {
        try {
          const query = historical ? `?date=${day}` : "";
          const payload = await fetchJson(`https://api.coinbase.com/v2/prices/${code}-USD/spot${query}`);
          const data = payload?.data;
          if (data?.base !== code || data.currency !== "USD" || !positive(data.amount)) {
            throw new Error("Invalid cryptocurrency quote");
          }
          if (epoch !== requestEpoch || !selected.has(code)) return;
          const quote = {
            price: Number(data.amount), day, checkedAt: Date.now(), source: "Coinbase",
            delayLabel: historical ? "Historical daily price" : "Spot", connected: true,
          };
          if (historical) history.set(key, quote);
          else quotes.set(code, quote);
        } catch (_) {
          if (!historical && epoch === requestEpoch) retain(code);
        }
      });
    }

    async function pollStocks(codes, requestEpoch) {
      if (!codes.length) return;
      return once(`${requestEpoch}:stocks:${codes.join(",")}`, async () => {
        try {
          const payload = await fetchJson("https://scanner.tradingview.com/america/scan", {
            method: "POST", headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
              symbols: { tickers: codes.map((code) => STOCK_TICKERS[code]) },
              columns: ["close", "update_mode"],
            }),
          });
          if (epoch !== requestEpoch) return;
          for (const code of codes) {
            if (!selected.has(code)) continue;
            const item = payload?.data?.find((entry) => entry.s === STOCK_TICKERS[code]);
            if (!positive(item?.d?.[0])) { retain(code); continue; }
            const seconds = Number(String(item.d[1] || "").match(/delayed_streaming_(\d+)/)?.[1]);
            quotes.set(code, {
              price: Number(item.d[0]), day: localDay(), checkedAt: Date.now(), source: "TradingView",
              delayLabel: seconds > 0 ? `${Math.round(seconds / 60)}m delayed` : "Indicative",
              connected: true,
            });
          }
        } catch (_) {
          if (epoch === requestEpoch) codes.forEach(retain);
        }
      });
    }

    async function pollBtcfx(requestEpoch) {
      return once(`${requestEpoch}:BTCFX:current`, async () => {
        try {
          const payload = await fetchJson(BTCFX_NAV_URL, { credentials: "omit" });
          const items = payload?.ITVQuoteResult?.ITVQuote;
          const item = Array.isArray(items) ? items.find((entry) => entry?.symbol === "BTCFX") : null;
          // CNBC flags this as realTime, but a mutual fund publishes a daily NAV.
          // Parse its US calendar date explicitly instead of treating receipt time as pricing time.
          const date = /^(\d{2})\/(\d{2})\/(\d{2}) (?:EST|EDT)$/.exec(item?.last_timedate || "");
          const day = date ? `20${date[3]}-${date[1]}-${date[2]}` : "";
          if (item?.code !== "0" || item.type !== "FUND" || item.currencyCode !== "USD"
              || !["string", "number"].includes(typeof item.last) || !positive(item.last)
              || !validDay(day) || day > localDay()) {
            throw new Error("Invalid BTCFX NAV quote");
          }
          if (epoch !== requestEpoch || !selected.has("BTCFX")) return;
          const previous = quotes.get("BTCFX");
          if (previous && day < previous.day) throw new Error("Superseded BTCFX NAV quote");
          quotes.set("BTCFX", {
            price: Number(item.last), day, checkedAt: Date.now(), source: "CNBC",
            delayLabel: `Daily NAV as of ${day} · CNBC`, connected: true,
          });
        } catch (_) {
          if (epoch === requestEpoch) retain("BTCFX");
        }
      });
    }

    async function refresh({ isoDate } = {}) {
      const day = isoDate || localDay();
      if (!validDay(day) || day > localDay()) return false;
      const requestEpoch = epoch;
      const codes = [...selected].sort();
      await Promise.allSettled([
        ...codes.filter((code) => cryptoCodes.has(code)).map((code) => pollCrypto(code, day, requestEpoch)),
        // A current equity quote never values a past date. The comparison CSV
        // contains adjusted closes, which cannot safely value as-held shares.
        ...(day === localDay() ? [pollStocks(codes.filter((code) => STOCK_TICKERS[code]), requestEpoch)] : []),
        ...(day === localDay() && selected.has("BTCFX") ? [pollBtcfx(requestEpoch)] : []),
      ]);
      if (requestEpoch !== epoch) return false;
      persist();
      scheduleExpiry();
      notify();
      return true;
    }

    function schedule(delay = POLL_MS) {
      window.clearTimeout(timer);
      if (started && document.visibilityState !== "hidden") {
        timer = window.setTimeout(async () => { await refresh(); schedule(); }, delay);
      }
    }

    function setActiveCodes(codes) {
      const wanted = new Set(Array.from(codes || []).filter((code) => marketCodes.has(code)));
      if (wanted.size === selected.size && [...wanted].every((code) => selected.has(code))) return;
      epoch += 1;
      for (const request of requests) request.abort();
      selected.clear();
      wanted.forEach((code) => selected.add(code));
      if (started) schedule(0);
    }

    function start() {
      if (started) return;
      started = true;
      schedule(0);
      scheduleExpiry();
    }

    function stop() {
      started = false;
      epoch += 1;
      window.clearTimeout(timer);
      window.clearTimeout(expiryTimer);
      for (const request of requests) request.abort();
      quotes.forEach((quote) => { quote.connected = false; });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timer);
        window.clearTimeout(expiryTimer);
      } else if (started) {
        notify();
        schedule(0);
        scheduleExpiry();
      }
    });
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", start);
    return { setActiveCodes, refresh, getUsdPrice, getQuote, start, stop };
  }

  window.WSBNetWorthMarketUnits = Object.freeze({ units, create });
}());
