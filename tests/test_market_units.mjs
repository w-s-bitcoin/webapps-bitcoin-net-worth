#!/usr/bin/env node
/* Isolated public-quote fixtures; never reads or writes personal Net Worth data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../market_units.js', import.meta.url), 'utf8');
let now = Date.parse('2026-10-08T15:00:00Z');
let nextTimer = 0;
let changes = 0;
let failing = false;
let malformed = false;
let releaseRequest;
const requests = [];
const timers = new Map();
const storage = new Map();
const events = new Map();
const fixturePrices = { MSTR: 320, COIN: 180, ETH: 2500, SOL: 150, VOO: 600, IBIT: 50 };
const validNav = { symbol: 'BTCFX', code: '0', type: 'FUND', currencyCode: 'USD',
  last: '17.89', last_timedate: '10/07/26 EDT', realTime: 'true' };
let navQuote = { ...validNav };
const window = {
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id) { timers.delete(id); },
  addEventListener() {},
};
const document = {
  visibilityState: 'visible',
  addEventListener(name, callback) { events.set(name, callback); },
};
const sandbox = {
  window, document, AbortController,
  Date: class extends Date { static now() { return now; } },
  fetch: async (url, options = {}) => {
    requests.push({ url, options });
    if (releaseRequest) await new Promise((resolve) => { releaseRequest.resolve = resolve; });
    if (failing) throw new Error('Fixture feed offline');
    let data;
    if (url.includes('quote.cnbc.com')) {
      data = { ITVQuoteResult: { ITVQuote: [navQuote] } };
    } else if (url.includes('tradingview')) {
      const { symbols } = JSON.parse(options.body);
      data = { data: symbols.tickers.map((ticker) => ({
        s: ticker, d: [fixturePrices[ticker.split(':')[1]] ?? null, 'delayed_streaming_900'],
      })) };
    } else {
      const code = url.match(/prices\/(.+)-USD/)[1];
      data = { data: {
        amount: String(url.includes('?date=') ? 1000 : fixturePrices[code]),
        base: code, currency: malformed ? 'EUR' : 'USD',
      } };
    }
    return { ok: true, json: async () => data };
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = window.WSBNetWorthMarketUnits;
const feed = api.create({ onChange: () => { changes += 1; } });
const today = '2026-10-08';

assert.equal(new Set(api.units.map((unit) => unit.code)).size, api.units.length, 'units are unambiguous');
assert.deepEqual(Array.from(api.units.filter((unit) => unit.bitcoinLinked), (unit) => unit.code).sort(),
  ['MSTR', 'BTCFX', 'IBIT', 'FBTC', 'ARKB', 'BITB', 'GBTC', 'HODL', 'BTCO', 'BRRR', 'EZBC', 'BTCW', 'BITO'].sort(),
  'only MSTR and Bitcoin funds participate in manual Bitcoin estimates');
assert.equal(api.units.find((unit) => unit.code === 'sats').decimals, 0);
assert.equal(api.units.find((unit) => unit.code === 'MSTR').kind, 'stock');
assert.ok(api.units.find((unit) => unit.code === 'MSTR').decimals > 0, 'fractional shares are supported');
assert.equal(feed.getUsdPrice('MSTR'), null, 'an unavailable share price is never zero or a USD rate');

feed.setActiveCodes(['USD', 'BTC', 'sats', 'MSTR', 'ETH', 'NOT_A_UNIT']);
await Promise.all([feed.refresh(), feed.refresh()]);
assert.equal(requests.length, 2, 'only the selected crypto and stock are fetched; concurrent refreshes deduplicate');
assert.deepEqual(JSON.parse(requests.find((request) => request.url.includes('tradingview')).options.body).symbols.tickers,
  ['NASDAQ:MSTR']);
assert.equal(feed.getUsdPrice('MSTR'), 320);
assert.equal(feed.getUsdPrice('MSTR', today), 320);
assert.equal(feed.getUsdPrice('MSTR') * 2.5, 800, 'share quantity is multiplied by its per-share USD price');
assert.equal(feed.getUsdPrice('ETH'), 2500);
assert.equal(feed.getQuote('MSTR').delayLabel, '15m delayed');
assert.equal(feed.getQuote('MSTR').status, 'current');
assert.equal(feed.getUsdPrice('MSTR', '2024-01-01'), null, 'current equity quotes never value historical shares');
assert.equal(feed.getUsdPrice('ETH', '2024-01-01'), null, 'current crypto quotes never value historical coins');
assert.equal(feed.getUsdPrice('ETH', '2027-01-01'), null, 'future quotes are unavailable');

// ETFs use exchange-specific equity quotes and preserve fractional share counts.
const etfFeed = api.create();
etfFeed.setActiveCodes(['VOO', 'IBIT']);
await etfFeed.refresh();
assert.deepEqual(JSON.parse(requests.at(-1).options.body).symbols.tickers, ['NASDAQ:IBIT', 'AMEX:VOO']);
assert.equal(etfFeed.getUsdPrice('VOO') * 2.5, 1500);
assert.equal(etfFeed.getUsdPrice('IBIT') * 12.5, 625);
assert.equal(etfFeed.getQuote('IBIT').delayLabel, '15m delayed');
assert.equal(etfFeed.getUsdPrice('IBIT', '2024-01-01'), null, 'current ETF quotes cannot value historical shares');

// Mutual funds expose the actual NAV date even when a provider calls the quote real-time.
const navFeed = api.create();
navFeed.setActiveCodes(['BTCFX']);
const beforeNav = requests.length;
await Promise.all([navFeed.refresh(), navFeed.refresh()]);
assert.equal(requests.length, beforeNav + 1, 'concurrent NAV refreshes deduplicate');
assert.ok(requests.at(-1).url.includes('symbols=BTCFX'));
assert.equal(requests.at(-1).options.credentials, 'omit');
assert.equal(navFeed.getUsdPrice('BTCFX') * 12.5, 223.625, 'fractional fund shares use per-share NAV');
assert.equal(navFeed.getQuote('BTCFX').day, '2026-10-07', 'NAV date is not the retrieval day');
assert.equal(navFeed.getQuote('BTCFX').delayLabel, 'Daily NAV as of 2026-10-07 · CNBC');
assert.equal(navFeed.getQuote('BTCFX').status, 'current');
assert.equal(navFeed.getUsdPrice('BTCFX', '2024-01-01'), null, 'latest NAV cannot backdate a holding');
const beforeNavHistory = requests.length;
await navFeed.refresh({ isoDate: '2024-01-01' });
assert.equal(requests.length, beforeNavHistory, 'past dates do not request latest NAV');
for (const invalid of [
  { symbol: 'OTHER' }, { code: '1' }, { type: 'STOCK' }, { currencyCode: 'EUR' },
  { last: 'NaN' }, { last: 0 }, { last: true }, { last: Infinity },
  { last_timedate: '02/30/26 EST' }, { last_timedate: '10/09/26 EDT' },
  { last_timedate: '10/06/26 EDT' }, { last_timedate: 'invalid' },
]) {
  navQuote = { ...validNav, last: '99.00', ...invalid };
  await navFeed.refresh();
  assert.equal(navFeed.getUsdPrice('BTCFX'), 17.89, `invalid/stale NAV rejected: ${JSON.stringify(invalid)}`);
  assert.equal(navFeed.getQuote('BTCFX').status, 'retained');
}
navQuote = { ...validNav, last: '18.25', last_timedate: '10/08/26 EDT' };
await navFeed.refresh();
assert.equal(navFeed.getUsdPrice('BTCFX'), 18.25, 'the next published NAV updates automatically');
assert.equal(navFeed.getQuote('BTCFX').day, today);
failing = true;
await navFeed.refresh();
assert.equal(navFeed.getUsdPrice('BTCFX'), 18.25, 'outages retain the latest NAV');
assert.equal(navFeed.getQuote('BTCFX').status, 'retained');
const restoredNav = api.create();
assert.equal(restoredNav.getUsdPrice('BTCFX'), 18.25, 'NAV survives an offline reload');
assert.equal(restoredNav.getQuote('BTCFX').day, today);
assert.equal(restoredNav.getQuote('BTCFX').status, 'retained');
failing = false;
navFeed.setActiveCodes([]);
const beforeNavDeselection = requests.length;
await navFeed.refresh();
assert.equal(requests.length, beforeNavDeselection, 'unused BTCFX does not request NAV');

const historicRequestCount = requests.length;
await feed.refresh({ isoDate: '2024-01-01' });
assert.equal(requests.length, historicRequestCount + 1, 'one requested historical date only fetches its selected crypto');
assert.ok(requests.at(-1).url.endsWith('ETH-USD/spot?date=2024-01-01'));
assert.equal(feed.getUsdPrice('ETH', '2024-01-01'), 1000);
assert.equal(feed.getUsdPrice('ETH', '2024-01-02'), null, 'historical prices remain scoped to their exact day');
assert.equal(feed.getQuote('ETH', '2024-01-01').status, 'historical');
assert.equal(feed.getUsdPrice('ETH'), 2500, 'a historical fetch never replaces the current quote');
await feed.refresh({ isoDate: '2024-01-01' });
assert.equal(requests.length, historicRequestCount + 1, 'accepted history is cached in the open tab');
assert.equal(await feed.refresh({ isoDate: '2024-02-30' }), false);
assert.equal(await feed.refresh({ isoDate: '2027-01-01' }), false);

failing = true;
await feed.refresh();
assert.equal(feed.getUsdPrice('MSTR'), 320, 'an outage preserves accepted equity prices');
assert.equal(feed.getUsdPrice('ETH'), 2500, 'an outage preserves accepted crypto prices');
assert.equal(feed.getQuote('MSTR').status, 'retained', 'an outage cannot be labeled live');
const restored = api.create();
assert.equal(restored.getUsdPrice('MSTR'), 320, 'an offline reload can retain public quote metadata');
assert.equal(restored.getQuote('MSTR').status, 'retained', 'cache restoration never claims a live quote');
assert.equal(restored.getUsdPrice('MSTR', '2024-01-01'), null, 'cached current quotes cannot leak into the past');
failing = false;

malformed = true;
fixturePrices.ETH = 9999;
await feed.refresh();
assert.equal(feed.getUsdPrice('ETH'), 2500, 'a non-USD provider response cannot corrupt a USD valuation');
malformed = false;
fixturePrices.MSTR = Infinity;
await feed.refresh();
assert.equal(feed.getUsdPrice('MSTR'), 320, 'non-finite prices cannot corrupt a valuation');
fixturePrices.MSTR = 320;

feed.setActiveCodes(['COIN']);
const beforeSelection = requests.length;
await feed.refresh();
assert.equal(requests.length, beforeSelection + 1, 'deselected markets stop producing network requests');
assert.deepEqual(JSON.parse(requests.at(-1).options.body).symbols.tickers, ['NASDAQ:COIN']);
assert.equal(feed.getUsdPrice('COIN'), 180);
feed.start();
timers.clear();
feed.setActiveCodes(['COIN']);
assert.equal(timers.size, 0, 'rendering unchanged active codes cannot create a fetch/render loop');
feed.setActiveCodes(['SOL']);
assert.equal([...timers.values()].filter((timer) => timer.delay === 0).length, 1);

await feed.refresh();
assert.equal(feed.getUsdPrice('SOL'), 150);
now += 60000;
assert.equal(feed.getQuote('SOL').status, 'retained', 'a quote ages out even if no request is made');
assert.equal(feed.getUsdPrice('SOL'), 150, 'aging changes status without dropping the last valuation');

releaseRequest = {};
fixturePrices.SOL = 999;
const held = feed.refresh();
feed.stop();
releaseRequest.resolve();
await held;
releaseRequest = null;
assert.equal(feed.getUsdPrice('SOL'), 150, 'an in-flight response cannot install data after stop');
assert.equal(timers.size, 0, 'stop clears polling, status, and request timeout timers');
assert.ok(changes > 0, 'accepted quotes and failures notify the dashboard');
console.log('Net Worth market unit catalogue, quotes, history, outages, and lifecycle passed.');
