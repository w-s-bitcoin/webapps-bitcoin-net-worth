#!/usr/bin/env python3
"""Fixture-driven Net Worth unit settings, share quantities, and valuation checks.

Uses an isolated Chrome profile and public-feed fetch shims. No personal files,
production producers, or checked-in datasets are changed. Set CHROME_BIN when
Chrome is not installed at its default macOS path. Set NETWORTH_SCREENSHOT_DIR
for optional desktop/mobile screenshots of the settings panel.
"""

import base64
import json
import os
import subprocess
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from browser_helpers import CdpSocket, free_port, wait_for
import shutil
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from standalone_server import Handler


ROOT = Path(__file__).resolve().parents[1]
CHROME = os.environ.get("CHROME_BIN", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
SHIM = r"""
(() => {
  const nativeFetch = window.fetch.bind(window);
  const navDate = new Date();
  navDate.setDate(navDate.getDate() - 1);
  const navMonth = String(navDate.getMonth() + 1).padStart(2, '0');
  const navDay = String(navDate.getDate()).padStart(2, '0');
  const navYear = String(navDate.getFullYear());
  window.__netWorthFixture = {
    offline: false, btcfxOffline: false, requests: [],
    btcfxDay: `${navYear}-${navMonth}-${navDay}`,
    btcfxTimestamp: `${navMonth}/${navDay}/${navYear.slice(-2)} EDT`,
  };
  class PriceSocket {
    constructor() {
      setTimeout(() => {
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ weightedPrice: '100000' }) });
      }, 0);
    }
    close() {}
  }
  window.WebSocket = PriceSocket;
  const jsonResponse = (payload) => Promise.resolve(new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  }));
  window.fetch = (input, options) => {
    const raw = String(typeof input === 'string' ? input : input?.url || '');
    const url = new URL(raw, location.href);
    const fixture = window.__netWorthFixture;
    if (url.pathname.endsWith('/daily_fx_rates.csv')) {
      return Promise.resolve(new Response('date,eurusd,jpyusd,gbpusd,xauusd\n2024-01-01,1.25,0.005,1.5,2000\n', {
        status: 200, headers: { 'Content-Type': 'text/csv' }
      }));
    }
    if (url.hostname === 'scanner.tradingview.com') {
      fixture.requests.push({ url: raw, body: options?.body || '' });
      if (fixture.offline) return Promise.reject(new TypeError('fixture market offline'));
      const body = JSON.parse(options?.body || '{}');
      return jsonResponse({ data: (body.symbols?.tickers || [])
        .filter((ticker) => ['MSTR', 'IBIT', 'VOO'].includes(ticker.split(':')[1]))
        .map((ticker) => ({ s: ticker, d: [{ MSTR: 320, IBIT: 50, VOO: 600 }[ticker.split(':')[1]], 'delayed_streaming_900'] })) });
    }
    if (url.hostname === 'quote.cnbc.com' && url.pathname === '/quote-html-webservice/quote.htm') {
      fixture.requests.push({ url: raw });
      if (fixture.offline || fixture.btcfxOffline)
        return Promise.reject(new TypeError('fixture BTCFX feed offline'));
      if (url.searchParams.get('symbols') !== 'BTCFX')
        return Promise.resolve(new Response('{}', { status: 404 }));
      return jsonResponse({ ITVQuoteResult: { ITVQuote: [{
        symbol: 'BTCFX', code: '0', type: 'FUND', currencyCode: 'USD',
        last: '17.89', last_timedate: fixture.btcfxTimestamp,
      }] } });
    }
    if (url.hostname === 'api.coinbase.com' && url.pathname.includes('/prices/')) {
      fixture.requests.push({ url: raw });
      if (fixture.offline) return Promise.reject(new TypeError('fixture market offline'));
      if (url.pathname.includes('/ETH-USD/')) {
        return jsonResponse({ data: { amount: '2500', base: 'ETH', currency: 'USD' } });
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }
    if (url.pathname.endsWith('/daily_price.csv')) return Promise.resolve(new Response('1/1/24,2024-01-01,100000\n'));
    if (url.hostname === '2140data.io') return jsonResponse({ price: 100000 });
    if (url.hostname === 'api.kraken.com') {
      return jsonResponse({ result: { USDCUSD: { a: ['1'] }, XBTUSDC: { a: ['100000'] } } });
    }
    if (url.origin !== location.origin) return Promise.reject(new TypeError('unconfigured fixture URL'));
    return nativeFetch(input, options);
  };
})();
"""


class BrowserChecks:
    def __init__(self, cdp):
        self.cdp = cdp
        self.context_id = None

    def evaluate(self, expression):
        if self.context_id is None:
            return self.cdp.evaluate(expression)
        result = self.cdp.command("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
            "contextId": self.context_id,
        })
        remote = result.get("result", {})
        if remote.get("subtype") == "error":
            raise RuntimeError(remote.get("description") or remote)
        return remote.get("value")

    def check(self, label, source):
        result = self.evaluate("(async () => {\n" + source + "\nreturn '';\n})()")
        if result:
            raise AssertionError(f"{label}: {result}")

    def ready(self):
        wait_for(lambda: self.evaluate("""
          document.querySelector('#netWorthSettingsBtn') &&
          document.querySelector('#assetsRows select') &&
          typeof renderAll === 'function' && serverAvailable && snapshots.length > 0 && formState.btcusd > 0
        """), timeout=65, description="Net Worth dashboard and settings")

    def open_settings(self):
        self.evaluate("""
          if (!document.querySelector('#netWorthSettingsPanel').open) {
            const button = document.querySelector('#netWorthSettingsBtn');
            button.focus();
            button.click();
          }
        """)
        wait_for(lambda: self.evaluate("""
          document.querySelector('#netWorthSettingsPanel').open &&
          document.querySelectorAll('#netWorthUnitOptions input[type=checkbox]').length > 20
        """), description="unit settings options")

    def screenshot(self, filename):
        directory = os.environ.get("NETWORTH_SCREENSHOT_DIR")
        if directory:
            folder = Path(directory).resolve()
            folder.mkdir(parents=True, exist_ok=True)
            data = self.cdp.command("Page.captureScreenshot", {"format": "png"})["data"]
            (folder / filename).write_bytes(base64.b64decode(data))


def check_settings(browser):
    browser.open_settings()
    browser.check("fresh defaults and categories", r"""
      const checked = [...document.querySelectorAll('#netWorthUnitOptions input:checked')]
        .map(input => input.value).sort();
      if (JSON.stringify(checked) !== JSON.stringify(['BTC', 'USD', 'sats']))
        return `unexpected default units: ${checked}`;
      for (const code of ['EUR', 'GBP', 'JPY', 'ETH', 'SOL', 'MSTR', 'COIN', 'MARA', 'SPY', 'VOO', 'QQQ', 'IBIT', 'FBTC', 'BTCFX']) {
        if (!document.querySelector(`#netWorthUnitOptions input[value="${code}"]`))
          return `missing catalog unit ${code}`;
      }
      const allowed = new Set(['USD', 'BTC', 'sats']);
      for (const select of document.querySelectorAll('#primaryUoaSelect, #secondaryUoaSelect, #assetsRows select, #liabilitiesRows select')) {
        if ([...select.options].some(option => !allowed.has(option.value)))
          return `unselected unit leaked into ${select.id || 'row dropdown'}`;
      }
    """)
    browser.check("settings search", r"""
      const input = document.querySelector('#netWorthUnitSearch');
      input.value = 'mstr';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const visible = [...document.querySelectorAll('#netWorthUnitOptions input[type=checkbox]')]
        .filter(input => input.getClientRects().length).map(input => input.value);
      if (JSON.stringify(visible) !== JSON.stringify(['MSTR']))
        return `search did not narrow to MSTR: ${visible}`;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      for (const code of ['EUR', 'ETH', 'MSTR']) {
        document.querySelector(`#netWorthUnitOptions input[value="${code}"]`).click();
      }
      const expected = new Set(['USD', 'BTC', 'sats', 'EUR', 'ETH', 'MSTR']);
      for (const select of document.querySelectorAll('#primaryUoaSelect, #assetsRows select, #liabilitiesRows select')) {
        const values = [...select.options].map(option => option.value);
        if (values.length !== expected.size || values.some(value => !expected.has(value)))
          return `enabled units missing from ${select.id || 'row dropdown'}: ${values}`;
      }
    """)
    browser.screenshot("networth-settings-desktop.png")
    browser.evaluate("document.querySelector('#netWorthUnitSearch').focus()")
    browser.cdp.command("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    browser.cdp.command("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    browser.check("Escape and return focus", r"""
      if (document.querySelector('#netWorthSettingsPanel').open)
        return 'Escape did not close settings';
      if (document.activeElement.id !== 'netWorthSettingsBtn')
        return `focus went to ${document.activeElement.id || document.activeElement.tagName}`;
    """)
    browser.check("visible UoA options", r"""
      document.querySelector('#primaryUoaDropdownTrigger').click();
      const options = [...document.querySelectorAll('#primaryUoaDropdownMenu [data-value]')]
        .map(option => option.dataset.value).sort();
      if (JSON.stringify(options) !== JSON.stringify(['BTC', 'ETH', 'EUR', 'MSTR', 'USD', 'sats']))
        return `custom dropdown differs from settings: ${options}`;
      document.querySelector('#primaryUoaValue').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true
      }));
    """)


def check_holdings(browser):
    # Replace only this isolated profile's demo state with named synthetic rows.
    browser.evaluate("""
      currentMode = 'live';
      liveAccessLocked = false;
      liveHistoryFile = 'networth-unit-test.csv';
      editingSnapshotDate = mmddyy(new Date());
      snapshots = [];
      formState = { ...freshFormState('live'), btcusd: 100000, assets: [], liabilities: [] };
      localStorage.setItem(MODE_KEY, 'live');
      localStorage.setItem(LIVE_HISTORY_FILE_KEY, liveHistoryFile);
      saveForm();
      saveSnapshots();
      renderAll();
      document.querySelector('[data-target="assetsRows"]').click();
      const unit = document.querySelector('#assetsRows select');
      unit.value = 'MSTR';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
    """)
    wait_for(lambda: browser.evaluate("""
      formState.assets[0]?.unit === 'MSTR' &&
      usdPerUnit('MSTR', 100000, mmddyy(new Date())) === 320
    """), description="MSTR unit and fixture share quote")
    browser.check("fractional MSTR shares", r"""
      let name = document.querySelector('#assetsRows input[data-field=name]');
      name.value = 'Strategy shares fixture';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      let amount = document.querySelector('#assetsRows input[data-field=amount]');
      amount.value = '12.5';
      amount.dispatchEvent(new Event('input', { bubbles: true }));
      amount.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      if (formState.assets[0]?.unit !== 'MSTR' || Number(formState.assets[0]?.amount) !== 12.5)
        return 'share count or unit was converted while entering it';
      const total = computeTotals([{ name: 'shares', value: 12.5, unit: 'MSTR' }], [], 100000, mmddyy(new Date()));
      if (total.assets_usd !== 4000 || total.assets_btc !== 0.04)
        return `incorrect share valuation: ${JSON.stringify(total)}`;
      if (!document.querySelector('#assetsMetricUsd').textContent.includes('4,000.00'))
        return `USD KPI did not show share value: ${document.querySelector('#assetsMetricUsd').textContent}`;
    """)
    browser.open_settings()
    browser.check("hiding used units preserves shares", r"""
      const before = JSON.stringify(formState.assets);
      document.querySelector('#netWorthUnitOptions input[value=MSTR]').click();
      document.querySelector('#netWorthSettingsClose').click();
      if (JSON.stringify(formState.assets) !== before) return 'hiding MSTR modified holdings';
      if (document.querySelector('#assetsRows select').value !== 'MSTR') return 'MSTR row lost its selected unit';
      if ([...document.querySelector('#primaryUoaSelect').options].some(option => option.value === 'MSTR'))
        return 'hidden MSTR still offered as a new UoA';
      document.querySelector('[data-target="assetsRows"]').click();
      const selects = [...document.querySelectorAll('#assetsRows select')];
      if ([...selects[0].options].some(option => option.value === 'MSTR'))
        return 'hidden MSTR was offered in a new row';
      if (selects[1].value !== 'MSTR') return 'existing MSTR row was changed by new-row creation';
      document.querySelector('#assetsRows .remove-btn').click();
    """)
    browser.check("CSV preserves quantities and stored valuation", r"""
      const original = normalizedSnapshot(100000);
      if (Number(original.unit_prices?.MSTR) !== 320) return 'snapshot did not capture the MSTR quote';
      if (usdPerUnit('MSTR', 100000, '010124') !== null)
        return 'a current share quote was applied to an unsaved historical date';
      original.date = '010124';
      const csv = snapshotsToCsv([original]);
      const restored = parseLiveHistoryCsv(csv);
      if (restored.length !== 1) return 'CSV roundtrip lost the snapshot';
      const asset = restored[0].assets[0];
      if (asset?.unit !== 'MSTR' || Number(asset?.value) !== 12.5)
        return `CSV roundtrip changed shares: ${JSON.stringify(asset)}`;
      if (Number(restored[0].btcusd) !== 100000)
        return 'CSV did not retain the recorded BTC/USD rate';
      if (Number(restored[0].unit_prices?.MSTR) !== 320)
        return 'CSV did not retain the recorded MSTR quote';
      if (Number(restored[0].totals?.assets_usd) !== 4000)
        return 'CSV roundtrip changed the stored valuation';
      const encrypted = await encryptText(csv, 'synthetic-browser-test-password');
      if (encrypted.includes('Strategy shares fixture')) return 'encrypted export contains plaintext holdings';
      const decrypted = await decryptText(encrypted, 'synthetic-browser-test-password');
      const unsealed = parseLiveHistoryCsv(decrypted);
      if (JSON.stringify(unsealed) !== JSON.stringify(restored))
        return 'encrypted export changed share quantities or recorded prices';
    """)



def check_etfs(browser):
    browser.open_settings()
    browser.check("ETF selection and fractional share valuation", r"""
      const search = document.querySelector('#netWorthUnitSearch');
      search.value = 'etf';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      if (!document.querySelector('#netWorthUnitOptions input[value=IBIT]') ||
          !document.querySelector('#netWorthUnitOptions input[value=VOO]') ||
          document.querySelector('#netWorthUnitOptions input[value=MSTR]'))
        return 'ETF search did not show the fund category';
      for (const code of ['IBIT', 'VOO']) document.querySelector(`#netWorthUnitOptions input[value="${code}"]`).click();
      for (const code of ['IBIT', 'VOO']) {
        if (![...document.querySelector('#primaryUoaSelect').options].some(option => option.value === code) ||
            ![...document.querySelector('#assetsRows select').options].some(option => option.value === code))
          return `enabled ETF ${code} missing from dropdowns`;
      }
      document.querySelector('#netWorthSettingsClose').click();
      networthMarketFeed.setActiveCodes(['IBIT', 'VOO']);
      await networthMarketFeed.refresh();
      const assets = [{ name: 'Bitcoin ETF fixture', value: 12.5, unit: 'IBIT' },
        { name: 'Index ETF fixture', value: 2.5, unit: 'VOO' }];
      const totals = computeTotals(assets, [], 100000, mmddyy(new Date()));
      if (!totals.complete || totals.assets_usd !== 2125)
        return `ETF shares valued incorrectly: ${JSON.stringify(totals)}`;
      setUnitEnabled('IBIT', false);
      setUnitEnabled('VOO', false);
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    """)


def check_btcfx(browser):
    browser.open_settings()
    browser.check("BTCFX daily NAV, retention, and manual override", r"""
      const prior = { form: formState, snapshots, date: editingSnapshotDate,
        enabled: enabledUnitCodes.has('BTCFX'), prompt: window.prompt };
      const fixture = window.__netWorthFixture;
      networthMarketFeed.stop();
      try {
        const search = document.querySelector('#netWorthUnitSearch');
        search.value = 'btcfx';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const choice = document.querySelector('#netWorthUnitOptions input[value=BTCFX]');
        if (!choice || !choice.getClientRects().length) return 'BTCFX cannot be found in settings';
        if (!choice.checked) choice.click();
        if (![...document.querySelector('#primaryUoaSelect').options].some(option => option.value === 'BTCFX'))
          return 'enabled BTCFX missing from valuation dropdown';
        document.querySelector('#netWorthSettingsClose').click();

        const today = mmddyy(new Date());
        editingSnapshotDate = today;
        snapshots = [];
        formState = { ...freshFormState('live'), btcusd: 100000,
          assets: [{ name: 'Bitcoin mutual fund fixture', amount: 12.5, unit: 'USD' }], liabilities: [] };
        renderAll();
        const unit = document.querySelector('#assetsRows select');
        unit.value = 'BTCFX';
        unit.dispatchEvent(new Event('change', { bubbles: true }));
        await networthMarketFeed.refresh();
        renderAll();
        if (formState.assets[0]?.unit !== 'BTCFX' || Number(formState.assets[0]?.amount) !== 12.5)
          return 'selecting BTCFX changed the fractional share quantity';
        const assets = [{ name: 'Bitcoin mutual fund fixture', value: 12.5, unit: 'BTCFX' }];
        const total = computeTotals(assets, [], 100000, today);
        if (!total.complete || Math.abs(total.assets_usd - 223.625) > 1e-9)
          return `BTCFX fractional shares valued incorrectly: ${JSON.stringify(total)}`;
        if (!document.querySelector('#assetsMetricUsd').textContent.includes('223.63'))
          return 'BTCFX NAV valuation did not reach the displayed total';
        const status = () => document.querySelector('#marketQuoteStatus').textContent;
        if (!status().includes(`Daily NAV as of ${fixture.btcfxDay}`) || !status().includes('CNBC'))
          return `BTCFX price status lost its NAV date or source: ${status()}`;
        if (!fixture.requests.some(request => request.url.includes('quote.cnbc.com/') &&
            new URL(request.url).searchParams.get('symbols') === 'BTCFX'))
          return 'BTCFX did not use the public NAV feed';
        if (usdPerUnit('BTCFX', 100000, '010124') !== null ||
            computeTotals(assets, [], 100000, '010124').complete !== false)
          return 'current BTCFX NAV leaked into an unsaved historical date';

        fixture.btcfxOffline = true;
        await networthMarketFeed.refresh();
        renderAll();
        if (usdPerUnit('BTCFX', 100000, today) !== 17.89 || !status().includes('retained'))
          return `BTCFX outage did not retain and label the last NAV: ${status()}`;
        if (!status().includes(`Daily NAV as of ${fixture.btcfxDay}`))
          return 'retained BTCFX NAV lost its actual pricing date';

        window.prompt = () => '20';
        const setPrice = [...document.querySelectorAll('#marketQuoteStatus button')]
          .find(button => button.textContent === 'Set a price');
        if (!setPrice) return 'BTCFX manual price control is missing';
        setPrice.click();
        fixture.btcfxOffline = false;
        await networthMarketFeed.refresh();
        renderAll();
        if (usdPerUnit('BTCFX', 100000, today) !== 20 ||
            computeTotals(assets, [], 100000, today).assets_usd !== 250 ||
            !status().includes('Manual price'))
          return `automatic BTCFX NAV replaced the manual price: ${status()}`;
      } finally {
        // Let the standalone unit selector finish focusing its amount field,
        // then leave the editor before restoring the previous test state.
        await new Promise(resolve => setTimeout(resolve, 0));
        document.activeElement?.blur();
        await new Promise(resolve => setTimeout(resolve, 0));
        fixture.btcfxOffline = false;
        window.prompt = prior.prompt;
        formState = prior.form;
        snapshots = prior.snapshots;
        editingSnapshotDate = prior.date;
        setUnitEnabled('BTCFX', prior.enabled);
        const search = document.querySelector('#netWorthUnitSearch');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#netWorthSettingsClose').click();
        saveForm();
        await saveLiveSnapshotsToServer();
        networthMarketFeed.start();
        renderAll();
      }
    """)


def check_existing_conversions(browser):
    browser.check("fiat and sats conversions", r"""
      await ensureFxRatesLoaded();
      if (convertAmountBetweenUnits(8, 'EUR', 'USD', 100000, '010124') !== 10 ||
          convertAmountBetweenUnits(10, 'USD', 'EUR', 100000, '010124') !== 8)
        return 'existing EUR/USD amount conversions changed';
      if (convertAmountBetweenUnits(1, 'BTC', 'sats', 100000, '010124') !== 100000000 ||
          convertAmountBetweenUnits(100000000, 'sats', 'BTC', 100000, '010124') !== 1 ||
          usdToUnitValue(100000, 'sats', 100000, '010124') !== 100000000)
        return 'BTC/sats conversion changed';
      const primary = document.querySelector('#primaryUoaSelect');
      const original = primary.value;
      primary.value = 'sats';
      primary.dispatchEvent(new Event('change', { bubbles: true }));
      if (uoaSelections.primary !== 'sats' || document.querySelector('#primaryUoaValue').value !== 'sats')
        return 'sats could not be selected as the primary unit';
      if ([...document.querySelector('#secondaryUoaSelect').options].some(option => option.value === 'sats'))
        return 'primary sats was also offered as secondary unit';
      primary.value = original;
      primary.dispatchEvent(new Event('change', { bubbles: true }));
    """)


def check_dated_crypto_prices(browser):
    browser.check("pending dated crypto quote does not freeze an earlier saved price", r"""
      const prior = { form: formState, snapshots, date: editingSnapshotDate };
      networthMarketFeed.stop();
      try {
        editingSnapshotDate = '010224';
        formState = { ...freshFormState('live'), btcusd: 100000,
          assets: [{ name: 'Dated ether fixture', amount: 2, unit: 'ETH' }], liabilities: [] };
        snapshots = [{ date: '010124', timestamp: '2024-01-01T00:00:00Z', btcusd: 100000,
          assets: [{ name: 'Dated ether fixture', value: 2, unit: 'ETH' }], liabilities: [],
          unit_prices: { ETH: 100 } }];
        networthMarketFeed.setActiveCodes(['ETH']);
        if (Object.hasOwn(captureUnitPrices('010224'), 'ETH'))
          return 'earlier saved ETH fallback was captured as a new dated price';
        await networthMarketFeed.refresh({ isoDate: '2024-01-02' });
        if (captureUnitPrices('010224').ETH !== 2500)
          return 'dated ETH quote was not captured after its request completed';
        if (!window.__netWorthFixture.requests.some(request => request.url.includes('ETH-USD/spot?date=2024-01-02')))
          return 'historical ETH valuation did not request the selected date';
      } finally {
        formState = prior.form;
        snapshots = prior.snapshots;
        editingSnapshotDate = prior.date;
        networthMarketFeed.start();
        renderAll();
      }
    """)


def check_mobile(browser):
    browser.cdp.command("Emulation.setDeviceMetricsOverride", {
        "width": 390, "height": 844, "deviceScaleFactor": 1, "mobile": True,
    })
    browser.open_settings()
    for theme in ("dark", "light"):
        browser.evaluate(f"""
          setTheme({json.dumps(theme)});
        """)
        browser.check(f"mobile {theme} settings bounds", """
          const panel = document.querySelector('#netWorthSettingsPanel');
          const box = panel.getBoundingClientRect();
          const viewportWidth = visualViewport?.width ?? innerWidth;
          const viewportHeight = visualViewport?.height ?? innerHeight;
          if (box.left < -1 || box.right > viewportWidth + 1 || box.top < -1 || box.bottom > viewportHeight + 1)
            return `panel overflow: ${JSON.stringify(box.toJSON())}, viewport=${viewportWidth}x${viewportHeight}`;
          if (box.width < 250 || box.height < 150) return 'settings panel collapsed';
          const close = document.querySelector('#netWorthSettingsClose').getBoundingClientRect();
          if (close.bottom > viewportHeight || close.right > viewportWidth) return 'close button outside viewport';
        """)
        browser.screenshot(f"networth-settings-mobile-{theme}.png")
    browser.evaluate("document.querySelector('#netWorthSettingsClose').click()")
    browser.cdp.command("Emulation.setDeviceMetricsOverride", {
        "width": 1280, "height": 1000, "deviceScaleFactor": 1, "mobile": False,
    })


def check_top_panel_layout(browser):
    # Change only this isolated profile's presentation state; no file is loaded
    # or saved while exercising mode-dependent controls and long filenames.
    browser.evaluate("""
      window.__layoutPrior = { mode: currentMode, file: liveHistoryFile,
        locked: liveAccessLocked, theme: currentTheme };
      document.activeElement?.blur();
    """)
    try:
        for mode in ("demo", "live"):
            browser.evaluate(f"""
              currentMode = {json.dumps(mode)};
              liveHistoryFile = 'A-long-synthetic-history-filename-for-responsive-layout.csv';
              liveAccessLocked = false;
              updateModeToggleUI();
            """)
            for width in (320, 390, 533, 768, 980, 981, 1024, 1280, 1920):
                browser.cdp.command("Emulation.setDeviceMetricsOverride", {
                    "width": width, "height": 1000, "deviceScaleFactor": 1,
                    "mobile": width <= 768,
                })
                browser.cdp.command("Emulation.setPageScaleFactor", {"pageScaleFactor": 1})
                for theme in ("dark", "light"):
                    browser.evaluate(f"""
                      currentTheme = {json.dumps(theme)};
                      applyTheme();
                      window.scrollTo(0, 0);
                      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    """)
                    actual_width = browser.evaluate("document.documentElement.clientWidth")
                    if actual_width != width:
                        raise AssertionError(f"expected {width}px viewport, got {actual_width}px")
                    if (width, mode, theme) in ((533, "demo", "dark"), (320, "live", "dark"), (1280, "live", "light")):
                        browser.screenshot(f"networth-top-panel-{width}-{mode}-{theme}.png")
                    browser.check(f"top panel {width}px {mode} {theme}", """
                      const panel = document.querySelector('.title-panel').getBoundingClientRect();
                      if (panel.left < -1 || panel.right > document.documentElement.clientWidth + 1 || panel.top < -1)
                        return `panel outside viewport: ${JSON.stringify(panel.toJSON())}`;
                      const nodes = [...document.querySelectorAll(`.title-panel h1, .title-panel .info-wrap,
                        .title-panel .filters-menu-wrap, .history-action-buttons, .theme-toggle,
                        .mode-toggle, .live-file-wrap, .encryption-toggle-wrap, .uoa-filter-chip`)]
                        .filter(node => node.getClientRects().length)
                        .map(node => ({ name: node.id || node.className || node.tagName,
                          box: node.getBoundingClientRect() }));
                      for (const { name, box } of nodes) {
                        if (box.left < panel.left - 1 || box.right > panel.right + 1 ||
                            box.top < panel.top - 1 || box.bottom > panel.bottom + 1)
                          return `${name} outside panel: ${JSON.stringify(box.toJSON())}; panel=${JSON.stringify(panel.toJSON())}`;
                      }
                      const overlaps = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
                      for (let i = 0; i < nodes.length; i++) {
                        for (let j = i + 1; j < nodes.length; j++) {
                          if (overlaps(nodes[i].box, nodes[j].box))
                            return `${nodes[i].name} overlaps ${nodes[j].name}`;
                        }
                      }
                      const quote = document.querySelector('.price-card').getBoundingClientRect();
                      if (overlaps(panel, quote)) return 'title panel overlaps the exchange-rate card';
                    """)
                    if width == 533 and theme == "dark":
                        check_uoa_menu_layout(browser)
    finally:
        browser.evaluate("""
          currentMode = window.__layoutPrior.mode;
          liveHistoryFile = window.__layoutPrior.file;
          liveAccessLocked = window.__layoutPrior.locked;
          currentTheme = window.__layoutPrior.theme;
          applyTheme();
          delete window.__layoutPrior;
          updateModeToggleUI();
        """)
        browser.cdp.command("Emulation.setDeviceMetricsOverride", {
            "width": 1280, "height": 1000, "deviceScaleFactor": 1, "mobile": False,
        })


def check_uoa_menu_layout(browser):
    for kind in ("primary", "secondary"):
        browser.evaluate(f"document.querySelector('#{kind}UoaDropdownTrigger').click()")
        for width in (533, 320, 533):
            browser.cdp.command("Emulation.setDeviceMetricsOverride", {
                "width": width, "height": 1000, "deviceScaleFactor": 1, "mobile": True,
            })
            browser.cdp.command("Emulation.setPageScaleFactor", {"pageScaleFactor": 1})
            browser.check(f"{kind} UoA menu after resize to {width}px", f"""
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const dropdown = document.querySelector('#{kind}UoaDropdown');
              const box = document.querySelector('#{kind}UoaDropdownMenu').getBoundingClientRect();
              if (dropdown.getAttribute('aria-expanded') !== 'true' || box.width < 100)
                return 'menu did not stay open';
              if (box.left < -1 || box.right > document.documentElement.clientWidth + 1)
                return `menu outside viewport: ${{JSON.stringify(box.toJSON())}}`;
            """)
        browser.check(f"{kind} UoA menu closes with Escape", f"""
          const input = document.querySelector('#{kind}UoaValue');
          input.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Escape', bubbles: true }}));
          input.blur();
          if (document.querySelector('#{kind}UoaDropdown').getAttribute('aria-expanded') !== 'false')
            return 'Escape left the menu open';
        """)



def check_missing_prices(browser):
    browser.check("unavailable quotes never become zero-valued holdings", r"""
      formState.assets = [{ name: 'Unpriced exchange fixture', amount: 5, unit: 'COIN' }];
      formState.liabilities = [];
      snapshots = [];
      renderAll();
      await networthMarketFeed.refresh();
      renderAll();
      const total = computeTotals([{ name: 'unpriced', value: 5, unit: 'COIN' }], [], 100000, mmddyy(new Date()));
      if (total.complete !== false || Number.isFinite(total.assets_usd))
        return `missing quote was treated as a valued holding: ${JSON.stringify(total)}`;
      if (document.querySelector('#assetsMetric').textContent.trim() !== '—' ||
          document.querySelector('#assetsMetricUsd').textContent.trim() !== '—')
        return 'unpriced asset displayed a numeric aggregate';
      const status = document.querySelector('#marketQuoteStatus');
      if (status.hidden || !status.textContent.includes('COIN'))
        return 'missing COIN quote was not explained to the user';
    """)



def check_categories(browser):
    browser.open_settings()
    browser.check("category collapse, count, and search", r"""
      const heading = () => [...document.querySelectorAll('.networth-unit-category-toggle')]
        .find(button => button.textContent.startsWith('Currencies'));
      if (heading().textContent !== 'Currencies (2)') return 'selected currency count incorrect';
      const button = heading();
      button.click();
      if (button.getAttribute('aria-expanded') !== 'false' || !document.querySelector('#netWorthUnitGroup-fiat').hidden)
        return 'category did not collapse';
      button.click();
      if (button.getAttribute('aria-expanded') !== 'true') return 'category did not expand';
      const search = document.querySelector('#netWorthUnitSearch');
      search.value = 'USD';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      if (heading().textContent !== 'Currencies (2)') return 'search changed whole-category selected count';
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#netWorthSettingsClose').click();
    """)


def check_file_api(browser):
    browser.check("native file API preserves encrypted shares and prices", r"""
      const snap = { date: '010124', btcusd: 100000, timestamp: '2024-01-01T00:00:00Z',
        assets: [{ name: 'Local file fixture', value: 12.5, unit: 'MSTR' }],
        liabilities: [], comments: 'synthetic fixture', unit_prices: { MSTR: 320 } };
      const csv = snapshotsToCsv([snap]);
      const password = 'synthetic-file-api-test-password';
      const encrypted = await encryptText(csv, password);
      if (!await writeLiveHistoryFile(encrypted, true, { strict: true, filename: 'api-fixture.enc' }))
        return 'native encrypted file write failed';
      const raw = await fetchLiveHistoryFile('api-fixture.enc');
      if (raw.includes('Local file fixture')) return 'server returned plaintext encrypted holding';
      const restored = parseLiveHistoryCsv(await decryptText(raw, password));
      if (restored[0]?.assets[0]?.value !== 12.5 || restored[0]?.assets[0]?.unit !== 'MSTR'
          || restored[0]?.unit_prices?.MSTR !== 320 || restored[0]?.totals?.assets_usd !== 4000)
        return 'native encrypted file API lost shares or dated price';
      if (!(await fetchAvailableLiveFiles()).includes('api-fixture.enc')) return 'saved file missing from native menu';
    """)



def check_historical_filters(browser):
    browser.check("historical shares keep dated prices through filters and manual chart mode", r"""
      const prior = { form: formState, snapshots, date: editingSnapshotDate, historicalPrices };
      networthMarketFeed.stop();
      try {
        editingSnapshotDate = '010124';
        formState = { ...freshFormState('live'), btcusd: 100000, useManualBtcusd: true, manualBtcusd: 100000,
          assets: [{ name: 'Historical MSTR', amount: 10, unit: 'MSTR' },
            { name: 'Cash', amount: 50, unit: 'USD' }], liabilities: [] };
        snapshots = [{ date: '010124', btcusd: 100000,
          assets: [{ name: 'Historical MSTR', value: 10, unit: 'MSTR' }, { name: 'Cash', value: 50, unit: 'USD' }],
          liabilities: [], unit_prices: { MSTR: 100 } }];
        const snap = normalizedSnapshot(100000);
        if (snap.date !== '010124' || snap.totals.assets_usd !== 1050) return 'historical snapshot lost its date or price';
        const filtered = applyExclusionFilters(snap, new Set(['Cash']), new Set());
        if (filtered.totals.assets_usd !== 1000) return 'filter used current share price for historical holdings';
        historicalPrices = {};
        const chart = snapshotsForCharts(100000, new Set(), new Set());
        if (new Set(chart.map(snap => snap.date)).size !== chart.length)
          return 'manual mode replaced today with a duplicate historical snapshot';
        const today = mmddyy(new Date());
        snapshots.push({ date: today, btcusd: 100000,
          assets: [{ name: 'Current MSTR', value: 5, unit: 'MSTR' }], liabilities: [], unit_prices: { MSTR: 320 } });
        historicalPrices = { '010124': 100000, [today]: 100000 };
        const denseToday = snapshotsForCharts(100000, new Set(), new Set()).find(snap => snap.date === today);
        if (denseToday?.totals?.assets_usd !== 1600)
          return 'editing history replaced current chart holdings under manual pricing';
      } finally {
        formState = prior.form; snapshots = prior.snapshots; editingSnapshotDate = prior.date;
        historicalPrices = prior.historicalPrices;
        networthMarketFeed.start();
        renderAll();
      }
    """)


def check_manual_bitcoin_estimates(browser):
    browser.check("manual BTC price estimates stay proportional and separate from saved prices", r"""
      const prior = { state: trackedStateSnapshot(), prices: historicalPrices,
        enabled: new Set(enabledUnitCodes), undo: undoStack, redo: redoStack, log: actionLog,
        edited: manualEditedThisSession, prompt: window.prompt };
      const closeTo = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) < 1e-8;
      const settleEditor = async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        document.activeElement?.blur();
        await new Promise(resolve => setTimeout(resolve, 0));
        syncEditorRowsFocusedFromDom();
      };
      const enterBitcoinPrice = async (price) => {
        const input = document.querySelector('#manualBtcusd');
        input.focus();
        input.value = String(price);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settleEditor();
        renderAll();
      };
      networthMarketFeed.stop();
      try {
        await settleEditor();
        const today = mmddyy(new Date());
        const todayIso = mmddyyToIsoOrToday(today);
        const past = new Date();
        past.setDate(past.getDate() - 1);
        const yesterday = mmddyy(past);
        editingSnapshotDate = today;
        excludedAssets = new Set();
        excludedLiabilities = new Set();
        uoaSelections = { primary: 'BTC', secondary: 'USD' };
        enabledUnitCodes = new Set([...prior.enabled, 'MSTR', 'BTCFX', 'IBIT', 'VOO']);
        formState = { ...freshFormState('live'), btcusd: 100000,
          unit_prices: { [todayIso]: { COIN: 200, MARA: 15, XYZ: 70, HOOD: 25 } },
          assets: [
            { name: 'Strategy estimate fixture', amount: 2.5, unit: 'MSTR' },
            { name: 'Mutual fund estimate fixture', amount: 10, unit: 'BTCFX' },
            { name: 'Bitcoin ETF estimate fixture', amount: 4, unit: 'IBIT' },
            { name: 'Index ETF unchanged fixture', amount: 1, unit: 'VOO' },
            { name: 'Exchange unchanged fixture', amount: 1, unit: 'COIN' },
            { name: 'Miner unchanged fixture', amount: 1, unit: 'MARA' },
            { name: 'Block unchanged fixture', amount: 1, unit: 'XYZ' },
            { name: 'Broker unchanged fixture', amount: 1, unit: 'HOOD' },
            { name: 'Cash unchanged fixture', amount: 100, unit: 'USD' },
          ], liabilities: [{ name: 'Share liability fixture', amount: 0.5, unit: 'MSTR' }] };
        snapshots = [{ date: yesterday, btcusd: 100000,
          assets: [{ name: 'Historical shares fixture', value: 10, unit: 'MSTR' }],
          liabilities: [], unit_prices: { MSTR: 100 } }];
        historicalPrices = { [yesterday]: 100000, [today]: 100000 };
        renderAll();
        await networthMarketFeed.refresh();
        renderAll();
        const originalHoldings = JSON.stringify([formState.assets, formState.liabilities]);
        const rawPrices = captureUnitPrices(today);
        if (rawPrices.MSTR !== 320 || rawPrices.BTCFX !== 17.89 || rawPrices.IBIT !== 50 || rawPrices.VOO !== 600)
          return `estimate baseline quotes are missing: ${JSON.stringify(rawPrices)}`;
        undoStack = []; redoStack = []; actionLog = [];
        updateUndoRedoButtons();

        await enterBitcoinPrice(120000);
        const up = getDisplaySnapshot();
        for (const [code, expected] of Object.entries({ MSTR: 384, BTCFX: 21.468, IBIT: 60 })) {
          if (!closeTo(up.valuation_prices?.[code], expected))
            return `120k BTC estimate for ${code} is ${up.valuation_prices?.[code]}, expected ${expected}`;
        }
        for (const [code, expected] of Object.entries({ VOO: 600, COIN: 200, MARA: 15, XYZ: 70, HOOD: 25 })) {
          const row = { amount: 1, unit: code };
          if (!closeTo(rowValueInUsd(row, up.btcusd, today, up.valuation_prices), expected))
            return `${code} incorrectly changed with the manual BTC price`;
        }
        if (!closeTo(up.totals.assets_usd, 2424.68) || !closeTo(up.totals.liabilities_usd, 192))
          return `upward estimate totals are wrong: ${JSON.stringify(up.totals)}`;
        if (!document.querySelector('#assetsMetricUsd').textContent.includes('2,424.68'))
          return 'estimated asset total did not reach the USD KPI';
        const status = document.querySelector('#marketQuoteStatus').textContent;
        if (!/estimated/i.test(status) || !/BTC \+20%/.test(status) || !/manual/i.test(el.quoteTime.textContent))
          return `estimated share values are not identified: ${status}`;
        const strategySlice = metricPieChartState.assets.slices.find(slice => slice.name === 'Strategy estimate fixture');
        const liabilitySlice = metricPieChartState.liabilities.slices.find(slice => slice.name === 'Share liability fixture');
        if (!closeTo(strategySlice?.value, 960 / 120000) || !closeTo(liabilitySlice?.value, 192 / 120000))
          return 'asset or liability pie used raw prices while totals used estimates';
        const filtered = applyExclusionFilters(up, new Set(['Cash unchanged fixture']), new Set());
        if (!closeTo(filtered.totals.assets_usd, 2324.68))
          return 'filtering discarded or reapplied the proportional estimate';
        if (!closeTo(usdToUnitValue(384, 'MSTR', 120000, today, up.valuation_prices), 1))
          return 'share-denominated conversion did not use the estimated share price';

        document.querySelector('#undoBtn').click();
        if (isManualOverrideActive() || !closeTo(getDisplaySnapshot().totals.assets_usd, 2188.9))
          return 'one undo did not restore automatic share valuations after Enter and blur';
        document.querySelector('#redoBtn').click();
        if (!closeTo(getDisplaySnapshot().totals.assets_usd, 2424.68))
          return 'redo did not restore the proportional estimate';
        await enterBitcoinPrice(80000);
        const down = getDisplaySnapshot();
        if (!closeTo(down.valuation_prices?.MSTR, 256) || !closeTo(down.valuation_prices?.BTCFX, 14.312) ||
            !closeTo(down.valuation_prices?.IBIT, 40) || !closeTo(down.totals.assets_usd, 1953.12))
          return `lower manual BTC price compounded an earlier estimate: ${JSON.stringify(down.totals)}`;
        await enterBitcoinPrice(120000);
        await enterBitcoinPrice(120000);
        if (!closeTo(getDisplaySnapshot().totals.assets_usd, 2424.68))
          return 'repeating a manual BTC price compounded the share estimates';
        if (JSON.stringify([formState.assets, formState.liabilities]) !== originalHoldings)
          return 'manual BTC estimate modified share quantities';

        formState.unit_prices[todayIso].BTCFX = 20;
        const manualBase = getDisplaySnapshot();
        if (!closeTo(manualBase.valuation_prices?.BTCFX, 24) ||
            marketUsdPrice('BTCFX', todayIso) !== 20 || captureUnitPrices(today).BTCFX !== 20)
          return 'a manual share price was not used as the unmodified base for the estimate';
        delete formState.unit_prices[todayIso].BTCFX;
        formState.btcusd = 0;
        const missingBaseline = getDisplaySnapshot();
        if (!closeTo(missingBaseline.totals.assets_usd, 2188.9) ||
            !closeTo(missingBaseline.valuation_prices?.MSTR ?? marketUsdPrice('MSTR', todayIso), 320))
          return 'missing automatic BTC price produced an invalid share estimate';
        formState.btcusd = 100000;
        renderAll();

        const primary = document.querySelector('#primaryUoaSelect');
        primary.value = 'MSTR';
        primary.dispatchEvent(new Event('change', { bubbles: true }));
        const expectedShares = formatUoaAmount(2424.68 / 384, 'MSTR');
        if (document.querySelector('#assetsMetric').textContent !== expectedShares)
          return `share UoA used a raw denominator: ${document.querySelector('#assetsMetric').textContent}`;
        primary.value = 'BTC';
        primary.dispatchEvent(new Event('change', { bubbles: true }));

        persistSnapshotForActiveSelection({ render: true, trackAction: false });
        await networthMarketFeed.refresh();
        const saved = snapshots.find(snap => snap.date === today);
        if (!saved || saved.valuation_prices || !closeTo(saved.totals.assets_usd, 2188.9) ||
            saved.unit_prices?.MSTR !== 320 || saved.unit_prices?.BTCFX !== 17.89 || saved.unit_prices?.IBIT !== 50)
          return `autosave persisted estimated prices: ${JSON.stringify(saved)}`;
        if (JSON.stringify(captureUnitPrices(today)) !== JSON.stringify(rawPrices) ||
            networthMarketFeed.getUsdPrice('MSTR', todayIso) !== 320 ||
            marketUsdPrice('BTCFX', todayIso) !== 17.89 || usdPerUnit('IBIT', 120000, today) !== 50)
          return 'estimate mutated a raw feed, saved capture, or ordinary conversion';
        const restored = parseLiveHistoryCsv(snapshotsToCsv(snapshots));
        const restoredToday = restored.find(snap => snap.date === today);
        if (restoredToday?.unit_prices?.MSTR !== 320 || !closeTo(restoredToday?.totals?.assets_usd, 2188.9))
          return 'CSV roundtrip applied or saved the manual BTC estimate';
        for (const prices of [{}, { [yesterday]: 100000, [today]: 100000 }]) {
          historicalPrices = prices;
          const chart = snapshotsForCharts(120000, new Set(), new Set());
          if (!closeTo(chart.find(snap => snap.date === today)?.totals.assets_usd, 2424.68) ||
              !closeTo(chart.find(snap => snap.date === yesterday)?.totals.assets_usd, 1000))
            return 'saved prices were scaled twice or historical chart prices were changed';
        }
        editingSnapshotDate = yesterday;
        formState.assets = [{ name: 'Historical shares fixture', amount: 10, unit: 'MSTR' }];
        formState.liabilities = [];
        const historical = getDisplaySnapshot();
        if (historical.valuation_prices || !closeTo(historical.totals.assets_usd, 1000))
          return 'manual BTC estimate leaked into the historical editor';
        editingSnapshotDate = today;
        [formState.assets, formState.liabilities] = JSON.parse(originalHoldings);
        renderAll();

        document.querySelector('#refreshQuoteBtn').click();
        for (let i = 0; i < 100 && (isManualOverrideActive() || isTrackingAction); i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        renderAll();
        if (isManualOverrideActive() || !closeTo(getDisplaySnapshot().totals.assets_usd, 2188.9))
          return 'Refresh did not restore automatic prices';
        if (/estimated/i.test(document.querySelector('#marketQuoteStatus').textContent))
          return 'estimate status remained after returning to automatic prices';
      } finally {
        await settleEditor();
        window.prompt = prior.prompt;
        enabledUnitCodes = prior.enabled;
        localStorage.setItem(ENABLED_UNITS_KEY, JSON.stringify([...prior.enabled]));
        historicalPrices = prior.prices;
        restoreTrackedState(prior.state);
        await saveLiveSnapshotsToServer();
        undoStack = prior.undo; redoStack = prior.redo; actionLog = prior.log;
        manualEditedThisSession = prior.edited;
        updateUndoRedoButtons();
        networthMarketFeed.start();
        renderAll();
      }
    """)


def check_save_races(browser):
    browser.check("delayed encrypted saves stay on the original file and latest generation", r"""
      const prior = { snapshots, file: liveHistoryFile, password: liveEncryptionPassword,
        encryptText, writeLiveHistoryFile, mode: currentMode, locked: liveAccessLocked };
      const pending = [];
      const writes = [];
      networthMarketFeed.stop();
      try {
        encryptText = (text, password) => new Promise(resolve => pending.push(() => resolve('encrypted:' + text)));
        writeLiveHistoryFile = async (content, encrypted, options) => { writes.push({content, encrypted, file: options?.filename}); return true; };
        currentMode = 'live'; liveAccessLocked = false;
        liveHistoryFile = 'original-fixture.enc'; liveEncryptionPassword = 'synthetic';
        snapshots = [{ date: '010124', btcusd: 100000, assets: [], liabilities: [], comments: 'older' }];
        const older = saveLiveSnapshotsToServer();
        snapshots = [{ ...snapshots[0], comments: 'newer' }];
        const newer = saveLiveSnapshotsToServer();
        liveHistoryFile = 'other-fixture.csv';
        pending[1](); await newer;
        pending[0](); await older;
        if (writes.length !== 1 || writes[0].file !== 'original-fixture.enc' || !writes[0].content.includes('newer'))
          return 'delayed encryption saved stale content or wrote to another file';
        liveHistoryFile = 'variant-fixture.enc';
        const changingEncryption = saveLiveSnapshotsToServer();
        liveHistoryFile = 'variant-fixture.csv';
        pending[2](); await changingEncryption;
        if (writes.length !== 1) return 'delayed save recreated the previous encryption variant';
      } finally {
        snapshots = prior.snapshots; liveHistoryFile = prior.file; liveEncryptionPassword = prior.password;
        encryptText = prior.encryptText; writeLiveHistoryFile = prior.writeLiveHistoryFile;
        currentMode = prior.mode; liveAccessLocked = prior.locked;
        networthMarketFeed.start();
      }
    """)


def main():
    if not Path(CHROME).is_file():
        raise SystemExit(f"Chrome not found at {CHROME}; set CHROME_BIN")
    server_port, debug_port = free_port(), free_port()
    # The real file API operates only inside this disposable copy. Never serve
    # a developer's history_files while tests write synthetic live snapshots.
    runtime = tempfile.TemporaryDirectory(prefix="networth-fixture-root-")
    runtime_root = Path(runtime.name)
    for name in ("app.js", "market_units.js", "index.html", "styles.css"):
        shutil.copyfile(ROOT / name, runtime_root / name)
    (runtime_root / "history_files").mkdir()
    shutil.copyfile(ROOT / "history_files/demo_history.csv", runtime_root / "history_files/demo_history.csv")
    server = ThreadingHTTPServer(("127.0.0.1", server_port),
        lambda *args, **kwargs: Handler(*args, directory=str(runtime_root), **kwargs))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="wsb-networth-units-cdp-") as profile:
        chrome = subprocess.Popen([
            CHROME, "--headless=new", "--disable-gpu", "--remote-allow-origins=*",
            "--window-size=1280,1000", f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={profile}", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for(lambda: urllib.request.urlopen(
                f"http://127.0.0.1:{debug_port}/json/version", timeout=0.5).read(),
                description="Chrome DevTools endpoint")
            target = json.load(urllib.request.urlopen(urllib.request.Request(
                f"http://127.0.0.1:{debug_port}/json/new?about:blank", method="PUT"), timeout=2))
            cdp = CdpSocket(target["webSocketDebuggerUrl"])
            cdp.command("Page.enable")
            cdp.command("Runtime.enable")
            cdp.command("Page.addScriptToEvaluateOnNewDocument", {"source": SHIM})
            dashboard_url = f"http://127.0.0.1:{server_port}/"
            cdp.command("Page.navigate", {"url": dashboard_url})
            browser = BrowserChecks(cdp)
            browser.ready()
            check_top_panel_layout(browser)
            check_settings(browser)
            check_categories(browser)
            check_holdings(browser)
            check_etfs(browser)
            check_btcfx(browser)
            check_existing_conversions(browser)
            check_dated_crypto_prices(browser)
            check_historical_filters(browser)
            check_manual_bitcoin_estimates(browser)
            check_save_races(browser)
            browser.evaluate("saveLiveSnapshotsToServer()")
            cdp.command("Page.navigate", {"url": dashboard_url})
            wait_for(lambda: browser.evaluate("""
              document.querySelector('#assetsRows select')?.value === 'MSTR'
              && typeof enabledUnitCodes !== 'undefined'
            """), description="saved holdings after reload")
            browser.open_settings()
            browser.check("persisted settings and holdings", """
              for (const [code, enabled] of [['EUR', true], ['ETH', true], ['MSTR', false]]) {
                if (document.querySelector(`#netWorthUnitOptions input[value="${code}"]`).checked !== enabled)
                  return `preference lost for ${code}`;
              }
              if (Number(formState.assets[0]?.amount) !== 12.5 || formState.assets[0]?.unit !== 'MSTR')
                return 'reloading changed the retained share holding';
            """)
            check_mobile(browser)
            check_missing_prices(browser)
            check_file_api(browser)
            print("Net Worth unit settings, share quantities, CSV, persistence, and mobile browser regression passed.")
        finally:
            chrome.terminate()
            try:
                chrome.wait(timeout=5)
            except subprocess.TimeoutExpired:
                chrome.kill()
                chrome.wait(timeout=5)
            server.shutdown()
            server.server_close()
            runtime.cleanup()


if __name__ == "__main__":
    main()
