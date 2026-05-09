const KRAKEN_URL = "https://api.kraken.com/0/public/Ticker?pair=USDCUSD,XBTUSDC";
const HIST_PRICE_URL = "https://raw.githubusercontent.com/w-s-bitcoin/wickedsmartbitcoin/main/assets/daily_price.csv";
const LIVE_HISTORY_API = "/api/live-history";
const STORE_KEY_DEMO = "bitcoinNetWorthTrackerSnapshotsDemoV1";
const STORE_KEY_LIVE = "bitcoinNetWorthTrackerSnapshotsLiveV1";
const FORM_KEY_DEMO = "bitcoinNetWorthTrackerFormDemoV1";
const FORM_KEY_LIVE = "bitcoinNetWorthTrackerFormLiveV1";
const STORE_KEY_LIVE_ENC = "bitcoinNetWorthTrackerSnapshotsLiveEncV1";
const FORM_KEY_LIVE_ENC = "bitcoinNetWorthTrackerFormLiveEncV1";
const LIVE_ENCRYPTION_ENABLED_KEY = "bitcoinNetWorthTrackerLiveEncryptionEnabledV1";
const LIVE_HISTORY_FILE_KEY = "bitcoinNetWorthTrackerLiveFileV1";
const LIVE_LAST_VIEWED_FILE_KEY = "bitcoinNetWorthTrackerLastViewedLiveFileV1";
const MODE_KEY = "bitcoinNetWorthTrackerModeV1";
const THEME_KEY = "bitcoinNetWorthTrackerThemeV1";
const BTCUSD_CACHE_KEY = "bitcoinNetWorthTrackerBtcusdCacheV1";
const FILTER_KEY_DEMO = "bitcoinNetWorthTrackerFiltersDemoV1";
const FILTER_KEY_LIVE = "bitcoinNetWorthTrackerFiltersLiveV1";
const AL_CHART_MODE_KEY = "bitcoinNetWorthTrackerAlChartModeV1";
const AL_CHART_AXES_MODE_KEY = "bitcoinNetWorthTrackerAlChartAxesModeV1";
const NET_CHART_AXES_MODE_KEY = "bitcoinNetWorthTrackerNetChartAxesModeV1";
const QUOTE_AUTO_REFRESH_MS = 60_000;
const QUOTE_AUTO_REFRESH_OFFSET_MS = 1_000;
const SERVER_HEARTBEAT_API = "/api/heartbeat";
const SERVER_HEARTBEAT_MS = 20_000;

let serverAvailable = false; // set to true after first successful server probe

// Returns a fresh default formState for the given mode, seeded with the last
// known BTC price so the exchange rate is never lost across resets.
function freshFormState(mode) {
  const base = mode === "demo"
    ? structuredClone(DEFAULT_FORM_DEMO)
    : structuredClone(DEFAULT_FORM_LIVE);
  if (!base.btcusd || base.btcusd === 0) {
    const cached = Number(localStorage.getItem(BTCUSD_CACHE_KEY) || 0);
    if (cached > 0) base.btcusd = cached;
  }
  return base;
}

// Migrate any existing data from the old single keys into mode-specific keys.
// Old data was always demo (demo was the only mode), so migrate into demo keys.
(function migrateOldStore() {
  const OLD_STORE = "bitcoinNetWorthTrackerSnapshotsV1";
  const OLD_FORM  = "bitcoinNetWorthTrackerFormV1";
  const oldSnap = localStorage.getItem(OLD_STORE);
  if (oldSnap && !localStorage.getItem(STORE_KEY_DEMO)) {
    localStorage.setItem(STORE_KEY_DEMO, oldSnap);
    localStorage.removeItem(OLD_STORE);
  }
  const oldForm = localStorage.getItem(OLD_FORM);
  if (oldForm && !localStorage.getItem(FORM_KEY_DEMO)) {
    localStorage.setItem(FORM_KEY_DEMO, oldForm);
    localStorage.removeItem(OLD_FORM);
  }
  // One-time fix: earlier migration incorrectly copied demo data into the live
  // store. Clear it so live starts clean. Guard with a flag so we only do this once.
  const FIX_KEY = "bitcoinNetWorthTrackerLiveMigrationFixV1";
  if (!localStorage.getItem(FIX_KEY)) {
    localStorage.removeItem(STORE_KEY_LIVE);
    localStorage.removeItem(FORM_KEY_LIVE);
    localStorage.setItem(FIX_KEY, "1");
  }
})();

let currentMode = localStorage.getItem(MODE_KEY) || "demo";

const DEFAULT_FORM_DEMO = {
  btcusd: 0,
  manualBtcusd: null,
  useManualBtcusd: false,
  comments: "",
  assets: [
    { name: "bitcoin", amount: 1, unit: "BTC" },
    { name: "cash", amount: 1000, unit: "USD" },
    { name: "stocks", amount: 2000, unit: "USD" },
    { name: "car_value", amount: 5000, unit: "USD" },
    { name: "home_value", amount: 250000, unit: "USD" }
  ],
  liabilities: [
    { name: "credit_card_debt", amount: 2500, unit: "USD" },
    { name: "student_loans", amount: 10000, unit: "USD" },
    { name: "car_loans", amount: 4000, unit: "USD" },
    { name: "mortgage", amount: 220000, unit: "USD" }
  ]
};

const DEFAULT_FORM_LIVE = {
  btcusd: 0,
  manualBtcusd: null,
  useManualBtcusd: false,
  comments: "",
  assets: [],
  liabilities: []
};

const COLORS = [
  "#f7931a", "#2bb5ff", "#39d7a4", "#ef6f6c", "#ffd166",
  "#b48cf0", "#86efac", "#f9a8d4", "#67e8f9", "#fca5a5"
];
const CHART_PAD = { l: 130, r: 22, t: 34, b: 64 };
let currentTheme = localStorage.getItem(THEME_KEY) || "dark";

let formState = loadForm();
let snapshots = loadSnapshots();
let pendingRowFocus = null;
let pendingRowFieldFocus = null;
let manualEditedThisSession = false;
let historicalPrices = {}; // MMDDYY -> USD price, loaded from remote CSV on init
let editingSnapshotDate = mmddyy(new Date());
let hasUnsavedAssetLiabilityChanges = false;
let hoveredSnapshotDate = null;
let hoveredCanvasY = null;
let liveEncryptionEnabled = localStorage.getItem(LIVE_ENCRYPTION_ENABLED_KEY) === "1";
let liveEncryptionPassword = null; // session-only, never persisted
let liveHistoryFile = localStorage.getItem(LIVE_HISTORY_FILE_KEY)
  || localStorage.getItem(LIVE_LAST_VIEWED_FILE_KEY)
  || "my_history.csv";
let liveAccessLocked = false;
const liveFilePasswords = new Map(); // filename -> password (session-only)
let chartRange = { startDate: null, endDate: null };
let excludedAssets = new Set();
let excludedLiabilities = new Set();

function filterKeyForMode(mode) {
  return mode === "live" ? FILTER_KEY_LIVE : FILTER_KEY_DEMO;
}

function persistLiveFileSelection(file, { setCurrent = true } = {}) {
  const normalized = String(file || "").trim();
  if (!normalized) return;
  localStorage.setItem(LIVE_LAST_VIEWED_FILE_KEY, normalized);
  if (setCurrent) localStorage.setItem(LIVE_HISTORY_FILE_KEY, normalized);
}

function saveFilters(mode) {
  const payload = {
    excludedAssets: Array.from(excludedAssets),
    excludedLiabilities: Array.from(excludedLiabilities)
  };
  localStorage.setItem(filterKeyForMode(mode), JSON.stringify(payload));
}

function loadFilters(mode) {
  try {
    const raw = localStorage.getItem(filterKeyForMode(mode));
    if (!raw) return;
    const { excludedAssets: ea = [], excludedLiabilities: el = [] } = JSON.parse(raw);
    excludedAssets = new Set(ea);
    excludedLiabilities = new Set(el);
  } catch {
    excludedAssets = new Set();
    excludedLiabilities = new Set();
  }
}
const chartInteractionState = {
  alChart: { labels: [], markerDates: [] },
  netChart: { labels: [], markerDates: [] }
};
let metricPieChartState = {
  netWorth: { hoveredIndex: null, slices: [] },
  assets: { hoveredIndex: null, slices: [] },
  liabilities: { hoveredIndex: null, slices: [] }
};
const MAX_ACTION_HISTORY = 200;
let undoStack = [];
let redoStack = [];
let actionLog = [];
let isApplyingHistory = false;
let isTrackingAction = false;
let quoteRefreshTimer = null;
let quoteRefreshAlignTimer = null;
let quoteRefreshInFlight = false;
let quoteRefreshAbortController = null;
let pendingQuoteUiUpdate = false;
let pendingBackgroundQuoteRefresh = false;
let editorRowsFocused = false;
let lastQuoteRefreshAt = null;
let suppressNextEditorFocusRestore = false;
let alChartMode = localStorage.getItem(AL_CHART_MODE_KEY) === "ratio" ? "ratio" : "value";
let alChartSeparateAxes = localStorage.getItem(AL_CHART_AXES_MODE_KEY) === "separate";
let netChartSeparateAxes = localStorage.getItem(NET_CHART_AXES_MODE_KEY) === "separate";

if (currentMode === "demo") {
  formState = freshFormState("demo");
  editingSnapshotDate = mmddyy(new Date());
}

// Initial encrypted-live boot should render a blank dashboard until unlocked.
if (currentMode === "live" && liveEncryptionEnabled && !liveEncryptionPassword) {
  snapshots = [];
  formState = freshFormState("live");
  editingSnapshotDate = mmddyy(new Date());
  hasUnsavedAssetLiabilityChanges = false;
  hoveredSnapshotDate = null;
}

// Always start on the real price source; manual field will be populated from real price after first fetch.
formState.useManualBtcusd = false;
formState.manualBtcusd = null;
editingSnapshotDate = mmddyy(new Date());
if (!(currentMode === "live" && liveEncryptionEnabled && !liveEncryptionPassword)) {
  seedTodayFormStateFromHistory({ save: false });
}
loadFilters(currentMode);

const el = {
  realPriceCard: document.getElementById("realPriceCard"),
  quoteTime: document.getElementById("quoteTime"),
  manualBtcusd: document.getElementById("manualBtcusd"),
  assetsPanelTitle: document.getElementById("assetsPanelTitle"),
  assetsCount: document.getElementById("assetsCount"),
  assetsRows: document.getElementById("assetsRows"),
  liabilitiesPanelTitle: document.getElementById("liabilitiesPanelTitle"),
  liabilitiesCount: document.getElementById("liabilitiesCount"),
  liabilitiesRows: document.getElementById("liabilitiesRows"),
  assetsMetric: document.getElementById("assetsMetric"),
  assetsMetricUsd: document.getElementById("assetsMetricUsd"),
  liabilitiesMetric: document.getElementById("liabilitiesMetric"),
  liabilitiesMetricUsd: document.getElementById("liabilitiesMetricUsd"),
  netMetric: document.getElementById("netMetric"),
  netMetricUsd: document.getElementById("netMetricUsd"),
  historyCount: document.getElementById("historyCount"),
  historyTableBody: document.getElementById("historyTableBody"),
  alChart: document.getElementById("alChart"),
  alChartTitle: document.getElementById("alChartTitle"),
  alChartLegend: document.getElementById("alChartLegend"),
  alChartModeToggle: document.getElementById("alChartModeToggle"),
  alModeValueBtn: document.getElementById("alModeValueBtn"),
  alModeRatioBtn: document.getElementById("alModeRatioBtn"),
  alChartSeparateAxes: document.getElementById("alChartSeparateAxes"),
  alChartAxisToggleWrap: document.getElementById("alChartAxisToggleWrap"),
  netChartSeparateAxes: document.getElementById("netChartSeparateAxes"),
  netChartLegend: document.getElementById("netChartLegend"),
  netChart: document.getElementById("netChart"),
  themeToggle: document.getElementById("themeToggle"),
  themeDarkBtn: document.getElementById("themeDarkBtn"),
  themeLightBtn: document.getElementById("themeLightBtn"),
  undoBtn: document.getElementById("undoBtn"),
  redoBtn: document.getElementById("redoBtn"),
  lockDataBtn: document.getElementById("lockDataBtn"),
  chartStartDate: document.getElementById("chartStartDate"),
  chartEndDate: document.getElementById("chartEndDate"),
  assetsFilterBtn: document.getElementById("assetsFilterBtn"),
  assetsFilterLabel: document.getElementById("assetsFilterLabel"),
  assetsFilterPanel: document.getElementById("assetsFilterPanel"),
  liabilitiesFilterBtn: document.getElementById("liabilitiesFilterBtn"),
  liabilitiesFilterLabel: document.getElementById("liabilitiesFilterLabel"),
  liabilitiesFilterPanel: document.getElementById("liabilitiesFilterPanel"),
  liveEncryptionEnabled: document.getElementById("liveEncryptionEnabled"),
  encryptionToggleWrap: document.getElementById("encryptionToggleWrap"),
  liveFileWrap: document.getElementById("liveFileWrap"),
  liveFileDropdown: document.getElementById("liveFileDropdown"),
  liveFileBtn: document.getElementById("liveFileBtn"),
  liveFileValue: document.getElementById("liveFileValue"),
  liveFilePanel: document.getElementById("liveFilePanel"),
  liveFileCreateBtn: document.getElementById("liveFileCreateBtn"),
  liveFileList: document.getElementById("liveFileList"),
};

function syncEditorRowsFocusedFromDom() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    editorRowsFocused = false;
    return;
  }
  // Exclude delete buttons from focus tracking - they're in the rows but shouldn't block renders
  if (active.classList?.contains("remove-btn")) {
    editorRowsFocused = false;
    return;
  }
  // Block refresh when a comment field is focused
  if (active.classList?.contains("snapshot-comment-field")) {
    editorRowsFocused = true;
    return;
  }
  const wasInAssets = Boolean(el.assetsRows && el.assetsRows.contains(active));
  const wasInLiabilities = Boolean(el.liabilitiesRows && el.liabilitiesRows.contains(active));
  editorRowsFocused = wasInAssets || wasInLiabilities;
}

function focusBodyWithoutScroll() {
  const prevTabIndex = document.body.getAttribute("tabindex");
  document.body.setAttribute("tabindex", "-1");
  try {
    document.body.focus({ preventScroll: true });
  } catch {
    document.body.focus();
  }
  if (prevTabIndex === null) {
    document.body.removeAttribute("tabindex");
  } else {
    document.body.setAttribute("tabindex", prevTabIndex);
  }
}

function initEditorFocusTracking() {
  const focusIn = () => {
    editorRowsFocused = true;
    pauseAutoQuoteRefresh();
    if (quoteRefreshAbortController) {
      quoteRefreshAbortController.abort();
    }
  };
  const focusOut = () => {
    // Let the next activeElement settle (e.g., tabbing to another row field)
    setTimeout(() => {
      syncEditorRowsFocusedFromDom();
      if (!editorRowsFocused) {
        flushDeferredQuoteUiRefresh();
        resumeAutoQuoteRefresh();
      }
    }, 0);
  };
  [el.assetsRows, el.liabilitiesRows].forEach((container) => {
    if (!container) return;
    container.addEventListener("focusin", focusIn);
    container.addEventListener("focusout", focusOut);
  });
}

updateModeToggleUI();

applyTheme();
initEditorFocusTracking();

document.getElementById("refreshQuoteBtn").addEventListener("click", () => {
  void runTrackedAction("quote-refresh", () => refreshQuote());
});
el.themeToggle.addEventListener("click", () => {
  setTheme(currentTheme === "dark" ? "light" : "dark");
});
if (el.undoBtn) {
  el.undoBtn.addEventListener("click", () => undoLastAction());
}
if (el.redoBtn) {
  el.redoBtn.addEventListener("click", () => redoLastAction());
}
if (el.lockDataBtn) {
  el.lockDataBtn.addEventListener("click", () => setLiveAccessLocked());
}
el.manualBtcusd.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitManualQuote();
    el.manualBtcusd.blur();
  }
});
el.manualBtcusd.addEventListener("focus", () => {
  captureEditorFieldBaseline(el.manualBtcusd);
  const num = Number(el.manualBtcusd.value.replace(/[$,]/g, "").trim());
  el.manualBtcusd.value = Number.isFinite(num) && num > 0 ? String(num) : "";
  el.manualBtcusd.select();
});
el.manualBtcusd.addEventListener("blur", commitManualQuote);
document.getElementById("modeDemoBtn").addEventListener("click", () => { void switchMode(currentMode === "demo" ? "live" : "demo"); });
document.getElementById("modeLiveBtn").addEventListener("click", () => { void switchMode(currentMode === "live" ? "demo" : "live"); });
el.liveEncryptionEnabled.addEventListener("change", () => {
  if (el.liveEncryptionEnabled.checked) {
    void enableLiveEncryption();
  } else {
    void disableLiveEncryption();
  }
});
el.liveFileBtn.addEventListener("click", () => {
  const isOpen = el.liveFilePanel && !el.liveFilePanel.hidden;
  closeAllOverlays();
  if (!isOpen && el.liveFilePanel && el.liveFileDropdown) {
    el.liveFilePanel.hidden = false;
    el.liveFileDropdown.classList.add("open");
    el.liveFileBtn.setAttribute("aria-expanded", "true");
  }
});
el.liveFileCreateBtn.addEventListener("click", async () => {
  if (!serverAvailable) {
    closeLiveFileDropdown();
    alert("History file server is unavailable. Start the local server to create/open files.");
    return;
  }
  closeLiveFileDropdown();
  const existingFiles = await fetchAvailableLiveFiles();
  const rawName = await promptForFilename({ existingFiles });
  if (!rawName) return;
  await createLiveFile(rawName);
  await populateLiveFileMenu();
});
document.querySelectorAll(".add-row-btn").forEach((btn) => {
  if (btn.dataset.target) btn.addEventListener("click", () => addRow(btn.dataset.target));
});

if (el.alChartModeToggle && el.alModeValueBtn && el.alModeRatioBtn) {
  const syncAlChartModeUI = () => {
    const isValue = alChartMode === "value";
    el.alModeValueBtn.classList.toggle("active", isValue);
    el.alModeRatioBtn.classList.toggle("active", !isValue);
    el.alModeValueBtn.setAttribute("aria-pressed", isValue ? "true" : "false");
    el.alModeRatioBtn.setAttribute("aria-pressed", isValue ? "false" : "true");
    const axisDisabled = !isValue;
    if (el.alChartSeparateAxes) {
      el.alChartSeparateAxes.disabled = axisDisabled;
      el.alChartSeparateAxes.setAttribute("aria-disabled", axisDisabled ? "true" : "false");
    }
    if (el.alChartAxisToggleWrap) {
      el.alChartAxisToggleWrap.classList.toggle("is-disabled", axisDisabled);
      el.alChartAxisToggleWrap.setAttribute("aria-disabled", axisDisabled ? "true" : "false");
    }
  };

  const setAlChartMode = (mode) => {
    if (mode !== "value" && mode !== "ratio") return;
    if (alChartMode === mode) return;
    alChartMode = mode;
    localStorage.setItem(AL_CHART_MODE_KEY, alChartMode);
    syncAlChartModeUI();
    renderChartsOnly();
  };

  const toggleAlChartMode = () => {
    setAlChartMode(alChartMode === "value" ? "ratio" : "value");
  };

  el.alModeValueBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (alChartMode === "value") {
      runTrackedAction("al-chart-mode-toggle", () => toggleAlChartMode());
      return;
    }
    runTrackedAction("al-chart-mode-value", () => setAlChartMode("value"));
  });
  el.alModeRatioBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (alChartMode === "ratio") {
      runTrackedAction("al-chart-mode-toggle", () => toggleAlChartMode());
      return;
    }
    runTrackedAction("al-chart-mode-ratio", () => setAlChartMode("ratio"));
  });
  el.alChartModeToggle.addEventListener("click", () => {
    runTrackedAction("al-chart-mode-toggle", () => toggleAlChartMode());
  });
  syncAlChartModeUI();
}

if (el.alChartSeparateAxes) {
  el.alChartSeparateAxes.checked = alChartSeparateAxes;
  el.alChartSeparateAxes.addEventListener("change", () => {
    alChartSeparateAxes = Boolean(el.alChartSeparateAxes.checked);
    localStorage.setItem(AL_CHART_AXES_MODE_KEY, alChartSeparateAxes ? "separate" : "shared");
    renderChartsOnly();
  });
}

if (el.netChartSeparateAxes) {
  el.netChartSeparateAxes.checked = netChartSeparateAxes;
  el.netChartSeparateAxes.addEventListener("change", () => {
    netChartSeparateAxes = Boolean(el.netChartSeparateAxes.checked);
    localStorage.setItem(NET_CHART_AXES_MODE_KEY, netChartSeparateAxes ? "separate" : "shared");
    renderChartsOnly();
  });
}

// ── Global overlay registry (one open at a time) ────────────────────────────
const _overlayClosers = new Set();
function closeAllOverlays() {
  _overlayClosers.forEach((fn) => fn());
  closeAllFilterDropdowns();
  closeLiveFileDropdown();
}

// ── Reusable custom date picker ───────────────────────────────────────────────
// opts.anchorEl   – element to position below
// opts.getSelected – () => "YYYY-MM-DD" or ""   (currently selected value)
// opts.getMin      – () => "YYYY-MM-DD" or ""   (earliest selectable, inclusive)
// opts.getMax      – () => "YYYY-MM-DD" or ""   (latest selectable, inclusive)
// opts.isDisabled  – (isoVal) => bool            (extra per-day disabled check)
// opts.onSelect    – (isoVal) => void
function makeDatePicker(opts) {
  let popup = null;
  let pickerYear, pickerMonth;
  let pickerView = "days"; // "days" | "years" | "year"
  let pickerExpandedYear = null;
  const align = opts.align === "left" ? "left" : "right";

  function isoToDate(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function buildCalendar() {
    const selectedIso = opts.getSelected();
    const minDate = isoToDate(opts.getMin());
    const maxDate = isoToDate(opts.getMax());

    const year = pickerYear;
    const month = pickerMonth;
    const monthLabel = new Date(year, month, 1).toLocaleString("default", { month: "long", year: "numeric" });

    const wrap = document.createElement("div");
    wrap.className = "date-picker-popup";

    // Header
    const header = document.createElement("div");
    header.className = "date-picker-header";
    const prev = document.createElement("button");
    prev.className = "date-picker-nav";
    prev.textContent = "‹";
    prev.type = "button";
    prev.addEventListener("click", (e) => { e.stopPropagation(); pickerMonth--; if (pickerMonth < 0) { pickerMonth = 11; pickerYear--; } rebuildCalendar(); });
    const next = document.createElement("button");
    next.className = "date-picker-nav";
    next.textContent = "›";
    next.type = "button";
    next.addEventListener("click", (e) => { e.stopPropagation(); pickerMonth++; if (pickerMonth > 11) { pickerMonth = 0; pickerYear++; } rebuildCalendar(); });
    const lbl = document.createElement("span");
    lbl.textContent = monthLabel;
    lbl.className = "date-picker-header-label";
    lbl.title = "Select year / month";
    lbl.addEventListener("click", (e) => { e.stopPropagation(); pickerView = "years"; pickerExpandedYear = null; rebuildCalendar(); });
    header.append(prev, lbl, next);
    wrap.appendChild(header);

    // Day-of-week row
    const grid = document.createElement("div");
    grid.className = "date-picker-grid";
    ["Su","Mo","Tu","We","Th","Fr","Sa"].forEach((d) => {
      const dow = document.createElement("div");
      dow.className = "date-picker-dow";
      dow.textContent = d;
      grid.appendChild(dow);
    });

    // Blank cells
    const firstDay = new Date(year, month, 1).getDay();
    for (let i = 0; i < firstDay; i++) {
      const blank = document.createElement("div");
      blank.className = "date-picker-day dp-empty";
      grid.appendChild(blank);
    }

    // Day cells
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      date.setHours(0, 0, 0, 0);
      const isoVal = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isSelected = isoVal === selectedIso;
      const outOfRange = (minDate && date < minDate) || (maxDate && date > maxDate);
      const extraDisabled = opts.isDisabled ? opts.isDisabled(isoVal) : false;

      const cell = document.createElement("div");
      cell.className = "date-picker-day";
      cell.textContent = d;

      if (isSelected) {
        cell.classList.add("dp-selected");
      }

      if (outOfRange || extraDisabled) {
        cell.classList.add("dp-disabled");
      } else {
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          closePopup();
          opts.onSelect(isoVal);
        });
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function buildYearGrid() {
    const minDate = isoToDate(opts.getMin());
    const maxDate = isoToDate(opts.getMax());
    const minYear = minDate ? minDate.getFullYear() : pickerYear - 10;
    const maxYear = maxDate ? maxDate.getFullYear() : pickerYear + 5;

    const wrap = document.createElement("div");
    wrap.className = "date-picker-popup dp-year-grid-popup";

    const header = document.createElement("div");
    header.className = "date-picker-header";
    const backBtn = document.createElement("button");
    backBtn.className = "date-picker-nav";
    backBtn.textContent = "‹";
    backBtn.type = "button";
    backBtn.title = "Back to calendar";
    backBtn.addEventListener("click", (e) => { e.stopPropagation(); pickerView = "days"; rebuildCalendar(); });
    const lbl = document.createElement("span");
    lbl.className = "date-picker-header-label";
    lbl.textContent = "Select Year";
    header.append(backBtn, lbl);
    wrap.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "dp-year-grid";
    for (let y = minYear; y <= maxYear; y++) {
      const cell = document.createElement("div");
      cell.className = "dp-year-cell";
      if (y === pickerYear) cell.classList.add("dp-year-current");
      const yearLbl = document.createElement("span");
      yearLbl.textContent = y;
      const yearChevron = document.createElement("span");
      yearChevron.className = "dp-accordion-chevron";
      yearChevron.textContent = "›";
      cell.append(yearLbl, yearChevron);
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        pickerView = "year";
        pickerExpandedYear = y;
        rebuildCalendar();
      });
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  function buildYearAccordion() {
    const minDate = isoToDate(opts.getMin());
    const maxDate = isoToDate(opts.getMax());
    const minYear = minDate ? minDate.getFullYear() : pickerYear - 10;
    const maxYear = maxDate ? maxDate.getFullYear() : pickerYear + 5;
    const expandedYear = pickerExpandedYear !== null ? pickerExpandedYear : pickerYear;

    const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    const wrap = document.createElement("div");
    wrap.className = "date-picker-popup dp-year-grid-popup";

    const header = document.createElement("div");
    header.className = "date-picker-header";
    const backBtn = document.createElement("button");
    backBtn.className = "date-picker-nav";
    backBtn.textContent = "‹";
    backBtn.type = "button";
    backBtn.title = "Back to year list";
    backBtn.addEventListener("click", (e) => { e.stopPropagation(); pickerView = "years"; pickerExpandedYear = null; rebuildCalendar(); });
    const lbl = document.createElement("span");
    lbl.className = "date-picker-header-label";
    lbl.textContent = "Select Month";
    header.append(backBtn, lbl);
    wrap.appendChild(header);

    const list = document.createElement("div");
    list.className = "dp-accordion-list";

    for (let y = minYear; y <= maxYear; y++) {
      const yearRow = document.createElement("div");
      yearRow.className = "dp-accordion-year" + (y === expandedYear ? " dp-accordion-open" : "");

      const yearBtn = document.createElement("button");
      yearBtn.type = "button";
      yearBtn.className = "dp-accordion-year-btn";
      yearBtn.textContent = y;
      const chevron = document.createElement("span");
      chevron.className = "dp-accordion-chevron";
      chevron.textContent = "›";
      yearBtn.appendChild(chevron);
      yearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pickerExpandedYear = (pickerExpandedYear === y) ? null : y;
        rebuildCalendar();
      });
      yearRow.appendChild(yearBtn);

      if (y === expandedYear) {
        const monthGrid = document.createElement("div");
        monthGrid.className = "dp-month-grid";
        MONTH_NAMES.forEach((name, m) => {
          const minMonth = minDate && y === minDate.getFullYear() ? minDate.getMonth() : -1;
          const maxMonth = maxDate && y === maxDate.getFullYear() ? maxDate.getMonth() : 12;
          const disabled = m < minMonth || m > maxMonth;
          const cell = document.createElement("div");
          cell.className = "dp-month-cell" + (disabled ? " dp-disabled" : "");
          if (y === pickerYear && m === pickerMonth) cell.classList.add("dp-month-current");
          cell.textContent = name;
          if (!disabled) {
            cell.addEventListener("click", (e) => {
              e.stopPropagation();
              pickerYear = y;
              pickerMonth = m;
              pickerView = "days";
              pickerExpandedYear = null;
              rebuildCalendar();
            });
          }
          monthGrid.appendChild(cell);
        });
        yearRow.appendChild(monthGrid);
      }
      list.appendChild(yearRow);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function rebuildCalendar() {
    if (!popup) return;
    const fresh = pickerView === "years" ? buildYearGrid()
                : pickerView === "year"  ? buildYearAccordion()
                : buildCalendar();
    popup.replaceChildren(...fresh.childNodes);
    popup.className = fresh.className;
    requestAnimationFrame(() => {
      positionPopup();
      if (pickerView === "years") {
        const grid = popup.querySelector(".dp-year-grid");
        if (grid) grid.scrollTop = grid.scrollHeight;
      } else if (pickerView === "year") {
        const openRow = popup.querySelector(".dp-accordion-year.dp-accordion-open");
        if (openRow) openRow.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function positionPopup() {
    if (!popup) return;
    const rect = opts.anchorEl.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 6}px`;
    const idealLeft = align === "left" ? rect.left : (rect.right - popup.offsetWidth);
    const maxLeft = Math.max(4, window.innerWidth - popup.offsetWidth - 4);
    const left = Math.min(Math.max(4, idealLeft), maxLeft);
    popup.style.left = `${left}px`;
  }

  function openPopup() {
    closeAllOverlays();
    pickerView = "days";
    pickerExpandedYear = null;
    // Start on month of current selection, or today
    const selIso = opts.getSelected();
    if (selIso) {
      const [y, m] = selIso.split("-").map(Number);
      pickerYear = y; pickerMonth = m - 1;
    } else {
      const now = new Date();
      pickerYear = now.getFullYear(); pickerMonth = now.getMonth();
    }
    popup = buildCalendar();
    document.body.appendChild(popup);
    requestAnimationFrame(positionPopup);
    window.addEventListener("scroll", positionPopup, true);
    window.addEventListener("resize", positionPopup);
  }

  function closePopup() {
    if (popup) {
      popup.remove();
      popup = null;
      window.removeEventListener("scroll", positionPopup, true);
      window.removeEventListener("resize", positionPopup);
    }
  }

  function toggle(e) {
    e.stopPropagation();
    if (popup) { closePopup(); } else { openPopup(); }
  }

  document.addEventListener("click", closePopup);

  _overlayClosers.add(closePopup);
  return { toggle, closePopup, rebuildCalendar };
}

// ── History panel date picker ─────────────────────────────────────────────────
(function initHistoryDatePicker() {
  const btn = document.getElementById("addHistoryDateBtn");
  const picker = makeDatePicker({
    align: "right",
    anchorEl: btn,
    getSelected: () => "",
    getMin: () => "2012-01-01",
    getMax: () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const y = yesterday.getFullYear();
      const m = String(yesterday.getMonth() + 1).padStart(2, "0");
      const d = String(yesterday.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    },
    isDisabled: (isoVal) => snapshots.some((s) => mmddyyToInputValue(s.date) === isoVal),
    onSelect: (isoVal) => addSnapshotForDate(inputValueToMMDDYY(isoVal))
  });
  btn.addEventListener("click", picker.toggle);
})();

// ── Chart date range pickers ──────────────────────────────────────────────────
(function initChartDatePickers() {
  const startBtn = document.getElementById("chartStartDateBtn");
  const endBtn   = document.getElementById("chartEndDateBtn");

  function fmtLabel(isoVal) {
    if (!isoVal) return "—";
    const [y, m, d] = isoVal.split("-");
    return `${m}/${d}/${y.slice(2)}`;
  }

  function refreshBtnLabels() {
    startBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${fmtLabel(el.chartStartDate.value)}`;
    endBtn.innerHTML   = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${fmtLabel(el.chartEndDate.value)}`;
  }

  // Patch syncChartRange side-effects so buttons update too
  const _origRenderChartsOnly = renderChartsOnly;
  window._chartDatePickersRefresh = refreshBtnLabels;

  const startPicker = makeDatePicker({
    align: "left",
    anchorEl: startBtn,
    getSelected: () => el.chartStartDate.value,
    getMin: () => el.chartStartDate.min || "",
    getMax: () => el.chartStartDate.max || "",
    isDisabled: () => false,
    onSelect: (isoVal) => {
      el.chartStartDate.value = isoVal;
      updateChartDateRangeFromInputs("start");
      refreshBtnLabels();
      endPicker.rebuildCalendar();
    }
  });

  const endPicker = makeDatePicker({
    align: "left",
    anchorEl: endBtn,
    getSelected: () => el.chartEndDate.value,
    getMin: () => el.chartEndDate.min || "",
    getMax: () => el.chartEndDate.max || "",
    isDisabled: () => false,
    onSelect: (isoVal) => {
      el.chartEndDate.value = isoVal;
      updateChartDateRangeFromInputs("end");
      refreshBtnLabels();
      startPicker.rebuildCalendar();
    }
  });

  startBtn.addEventListener("click", startPicker.toggle);
  endBtn.addEventListener("click", endPicker.toggle);

  // Expose so renderChartsOnly can keep labels fresh
  window._chartDatePickersRefresh = refreshBtnLabels;
})();


document.getElementById("assetsFilterDropdown").addEventListener("click", (e) => {
  if (e.target.closest(".filter-dropdown-panel")) return;
  if (document.getElementById("assetsFilterBtn")?.disabled) return;
  toggleFilterDropdown("assets");
});
document.getElementById("liabilitiesFilterDropdown").addEventListener("click", (e) => {
  if (e.target.closest(".filter-dropdown-panel")) return;
  if (document.getElementById("liabilitiesFilterBtn")?.disabled) return;
  toggleFilterDropdown("liabilities");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".filter-dropdown")) closeAllFilterDropdowns();
  if (!e.target.closest(".live-file-dropdown")) closeLiveFileDropdown();
});
document.addEventListener("keydown", handleUndoRedoHotkeys);
attachChartInteractions();
updateUndoRedoButtons();

// Resize canvas buffers to match display pixels so fonts don't squish at narrow widths.
(function attachChartResizeObserver() {
  let pending = false;
  function syncCanvasSizes() {
    let changed = false;
    [el.alChart, el.netChart].forEach((canvas) => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        changed = true;
      }
    });
    if (changed) renderChartsOnly();
    pending = false;
  }
  const ro = new ResizeObserver(() => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(syncCanvasSizes);
    }
  });
  [el.alChart, el.netChart].forEach((c) => ro.observe(c));
  // Initial sync on first frame
  requestAnimationFrame(syncCanvasSizes);
}());

// ── Metric Pie Chart Resize Observer & Event Listeners ──────────────────────
(function attachMetricPieChartInteractions() {
  const metricCharts = [
    { canvas: document.getElementById("netWorthPieChart"), type: "netWorth" },
    { canvas: document.getElementById("assetsPieChart"), type: "assets" },
    { canvas: document.getElementById("liabilitiesPieChart"), type: "liabilities" }
  ];

  // Attach mouse events for tooltips
  metricCharts.forEach(({ canvas, type }) => {
    if (!canvas) return;
    
    canvas.addEventListener("mousemove", (e) => {
      showMetricPieChartTooltip(canvas, e.clientX, e.clientY, type);
    });
    
    canvas.addEventListener("mouseleave", () => {
      const state = metricPieChartState[type];
      if (state.hoveredIndex !== null) {
        state.hoveredIndex = null;
        if (type === "netWorth") {
          const snap = getDisplaySnapshot();
          renderNetWorthPieChart(snap);
        } else if (type === "assets") {
          const snap = getDisplaySnapshot();
          renderAssetsPieChart(snap);
        } else if (type === "liabilities") {
          const snap = getDisplaySnapshot();
          renderLiabilitiesPieChart(snap);
        }
      }
      hideMetricPieTooltip();
    });
  });

  // Attach resize observer for metric cards
  let pending = false;
  function syncMetricCanvasSizes() {
    let changed = false;
    metricCharts.forEach(({ canvas }) => {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        changed = true;
      }
    });
    if (changed) {
      const snap = getDisplaySnapshot();
      renderNetWorthPieChart(snap);
      renderAssetsPieChart(snap);
      renderLiabilitiesPieChart(snap);
    }
    pending = false;
  }

  const ro = new ResizeObserver(() => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(syncMetricCanvasSizes);
    }
  });

  metricCharts.forEach(({ canvas }) => {
    if (canvas) {
      const parent = canvas.closest(".metric-card");
      if (parent) ro.observe(parent);
    }
  });

  // Initial render after first frame
  requestAnimationFrame(() => {
    const snap = getDisplaySnapshot();
    renderNetWorthPieChart(snap);
    renderAssetsPieChart(snap);
    renderLiabilitiesPieChart(snap);
  });
}());

startServerHeartbeat();
void bootstrap();

function mmddyy(date = new Date()) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}${dd}${yy}`;
}

function parseMMDDYY(tag) {
  const mm = Number(tag.slice(0, 2));
  const dd = Number(tag.slice(2, 4));
  const yy = Number(tag.slice(4, 6));
  return new Date(2000 + yy, mm - 1, dd);
}

function formatDisplayDate(tag) {
  const d = parseMMDDYY(tag);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function formatQuoteTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function themeValue(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function startServerHeartbeat() {
  let timer = null;
  const sendHeartbeat = () => {
    fetch(SERVER_HEARTBEAT_API, {
      method: "POST",
      keepalive: true,
      cache: "no-store"
    }).catch(() => {
      // Ignore heartbeat failures; server might be unavailable during startup.
    });
  };

  sendHeartbeat();
  timer = window.setInterval(sendHeartbeat, SERVER_HEARTBEAT_MS);

  window.addEventListener("pagehide", () => {
    if (timer) window.clearInterval(timer);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(SERVER_HEARTBEAT_API, "bye");
    }
  }, { once: true });
}

function applyTheme() {
  document.body.classList.toggle("light-theme", currentTheme === "light");
  if (el.themeDarkBtn && el.themeLightBtn) {
    el.themeDarkBtn.classList.toggle("active", currentTheme === "dark");
    el.themeLightBtn.classList.toggle("active", currentTheme === "light");
  }
}

function setTheme(nextTheme) {
  if (nextTheme === currentTheme) return;
  currentTheme = nextTheme;
  localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme();
  renderAll();
}

function trackedStateSnapshot() {
  return {
    formState: structuredClone(formState),
    snapshots: structuredClone(snapshots),
    chartRange: structuredClone(chartRange),
    excludedAssets: Array.from(excludedAssets).sort(),
    excludedLiabilities: Array.from(excludedLiabilities).sort(),
    alChartMode,
    editingSnapshotDate,
    hasUnsavedAssetLiabilityChanges
  };
}

function trackedStateEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function recordActionEntry(action, before, after) {
  undoStack.push({ action, before, after });
  if (undoStack.length > MAX_ACTION_HISTORY) undoStack.shift();
  redoStack = [];
  actionLog.push({ action, at: new Date().toISOString(), direction: "forward" });
  if (actionLog.length > MAX_ACTION_HISTORY * 4) actionLog.shift();
  updateUndoRedoButtons();
}

function restoreTrackedState(state) {
  formState = structuredClone(state.formState);
  snapshots = structuredClone(state.snapshots);
  chartRange = structuredClone(state.chartRange || { startDate: null, endDate: null });
  excludedAssets = new Set(state.excludedAssets || []);
  excludedLiabilities = new Set(state.excludedLiabilities || []);
  if (state.alChartMode === "ratio" || state.alChartMode === "value") {
    alChartMode = state.alChartMode;
  }
  localStorage.setItem(AL_CHART_MODE_KEY, alChartMode);
  if (el.alModeValueBtn && el.alModeRatioBtn) {
    const isValue = alChartMode === "value";
    el.alModeValueBtn.classList.toggle("active", isValue);
    el.alModeRatioBtn.classList.toggle("active", !isValue);
    el.alModeValueBtn.setAttribute("aria-pressed", isValue ? "true" : "false");
    el.alModeRatioBtn.setAttribute("aria-pressed", isValue ? "false" : "true");
  }
  if (el.alChartSeparateAxes) {
    el.alChartSeparateAxes.checked = Boolean(alChartSeparateAxes);
    const axisDisabled = alChartMode !== "value";
    el.alChartSeparateAxes.disabled = axisDisabled;
    el.alChartSeparateAxes.setAttribute("aria-disabled", axisDisabled ? "true" : "false");
  }
  if (el.alChartAxisToggleWrap) {
    const axisDisabled = alChartMode !== "value";
    el.alChartAxisToggleWrap.classList.toggle("is-disabled", axisDisabled);
    el.alChartAxisToggleWrap.setAttribute("aria-disabled", axisDisabled ? "true" : "false");
  }
  editingSnapshotDate = state.editingSnapshotDate;
  hasUnsavedAssetLiabilityChanges = Boolean(state.hasUnsavedAssetLiabilityChanges);
  saveForm();
  saveSnapshots();
  saveFilters(currentMode);
  renderAll();
}

function runTrackedAction(action, fn) {
  if (isApplyingHistory || isTrackingAction) return fn();
  isTrackingAction = true;
  const before = trackedStateSnapshot();
  try {
    const result = fn();
    const finalize = () => {
      const after = trackedStateSnapshot();
      if (!trackedStateEquals(before, after)) {
        recordActionEntry(action, before, after);
      }
      isTrackingAction = false;
    };
    if (result && typeof result.then === "function") {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (e) {
    isTrackingAction = false;
    throw e;
  }
}

function runTrackedActionFromBefore(action, before, fn) {
  if (isApplyingHistory || isTrackingAction) return fn();
  isTrackingAction = true;
  try {
    const result = fn();
    const finalize = () => {
      const after = trackedStateSnapshot();
      if (!trackedStateEquals(before, after)) {
        recordActionEntry(action, before, after);
      }
      isTrackingAction = false;
    };
    if (result && typeof result.then === "function") {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (e) {
    isTrackingAction = false;
    throw e;
  }
}

function captureEditorFieldBaseline(el) {
  if (!el._trackedBeforeState) {
    el._trackedBeforeState = trackedStateSnapshot();
  }
}

function consumeEditorFieldBaseline(el) {
  const before = el._trackedBeforeState || trackedStateSnapshot();
  el._trackedBeforeState = null;
  return before;
}

function undoLastAction() {
  if (!undoStack.length) return;
  const entry = undoStack.pop();
  isApplyingHistory = true;
  restoreTrackedState(entry.before);
  isApplyingHistory = false;
  redoStack.push(entry);
  actionLog.push({ action: entry.action, at: new Date().toISOString(), direction: "undo" });
  updateUndoRedoButtons();
}

function redoLastAction() {
  if (!redoStack.length) return;
  const entry = redoStack.pop();
  isApplyingHistory = true;
  restoreTrackedState(entry.after);
  isApplyingHistory = false;
  undoStack.push(entry);
  actionLog.push({ action: entry.action, at: new Date().toISOString(), direction: "redo" });
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  if (el.undoBtn) el.undoBtn.disabled = undoStack.length === 0;
  if (el.redoBtn) el.redoBtn.disabled = redoStack.length === 0;
}

function handleUndoRedoHotkeys(event) {
  const zKey = String(event.key || "").toLowerCase() === "z";
  if (!zKey) return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  event.preventDefault();
  if (event.shiftKey) {
    redoLastAction();
  } else {
    undoLastAction();
  }
}

function mmddyyToInputValue(tag) {
  const d = parseMMDDYY(tag);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function inputValueToMMDDYY(value) {
  if (!value) return null;
  return yyyymmddToMMDDYY(value.replaceAll("-", ""));
}

function yyyymmddToMMDDYY(yyyymmdd) {
  const yyyy = yyyymmdd.slice(0, 4);
  const mm = yyyymmdd.slice(4, 6);
  const dd = yyyymmdd.slice(6, 8);
  const yy = yyyy.slice(-2);
  return `${mm}${dd}${yy}`;
}

function parseYYYYMMDD(yyyymmdd) {
  const yyyy = Number(yyyymmdd.slice(0, 4));
  const mm = Number(yyyymmdd.slice(4, 6));
  const dd = Number(yyyymmdd.slice(6, 8));
  return new Date(yyyy, mm - 1, dd);
}

function snapshotRowsToFormRows(rows) {
  return (rows || []).map((r) => ({
    name: String(r.name || ""),
    amount: parseRowAmount(r.value),
    unit: normalizeUnit(r.unit)
  }));
}

function latestSnapshot() {
  if (!snapshots.length) return null;
  return snapshots.slice().sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date))[0];
}

function todayOrLatestSnapshot() {
  const today = mmddyy(new Date());
  return snapshots.find((s) => s.date === today) || latestSnapshot();
}

function seedTodayFormStateFromHistory({ save = true } = {}) {
  const today = mmddyy(new Date());
  if (editingSnapshotDate !== today) return;
  const base = todayOrLatestSnapshot();
  if (!base) return;
  formState.assets = snapshotRowsToFormRows(base.assets);
  formState.liabilities = snapshotRowsToFormRows(base.liabilities);
  hasUnsavedAssetLiabilityChanges = false;
  if (save) saveForm();
}

function todayHistoryRowSnapshot() {
  const today = mmddyy(new Date());
  const existingToday = snapshots.find((s) => s.date === today);
  if (existingToday) return existingToday;

  // Always base the synthetic today row on the latest saved snapshot's assets/liabilities
  // valued at the current live exchange rate — not the currently selected form state.
  const base = latestSnapshot();
  const price = activeBtcusd() || (base && Number(base.btcusd) > 0 ? Number(base.btcusd) : 0);
  const assets = base ? (base.assets || []).map((a) => ({ ...a })) : [];
  const liabilities = base ? (base.liabilities || []).map((l) => ({ ...l })) : [];
  const totals = computeTotals(assets, liabilities, price);

  return {
    date: today,
    timestamp: new Date().toISOString(),
    btcusd: price,
    assets,
    liabilities,
    totals,
    synthetic: true
  };
}

function historyDatesIncludingToday() {
  const today = mmddyy(new Date());
  const out = new Set((snapshots || []).map((s) => s.date));
  out.add(today);
  return Array.from(out);
}

function chartXAtIndex(index, labelCount, x0, chartW) {
  if (labelCount <= 1) return x0 + (chartW * 0.99) / 2;
  // Add 1% margin on the right by using 99% of available width
  return x0 + (chartW * 0.99 * index) / (labelCount - 1);
}

function nearestHistoryDateForCanvasPoint(canvas, xPx) {
  const state = chartInteractionState[canvas.id];
  if (!state || !state.labels.length || !state.markerDates.length) return null;
  const labels = state.labels;
  const labelToIndex = new Map(labels.map((d, i) => [d, i]));
  const x0 = Number.isFinite(state.plotX0) ? state.plotX0 : CHART_PAD.l;
  const chartW = Number.isFinite(state.plotW)
    ? state.plotW
    : (canvas.width - CHART_PAD.l - CHART_PAD.r);
  if (chartW <= 0) return null;

  let best = null;
  state.markerDates.forEach((date) => {
    const idx = labelToIndex.get(date);
    if (!Number.isInteger(idx)) return;
    const mx = chartXAtIndex(idx, labels.length, x0, chartW);
    const dist = Math.abs(xPx - mx);
    if (!best || dist < best.dist) best = { date, dist };
  });
  return best ? best.date : null;
}

function chartMouseX(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
  return (event.clientX - rect.left) * scaleX;
}

function syncChartRange(chartSnapshots, rangeState, startInputEl, endInputEl) {
  if (!chartSnapshots.length) {
    startInputEl.value = "";
    endInputEl.value = "";
    startInputEl.min = "";
    startInputEl.max = "";
    endInputEl.min = "";
    endInputEl.max = "";
    startInputEl.disabled = true;
    endInputEl.disabled = true;
    return { range: { startDate: null, endDate: null }, filtered: [] };
  }

  const minDate = chartSnapshots[0].date;
  const maxDate = chartSnapshots[chartSnapshots.length - 1].date;
  let startDate = rangeState.startDate || minDate;
  let endDate = rangeState.endDate || maxDate;

  if (parseMMDDYY(startDate) < parseMMDDYY(minDate)) startDate = minDate;
  if (parseMMDDYY(startDate) > parseMMDDYY(maxDate)) startDate = maxDate;
  if (parseMMDDYY(endDate) > parseMMDDYY(maxDate)) endDate = maxDate;
  if (parseMMDDYY(endDate) < parseMMDDYY(minDate)) endDate = minDate;
  if (parseMMDDYY(endDate) < parseMMDDYY(startDate)) endDate = startDate;

  const minInput = mmddyyToInputValue(minDate);
  const maxInput = mmddyyToInputValue(maxDate);
  const startInput = mmddyyToInputValue(startDate);
  const endInput = mmddyyToInputValue(endDate);

  startInputEl.disabled = false;
  endInputEl.disabled = false;
  startInputEl.min = minInput;
  startInputEl.max = endInput;
  endInputEl.min = startInput;
  endInputEl.max = maxInput;
  startInputEl.value = startInput;
  endInputEl.value = endInput;

  return {
    range: { startDate, endDate },
    filtered: chartSnapshots.filter((snap) => {
      const date = parseMMDDYY(snap.date);
      return date >= parseMMDDYY(startDate) && date <= parseMMDDYY(endDate);
    })
  };
}

function getAllAssetNames() {
  const names = new Set();
  snapshots.forEach((s) => (s.assets || []).forEach((a) => { if (a.name) names.add(a.name); }));
  (formState.assets || []).forEach((r) => { const n = String(r.name || "").trim(); if (n) names.add(n); });
  return Array.from(names).sort();
}

function getAllLiabilityNames() {
  const names = new Set();
  snapshots.forEach((s) => (s.liabilities || []).forEach((l) => { if (l.name) names.add(l.name); }));
  (formState.liabilities || []).forEach((r) => { const n = String(r.name || "").trim(); if (n) names.add(n); });
  return Array.from(names).sort();
}

function buildFilterPanel(panelEl, names, excluded, onChange, actionName) {
  panelEl.innerHTML = "";
  if (!names.length) {
    const msg = document.createElement("div");
    msg.className = "filter-empty-msg";
    msg.textContent = "No items";
    panelEl.appendChild(msg);
    return;
  }

  const itemCheckboxes = [];
  const syncAllCheckbox = () => {
    allCb.checked = itemCheckboxes.every((cb) => cb.checked);
  };

  const allLabel = document.createElement("label");
  allLabel.className = "filter-checkbox-item filter-checkbox-item-all";
  const allCb = document.createElement("input");
  allCb.type = "checkbox";
  allCb.checked = excluded.size === 0;
  allCb.addEventListener("change", () => {
    runTrackedAction(actionName, () => {
      if (allCb.checked) {
        excluded.clear();
      } else {
        names.forEach((name) => excluded.add(name));
      }
      itemCheckboxes.forEach((cb) => {
        cb.checked = allCb.checked;
      });
      onChange();
    });
  });
  allLabel.appendChild(allCb);
  allLabel.appendChild(document.createTextNode("All"));
  panelEl.appendChild(allLabel);

  names.forEach((name) => {
    const label = document.createElement("label");
    label.className = "filter-checkbox-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !excluded.has(name);
    itemCheckboxes.push(cb);
    cb.addEventListener("change", () => {
      runTrackedAction(actionName, () => {
        if (cb.checked) excluded.delete(name);
        else excluded.add(name);
        syncAllCheckbox();
        onChange();
      });
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(name));
    panelEl.appendChild(label);
  });

  syncAllCheckbox();
}

function updateFilterDropdownLabel(labelEl, btnEl, total, excluded) {
  const hidden = excluded.size;
  if (hidden === 0) {
    labelEl.textContent = "All";
    btnEl.classList.remove("has-exclusions");
  } else {
    labelEl.textContent = `${total - hidden} / ${total}`;
    btnEl.classList.add("has-exclusions");
  }
}

function populateFilterDropdowns() {
  const assetNames = getAllAssetNames();
  const liabilityNames = getAllLiabilityNames();

  buildFilterPanel(el.assetsFilterPanel, assetNames, excludedAssets, () => {
    updateFilterDropdownLabel(el.assetsFilterLabel, el.assetsFilterBtn, assetNames.length, excludedAssets);
    saveFilters(currentMode);
    renderChartsOnly();
    updateKPIs();
  }, "filter-assets");
  buildFilterPanel(el.liabilitiesFilterPanel, liabilityNames, excludedLiabilities, () => {
    updateFilterDropdownLabel(el.liabilitiesFilterLabel, el.liabilitiesFilterBtn, liabilityNames.length, excludedLiabilities);
    saveFilters(currentMode);
    renderChartsOnly();
    updateKPIs();
  }, "filter-liabilities");
  updateFilterDropdownLabel(el.assetsFilterLabel, el.assetsFilterBtn, assetNames.length, excludedAssets);
  updateFilterDropdownLabel(el.liabilitiesFilterLabel, el.liabilitiesFilterBtn, liabilityNames.length, excludedLiabilities);
}

function toggleFilterDropdown(type) {
  const dropdown = document.getElementById(type === "assets" ? "assetsFilterDropdown" : "liabilitiesFilterDropdown");
  const panel = type === "assets" ? el.assetsFilterPanel : el.liabilitiesFilterPanel;
  const isOpen = !panel.hidden;
  closeAllOverlays();
  if (!isOpen) {
    panel.hidden = false;
    dropdown.classList.add("open");
  }
}

function closeAllFilterDropdowns() {
  ["assetsFilterDropdown", "liabilitiesFilterDropdown"].forEach((id) => {
    const d = document.getElementById(id);
    if (d) d.classList.remove("open");
  });
  if (el.assetsFilterPanel) el.assetsFilterPanel.hidden = true;
  if (el.liabilitiesFilterPanel) el.liabilitiesFilterPanel.hidden = true;
}

function updateChartDateRangeFromInputs(changedField, { tracked = true } = {}) {
  const applyRangeFromInputs = () => {
    const startDate = inputValueToMMDDYY(el.chartStartDate.value);
    const endDate = inputValueToMMDDYY(el.chartEndDate.value);

    if (!startDate || !endDate) return;

    if (parseMMDDYY(endDate) < parseMMDDYY(startDate)) {
      if (changedField === "start") {
        el.chartEndDate.value = el.chartStartDate.value;
      } else {
        el.chartStartDate.value = el.chartEndDate.value;
      }
    }

    chartRange = {
      startDate: inputValueToMMDDYY(el.chartStartDate.value),
      endDate: inputValueToMMDDYY(el.chartEndDate.value)
    };
    renderChartsOnly();
  };

  if (!tracked || isApplyingHistory || isTrackingAction) {
    applyRangeFromInputs();
    return;
  }
  runTrackedAction(`chart-range-${changedField}`, applyRangeFromInputs);
}

function updateChartControlsDisabledState() {
  const hasSnapshots = snapshots.length > 0;
  const hasAssets = getAllAssetNames().length > 0;
  const hasLiabilities = getAllLiabilityNames().length > 0;

  const startBtn = document.getElementById("chartStartDateBtn");
  const endBtn   = document.getElementById("chartEndDateBtn");
  const assetsBtn = document.getElementById("assetsFilterBtn");
  const liabsBtn  = document.getElementById("liabilitiesFilterBtn");

  if (startBtn) startBtn.disabled = !hasSnapshots;
  if (endBtn)   endBtn.disabled   = !hasSnapshots;
  if (assetsBtn) assetsBtn.disabled = !hasAssets;
  if (liabsBtn)  liabsBtn.disabled  = !hasLiabilities;
}

function renderChartsOnly() {
  const displayPrice = activeBtcusd();
  const chartSnapshots = snapshotsForCharts(displayPrice, excludedAssets, excludedLiabilities);
  const synced = syncChartRange(chartSnapshots, chartRange, el.chartStartDate, el.chartEndDate);
  chartRange = synced.range;

  updateChartControlsDisabledState();
  renderAssetLiabilityChart(synced.filtered);
  renderNetChangeChart(synced.filtered);
  if (window._chartDatePickersRefresh) window._chartDatePickersRefresh();
}

function attachChartInteractions() {
  [el.alChart, el.netChart].forEach((canvas) => {
    canvas.addEventListener("mousemove", (event) => {
      const x = chartMouseX(canvas, event);
      const rect = canvas.getBoundingClientRect();
      const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
      const nextY = (event.clientY - rect.top) * scaleY;
      const nextHover = nearestHistoryDateForCanvasPoint(canvas, x);
      const yChanged = Math.abs((hoveredCanvasY ?? nextY) - nextY) >= 1;
      hoveredCanvasY = nextY;
      if (nextHover !== hoveredSnapshotDate || (nextHover && yChanged)) {
        hoveredSnapshotDate = nextHover;
        renderChartsOnly();
      }
    });

    canvas.addEventListener("mouseleave", () => {
      hoveredCanvasY = null;
      if (hoveredSnapshotDate !== null) {
        hoveredSnapshotDate = null;
        renderChartsOnly();
      }
    });

    canvas.addEventListener("click", (event) => {
      const x = chartMouseX(canvas, event);
      const date = nearestHistoryDateForCanvasPoint(canvas, x);
      if (!date) return;
      hoveredSnapshotDate = date;
      selectSnapshot(date);
    });
  });
}

function parseSnapshotsRaw(raw) {
  const parsed = JSON.parse(raw);
  const arr = Array.isArray(parsed) ? parsed : [];
  return arr.sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date));
}

async function bootstrap() {
  // Probe server availability first (non-blocking for the initial render)
  void probeServer();

  // Always start from a neutral view; source files are loaded immediately after.
  snapshots = [];
  if (currentMode === "demo") {
    formState = freshFormState("demo");
  } else {
    formState = freshFormState("live");
  }
  editingSnapshotDate = mmddyy(new Date());

  renderAll();
  startAutoQuoteRefresh();
  requestBackgroundQuoteRefresh();
  updateModeToggleUI();

  if (currentMode === "demo") {
    formState = freshFormState("demo");
    await fetchHistoricalPrices();
    // Always read demo source file fresh on reload.
    const loadedDemo = await loadDemoData();
    if (!loadedDemo) {
      // Fallback only when source file cannot be read.
      snapshots = loadSnapshots();
    }
    // re-enrich snapshot prices now that historical data is available
    snapshots = snapshots.map((snap) => {
      const price = historicalPrices[snap.date];
      if (!price) return snap;
      const btcusd = Number(price);
      const assetsBtc = {}, assetsUsd = {}, liabilitiesBtc = {}, liabilitiesUsd = {};
      (snap.assets || []).forEach((a) => {
        if (a.unit === "BTC") { assetsBtc[a.name] = Number(a.value ?? a.amount ?? 0); assetsUsd[a.name] = assetsBtc[a.name] * btcusd; }
        else { assetsUsd[a.name] = Number(a.value ?? a.amount ?? 0); assetsBtc[a.name] = assetsUsd[a.name] / btcusd; }
      });
      (snap.liabilities || []).forEach((l) => {
        if (l.unit === "BTC") { liabilitiesBtc[l.name] = Number(l.value ?? l.amount ?? 0); liabilitiesUsd[l.name] = liabilitiesBtc[l.name] * btcusd; }
        else { liabilitiesUsd[l.name] = Number(l.value ?? l.amount ?? 0); liabilitiesBtc[l.name] = liabilitiesUsd[l.name] / btcusd; }
      });
      const tAB = sum(Object.values(assetsBtc)), tAU = sum(Object.values(assetsUsd));
      const tLB = sum(Object.values(liabilitiesBtc)), tLU = sum(Object.values(liabilitiesUsd));
      return { ...snap, btcusd, totals: { assets_btc: tAB, assets_usd: tAU, liabilities_btc: tLB, liabilities_usd: tLU, net_btc: tAB - tLB, net_usd: tAU - tLU } };
    });
    saveSnapshots();
  } else {
    // Live mode: wait for server probe, then load from file
    if (!liveHistoryFile) {
      liveHistoryFile = localStorage.getItem(LIVE_LAST_VIEWED_FILE_KEY) || "my_history.csv";
      persistLiveFileSelection(liveHistoryFile);
    }
    await probeServer();
    updateModeToggleUI();
    await fetchHistoricalPrices();
    if (serverAvailable) {
      await ensureLiveBaseFileIfMissing();
    }

    // Helper: prompt for password with inline error on failure; returns true if unlocked, false if cancelled.
    const promptAndUnlock = async (decryptFn, msgText = "") => {
      const pw = await promptForPassword({
        confirm: false,
        message: msgText,
        validator: async (p) => {
          const ok = await decryptFn(p);
          return ok ? null : "Incorrect password. Please try again.";
        }
      });
      return pw !== null;
    };

    if (serverAvailable) {
      if (liveEncryptionEnabled) {
        const hasEncFile = (await fetchLiveHistoryFile()) !== null;
        if (hasEncFile) {
          const unlocked = await promptAndUnlock(async (pw) => {
            try {
              const raw = await fetchLiveHistoryFile();
              if (!raw) return false;
              const plain = await decryptText(raw, pw);
              const parsed = parseLiveHistoryCsv(plain);
              snapshots = parsed;
              liveEncryptionPassword = pw;
              seedTodayFormStateFromHistory({ save: false });
              return true;
            } catch { return false; }
          });
          if (!unlocked) {
            // User cancelled — switch to demo mode rather than showing empty live data
            await switchMode("demo");
            renderAll();
            return;
          }
        }
      } else {
        const loaded = await loadLiveSnapshotsFromServer();
        snapshots = loaded;
        seedTodayFormStateFromHistory({ save: true });
      }
    } else {
      // No server — fall back to localStorage (encrypted or plain)
      if (liveEncryptionEnabled) {
        const hasEncData = Boolean(localStorage.getItem(STORE_KEY_LIVE_ENC));
        if (hasEncData) {
          const unlocked = await promptAndUnlock(async (pw) => {
            const ok = await unlockLiveEncryptedData(pw);
            if (ok) {
              liveEncryptionPassword = pw;
              seedTodayFormStateFromHistory({ save: false });
            }
            return ok;
          });
          if (!unlocked) {
            await switchMode("demo");
            renderAll();
            return;
          }
        }
      } else if (!snapshots.length) {
        const loaded = await loadLiveSnapshotsFromStaticCsv();
        if (loaded.length > 0) {
          snapshots = loaded;
          seedTodayFormStateFromHistory({ save: true });
        }
      }
    }
  }
  renderAll();
}

function clearAutoQuoteRefreshTimers() {
  if (quoteRefreshTimer !== null) {
    clearInterval(quoteRefreshTimer);
    quoteRefreshTimer = null;
  }
  if (quoteRefreshAlignTimer !== null) {
    clearTimeout(quoteRefreshAlignTimer);
    quoteRefreshAlignTimer = null;
  }
}

function startAutoQuoteRefresh() {
  clearAutoQuoteRefreshTimers();

  const now = Date.now();
  const msUntilNextMinute = QUOTE_AUTO_REFRESH_MS - (now % QUOTE_AUTO_REFRESH_MS);
  const firstDelay = msUntilNextMinute + QUOTE_AUTO_REFRESH_OFFSET_MS;

  quoteRefreshAlignTimer = setTimeout(() => {
    requestBackgroundQuoteRefresh();
    quoteRefreshTimer = setInterval(() => {
      requestBackgroundQuoteRefresh();
    }, QUOTE_AUTO_REFRESH_MS);
  }, firstDelay);
}

function pauseAutoQuoteRefresh() {
  clearAutoQuoteRefreshTimers();
}

function resumeAutoQuoteRefresh() {
  startAutoQuoteRefresh();
}

function requestBackgroundQuoteRefresh() {
  if (isManualOverrideActive()) return;
  if (isAssetLiabilityEditorFocused()) {
    pendingBackgroundQuoteRefresh = true;
    return;
  }
  pendingBackgroundQuoteRefresh = false;
  void refreshQuote({ background: true });
}

function parseFormFromRaw(raw, defaultForm) {
  const parsed = JSON.parse(raw);
  const merged = {
    ...structuredClone(defaultForm),
    ...parsed
  };

  if ((!Array.isArray(merged.assets) || !merged.assets.length) && (Array.isArray(parsed.assetsBtc) || Array.isArray(parsed.assetsUsd))) {
    const migratedAssets = [];
    (parsed.assetsBtc || []).forEach((r) => migratedAssets.push({
      name: String(r.name || ""),
      amount: Number(r.amount || 0),
      unit: "BTC"
    }));
    (parsed.assetsUsd || []).forEach((r) => migratedAssets.push({
      name: String(r.name || ""),
      amount: Number(r.amount || 0),
      unit: "USD"
    }));
    merged.assets = migratedAssets;
  }

  merged.assets = (merged.assets || []).map((r) => ({
    name: String(r.name || ""),
    amount: Number(r.amount || 0),
    unit: normalizeUnit(r.unit)
  }));

  if ((!Array.isArray(merged.liabilities) || !merged.liabilities.length) && (Array.isArray(parsed.liabilitiesBtc) || Array.isArray(parsed.liabilitiesUsd))) {
    const migratedLiabilities = [];
    (parsed.liabilitiesBtc || []).forEach((r) => migratedLiabilities.push({
      name: String(r.name || ""),
      amount: Number(r.amount || 0),
      unit: "BTC"
    }));
    (parsed.liabilitiesUsd || []).forEach((r) => migratedLiabilities.push({
      name: String(r.name || ""),
      amount: Number(r.amount || 0),
      unit: "USD"
    }));
    merged.liabilities = migratedLiabilities;
  }

  merged.liabilities = (merged.liabilities || []).map((r) => ({
    name: String(r.name || ""),
    amount: Number(r.amount || 0),
    unit: normalizeUnit(r.unit)
  }));

  const manual = Number(merged.manualBtcusd);
  merged.manualBtcusd = Number.isFinite(manual) && manual > 0 ? manual : null;
  merged.useManualBtcusd = Boolean(merged.useManualBtcusd) && Number.isFinite(merged.manualBtcusd);
  return merged;
}

// ── Client-side AES-GCM encryption (Web Crypto API) ─────────────────────────

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveAesKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 210_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(plaintext, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const key  = await deriveAesKey(password, salt);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(plaintext)
  );
  // Format: base64(salt) + "." + base64(iv) + "." + base64(ciphertext)
  return `${bytesToBase64(salt)}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuf))}`;
}

async function decryptText(payload, password) {
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted payload");
  const salt   = base64ToBytes(parts[0]);
  const iv     = base64ToBytes(parts[1]);
  const cipher = base64ToBytes(parts[2]);
  const key    = await deriveAesKey(password, salt);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plainBuf);
}

// Prompt user for a new history filename. existingFiles blocks same-stem names.
async function promptForFilename({ existingFiles = [] } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "enc-overlay";

    const box = document.createElement("div");
    box.className = "enc-dialog";

    const msg = document.createElement("p");
    msg.textContent = "Enter a name for the new history file.";
    box.appendChild(msg);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "e.g. my_history.csv or wallet.enc";
    nameInput.className = "enc-input";
    box.appendChild(nameInput);

    const hint = document.createElement("p");
    hint.className = "enc-error";
    hint.style.display = "";
    hint.style.color = "var(--text-muted, #888)";
    hint.textContent = "Name must end with .csv or .enc";
    box.appendChild(hint);

    const btnRow = document.createElement("div");
    btnRow.className = "enc-btn-row";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "enc-btn enc-btn-cancel";
    cancelBtn.type = "button";

    const okBtn = document.createElement("button");
    okBtn.textContent = "Create";
    okBtn.className = "enc-btn enc-btn-ok";
    okBtn.type = "button";
    okBtn.disabled = true;

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    nameInput.focus();

    const validate = () => {
      const v = nameInput.value.trim().toLowerCase();
      const isValidExt = v.endsWith(".csv") || v.endsWith(".enc");
      if (!isValidExt) {
        hint.style.color = "var(--text-muted, #888)";
        hint.textContent = "Name must end with .csv or .enc";
        okBtn.disabled = true;
        return;
      }
      const cleaned = v.replace(/[^a-zA-Z0-9_.\-]/g, "_");
      const stem = cleaned.replace(/\.(csv|enc)$/, "");
      const conflict = existingFiles.find((f) => f.replace(/\.(csv|enc)$/i, "").toLowerCase() === stem);
      if (conflict) {
        hint.style.color = "var(--color-error, #ef4444)";
        hint.textContent = `"${conflict}" already exists. Choose a different name.`;
        okBtn.disabled = true;
      } else {
        hint.style.color = "var(--text-muted, #888)";
        hint.textContent = "Name must end with .csv or .enc";
        okBtn.disabled = false;
      }
    };
    nameInput.addEventListener("input", validate);

    const cleanup = (val) => {
      document.body.removeChild(overlay);
      resolve(val);
    };

    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });

    const submit = () => {
      if (okBtn.disabled) return;
      const cleaned = nameInput.value.trim().replace(/[^a-zA-Z0-9_.\-]/g, "_");
      cleanup(cleaned);
    };

    okBtn.addEventListener("click", submit);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") cleanup(null); });
  });
}

async function promptForPassword({ confirm: needConfirm = false, message = "", validator = null } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "enc-overlay";

    const box = document.createElement("div");
    box.className = "enc-dialog";

    const msg = document.createElement("p");
    msg.textContent = message || (needConfirm ? "Set a password to encrypt your live data." : "Enter your password to unlock live data.");
    box.appendChild(msg);

    const pwInput = document.createElement("input");
    pwInput.type = "password";
    pwInput.placeholder = "Password";
    pwInput.className = "enc-input";
    box.appendChild(pwInput);

    let confirmInput = null;
    if (needConfirm) {
      confirmInput = document.createElement("input");
      confirmInput.type = "password";
      confirmInput.placeholder = "Confirm password";
      confirmInput.className = "enc-input";
      box.appendChild(confirmInput);
    }

    const errMsg = document.createElement("p");
    errMsg.className = "enc-error";
    errMsg.style.display = "none";
    box.appendChild(errMsg);

    const btnRow = document.createElement("div");
    btnRow.className = "enc-btn-row";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "enc-btn enc-btn-cancel";
    cancelBtn.type = "button";

    const okBtn = document.createElement("button");
    okBtn.textContent = needConfirm ? "Set password" : "Unlock";
    okBtn.className = "enc-btn enc-btn-ok";
    okBtn.type = "button";

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = (val) => {
      document.body.removeChild(overlay);
      resolve(val);
    };

    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });

    const submit = async () => {
      const pw = pwInput.value;
      if (!pw) {
        errMsg.textContent = "Password cannot be empty.";
        errMsg.style.display = "";
        return;
      }
      if (confirmInput && pw !== confirmInput.value) {
        errMsg.textContent = "Passwords do not match.";
        errMsg.style.display = "";
        return;
      }
      if (validator) {
        okBtn.disabled = true;
        cancelBtn.disabled = true;
        const err = await validator(pw);
        okBtn.disabled = false;
        cancelBtn.disabled = false;
        if (err) {
          errMsg.textContent = err;
          errMsg.style.display = "";
          pwInput.select();
          pwInput.focus();
          return;
        }
      }
      cleanup(pw);
    };

    okBtn.addEventListener("click", submit);
    pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    if (confirmInput) confirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

    setTimeout(() => pwInput.focus(), 50);
  });
}

// ── Server file I/O ─────────────────────────────────────────────────────────

// Probe whether the local server is available. Sets serverAvailable.
async function probeServer() {
  try {
    const res = await fetch(LIVE_HISTORY_API, { method: "HEAD", cache: "no-cache" });
    serverAvailable = res.ok || res.status === 404; // 404 = server up, file missing
    return serverAvailable;
  } catch {
    serverAvailable = false;
    return false;
  }
}

// Read live history from server. Returns raw text or null on failure.
// Optionally pass a filenameOverride to read a specific file instead of liveHistoryFile.
async function fetchLiveHistoryFile(filenameOverride = null) {
  try {
    const file = filenameOverride || liveHistoryFile;
    const res = await fetch(`${LIVE_HISTORY_API}?file=${encodeURIComponent(file)}`, { cache: "no-cache" });
    if (res.status === 404) return null; // file doesn't exist yet — that's fine
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Write live history to server. content is a plain CSV or encrypted string.
// Returns true on success. In strict mode, throws on failure.
async function writeLiveHistoryFile(content, encrypted = false, { strict = false, filename = null } = {}) {
  const targetFile = filename || liveHistoryFile;
  if (!serverAvailable) {
    await probeServer();
  }
  if (!serverAvailable) {
    if (strict) throw new Error("Server unavailable");
    return false;
  }
  try {
    const res = await fetch(LIVE_HISTORY_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: targetFile, encrypted, content })
    });
    if (!res.ok) {
      if (strict) throw new Error(`Server rejected write (${res.status})`);
      return false;
    }
    return true;
  } catch (err) {
    if (strict) throw err;
    return false;
  }
}

// Parse my_history.csv text into snapshots array.
function parseLiveHistoryCsv(text, { legacyUnitSelections = null } = {}) {
  if (!text || !text.trim()) {
    const empty = [];
    empty._legacyConverted = false;
    return empty;
  }
  try {
    const isLegacy = isLegacyHistoryCsv(text);
    const rows = parseCsv(text);
    const parsed = rows.map((row) => {
      const mmddyyDate = parseCsvDateToMMDDYY(row.date);
      if (!mmddyyDate) return null;

      const btcusd = Number(row.btcusd || historicalPrices[mmddyyDate] || formState.btcusd || 0);
      let assets = [];
      let liabilities = [];

      if (isLegacy) {
        const usdAssets = parseLegacyDictField(row.assets_usd || row.assets);
        const btcAssets = parseLegacyDictField(row.assets_btc);
        const usdLiabs = parseLegacyDictField(row.liabilities_usd || row.liabilities);
        const btcLiabs = parseLegacyDictField(row.liabilities_btc);

        const assetNames = new Set([
          ...Object.keys(usdAssets || {}),
          ...Object.keys(btcAssets || {}),
          ...Object.keys((legacyUnitSelections && legacyUnitSelections.assets) || {})
        ]);
        const liabilityNames = new Set([
          ...Object.keys(usdLiabs || {}),
          ...Object.keys(btcLiabs || {}),
          ...Object.keys((legacyUnitSelections && legacyUnitSelections.liabilities) || {})
        ]);

        const pickRows = (names, usdDict, btcDict, selectedUnits = {}) => {
          const out = [];
          names.forEach((rawName) => {
            const name = String(rawName || "").trim();
            if (!name) return;
            const chosen = String(selectedUnits[name] || "USD");
            const usdValRaw = Number(usdDict?.[name]);
            const btcValRaw = Number(btcDict?.[name]);
            let usdVal = Number.isFinite(usdValRaw) ? usdValRaw : NaN;
            let btcVal = Number.isFinite(btcValRaw) ? btcValRaw : NaN;
            const fx = Number.isFinite(btcusd) && btcusd > 0 ? btcusd : NaN;

            // Legacy files normally store both USD and BTC dictionaries for the same items.
            // If one side is missing, derive it from the other using row BTCUSD.
            if (!Number.isFinite(usdVal) && Number.isFinite(btcVal) && Number.isFinite(fx)) {
              usdVal = btcVal * fx;
            }
            if (!Number.isFinite(btcVal) && Number.isFinite(usdVal) && Number.isFinite(fx)) {
              btcVal = usdVal / fx;
            }

            let value = 0;
            let unit = "USD";

            if (chosen === "BTC") {
              unit = "BTC";
              value = Number.isFinite(btcVal) ? btcVal : 0;
            } else if (chosen === "sats") {
              unit = "sats";
              value = Number.isFinite(btcVal) ? btcVal * 100000000 : 0;
            } else {
              unit = "USD";
              value = Number.isFinite(usdVal) ? usdVal : 0;
            }

            if (!Number.isFinite(value) || value === 0) return;
            out.push({ name, value, unit });
          });
          return out;
        };

        assets = pickRows(
          assetNames,
          usdAssets,
          btcAssets,
          (legacyUnitSelections && legacyUnitSelections.assets) || {}
        );
        liabilities = pickRows(
          liabilityNames,
          usdLiabs,
          btcLiabs,
          (legacyUnitSelections && legacyUnitSelections.liabilities) || {}
        );
      } else {
        assets = typeof row.assets === "string" ? JSON.parse(row.assets) : (row.assets || []);
        liabilities = typeof row.liabilities === "string" ? JSON.parse(row.liabilities) : (row.liabilities || []);
      }

      if (!Array.isArray(assets)) assets = [];
      if (!Array.isArray(liabilities)) liabilities = [];

      return {
        date: mmddyyDate,
        timestamp: row.timestamp || parseMMDDYY(mmddyyDate).toISOString(),
        btcusd,
        assets,
        liabilities,
        comments: row.comment || row.comments || "",
        totals: computeTotals(assets, liabilities, btcusd)
      };
    }).filter(Boolean);

    parsed._legacyConverted = isLegacy;
    return parsed;
  } catch {
    const empty = [];
    empty._legacyConverted = false;
    return empty;
  }
}

// Serialize snapshots to CSV string for my_history.csv.
function snapshotsToCsv(snaps) {
  const sorted = snaps.slice().sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date));
  const header = "date,assets,liabilities,comment";
  const rows = sorted.map((s) => {
    const yyyymmdd = mmddyyToInputValue(s.date).replaceAll("-", "");
    const assets = JSON.stringify(s.assets || []);
    const liabilities = JSON.stringify(s.liabilities || []);
    const comment = String(s.comments || "");
    // CSV-quote each field that may contain commas or quotes
    const q = (v) => `"${String(v).replaceAll('"', '""')}"`;
    return `${yyyymmdd},${q(assets)},${q(liabilities)},${q(comment)}`;
  });
  return [header, ...rows].join("\n");
}

function csvHeaderNames(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  return parseCsvRow(lines[0]).map((h) => String(h || "").trim().replace(/^\uFEFF/, "").toLowerCase());
}

function isLegacyHistoryCsv(text) {
  const headers = csvHeaderNames(text);
  if (!headers.length) return false;
  return headers.includes("assets_usd")
    || headers.includes("liabilities_usd")
    || headers.includes("assets_btc")
    || headers.includes("liabilities_btc");
}

function parseCsvDateToMMDDYY(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{8}$/.test(raw)) return yyyymmddToMMDDYY(raw);

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slash) {
    const mm = String(Number(slash[1])).padStart(2, "0");
    const dd = String(Number(slash[2])).padStart(2, "0");
    const yyRaw = String(slash[3]);
    const yy = yyRaw.length === 4 ? yyRaw.slice(-2) : yyRaw.padStart(2, "0");
    return `${mm}${dd}${yy}`;
  }

  const dash = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dash) {
    return `${dash[2]}${dash[3]}${dash[1].slice(-2)}`;
  }
  return null;
}

function parseLegacyDictField(rawValue) {
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) return rawValue;
  const text = String(rawValue || "").trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through and try Python-dict style parsing.
  }

  try {
    const normalized = text
      .replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*)'/g, ': "$1"');
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Ignore malformed dictionaries.
  }
  return {};
}

function legacyDictToUsdRows(dictLike) {
  const dict = parseLegacyDictField(dictLike);
  return Object.entries(dict)
    .map(([name, value]) => ({
      name: String(name || "").trim(),
      value: Number(value),
      unit: "USD"
    }))
    .filter((row) => row.name && Number.isFinite(row.value) && row.value !== 0);
}

function collectLegacyFieldNames(rows, kind) {
  const usdKey = `${kind}_usd`;
  const btcKey = `${kind}_btc`;
  const fallbackKey = kind;
  const names = new Set();
  rows.forEach((row) => {
    const usdDict = parseLegacyDictField(row[usdKey] || row[fallbackKey]);
    const btcDict = parseLegacyDictField(row[btcKey]);
    Object.keys(usdDict).forEach((k) => { if (k) names.add(String(k).trim()); });
    Object.keys(btcDict).forEach((k) => { if (k) names.add(String(k).trim()); });
  });
  return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

async function promptForLegacyUnitSelections(rawCsv, filename = "") {
  const rows = parseCsv(rawCsv);
  const assetNames = collectLegacyFieldNames(rows, "assets");
  const liabilityNames = collectLegacyFieldNames(rows, "liabilities");

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "enc-overlay";

    const box = document.createElement("div");
    box.className = "enc-dialog legacy-convert-dialog";

    const title = document.createElement("p");
    title.className = "legacy-convert-title";
    title.textContent = "Legacy file detected";
    box.appendChild(title);

    const msg = document.createElement("p");
    msg.textContent = `${filename || "This file"} uses the old dashboard format. Choose units for each item before conversion.`;
    box.appendChild(msg);

    const makeSection = (headingText, names) => {
      const section = document.createElement("div");
      section.className = "legacy-convert-section";

      const heading = document.createElement("div");
      heading.className = "legacy-convert-heading";
      heading.textContent = headingText;
      section.appendChild(heading);

      if (!names.length) {
        const empty = document.createElement("div");
        empty.className = "legacy-convert-empty";
        empty.textContent = "No items found";
        section.appendChild(empty);
        return { section, selects: new Map() };
      }

      const list = document.createElement("div");
      list.className = "legacy-convert-list";
      const selects = new Map();
      names.forEach((name) => {
        const row = document.createElement("label");
        row.className = "legacy-convert-row";

        const nameEl = document.createElement("span");
        nameEl.className = "legacy-convert-name";
        nameEl.textContent = name;

        const sel = document.createElement("select");
        sel.className = "legacy-convert-select";
        ["USD", "BTC", "sats"].forEach((unit) => {
          const opt = document.createElement("option");
          opt.value = unit;
          opt.textContent = unit;
          if (unit === "USD") opt.selected = true;
          sel.appendChild(opt);
        });

        row.appendChild(nameEl);
        row.appendChild(sel);
        list.appendChild(row);
        selects.set(name, sel);
      });
      section.appendChild(list);
      return { section, selects };
    };

    const assetsSection = makeSection("Assets", assetNames);
    const liabsSection = makeSection("Liabilities", liabilityNames);
    box.appendChild(assetsSection.section);
    box.appendChild(liabsSection.section);

    const btnRow = document.createElement("div");
    btnRow.className = "enc-btn-row";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.className = "enc-btn enc-btn-cancel";
    cancelBtn.type = "button";

    const okBtn = document.createElement("button");
    okBtn.textContent = "Convert File";
    okBtn.className = "enc-btn enc-btn-ok";
    okBtn.type = "button";

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = (val) => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(val);
    };

    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });

    okBtn.addEventListener("click", () => {
      const selected = {
        assets: {},
        liabilities: {}
      };
      assetsSection.selects.forEach((sel, name) => {
        selected.assets[name] = sel.value || "USD";
      });
      liabsSection.selects.forEach((sel, name) => {
        selected.liabilities[name] = sel.value || "USD";
      });
      cleanup(selected);
    });
  });
}

function hasCommentCsvColumn(text) {
  const headers = csvHeaderNames(text);
  return headers.includes("comment") || headers.includes("comments");
}

async function migrateCsvToIncludeCommentColumnIfMissing(rawCsv, parsedSnapshots, {
  encrypted = false,
  filename = null
} = {}) {
  const needsLegacyUpgrade = isLegacyHistoryCsv(rawCsv);
  const needsCommentUpgrade = !hasCommentCsvColumn(rawCsv);
  if (!needsLegacyUpgrade && !needsCommentUpgrade) return;

  const csv = snapshotsToCsv(Array.isArray(parsedSnapshots) ? parsedSnapshots : []);
  if (encrypted) {
    if (!liveEncryptionPassword) return;
    const enc = await encryptText(csv, liveEncryptionPassword);
    await writeLiveHistoryFile(enc, true, { filename });
  } else {
    await writeLiveHistoryFile(csv, false, { filename });
  }
}

async function parseHistoryCsvWithLegacyPrompt(rawCsv, filename, { encrypted = false } = {}) {
  if (!isLegacyHistoryCsv(rawCsv)) {
    return { parsed: parseLiveHistoryCsv(rawCsv), cancelled: false };
  }

  const selections = await promptForLegacyUnitSelections(rawCsv, filename);
  if (!selections) {
    return { parsed: [], cancelled: true };
  }

  const parsed = parseLiveHistoryCsv(rawCsv, { legacyUnitSelections: selections });
  await migrateCsvToIncludeCommentColumnIfMissing(rawCsv, parsed, {
    encrypted,
    filename
  });
  return { parsed, cancelled: false };
}

// Load live snapshots from server (or fall back to localStorage).
async function loadLiveSnapshotsFromServer() {
  const isEncrypted = liveHistoryFile.endsWith(".enc");
  const raw = await fetchLiveHistoryFile();
  if (raw === null) {
    return [];
  }
  if (!isEncrypted) {
    const result = await parseHistoryCsvWithLegacyPrompt(raw, liveHistoryFile, { encrypted: false });
    if (result.cancelled) return [];
    const parsed = result.parsed;
    if (parsed.length > 0) {
      // Sync to localStorage so offline access works
      localStorage.setItem(STORE_KEY_LIVE, JSON.stringify(parsed));
    }
    return parsed;
  }
  // Encrypted path
  if (!liveEncryptionPassword) return [];
  try {
    const plain = await decryptText(raw, liveEncryptionPassword);
    const result = await parseHistoryCsvWithLegacyPrompt(plain, liveHistoryFile, { encrypted: true });
    if (result.cancelled) return [];
    const parsed = result.parsed;
    return parsed;
  } catch {
    return [];
  }
}

// Load live snapshots from bundled static CSV (no API server required).
async function loadLiveSnapshotsFromStaticCsv(filenameOverride = null) {
  const file = filenameOverride
    || liveHistoryFile
    || localStorage.getItem(LIVE_LAST_VIEWED_FILE_KEY)
    || "my_history.csv";
  if (!file || !file.endsWith(".csv")) return [];
  try {
    let res = await fetch(`history_files/${file}`, { cache: "no-cache" });
    if (!res.ok) {
      res = await fetch(`/history_files/${file}`, { cache: "no-cache" });
    }
    if (!res.ok) return [];
    const raw = await res.text();
    const result = await parseHistoryCsvWithLegacyPrompt(raw, file, { encrypted: false });
    if (result.cancelled) return [];
    const parsed = result.parsed;
    if (parsed.length > 0) {
      liveHistoryFile = file;
      persistLiveFileSelection(file);
      localStorage.setItem(STORE_KEY_LIVE, JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return [];
  }
}

// If the selected live file is missing on the server, recreate a clean decrypted base file.
async function ensureLiveBaseFileIfMissing() {
  if (!serverAvailable || currentMode !== "live") return false;

  const selected = liveHistoryFile || "";
  const selectedRaw = selected ? await fetchLiveHistoryFile(selected) : null;
  if (selectedRaw !== null) return false;

  const prevBtcusd = Number(formState.btcusd || 0);
  const prevManualBtcusd = formState.manualBtcusd;
  const prevUseManual = formState.useManualBtcusd;

  liveHistoryFile = "my_history.csv";
  liveEncryptionEnabled = false;
  liveEncryptionPassword = null;
  liveAccessLocked = false;
  persistLiveFileSelection(liveHistoryFile);
  localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0");

  snapshots = [];
  formState = structuredClone(DEFAULT_FORM_LIVE);
  formState.btcusd = prevBtcusd;
  formState.manualBtcusd = prevManualBtcusd;
  formState.useManualBtcusd = prevUseManual;
  editingSnapshotDate = mmddyy(new Date());
  hasUnsavedAssetLiabilityChanges = false;
  hoveredSnapshotDate = null;
  chartRange = { startDate: null, endDate: null };
  netChartRange = { startDate: null, endDate: null };
  alChartRange = { startDate: null, endDate: null };
  if (el.chartStartDate) el.chartStartDate.value = "";
  if (el.chartEndDate) el.chartEndDate.value = "";

  localStorage.setItem(STORE_KEY_LIVE, JSON.stringify([]));
  localStorage.setItem(FORM_KEY_LIVE, JSON.stringify(formState));
  localStorage.removeItem(STORE_KEY_LIVE_ENC);
  localStorage.removeItem(FORM_KEY_LIVE_ENC);
  await writeLiveHistoryFile(snapshotsToCsv([]), false);
  return true;
}

// Save live snapshots to server (and localStorage as fallback).
async function saveLiveSnapshotsToServer() {
  const csv = snapshotsToCsv(snapshots);
  const isEncrypted = liveHistoryFile.endsWith(".enc");
  if (isEncrypted) {
    if (!liveEncryptionPassword) {
      const cached = liveFilePasswords.get(liveHistoryFile);
      if (cached) {
        liveEncryptionPassword = cached;
      } else {
        const pw = await promptForPassword({ confirm: false, message: `Enter password for ${liveHistoryFile}.` });
        if (!pw) return;
        liveEncryptionPassword = pw;
        liveFilePasswords.set(liveHistoryFile, pw);
      }
    }
    const enc = await encryptText(csv, liveEncryptionPassword);
    localStorage.setItem(STORE_KEY_LIVE_ENC, enc);
    await writeLiveHistoryFile(enc, true);
  } else {
    localStorage.setItem(STORE_KEY_LIVE, JSON.stringify(snapshots));
    await writeLiveHistoryFile(csv, false);
  }
}

async function saveDemoSnapshotsToServer() {
  const csv = snapshotsToCsv(snapshots);
  // demo source file is always plain CSV
  await writeLiveHistoryFile(csv, false, { filename: "demo_history.csv" });
}

// Fetch list of available history files from server.
async function fetchAvailableLiveFiles() {
  try {
    const res = await fetch("/api/live-history/files", { cache: "no-cache" });
    if (!res.ok) return [];
    const files = await res.json();
    return (Array.isArray(files) ? files : [])
      .filter((f) => typeof f === "string")
      .filter((f) => f !== "demo_history.csv")
      .filter((f) => f.endsWith(".csv") || f.endsWith(".enc"));
  } catch { return []; }
}

function closeLiveFileDropdown() {
  if (el.liveFilePanel) el.liveFilePanel.hidden = true;
  if (el.liveFileDropdown) el.liveFileDropdown.classList.remove("open");
  if (el.liveFileBtn) el.liveFileBtn.setAttribute("aria-expanded", "false");
}

function setLiveAccessLocked() {
  const prevBtcusd = formState.btcusd;
  const prevManualBtcusd = formState.manualBtcusd;
  const prevUseManual = formState.useManualBtcusd;

  liveAccessLocked = true;
  liveEncryptionPassword = null;
  liveHistoryFile = "";
  localStorage.removeItem(LIVE_HISTORY_FILE_KEY);
  snapshots = [];
  formState = structuredClone(DEFAULT_FORM_LIVE);
  formState.btcusd = prevBtcusd;
  formState.manualBtcusd = prevManualBtcusd;
  formState.useManualBtcusd = prevUseManual;
  editingSnapshotDate = mmddyy(new Date());
  hasUnsavedAssetLiabilityChanges = false;
  hoveredSnapshotDate = null;
  chartRange = { startDate: null, endDate: null };
  netChartRange = { startDate: null, endDate: null };
  alChartRange = { startDate: null, endDate: null };
  if (el.chartStartDate) el.chartStartDate.value = "";
  if (el.chartEndDate) el.chartEndDate.value = "";
  closeAllFilterDropdowns();
  updateModeToggleUI();
  renderAll();
}

// Populate the custom file menu from the server file list.
async function populateLiveFileMenu() {
  const displayFile = (liveAccessLocked || !liveHistoryFile) ? "-" : liveHistoryFile;
  if (el.liveFileValue) el.liveFileValue.textContent = displayFile;
  if (!el.liveFileList) return;
  if (!serverAvailable) {
    el.liveFileList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "live-file-empty";
    empty.textContent = "Server unavailable";
    el.liveFileList.appendChild(empty);
    return;
  }
  const files = await fetchAvailableLiveFiles();
  const allFiles = liveHistoryFile && !files.includes(liveHistoryFile)
    ? [liveHistoryFile, ...files]
    : files;

  el.liveFileList.innerHTML = "";
  if (!allFiles.length) {
    const empty = document.createElement("div");
    empty.className = "live-file-empty";
    empty.textContent = "No files found";
    el.liveFileList.appendChild(empty);
    return;
  }

  allFiles.forEach((file) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "live-file-option";
    if (!liveAccessLocked && file === liveHistoryFile) btn.classList.add("active");
    btn.textContent = file;
    btn.addEventListener("click", async () => {
      closeLiveFileDropdown();
      if (liveAccessLocked || file !== liveHistoryFile) {
        await switchLiveFile(file);
      }
      await populateLiveFileMenu();
    });
    el.liveFileList.appendChild(btn);
  });
}

// Switch to a different history file, prompting for password if it's encrypted.
async function switchLiveFile(filename) {
  const isEnc = filename.endsWith(".enc");
  if (isEnc) {
    const raw = await fetchLiveHistoryFile(filename);

    const requestPassword = async () => {
      if (raw === null) {
        return await promptForPassword({ confirm: false, message: `Enter password for ${filename}.` });
      }
      return await promptForPassword({
        confirm: false,
        message: `Enter password for ${filename}.`,
        validator: async (entered) => {
          try {
            const plain = await decryptText(raw, entered);
            parseLiveHistoryCsv(plain);
            return null;
          } catch {
            return "Incorrect password. Please try again.";
          }
        }
      });
    };

    const pw = await requestPassword();
    if (!pw) {
      setLiveAccessLocked();
      await populateLiveFileMenu();
      return;
    }

    if (raw !== null) {
      try {
        const plain = await decryptText(raw, pw);
        const result = await parseHistoryCsvWithLegacyPrompt(plain, filename, { encrypted: true });
        if (result.cancelled) return;
        snapshots = result.parsed;
      } catch {
        setLiveAccessLocked();
        await populateLiveFileMenu();
        return;
      }
    } else {
      snapshots = []; // new empty encrypted file
    }
    liveEncryptionPassword = pw;
    liveFilePasswords.set(filename, pw);
    liveHistoryFile = filename;
    persistLiveFileSelection(liveHistoryFile);
    liveAccessLocked = false;
    liveEncryptionEnabled = true;
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "1");
    el.liveEncryptionEnabled.checked = true;
  } else {
    const raw = await fetchLiveHistoryFile(filename);
    if (raw !== null) {
      const result = await parseHistoryCsvWithLegacyPrompt(raw, filename, { encrypted: false });
      if (result.cancelled) return;
      snapshots = result.parsed;
    } else {
      snapshots = [];
    }
    liveHistoryFile = filename;
    persistLiveFileSelection(liveHistoryFile);
    liveAccessLocked = false;
    liveEncryptionEnabled = false;
    liveEncryptionPassword = null;
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0");
    el.liveEncryptionEnabled.checked = false;
  }

  const prevBtcusd = formState.btcusd;
  const prevManualBtcusd = formState.manualBtcusd;
  const prevUseManual = formState.useManualBtcusd;
  formState = structuredClone(DEFAULT_FORM_LIVE);
  formState.btcusd = prevBtcusd;
  formState.manualBtcusd = prevManualBtcusd;
  formState.useManualBtcusd = prevUseManual;
  editingSnapshotDate = mmddyy(new Date());
  hasUnsavedAssetLiabilityChanges = false;
  hoveredSnapshotDate = null;
  chartRange = { startDate: null, endDate: null };
  netChartRange = { startDate: null, endDate: null };
  alChartRange = { startDate: null, endDate: null };
  if (el.chartStartDate) el.chartStartDate.value = "";
  if (el.chartEndDate) el.chartEndDate.value = "";
  seedTodayFormStateFromHistory({ save: false });
  updateModeToggleUI();
  renderAll();
}

// Create a new live history file and switch to it.
async function createLiveFile(filename) {
  if (!serverAvailable) return;

  const exists = (await fetchLiveHistoryFile(filename)) !== null;
  if (exists) {
    const overwrite = confirm(`${filename} already exists. Overwrite it?`);
    if (!overwrite) return;
  }

  const prevFile = liveHistoryFile;
  liveHistoryFile = filename;
  persistLiveFileSelection(liveHistoryFile);

  const prevBtcusd = Number(formState.btcusd || 0);
  const prevManualBtcusd = formState.manualBtcusd;
  const prevUseManual = formState.useManualBtcusd;

  if (filename.endsWith(".enc")) {
    const pw = await promptForPassword({
      confirm: true,
      message: `Set a password for ${filename}.`
    });
    if (!pw) {
      liveHistoryFile = prevFile;
      persistLiveFileSelection(liveHistoryFile);
      return;
    }

    snapshots = [];
    formState = structuredClone(DEFAULT_FORM_LIVE);
    formState.btcusd = prevBtcusd;
    formState.manualBtcusd = prevManualBtcusd;
    formState.useManualBtcusd = prevUseManual;
    liveEncryptionEnabled = true;
    liveEncryptionPassword = pw;
    liveFilePasswords.set(filename, pw);
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "1");
    el.liveEncryptionEnabled.checked = true;

    const enc = await encryptText(snapshotsToCsv([]), pw);
    localStorage.setItem(STORE_KEY_LIVE_ENC, enc);
    localStorage.removeItem(STORE_KEY_LIVE);
    localStorage.removeItem(FORM_KEY_LIVE);
    await writeLiveHistoryFile(enc, true);
  } else {
    snapshots = [];
    formState = structuredClone(DEFAULT_FORM_LIVE);
    formState.btcusd = prevBtcusd;
    formState.manualBtcusd = prevManualBtcusd;
    formState.useManualBtcusd = prevUseManual;

    liveEncryptionEnabled = false;
    liveEncryptionPassword = null;
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0");
    el.liveEncryptionEnabled.checked = false;

    localStorage.setItem(STORE_KEY_LIVE, JSON.stringify([]));
    localStorage.setItem(FORM_KEY_LIVE, JSON.stringify(formState));
    localStorage.removeItem(STORE_KEY_LIVE_ENC);
    localStorage.removeItem(FORM_KEY_LIVE_ENC);
    await writeLiveHistoryFile(snapshotsToCsv([]), false);
  }

  seedTodayFormStateFromHistory({ save: false });
  updateModeToggleUI();
  renderAll();
}

function loadForm() {
  // Synchronous path: demo mode, or live without encryption.
  // Encrypted live data is loaded separately via loadLiveEncryptedData().
  const key = currentMode === "demo" ? FORM_KEY_DEMO : FORM_KEY_LIVE;
  const defaultForm = currentMode === "demo" ? DEFAULT_FORM_DEMO : DEFAULT_FORM_LIVE;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return structuredClone(defaultForm);
    return parseFormFromRaw(raw, defaultForm);
  } catch {
    const defaultForm = currentMode === "demo" ? DEFAULT_FORM_DEMO : DEFAULT_FORM_LIVE;
    return structuredClone(defaultForm);
  }
}

function resetDemoState() {
  localStorage.removeItem(STORE_KEY_DEMO);
  localStorage.removeItem(FORM_KEY_DEMO);
}

function saveForm() {
  if (currentMode === "live" && liveEncryptionEnabled && liveEncryptionPassword) {
    // Fire-and-forget async encrypt save
    encryptText(JSON.stringify(formState), liveEncryptionPassword)
      .then((enc) => localStorage.setItem(FORM_KEY_LIVE_ENC, enc))
      .catch(() => {});
    return;
  }
  const key = currentMode === "demo" ? FORM_KEY_DEMO : FORM_KEY_LIVE;
  localStorage.setItem(key, JSON.stringify(formState));
}

function loadSnapshots() {
  try {
    // Keep encrypted live hidden until explicit unlock.
    if (currentMode === "live" && liveEncryptionEnabled) return [];
    const key = currentMode === "demo" ? STORE_KEY_DEMO : STORE_KEY_LIVE;
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return parseSnapshotsRaw(raw);
  } catch {
    return [];
  }
}

function saveSnapshots() {
  if (currentMode === "live") {
    if (liveAccessLocked || !liveHistoryFile) return;
    void saveLiveSnapshotsToServer();
    return;
  }
  // Demo mode: persist both local cache and source CSV file.
  const sorted = snapshots.slice().sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date));
  localStorage.setItem(STORE_KEY_DEMO, JSON.stringify(sorted));
  void saveDemoSnapshotsToServer();
}

async function refreshQuote({ background = false } = {}) {
  if (quoteRefreshInFlight) return;
  quoteRefreshInFlight = true;
  quoteRefreshAbortController = new AbortController();
  try {
    const response = await fetch(KRAKEN_URL, { cache: "no-cache", signal: quoteRefreshAbortController.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const usdcusd = Number(payload.result.USDCUSD.a[0]);
    const btcusdc = Number(payload.result.XBTUSDC.a[0]);
    const price = btcusdc / usdcusd;
    formState.btcusd = price;
    lastQuoteRefreshAt = new Date();
    // Persist price globally so it survives mode/file switches.
    localStorage.setItem(BTCUSD_CACHE_KEY, String(price));
    // Refresh always returns the UI to live exchange rate mode.
    formState.useManualBtcusd = false;
    formState.manualBtcusd = null;
    manualEditedThisSession = false;
    saveForm();

    // Also update the other mode's stored price so today's row is current in both modes
    const otherKey = currentMode === "demo" ? FORM_KEY_LIVE : FORM_KEY_DEMO;
    try {
      const otherRaw = localStorage.getItem(otherKey);
      const otherForm = otherRaw ? JSON.parse(otherRaw) : {};
      otherForm.btcusd = price;
      if (!otherForm.useManualBtcusd) {
        otherForm.manualBtcusd = price;
      }
      localStorage.setItem(otherKey, JSON.stringify(otherForm));
    } catch { /* ignore */ }

    if (background) {
      if (isAssetLiabilityEditorFocused()) {
        pendingQuoteUiUpdate = true;
      } else {
        applyBackgroundQuoteUiRefresh();
      }
    } else {
      renderAll();
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      // Expected when editor focus starts during an in-flight background refresh.
    } else {
      el.quoteTime.textContent = `Quote refresh failed: ${String(err)}`;
    }
  } finally {
    quoteRefreshAbortController = null;
    quoteRefreshInFlight = false;
  }
}

function isAssetLiabilityEditorFocused() {
  if (editorRowsFocused) return true;
  syncEditorRowsFocusedFromDom();
  return editorRowsFocused;
}

function applyBackgroundQuoteUiRefresh() {
  const manualActive = isManualOverrideActive();
  const manualDisplayValue = manualActive
    ? Number(formState.manualBtcusd)
    : Number(formState.btcusd || 0);
  if (document.activeElement !== el.manualBtcusd) {
    el.manualBtcusd.value = manualDisplayValue > 0 ? formatUsd(manualDisplayValue) : "";
  }
  el.quoteTime.textContent = manualActive
    ? "Manual price override"
    : (formState.btcusd ? `Updated · ${formatQuoteTimestamp(lastQuoteRefreshAt || new Date())}` : "No quote loaded");
  updateKPIs();
  renderHistoryTable();
  renderChartsOnly();
}

function flushDeferredQuoteUiRefresh() {
  if (isAssetLiabilityEditorFocused()) return;
  if (pendingBackgroundQuoteRefresh) {
    if (!quoteRefreshInFlight) {
      pendingBackgroundQuoteRefresh = false;
      void refreshQuote({ background: true });
    }
    return;
  }
  if (!pendingQuoteUiUpdate) return;
  pendingQuoteUiUpdate = false;
  applyBackgroundQuoteUiRefresh();
}

function commitManualQuote() {
  const before = consumeEditorFieldBaseline(el.manualBtcusd);
  runTrackedActionFromBefore("manual-btcusd", before, () => {
    const raw = el.manualBtcusd.value.replace(/[$,]/g, "").trim();
    if (!raw) {
      formState.manualBtcusd = Number(formState.btcusd || 0) || null;
      activateManualSource();
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0) {
      renderAll();
      return;
    }
    manualEditedThisSession = true;
    formState.manualBtcusd = num;
    activateManualSource();
  });
}

function activateManualSource() {
  if (!Number.isFinite(Number(formState.manualBtcusd)) || Number(formState.manualBtcusd) <= 0) {
    const fallback = Number(formState.btcusd || 0);
    formState.manualBtcusd = fallback > 0 ? fallback : null;
  }
  if (!Number.isFinite(Number(formState.manualBtcusd)) || Number(formState.manualBtcusd) <= 0) {
    formState.useManualBtcusd = false;
    saveForm();
    renderAll();
    return;
  }
  formState.useManualBtcusd = true;
  saveForm();
  renderAll();
}

function isManualOverrideActive() {
  return Boolean(formState.useManualBtcusd) && Number.isFinite(Number(formState.manualBtcusd)) && Number(formState.manualBtcusd) > 0;
}

function activeBtcusd() {
  if (isManualOverrideActive()) {
    return Number(formState.manualBtcusd);
  }
  return Number(formState.btcusd || 0);
}

function addRow(target) {
  const map = {
    assetsRows: "assets",
    liabilitiesRows: "liabilities"
  };
  const key = map[target];
  if (!key) return;
  runTrackedAction("row-add", () => {
    formState[key].unshift({ name: "", amount: 0, unit: "USD", _fresh: true });
    hasUnsavedAssetLiabilityChanges = true;
    pendingRowFocus = { key, idx: 0 };
    saveForm();
    persistSnapshotForActiveSelection({ render: true, onlyIfDirty: true, trackAction: false });
  });
}

function removeRow(key, idx) {
  runTrackedAction("row-delete", () => {
    formState[key].splice(idx, 1);
    hasUnsavedAssetLiabilityChanges = true;
    saveForm();
    persistSnapshotForActiveSelection({ render: true, onlyIfDirty: true, trackAction: false });
  });
}

function sanitizeRows(rows) {
  return rows
    .map((r) => ({ name: String(r.name || "").trim(), amount: parseRowAmount(r.amount) }))
    .filter((r) => r.name && Number.isFinite(r.amount));
}

function canonicalRowName(name) {
  return String(name || "").trim().toLowerCase();
}

function duplicateRowIndices(rows) {
  const counts = new Map();
  const duplicates = new Set();
  (rows || []).forEach((row) => {
    const key = canonicalRowName(row?.name);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  (rows || []).forEach((row, idx) => {
    const key = canonicalRowName(row?.name);
    if (!key) return;
    if ((counts.get(key) || 0) > 1) {
      duplicates.add(idx);
    }
  });
  return duplicates;
}

function uniqueValidRows(rows) {
  const seen = new Set();
  const unique = [];
  (rows || []).slice().reverse().forEach((row) => {
    const name = String(row?.name || "").trim();
    const amountSource = typeof row?.amount !== "undefined" ? row.amount : row?.value;
    const amount = parseRowAmount(amountSource);
    const unit = normalizeUnit(row?.unit);
    const key = canonicalRowName(name);
    if (!key || !Number.isFinite(amount) || seen.has(key)) return;
    seen.add(key);
    unique.unshift({ name, amount, unit });
  });
  return unique;
}

function parseRowAmount(value) {
  if (value === "" || value === null || typeof value === "undefined") return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function isRowComplete(row) {
  const name = String(row.name || "").trim();
  const amount = parseRowAmount(row.amount);
  return Boolean(name) && Number.isFinite(amount);
}

function rowsToObject(rows) {
  const out = {};
  uniqueValidRows(rows).forEach((r) => {
    out[r.name] = (out[r.name] || 0) + Number(r.amount);
  });
  return out;
}

function splitAssetRows(rows) {
  const assetsBtc = {};
  const assetsUsd = {};

  uniqueValidRows(rows).forEach((r) => {
    const name = r.name;
    const amount = r.amount;
    const unit = r.unit;
    if (unit === "BTC") {
      assetsBtc[name] = (assetsBtc[name] || 0) + amount;
    } else if (unit === "sats") {
      assetsBtc[name] = (assetsBtc[name] || 0) + (amount / 1e8);
    } else {
      assetsUsd[name] = (assetsUsd[name] || 0) + amount;
    }
  });

  return { assetsBtc, assetsUsd };
}

function splitLiabilityRows(rows) {
  const liabilitiesBtc = {};
  const liabilitiesUsd = {};

  uniqueValidRows(rows).forEach((r) => {
    const name = r.name;
    const amount = r.amount;
    const unit = r.unit;
    if (unit === "BTC") {
      liabilitiesBtc[name] = (liabilitiesBtc[name] || 0) + amount;
    } else if (unit === "sats") {
      liabilitiesBtc[name] = (liabilitiesBtc[name] || 0) + (amount / 1e8);
    } else {
      liabilitiesUsd[name] = (liabilitiesUsd[name] || 0) + amount;
    }
  });

  return { liabilitiesBtc, liabilitiesUsd };
}

function normalizedSnapshot(btcusdOverride = null) {
  const sourcePrice = btcusdOverride === null ? Number(formState.btcusd || 0) : Number(btcusdOverride || 0);
  const btcusd = Math.max(sourcePrice, 1e-12);
  const uniqueAssets = uniqueValidRows(formState.assets || []);
  const uniqueLiabilities = uniqueValidRows(formState.liabilities || []);
  const splitAssets = splitAssetRows(formState.assets || []);
  const splitLiabilities = splitLiabilityRows(formState.liabilities || []);
  const assetsBtc = splitAssets.assetsBtc;
  const assetsUsd = splitAssets.assetsUsd;
  const liabilitiesBtc = splitLiabilities.liabilitiesBtc;
  const liabilitiesUsd = splitLiabilities.liabilitiesUsd;

  Object.entries(assetsBtc).forEach(([name, v]) => {
    assetsUsd[name] = v * btcusd;
  });
  Object.entries(assetsUsd).forEach(([name, v]) => {
    assetsBtc[name] = v / btcusd;
  });

  Object.entries(liabilitiesBtc).forEach(([name, v]) => {
    liabilitiesUsd[name] = v * btcusd;
  });
  Object.entries(liabilitiesUsd).forEach(([name, v]) => {
    liabilitiesBtc[name] = v / btcusd;
  });

  const totalAssetsBtc = sum(Object.values(assetsBtc));
  const totalAssetsUsd = sum(Object.values(assetsUsd));
  const totalLiabilitiesBtc = sum(Object.values(liabilitiesBtc));
  const totalLiabilitiesUsd = sum(Object.values(liabilitiesUsd));

  return {
    date: mmddyy(new Date()),
    timestamp: new Date().toISOString(),
    btcusd,
    assets: uniqueAssets.map((r) => ({ name: r.name, value: r.amount, unit: r.unit })),
    liabilities: uniqueLiabilities.map((r) => ({ name: r.name, value: r.amount, unit: r.unit })),
    comments: formState.comments || "",
    totals: {
      assets_btc: totalAssetsBtc,
      assets_usd: totalAssetsUsd,
      liabilities_btc: totalLiabilitiesBtc,
      liabilities_usd: totalLiabilitiesUsd,
      net_btc: totalAssetsBtc - totalLiabilitiesBtc,
      net_usd: totalAssetsUsd - totalLiabilitiesUsd
    }
  };
}

function sum(arr) {
  return arr.reduce((acc, n) => acc + Number(n || 0), 0);
}

function saveSnapshot() {
  persistSnapshotForActiveSelection({ render: true });
}

function propagateNameRenameAcrossSnapshots(rowKey, oldNameRaw, newNameRaw, currentDate) {
  const oldName = String(oldNameRaw || "").trim();
  const newName = String(newNameRaw || "").trim();
  if (!oldName || !newName || oldName === newName) return;

  if (rowKey !== "assets" && rowKey !== "liabilities") return;

  for (const snap of snapshots) {
    if (snap.date === currentDate) continue;
    for (const row of (snap[rowKey] || [])) {
      if (String(row.name || "").trim() === oldName) {
        row.name = newName;
      }
    }
  }

  const excludedSet = rowKey === "assets" ? excludedAssets : excludedLiabilities;
  if (excludedSet.has(oldName)) {
    excludedSet.delete(oldName);
    excludedSet.add(newName);
  }
}

function propagateUnitChangeAcrossSnapshots(rowKey, rowNameRaw, oldUnitRaw, newUnitRaw, currentDate) {
  const rowName = String(rowNameRaw || "").trim();
  const oldUnit = normalizeUnit(oldUnitRaw);
  const newUnit = normalizeUnit(newUnitRaw);
  if (!rowName || oldUnit === newUnit) return;

  if (rowKey !== "assets" && rowKey !== "liabilities") return;

  for (const snap of snapshots) {
    if (snap.date === currentDate) continue;
    const datePrice = Number(snap.btcusd || historicalPrices[snap.date] || activeBtcusd());
    for (const row of (snap[rowKey] || [])) {
      if (String(row.name || "").trim() !== rowName) continue;
      const sourceAmount = typeof row.value !== "undefined" ? row.value : row.amount;
      const converted = convertAmountBetweenUnits(sourceAmount, oldUnit, newUnit, datePrice);
      if (typeof row.value !== "undefined") row.value = converted;
      else row.amount = converted;
      row.unit = newUnit;
    }
  }
}

function persistSnapshotForActiveSelection({ render = true, onlyIfDirty = false, trackAction = true, actionLabel = "snapshot-update" } = {}) {
  if (currentMode === "live" && (liveAccessLocked || !liveHistoryFile)) {
    if (render) {
      editorRowsFocused = false;
      renderAll();
    }
    return;
  }

  const applyPersist = () => {
    if (onlyIfDirty && !hasUnsavedAssetLiabilityChanges) {
      if (render) {
        editorRowsFocused = false;
        renderAll();
      }
      return;
    }
    const targetDate = editingSnapshotDate || mmddyy(new Date());
    const existing = snapshots.find((s) => s.date === targetDate);

    // If all assets and liabilities have been removed, delete the snapshot entirely
    const hasAnyRows =
      (formState.assets || []).some((r) => r.name && parseRowAmount(r.amount) > 0) ||
      (formState.liabilities || []).some((r) => r.name && parseRowAmount(r.amount) > 0);
    if (!hasAnyRows && existing) {
      snapshots = snapshots.filter((s) => s.date !== targetDate);
      hasUnsavedAssetLiabilityChanges = false;
      saveSnapshots();
      if (render) {
        editorRowsFocused = false;
        renderAll();
      }
      return;
    }

    const sourcePrice = existing && Number(existing.btcusd) > 0 ? Number(existing.btcusd) : Number(formState.btcusd || 0);
    const snap = normalizedSnapshot(sourcePrice);
    snap.date = targetDate;
    snap.timestamp = existing?.timestamp || new Date().toISOString();
    
    const idx = snapshots.findIndex((s) => s.date === targetDate);
    if (idx >= 0) snapshots[idx] = snap;
    else snapshots.push(snap);
    snapshots.sort((a, b) => parseMMDDYY(a.date) - parseMMDDYY(b.date));
    hasUnsavedAssetLiabilityChanges = false;
    saveSnapshots();
    saveFilters(currentMode);
    if (render) {
      editorRowsFocused = false;
      renderAll();
    }
  };

  if (!trackAction) {
    applyPersist();
    return;
  }
  runTrackedAction(actionLabel, applyPersist);
}

function comparableRowsFromForm(rows) {
  return (rows || [])
    .map((r) => ({
      name: String(r.name || "").trim(),
      value: parseRowAmount(r.amount),
      unit: normalizeUnit(r.unit)
    }))
    .filter((r) => r.name && Number.isFinite(r.value))
    .sort((a, b) => (a.name + a.unit).localeCompare(b.name + b.unit));
}

function comparableRowsFromSnapshot(rows) {
  return (rows || [])
    .map((r) => ({
      name: String(r.name || "").trim(),
      value: parseRowAmount(r.value),
      unit: normalizeUnit(r.unit)
    }))
    .filter((r) => r.name && Number.isFinite(r.value))
    .sort((a, b) => (a.name + a.unit).localeCompare(b.name + b.unit));
}

function rowsSignature(rows) {
  return JSON.stringify(rows.map((r) => [r.name, r.unit, Number(r.value).toFixed(8)]));
}
function selectSnapshot(date) {
  const today = mmddyy(new Date());
  
  // Persist any unsaved changes to the current snapshot before switching
  if (hasUnsavedAssetLiabilityChanges && editingSnapshotDate && editingSnapshotDate !== date) {
    persistSnapshotForActiveSelection({ render: false, trackAction: true });
  }
  
  editingSnapshotDate = date;
  const snap = snapshots.find((s) => s.date === date);
  if (!snap) {
    if (date === today) {
      seedTodayFormStateFromHistory({ save: true });
      hasUnsavedAssetLiabilityChanges = false;
      saveForm();
      renderAll();
    }
    return;
  }
  formState.assets = (snap.assets || []).map((a) => ({
    name: String(a.name || ""),
    amount: parseRowAmount(a.value),
    unit: normalizeUnit(a.unit)
  }));
  formState.liabilities = (snap.liabilities || []).map((l) => ({
    name: String(l.name || ""),
    amount: parseRowAmount(l.value),
    unit: normalizeUnit(l.unit)
  }));
  formState.comments = snap.comments || "";
  hasUnsavedAssetLiabilityChanges = false;
  saveForm();
  renderAll();
}

function addSnapshotForDate(mmddyyDate) {
  if (snapshots.some((s) => s.date === mmddyyDate)) return;

  const sorted = snapshots.slice().sort((a, b) => parseMMDDYY(a.date) - parseMMDDYY(b.date));
  const targetMs = parseMMDDYY(mmddyyDate).getTime();

  let prevSnap = null;
  let nextSnap = null;
  for (const s of sorted) {
    const ms = parseMMDDYY(s.date).getTime();
    if (ms < targetMs) prevSnap = s;
    else if (ms > targetMs && !nextSnap) nextSnap = s;
  }

  const seedSnap = prevSnap || nextSnap;
  const btcusd = Number(historicalPrices[mmddyyDate] || formState.btcusd || 0);
  const assets = (seedSnap ? (seedSnap.assets || []) : []).map((a) => ({ ...a }));
  const liabilities = (seedSnap ? (seedSnap.liabilities || []) : []).map((l) => ({ ...l }));

  const newSnap = {
    date: mmddyyDate,
    timestamp: parseMMDDYY(mmddyyDate).toISOString(),
    btcusd,
    assets,
    liabilities,
    comments: "",
    totals: computeTotals(assets, liabilities, btcusd)
  };

  runTrackedAction("snapshot-add-date", () => {
    const isEarlierThanAll = prevSnap === null && sorted.length > 0;
    snapshots.push(newSnap);
    editingSnapshotDate = mmddyyDate;
    formState.assets = assets.map((a) => ({
      name: String(a.name || ""),
      amount: parseRowAmount(a.value),
      unit: normalizeUnit(a.unit)
    }));
    formState.liabilities = liabilities.map((l) => ({
      name: String(l.name || ""),
      amount: parseRowAmount(l.value),
      unit: normalizeUnit(l.unit)
    }));
    hasUnsavedAssetLiabilityChanges = false;
    saveForm();
    saveSnapshots();
    if (isEarlierThanAll) {
      el.chartStartDate.value = mmddyyToInputValue(mmddyyDate);
      chartRange = {
        startDate: mmddyyDate,
        endDate: inputValueToMMDDYY(el.chartEndDate.value) || mmddyyDate
      };
    }
    renderAll();
    setTimeout(() => {
      const activeRow = document.querySelector("#historyTableBody tr.active-snapshot");
      if (activeRow) activeRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 50);
  });
}

function deleteSnapshot(date) {
  runTrackedAction("snapshot-delete", () => {
    const idx = snapshots.findIndex((s) => s.date === date);
    if (idx < 0) return;
    const today = mmddyy(new Date());
    const deletingToday = date === today;
    snapshots.splice(idx, 1);

    if (editingSnapshotDate === date) {
      const replacement = latestSnapshot();
      if (deletingToday) {
        // Stay on today but revert form values to the most recent remaining snapshot.
        editingSnapshotDate = today;
        if (replacement) {
          formState.assets = (replacement.assets || []).map((a) => ({
            name: String(a.name || ""),
            amount: parseRowAmount(a.value),
            unit: normalizeUnit(a.unit)
          }));
          formState.liabilities = (replacement.liabilities || []).map((l) => ({
            name: String(l.name || ""),
            amount: parseRowAmount(l.value),
            unit: normalizeUnit(l.unit)
          }));
        } else {
          formState.assets = [];
          formState.liabilities = [];
        }
      } else if (replacement) {
        editingSnapshotDate = replacement.date;
        formState.assets = (replacement.assets || []).map((a) => ({
          name: String(a.name || ""),
          amount: parseRowAmount(a.value),
          unit: normalizeUnit(a.unit)
        }));
        formState.liabilities = (replacement.liabilities || []).map((l) => ({
          name: String(l.name || ""),
          amount: parseRowAmount(l.value),
          unit: normalizeUnit(l.unit)
        }));
      } else {
        editingSnapshotDate = today;
        formState.assets = [];
        formState.liabilities = [];
      }
    }

    hasUnsavedAssetLiabilityChanges = false;
    saveForm();
    saveSnapshots();
    renderAll();
  });
}

function formatUsd(v) {
  return `$${Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function formatBtc(v) {
  return `${Number(v || 0).toFixed(8)} BTC`;
}

function normalizeUnit(unit) {
  const upper = String(unit || "USD").toUpperCase();
  if (upper === "BTC") return "BTC";
  if (upper === "SATS") return "sats";
  return "USD";
}

function decimalsForUnit(unit) {
  if (unit === "BTC") return 8;
  if (unit === "sats") return 0;
  return 2;
}

function stepForUnit(unit) {
  if (unit === "BTC") return "0.00000001";
  if (unit === "sats") return "1";
  return "0.01";
}

function formatAmountInputValue(amount, unit) {
  const parsed = parseRowAmount(amount);
  if (!Number.isFinite(parsed)) return "";
  return parsed.toFixed(decimalsForUnit(unit));
}

function convertAmountBetweenUnits(amount, fromUnitRaw, toUnitRaw, btcusdRaw) {
  const fromUnit = normalizeUnit(fromUnitRaw);
  const toUnit = normalizeUnit(toUnitRaw);
  const parsedAmount = parseRowAmount(amount);
  if (!Number.isFinite(parsedAmount)) return amount;
  if (fromUnit === toUnit) return parsedAmount;

  const datePrice = Number(btcusdRaw);
  let nextAmount = parsedAmount;
  if (fromUnit === "BTC" && toUnit === "sats") {
    nextAmount = Math.round(parsedAmount * 1e8);
  } else if (fromUnit === "sats" && toUnit === "BTC") {
    nextAmount = Number((parsedAmount / 1e8).toFixed(8));
  } else if (fromUnit === "BTC" && toUnit === "USD" && datePrice > 0) {
    nextAmount = Number((parsedAmount * datePrice).toFixed(2));
  } else if (fromUnit === "USD" && toUnit === "BTC" && datePrice > 0) {
    nextAmount = Number((parsedAmount / datePrice).toFixed(8));
  } else if (fromUnit === "sats" && toUnit === "USD" && datePrice > 0) {
    nextAmount = Number(((parsedAmount / 1e8) * datePrice).toFixed(2));
  } else if (fromUnit === "USD" && toUnit === "sats" && datePrice > 0) {
    nextAmount = Math.round((parsedAmount / datePrice) * 1e8);
  }

  return nextAmount;
}

function renderEditor(container, key) {
  container.innerHTML = "";
  formState[key].forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.className = key === "assets" || key === "liabilities" ? "row-editor four-col" : "row-editor";
    const unitValue = normalizeUnit(row.unit);

    const name = document.createElement("input");
    name.placeholder = "name";
    name.value = row.name;
    name.dataset.rowKey = key;
    name.dataset.rowIndex = String(idx);
    name.dataset.field = "name";
    // Direct focus tracking on input element
    name.addEventListener("focusin", () => {
      editorRowsFocused = true;
      pauseAutoQuoteRefresh();
      if (quoteRefreshAbortController) quoteRefreshAbortController.abort();
    });
    name.addEventListener("focusout", () => {
      setTimeout(() => {
        syncEditorRowsFocusedFromDom();
        if (!editorRowsFocused) {
          flushDeferredQuoteUiRefresh();
          resumeAutoQuoteRefresh();
        }
      }, 0);
    });
    name.addEventListener("focus", () => captureEditorFieldBaseline(name));
    name.addEventListener("focus", () => {
      name.dataset.originalName = String(formState[key][idx]?.name || "").trim();
    });
    name.addEventListener("input", () => {
      const wasComplete = isRowComplete(formState[key][idx]);
      const prevName = formState[key][idx].name;
      formState[key][idx].name = name.value;
      if (prevName !== name.value) {
        hasUnsavedAssetLiabilityChanges = true;
      }
      saveForm();
      updateEditorDuplicateWarnings(container, key);
      updateKPIs();
      if (!wasComplete && isRowComplete(formState[key][idx])) {
        persistSnapshotForActiveSelection({ render: false, onlyIfDirty: true, trackAction: false });
      }
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        name.blur();
      }
    });
    name.addEventListener("blur", (e) => {
      // Ignore synthetic blur triggered when rerender removes this input from the DOM.
      if (!e.target.isConnected) {
        setTimeout(flushDeferredQuoteUiRefresh, 0);
        return;
      }
      const before = consumeEditorFieldBaseline(name);
      runTrackedActionFromBefore(`${key}-name-edit`, before, () => {
        hasUnsavedAssetLiabilityChanges = true;
        const oldName = String(name.dataset.originalName || "").trim();
        const newName = String(name.value || "").trim();
        if ((key === "assets" || key === "liabilities") && oldName && newName && oldName !== newName) {
          const targetDate = editingSnapshotDate || mmddyy(new Date());
          propagateNameRenameAcrossSnapshots(key, oldName, newName, targetDate);
        }
        const next = e.relatedTarget;
        const stayingInSameRow = Boolean(next && wrap.contains(next));
        persistSnapshotForActiveSelection({ render: !stayingInSameRow, onlyIfDirty: false, trackAction: false });
      });
      setTimeout(flushDeferredQuoteUiRefresh, 0);
    });

    const amount = document.createElement("input");
    amount.type = "number";
    amount.min = "0";
    amount.step = stepForUnit(unitValue);
    amount.placeholder = "amount";
    amount.value = formatAmountInputValue(row.amount, unitValue);
    amount.dataset.rowKey = key;
    amount.dataset.rowIndex = String(idx);
    amount.dataset.field = "amount";
    // Direct focus tracking on input element
    amount.addEventListener("focusin", () => {
      editorRowsFocused = true;
      pauseAutoQuoteRefresh();
      if (quoteRefreshAbortController) quoteRefreshAbortController.abort();
    });
    amount.addEventListener("focusout", () => {
      setTimeout(() => {
        syncEditorRowsFocusedFromDom();
        if (!editorRowsFocused) {
          flushDeferredQuoteUiRefresh();
          resumeAutoQuoteRefresh();
        }
      }, 0);
    });
    amount.addEventListener("focus", () => captureEditorFieldBaseline(amount));
    amount.addEventListener("input", () => {
      const wasComplete = isRowComplete(formState[key][idx]);
      const prevAmount = formState[key][idx].amount;
      const next = amount.value === "" ? "" : Math.max(0, Number(amount.value));
      formState[key][idx].amount = next;
      // Once the user explicitly types an amount, the row is no longer "fresh"
      if (next !== "" && next !== 0) delete formState[key][idx]._fresh;
      if (String(prevAmount) !== String(next)) {
        hasUnsavedAssetLiabilityChanges = true;
      }
      saveForm();
      updateKPIs();
      if (!wasComplete && isRowComplete(formState[key][idx])) {
        persistSnapshotForActiveSelection({ render: false, onlyIfDirty: true, trackAction: false });
      }
    });
    amount.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        suppressNextEditorFocusRestore = true;
        pendingRowFieldFocus = null;
        amount.blur();
        setTimeout(() => {
          // Ensure Enter commits and the amount field does not retain focus.
          if (document.activeElement === amount) {
            amount.blur();
          }
          focusBodyWithoutScroll();
          editorRowsFocused = false;
        }, 0);
      }
      if (e.key === "Tab" && !e.shiftKey && (key === "assets" || key === "liabilities")) {
        // Keep focus flow predictable inside a row: Name -> Unit -> Amount
        e.preventDefault();
        const nextWrap = wrap.nextElementSibling;
        if (nextWrap) {
          const nextName = nextWrap.querySelector("input");
          if (nextName) {
            nextName.focus();
            nextName.select();
            return;
          }
        }
        const addBtn = document.querySelector(`.add-row-btn[data-target="${container.id}"]`);
        if (addBtn) addBtn.focus();
      }
    });
    amount.addEventListener("blur", (e) => {
      // Ignore synthetic blur triggered when rerender removes this input from the DOM.
      if (!e.target.isConnected) {
        setTimeout(flushDeferredQuoteUiRefresh, 0);
        return;
      }
      const before = consumeEditorFieldBaseline(amount);
      const cur = formState[key][idx].amount;
      if (cur !== "") {
        amount.value = formatAmountInputValue(cur, normalizeUnit(formState[key][idx].unit));
      }
      runTrackedActionFromBefore(`${key}-amount-edit`, before, () => {
        hasUnsavedAssetLiabilityChanges = true;
        const next = e.relatedTarget;
        const stayingInSameRow = Boolean(next && wrap.contains(next));
        persistSnapshotForActiveSelection({ render: !stayingInSameRow, onlyIfDirty: false, trackAction: false });
      });
      setTimeout(flushDeferredQuoteUiRefresh, 0);
    });

    let unit = null;
    if (key === "assets" || key === "liabilities") {
      unit = document.createElement("select");
      const optUsd = document.createElement("option");
      optUsd.value = "USD";
      optUsd.textContent = "USD";
      const optBtc = document.createElement("option");
      optBtc.value = "BTC";
      optBtc.textContent = "BTC";
      const optSats = document.createElement("option");
      optSats.value = "sats";
      optSats.textContent = "sats";
      unit.append(optUsd, optBtc, optSats);
      unit.value = unitValue;
      unit.dataset.rowKey = key;
      unit.dataset.rowIndex = String(idx);
      unit.dataset.field = "unit";
      // Direct focus tracking on select element
      unit.addEventListener("focusin", () => {
        editorRowsFocused = true;
        pauseAutoQuoteRefresh();
        if (quoteRefreshAbortController) quoteRefreshAbortController.abort();
      });
      unit.addEventListener("focusout", () => {
        setTimeout(() => {
          syncEditorRowsFocusedFromDom();
          if (!editorRowsFocused) {
            flushDeferredQuoteUiRefresh();
            resumeAutoQuoteRefresh();
          }
        }, 0);
      });
      unit.addEventListener("blur", () => {
        setTimeout(flushDeferredQuoteUiRefresh, 0);
      });
      unit.addEventListener("change", () => {
        pendingRowFieldFocus = { key, idx, field: "amount" };
        const before = trackedStateSnapshot();
        runTrackedActionFromBefore(`${key}-unit-edit`, before, () => {
          const rowName = String(formState[key][idx].name || "").trim();
          const prevUnit = normalizeUnit(formState[key][idx].unit);
          const nextUnit = normalizeUnit(unit.value);
          let nextAmount = formState[key][idx].amount;
          const parsedAmount = parseRowAmount(nextAmount);
          // Skip conversion for fresh rows (user hasn't committed an amount yet)
          const isFresh = Boolean(formState[key][idx]._fresh);
          if (!isFresh && Number.isFinite(parsedAmount)) {
            const datePrice = Number(historicalPrices[editingSnapshotDate]) || activeBtcusd();
            nextAmount = convertAmountBetweenUnits(parsedAmount, prevUnit, nextUnit, datePrice);
          }
          formState[key][idx].amount = nextAmount;
          formState[key][idx].unit = nextUnit;
          const targetDate = editingSnapshotDate || mmddyy(new Date());
          propagateUnitChangeAcrossSnapshots(key, rowName, prevUnit, nextUnit, targetDate);
          // Update the amount input display to match new unit formatting
          amount.step = stepForUnit(nextUnit);
          amount.value = formatAmountInputValue(nextAmount, nextUnit);
          hasUnsavedAssetLiabilityChanges = true;
          saveForm();
          // Drop focus from the select so render can run and restore focus to amount.
          unit.blur();
          persistSnapshotForActiveSelection({ render: true, onlyIfDirty: true, trackAction: false });
        });
      });

      name.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          unit.focus();
        }
      });

      unit.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          amount.focus();
          amount.select();
          return;
        }
        if (e.key !== "Tab" || e.shiftKey) return;
        e.preventDefault();
        amount.focus();
        amount.select();
      });
    }

    const del = document.createElement("button");
    del.className = "small-btn remove-btn";
    del.textContent = "×";
    del.title = "Remove";
    del.addEventListener("click", () => removeRow(key, idx));

    if (unit) {
      wrap.append(name, unit, amount, del);
    } else {
      wrap.append(name, amount, del);
    }
    container.appendChild(wrap);

    if (pendingRowFocus && pendingRowFocus.key === key && pendingRowFocus.idx === idx) {
      setTimeout(() => {
        name.focus();
      }, 0);
      pendingRowFocus = null;
    }

    if (pendingRowFieldFocus && pendingRowFieldFocus.key === key && pendingRowFieldFocus.idx === idx) {
      const focusTarget = pendingRowFieldFocus;
      pendingRowFieldFocus = null;
      setTimeout(() => {
        if (focusTarget.field === "unit") {
          const unitEl = wrap.querySelector("select");
          if (unitEl) unitEl.focus();
        } else if (focusTarget.field === "amount") {
          const amountEl = wrap.querySelector(`input[data-row-key="${key}"][data-field="amount"]`);
          if (amountEl) {
            amountEl.focus();
            amountEl.select();
          }
        }
      }, 0);
    }
  });

  updateEditorDuplicateWarnings(container, key);
}

function updateEditorDuplicateWarnings(container, key) {
  if (key !== "assets" && key !== "liabilities") return;
  const rows = formState[key] || [];
  const duplicates = duplicateRowIndices(rows);
  const hasUnnamed = rows.some((r) => !canonicalRowName(r?.name));
  const addBtn = document.querySelector(`.add-row-btn[data-target="${container.id}"]`);
  if (addBtn) {
    const blocked = duplicates.size > 0 || hasUnnamed;
    addBtn.disabled = blocked;
    addBtn.title = blocked
      ? "Resolve duplicate or unnamed rows before adding more"
      : (key === "assets" ? "Add Asset" : "Add Liability");
  }
  Array.from(container.children).forEach((wrap, idx) => {
    const isDuplicate = duplicates.has(idx);
    wrap.classList.toggle("row-editor-duplicate", isDuplicate);
    const nameInput = wrap.querySelector(`input[data-row-key="${key}"]`);
    if (nameInput) {
      nameInput.classList.toggle("duplicate-row-name", false);
      nameInput.title = "";
    }
    let warning = wrap.querySelector(".row-duplicate-warning");
    if (isDuplicate && !warning) {
      warning = document.createElement("span");
      warning.className = "row-duplicate-warning";
      warning.title = "Duplicated names are not allowed. Later duplicate rows are ignored until the duplication is resolved.";
      wrap.appendChild(warning);
    }
    if (isDuplicate && warning && nameInput) {
      warning.style.left = `${Math.max(2, nameInput.offsetLeft - 10)}px`;
      warning.style.top = `${nameInput.offsetTop + Math.round(nameInput.offsetHeight / 2)}px`;
    }
    if (!isDuplicate && warning) {
      warning.remove();
    }
  });
}

function renderHistoryTable() {
  // Preserve which accordion rows are currently open before rebuilding.
  const openDates = new Set();
  document.querySelectorAll(".history-accordion-row.open").forEach((row) => {
    if (row.dataset.snapshotDate) openDates.add(row.dataset.snapshotDate);
  });

  el.historyTableBody.innerHTML = "";
  const today = mmddyy(new Date());
  const historyRows = snapshots
    .slice()
    .sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date));
  if (!historyRows.some((s) => s.date === today)) {
    const todaySnap = todayHistoryRowSnapshot();
    if (todaySnap) {
      historyRows.unshift(todaySnap);
    }
  }

  historyRows.forEach((snap) => {
    const tr = document.createElement("tr");
    tr.classList.toggle("active-snapshot", snap.date === editingSnapshotDate);
    tr.title = "Click to load and edit this snapshot";
    tr.innerHTML = `
      <td><button class="history-toggle-btn" type="button" title="Show comment" aria-hidden="true">></button>${formatDisplayDate(snap.date)}</td>
      <td>${formatUsd(snap.btcusd)}</td>
      <td>${formatBtc(snap.totals.net_btc)}</td>
      <td>${formatUsd(snap.totals.net_usd)}</td>
      <td class="history-actions-cell"><button class="small-btn history-delete-btn" type="button" title="Delete snapshot" ${snap.synthetic ? 'style="visibility:hidden"' : ""}>×</button></td>
    `;
    tr.addEventListener("click", (e) => {
      if (!e.target.closest(".history-toggle-btn") && !e.target.closest(".history-delete-btn")) {
        selectSnapshot(snap.date);
      }
    });
    
    const toggleBtn = tr.querySelector(".history-toggle-btn");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const accordionRow = tr.nextElementSibling;
        if (accordionRow && accordionRow.classList.contains("history-accordion-row")) {
          accordionRow.classList.toggle("open");
          toggleBtn.classList.toggle("open");
        }
      });
    }
    
    if (!snap.synthetic) {
      const delBtn = tr.querySelector(".history-delete-btn");
      if (delBtn) {
        delBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          deleteSnapshot(snap.date);
        });
      }
    }
    el.historyTableBody.appendChild(tr);
    
    // Add accordion row for comments
    const accordionRow = document.createElement("tr");
    accordionRow.classList.add("history-accordion-row");
    accordionRow.dataset.snapshotDate = snap.date;
    accordionRow.innerHTML = `
      <td colspan="6" class="history-accordion-content">
        <textarea class="snapshot-comment-field" placeholder="Add a comment for this snapshot..." rows="3">${snap.comments || ""}</textarea>
      </td>
    `;
    
    const commentField = accordionRow.querySelector(".snapshot-comment-field");
    if (commentField) {
      commentField.addEventListener("focusin", () => {
        editorRowsFocused = true;
        pauseAutoQuoteRefresh();
        if (quoteRefreshAbortController) quoteRefreshAbortController.abort();
      });
      commentField.addEventListener("focusout", () => {
        setTimeout(() => {
          syncEditorRowsFocusedFromDom();
          if (!editorRowsFocused) {
            flushDeferredQuoteUiRefresh();
            resumeAutoQuoteRefresh();
          }
        }, 0);
      });
      commentField.addEventListener("blur", () => {
        const comment = commentField.value;
        
        if (snap.synthetic) {
          // If synthetic row has a comment, create a real snapshot for today
          if (!comment.trim()) return;
          
          const today = mmddyy(new Date());
          // Update formState so normalizedSnapshot captures the comment
          formState.comments = comment;
          saveForm();
          editingSnapshotDate = today;
          // Let persistSnapshotForActiveSelection create the real snapshot from formState
          persistSnapshotForActiveSelection({ render: false, trackAction: false });
          // Re-render history table only (preserves open accordions via openDates)
          renderHistoryTable();
          return;
        }
        
        const snapIdx = snapshots.findIndex((s) => s.date === snap.date);
        if (snapIdx >= 0) {
          snapshots[snapIdx].comments = comment;
          if (editingSnapshotDate === snap.date) {
            formState.comments = comment;
            saveForm();
          }
          persistSnapshotForActiveSelection({ render: false, trackAction: false });
        }
      });
    }
    
    el.historyTableBody.appendChild(accordionRow);

    // Restore open state if this accordion was open before the re-render.
    if (openDates.has(snap.date)) {
      accordionRow.classList.add("open");
      toggleBtn && toggleBtn.classList.add("open");
    }
  });
  el.historyCount.textContent = `${snapshots.length} snapshot${snapshots.length === 1 ? "" : "s"}`;
}

function captureEditorFocusState() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLSelectElement)) return null;
  const rowKey = active.dataset.rowKey;
  const rowIndex = active.dataset.rowIndex;
  const field = active.dataset.field;
  if (!rowKey || rowIndex === undefined || !field) return null;
  const state = { rowKey, rowIndex, field };
  if (active instanceof HTMLInputElement) {
    state.selectionStart = active.selectionStart;
    state.selectionEnd = active.selectionEnd;
  }
  return state;
}

function restoreEditorFocusState(state) {
  if (!state) return;
  const target = document.querySelector(
    `[data-row-key="${state.rowKey}"][data-row-index="${state.rowIndex}"][data-field="${state.field}"]`
  );
  if (!target || !(target instanceof HTMLElement)) return;
  target.focus();
  if (target instanceof HTMLInputElement && Number.isInteger(state.selectionStart) && Number.isInteger(state.selectionEnd)) {
    try {
      target.setSelectionRange(state.selectionStart, state.selectionEnd);
    } catch {
      // Ignore unsupported input types.
    }
  }
}

function updateKPIs() {
  const today = mmddyy(new Date());
  const isHistorical = editingSnapshotDate && editingSnapshotDate !== today;
  const existingSnap = isHistorical ? snapshots.find((s) => s.date === editingSnapshotDate) : null;
  const historicalPrice = existingSnap && Number(existingSnap.btcusd) > 0
    ? Number(existingSnap.btcusd)
    : (isHistorical && Number(historicalPrices[editingSnapshotDate]) > 0
        ? Number(historicalPrices[editingSnapshotDate])
        : null);
  const displayPrice = historicalPrice !== null ? historicalPrice : activeBtcusd();
  const snap = applyExclusionFilters(normalizedSnapshot(displayPrice), excludedAssets, excludedLiabilities, displayPrice);
  el.assetsMetric.textContent = formatBtc(snap.totals.assets_btc);
  el.assetsMetricUsd.textContent = formatUsd(snap.totals.assets_usd);
  el.liabilitiesMetric.textContent = formatBtc(snap.totals.liabilities_btc);
  el.liabilitiesMetricUsd.textContent = formatUsd(snap.totals.liabilities_usd);
  el.netMetric.textContent = formatBtc(snap.totals.net_btc);
  el.netMetricUsd.textContent = formatUsd(snap.totals.net_usd);
  
  // Update pie charts
  renderNetWorthPieChart(snap);
  renderAssetsPieChart(snap);
  renderLiabilitiesPieChart(snap);
}

function renderNetWorthPieChart(snap) {
  const canvas = document.getElementById("netWorthPieChart");
  if (!canvas) return;
  
  const assets = Number(snap.totals.assets_btc || 0);
  const liabilities = Number(snap.totals.liabilities_btc || 0);
  const total = assets + liabilities;
  
  const slices = [];
  if (total > 0) {
    slices.push({ name: "Assets", value: assets, color: "#39d7a4" });
    slices.push({ name: "Liabilities", value: liabilities, color: "#ef6f6c" });
  }
  
  metricPieChartState.netWorth.slices = slices;
  drawMetricPieChart(canvas, slices, metricPieChartState.netWorth.hoveredIndex, "netWorth");
}

function darkenHexColor(hex, amount) {
  const cleaned = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return hex;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  const factor = Math.max(0, Math.min(1, 1 - Number(amount || 0)));
  const rr = clamp(r * factor).toString(16).padStart(2, "0");
  const gg = clamp(g * factor).toString(16).padStart(2, "0");
  const bb = clamp(b * factor).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

function renderAssetsPieChart(snap) {
  const canvas = document.getElementById("assetsPieChart");
  if (!canvas) return;
  
  const assets = snap.assets || [];
  const btcusd = snap.btcusd || formState.btcusd || 1;
  
  const slices = assets
    .map((a) => {
      let btcValue = 0;
      if (a.unit === "BTC") {
        btcValue = Number(a.value || 0);
      } else {
        btcValue = Number(a.value || 0) / btcusd;
      }
      return { name: a.name, value: btcValue };
    })
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  
  // Start at KPI green, then darken each subsequent slice.
  const baseGreen = "#39d7a4";
  slices.forEach((s, i) => {
    const darkenAmount = Math.min(i * 0.09, 0.72);
    s.color = darkenHexColor(baseGreen, darkenAmount);
  });
  
  metricPieChartState.assets.slices = slices;
  drawMetricPieChart(canvas, slices, metricPieChartState.assets.hoveredIndex, "assets");
}

function renderLiabilitiesPieChart(snap) {
  const canvas = document.getElementById("liabilitiesPieChart");
  if (!canvas) return;
  
  const liabilities = snap.liabilities || [];
  const btcusd = snap.btcusd || formState.btcusd || 1;
  
  const slices = liabilities
    .map((l) => {
      let btcValue = 0;
      if (l.unit === "BTC") {
        btcValue = Number(l.value || 0);
      } else {
        btcValue = Number(l.value || 0) / btcusd;
      }
      return { name: l.name, value: btcValue };
    })
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);
  
  // Start at KPI red, then darken each subsequent slice.
  const baseRed = "#ef6f6c";
  slices.forEach((s, i) => {
    const darkenAmount = Math.min(i * 0.09, 0.72);
    s.color = darkenHexColor(baseRed, darkenAmount);
  });
  
  metricPieChartState.liabilities.slices = slices;
  drawMetricPieChart(canvas, slices, metricPieChartState.liabilities.hoveredIndex, "liabilities");
}

function drawMetricPieChart(canvas, slices, hoveredIndex, chartType) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  
  // Set canvas resolution for crisp rendering
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  
  ctx.scale(dpr, dpr);
  
  const w = rect.width;
  const h = rect.height;
  const centerX = w / 2;
  const centerY = h / 2;
  
  // Calculate radius to fit nicely with equal spacing
  const maxRadius = Math.min(w, h) / 2;
  const spacing = 6; // pixels for spacing
  const radius = Math.max(maxRadius - spacing, 20);
  
  if (!slices.length || slices.every(s => s.value === 0)) {
    // No data
    ctx.fillStyle = themeValue("--muted");
    ctx.font = "12px Space Grotesk";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("—", centerX, centerY);
    return;
  }
  
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return;

  let hoveredStartAngle = null;
  let hoveredEndAngle = null;
  const seamAngle = -Math.PI / 2;
  const dividerLineWidth = 0.6;
  const separatorAngles = [];
  
  // Draw pie slices starting from top (12 o'clock = -Math.PI / 2)
  let currentAngle = seamAngle;
  
  slices.forEach((slice, index) => {
    const sliceAngle = (slice.value / total) * 2 * Math.PI;
    const startAngle = currentAngle;
    const endAngle = currentAngle + sliceAngle;
    
    // Draw slice
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, startAngle, endAngle);
    ctx.closePath();
    
    // Fill slice
    ctx.fillStyle = slice.color;
    ctx.fill();

    if (index === hoveredIndex) {
      hoveredStartAngle = startAngle;
      hoveredEndAngle = endAngle;
    }
    
    // Draw separators only between adjacent slices.
    // Skip the last edge and draw the seam once after the loop.
    if (index < slices.length - 1) {
      separatorAngles.push(endAngle);
    }
    
    currentAngle = endAngle;
  });

  if (slices.length > 1) {
    separatorAngles.push(seamAngle);

    const twoPi = 2 * Math.PI;
    const normalizeAngle = (a) => {
      let out = a % twoPi;
      if (out < 0) out += twoPi;
      return out;
    };

    const dedupeThreshold = 1.5 / Math.max(radius, 1); // about 1.5px at edge
    const normalized = separatorAngles.map(normalizeAngle).sort((a, b) => a - b);
    const unique = [];
    normalized.forEach((a) => {
      if (!unique.length || Math.abs(a - unique[unique.length - 1]) > dedupeThreshold) {
        unique.push(a);
      }
    });
    if (unique.length > 1) {
      const wrapGap = (unique[0] + twoPi) - unique[unique.length - 1];
      if (wrapGap <= dedupeThreshold) unique.shift();
    }

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = dividerLineWidth;
    unique.forEach((angle) => {
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius
      );
      ctx.stroke();
    });
  }

  // Outer rim matches divider styling for a clean pie edge in all themes.
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = dividerLineWidth;
  ctx.stroke();

  // Draw hovered slice outline last so it always overlays delimiter lines.
  if (hoveredStartAngle !== null && hoveredEndAngle !== null) {
    ctx.beginPath();
    ctx.moveTo(centerX, centerY);
    ctx.arc(centerX, centerY, radius, hoveredStartAngle, hoveredEndAngle);
    ctx.closePath();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  
  // Store slice info for hit testing
  metricPieChartState[chartType].slices = slices;
}

function getMetricPieChartSliceAtPoint(canvas, x, y, chartType) {
  const rect = canvas.getBoundingClientRect();
  const localX = x - rect.left;
  const localY = y - rect.top;
  
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  
  const maxRadius = Math.min(rect.width, rect.height) / 2;
  const spacing = 8;
  const radius = Math.max(maxRadius - spacing, 20);
  
  const dx = localX - centerX;
  const dy = localY - centerY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  
  if (distance > radius || distance < 2) return -1; // Outside pie or too close to center
  
  const angle = Math.atan2(dy, dx) + Math.PI / 2; // Adjust to start from top
  const normalizedAngle = angle < 0 ? angle + 2 * Math.PI : angle;
  
  const slices = metricPieChartState[chartType].slices;
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return -1;
  
  let currentAngle = 0;
  for (let i = 0; i < slices.length; i++) {
    const sliceAngle = (slices[i].value / total) * 2 * Math.PI;
    if (normalizedAngle >= currentAngle && normalizedAngle < currentAngle + sliceAngle) {
      return i;
    }
    currentAngle += sliceAngle;
  }
  
  return -1;
}

function showMetricPieChartTooltip(canvas, x, y, chartType) {
  const sliceIndex = getMetricPieChartSliceAtPoint(canvas, x, y, chartType);
  const state = metricPieChartState[chartType];
  
  if (sliceIndex !== state.hoveredIndex) {
    state.hoveredIndex = sliceIndex;
    
    if (chartType === "netWorth") {
      const snap = getDisplaySnapshot();
      renderNetWorthPieChart(snap);
    } else if (chartType === "assets") {
      const snap = getDisplaySnapshot();
      renderAssetsPieChart(snap);
    } else if (chartType === "liabilities") {
      const snap = getDisplaySnapshot();
      renderLiabilitiesPieChart(snap);
    }
  }
  
  // Show tooltip if hovering over a slice
  if (sliceIndex >= 0) {
    const slices = state.slices;
    const slice = slices[sliceIndex];
    const tooltipText = `${slice.name}: ${Number(slice.value).toFixed(8)} BTC`;
    
    showMetricPieTooltip(canvas, x, y, tooltipText);
  } else {
    hideMetricPieTooltip();
  }
}

let metricPieTooltipEl = null;

function showMetricPieTooltip(canvas, mouseX, mouseY, text) {
  if (!metricPieTooltipEl) {
    metricPieTooltipEl = document.createElement("div");
    metricPieTooltipEl.className = "metric-pie-tooltip";
    document.body.appendChild(metricPieTooltipEl);
  }
  
  metricPieTooltipEl.textContent = text;
  metricPieTooltipEl.style.display = "block";
  
  // Position tooltip with offset from cursor
  const offsetX = 10;
  const offsetY = 10;
  metricPieTooltipEl.style.left = (mouseX + offsetX) + "px";
  metricPieTooltipEl.style.top = (mouseY + offsetY) + "px";
  
  // Ensure tooltip doesn't go off-screen
  requestAnimationFrame(() => {
    const rect = metricPieTooltipEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      metricPieTooltipEl.style.left = (mouseX - rect.width - offsetX) + "px";
    }
    if (rect.bottom > window.innerHeight) {
      metricPieTooltipEl.style.top = (mouseY - rect.height - offsetY) + "px";
    }
  });
}

function hideMetricPieTooltip() {
  if (metricPieTooltipEl) {
    metricPieTooltipEl.style.display = "none";
  }
}

function getDisplaySnapshot() {
  const today = mmddyy(new Date());
  const isHistorical = editingSnapshotDate && editingSnapshotDate !== today;
  const existingSnap = isHistorical ? snapshots.find((s) => s.date === editingSnapshotDate) : null;
  const historicalPrice = existingSnap && Number(existingSnap.btcusd) > 0
    ? Number(existingSnap.btcusd)
    : (isHistorical && Number(historicalPrices[editingSnapshotDate]) > 0
        ? Number(historicalPrices[editingSnapshotDate])
        : null);
  const displayPrice = historicalPrice !== null ? historicalPrice : activeBtcusd();
  return applyExclusionFilters(normalizedSnapshot(displayPrice), excludedAssets, excludedLiabilities, displayPrice);
}

function renderAll() {
  // GUARD: Never rerender while an editor row field is actively focused
  // This prevents focus loss and partial saves during user editing
  if (isAssetLiabilityEditorFocused()) {
    return;
  }
  
  const editorFocus = captureEditorFocusState();
  const displayDate = formatDisplayDate(editingSnapshotDate);
  const aCount = formState.assets.length;
  const lCount = formState.liabilities.length;
  el.assetsPanelTitle.textContent = `Assets on ${displayDate}`;
  el.assetsCount.textContent = `${aCount} item${aCount === 1 ? "" : "s"}`;
  el.liabilitiesPanelTitle.textContent = `Liabilities on ${displayDate}`;
  el.liabilitiesCount.textContent = `${lCount} item${lCount === 1 ? "" : "s"}`;
  renderEditor(el.assetsRows, "assets");
  renderEditor(el.liabilitiesRows, "liabilities");

  const today = mmddyy(new Date());
  const isHistorical = editingSnapshotDate && editingSnapshotDate !== today;
  const existingSnap = isHistorical ? snapshots.find((s) => s.date === editingSnapshotDate) : null;
  const historicalPrice = existingSnap && Number(existingSnap.btcusd) > 0
    ? Number(existingSnap.btcusd)
    : (isHistorical && Number(historicalPrices[editingSnapshotDate]) > 0
        ? Number(historicalPrices[editingSnapshotDate])
        : null);
  const displayPrice = historicalPrice !== null ? historicalPrice : activeBtcusd();
  const snap = applyExclusionFilters(normalizedSnapshot(displayPrice), excludedAssets, excludedLiabilities, displayPrice);
  const chartSnapshots = snapshotsForCharts(displayPrice);

  const manualActive = isManualOverrideActive();
  const manualDisplayValue = manualActive
    ? Number(formState.manualBtcusd)
    : Number(formState.btcusd || 0);
  if (document.activeElement !== el.manualBtcusd) {
    el.manualBtcusd.value = manualDisplayValue > 0 ? formatUsd(manualDisplayValue) : "";
  }
  el.quoteTime.textContent = manualActive
    ? "Manual price override"
    : (formState.btcusd ? `Updated · ${formatQuoteTimestamp(lastQuoteRefreshAt || new Date())}` : "No quote loaded");

  el.assetsMetric.textContent = formatBtc(snap.totals.assets_btc);
  el.assetsMetricUsd.textContent = formatUsd(snap.totals.assets_usd);
  el.liabilitiesMetric.textContent = formatBtc(snap.totals.liabilities_btc);
  el.liabilitiesMetricUsd.textContent = formatUsd(snap.totals.liabilities_usd);
  el.netMetric.textContent = formatBtc(snap.totals.net_btc);
  el.netMetricUsd.textContent = formatUsd(snap.totals.net_usd);

  renderNetWorthPieChart(snap);
  renderAssetsPieChart(snap);
  renderLiabilitiesPieChart(snap);

  renderHistoryTable();
  populateFilterDropdowns();
  renderChartsOnly();
  if (editorFocus && !suppressNextEditorFocusRestore) {
    restoreEditorFocusState(editorFocus);
  }
  suppressNextEditorFocusRestore = false;
}

function computeTotals(assets, liabilities, btcusd) {
  const p = Math.max(Number(btcusd) || 0, 1e-12);
  const assetRows = (assets || []).map((a) => ({ name: a.name, amount: a.value, unit: a.unit }));
  const liabilityRows = (liabilities || []).map((l) => ({ name: l.name, amount: l.value, unit: l.unit }));
  const splitA = splitAssetRows(assetRows);
  const splitL = splitLiabilityRows(liabilityRows);
  const aB = splitA.assetsBtc; const aU = splitA.assetsUsd;
  const lB = splitL.liabilitiesBtc; const lU = splitL.liabilitiesUsd;
  Object.entries(aB).forEach(([n, v]) => { aU[n] = v * p; });
  Object.entries(aU).forEach(([n, v]) => { aB[n] = v / p; });
  Object.entries(lB).forEach(([n, v]) => { lU[n] = v * p; });
  Object.entries(lU).forEach(([n, v]) => { lB[n] = v / p; });
  const tAB = sum(Object.values(aB)); const tAU = sum(Object.values(aU));
  const tLB = sum(Object.values(lB)); const tLU = sum(Object.values(lU));
  return { assets_btc: tAB, assets_usd: tAU, liabilities_btc: tLB, liabilities_usd: tLU, net_btc: tAB - tLB, net_usd: tAU - tLU };
}

function applyExclusionFilters(snap, exclAssets, exclLiabs, priceOverride) {
  if (!exclAssets?.size && !exclLiabs?.size) return snap;
  const filteredA = exclAssets?.size ? (snap.assets || []).filter(a => !exclAssets.has(a.name)) : (snap.assets || []);
  const filteredL = exclLiabs?.size ? (snap.liabilities || []).filter(l => !exclLiabs.has(l.name)) : (snap.liabilities || []);
  const price = priceOverride !== undefined ? priceOverride : Number(snap.btcusd || 0);
  return { ...snap, assets: filteredA, liabilities: filteredL, totals: computeTotals(filteredA, filteredL, price) };
}

function snapshotsForCharts(displayPrice, exclAssets, exclLiabs) {
  const today = mmddyy(new Date());
  const todayMs = parseMMDDYY(today).getTime();
  const sorted = snapshots.slice().sort((a, b) => parseMMDDYY(a.date) - parseMMDDYY(b.date));
  const snapshotByDate = new Map(sorted.map((s) => [s.date, s]));
  const hasEnteredFormRows = comparableRowsFromForm(formState.assets).length > 0 || comparableRowsFromForm(formState.liabilities).length > 0;

  // No historical prices loaded yet — fall back to sparse snapshot list
  if (Object.keys(historicalPrices).length === 0) {
    const syntheticToday = todayHistoryRowSnapshot();
    const baseList = sorted.some((s) => s.date === today)
      ? sorted
      : (syntheticToday && (sorted.length > 0 || hasEnteredFormRows))
        ? [...sorted, syntheticToday].sort((a, b) => parseMMDDYY(a.date) - parseMMDDYY(b.date))
        : sorted;
    const list = baseList.map((s) => applyExclusionFilters({ ...s, totals: { ...s.totals } }, exclAssets, exclLiabs));
    if (Number.isFinite(displayPrice) && displayPrice > 0 && isManualOverrideActive()) {
      const live = applyExclusionFilters(normalizedSnapshot(displayPrice), exclAssets, exclLiabs, displayPrice);
      const idx = list.findIndex((s) => s.date === today);
      if (idx >= 0) list[idx] = live;
      else { list.push(live); list.sort((a, b) => parseMMDDYY(a.date) - parseMMDDYY(b.date)); }
    }
    return list;
  }

  // If no saved snapshots, use the synthetic today row (current formState) so charts draw immediately
  if (!sorted.length) {
    if (!hasEnteredFormRows) return [];
    const syntheticToday = todayHistoryRowSnapshot();
    return syntheticToday ? [applyExclusionFilters(syntheticToday, exclAssets, exclLiabs)] : [];
  }

  // Pre-compute snapshot timestamps for efficient carry-forward lookup
  const snapMs = sorted.map((s) => parseMMDDYY(s.date).getTime());
  const result = [];
  const cur = new Date(snapMs[0]);
  let si = 0;

  while (cur.getTime() <= todayMs) {
    const curMs = cur.getTime();
    // Advance pointer to last snapshot on or before cur
    while (si + 1 < sorted.length && snapMs[si + 1] <= curMs) si++;
    const snap = sorted[si];
    const dateKey = mmddyy(cur);
    const exactSnapshot = snapshotByDate.get(dateKey);

    let price;
    if (dateKey === today) {
      price = Number.isFinite(displayPrice) && displayPrice > 0 ? displayPrice : Number(snap.btcusd || 0);
    } else {
      // Snapshot dates must use their recorded exchange rate.
      if (exactSnapshot && Number(exactSnapshot.btcusd) > 0) {
        price = Number(exactSnapshot.btcusd);
      } else {
        price = Number(historicalPrices[dateKey] || 0);
        // Keep chart continuity when historical feed doesn't cover this date.
        if (price <= 0 && Number(snap.btcusd) > 0) {
          price = Number(snap.btcusd);
        }
      }
    }
    if (price <= 0) { cur.setDate(cur.getDate() + 1); continue; }

    let totals;
    if (dateKey === today && isManualOverrideActive()) {
      const live = applyExclusionFilters(normalizedSnapshot(price), exclAssets, exclLiabs, price);
      totals = live.totals;
    } else {
      const filteredA = exclAssets?.size ? (snap.assets || []).filter(a => !exclAssets.has(a.name)) : (snap.assets || []);
      const filteredL = exclLiabs?.size ? (snap.liabilities || []).filter(l => !exclLiabs.has(l.name)) : (snap.liabilities || []);
      totals = computeTotals(filteredA, filteredL, price);
    }

    result.push({ date: dateKey, btcusd: price, totals });
    cur.setDate(cur.getDate() + 1);
  }

  return result;
}

function niceTicks(lo, hi, targetCount = 5) {
  const range = hi - lo;
  if (range === 0) return { ticks: [lo], step: 1 };
  const roughStep = range / Math.max(targetCount - 1, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const norm = roughStep / mag;
  const ladder = [1, 2, 2.5, 5, 10];
  // Choose the nearest "nice" step to avoid abrupt jumps when range changes slightly.
  let niceNorm = ladder[0];
  let minDelta = Math.abs(norm - niceNorm);
  for (let i = 1; i < ladder.length; i++) {
    const candidate = ladder[i];
    const delta = Math.abs(norm - candidate);
    if (delta < minDelta || (Math.abs(delta - minDelta) < 1e-9 && candidate < niceNorm)) {
      minDelta = delta;
      niceNorm = candidate;
    }
  }
  const step = niceNorm * mag;
  const tMin = Math.floor(lo / step) * step;
  const tMax = Math.ceil(hi / step) * step;
  const n = Math.round((tMax - tMin) / step);
  const ticks = Array.from({ length: n + 1 }, (_, i) =>
    Math.round((tMin + i * step) * 1e10) / 1e10
  );
  return { ticks, step };
}

function formatTickValue(v, step, isPercent) {
  const absMag = step > 0 ? Math.floor(Math.log10(step)) : 0;
  const isHalfStep = Math.abs((step / Math.pow(10, absMag)) - 2.5) < 1e-9;
  const decimals = isHalfStep ? Math.max(0, 1 - absMag) : Math.max(0, -absMag);
  return v.toFixed(decimals) + (isPercent ? '%' : '');
}

function thinDateTicks(candidates, maxTicks = 8) {
  if (candidates.length <= maxTicks) return candidates;
  const out = [];
  const step = (candidates.length - 1) / (maxTicks - 1);
  for (let i = 0; i < maxTicks; i++) {
    out.push(candidates[Math.round(i * step)]);
  }
  return out.filter((t, i, arr) => i === 0 || t.i !== arr[i - 1].i);
}

function buildDateLabelTicks(labels, maxTicks = 8) {
  if (!labels.length) return [];
  const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const endpointLabel = (d) => (d.getMonth() === 0 && d.getDate() === 1)
    ? String(d.getFullYear())
    : `${d.getMonth() + 1}/${d.getDate()}`;
  const parsed = labels.map((l) => (/^\d{6}$/.test(l) ? parseMMDDYY(l) : null));
  if (parsed.some((d) => !d)) return [];

  const n = labels.length;
  const spanDays = Math.max(0, Math.round((parsed[n - 1].getTime() - parsed[0].getTime()) / 86400000));

  if (spanDays <= 45) {
    const tickCount = Math.min(maxTicks, n);
    const ticks = [];
    for (let k = 0; k < tickCount; k++) {
      const i = tickCount === 1 ? 0 : Math.round((k * (n - 1)) / (tickCount - 1));
      const d = parsed[i];
      ticks.push({ i, text: `${d.getMonth() + 1}/${d.getDate()}` });
    }
    return ticks.filter((t, idx, arr) => idx === 0 || t.i !== arr[idx - 1].i);
  }

  if (spanDays <= 730) {
    const monthStarts = [];
    parsed.forEach((d, i) => {
      if (d.getDate() === 1) {
        monthStarts.push({ i, d });
      }
    });
    if (!monthStarts.length) return [];

    const allowedSteps = [1, 2, 3, 4, 6];
    let chosenStep = 6;
    for (const step of allowedSteps) {
      const count = monthStarts.filter(({ d }) => ((d.getFullYear() * 12 + d.getMonth()) % step) === 0).length;
      if (count > 0 && count <= maxTicks) {
        chosenStep = step;
        break;
      }
    }

    const ticks = monthStarts
      .filter(({ d }) => ((d.getFullYear() * 12 + d.getMonth()) % chosenStep) === 0)
      .map(({ i, d }) => {
        const month = d.getMonth();
        return { i, text: month === 0 ? String(d.getFullYear()) : monthShort[month] };
      });

    return ticks;
  }

  const yearCandidates = [];
  parsed.forEach((d, i) => {
    if (d.getMonth() === 0 && d.getDate() === 1) {
      yearCandidates.push({ i, text: String(d.getFullYear()) });
    }
  });
  if (!yearCandidates.length || yearCandidates[0].i !== 0) {
    yearCandidates.unshift({ i: 0, text: endpointLabel(parsed[0]) });
  }
  if (yearCandidates[yearCandidates.length - 1].i !== n - 1) {
    yearCandidates.push({ i: n - 1, text: endpointLabel(parsed[n - 1]) });
  }
  return thinDateTicks(yearCandidates, maxTicks);
}

function formatChartTooltipValue(v, isPercent) {
  if (isPercent) return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  return Number(v).toFixed(6);
}

function buildAxisScale(values, {
  paddingPct = 0,
  paddingMinPct = null,
  paddingMaxPct = null,
  targetTicks = 5,
  includeZeroTick = false,
  includeZeroTickIfInRange = false,
  minZero = false
} = {}) {
  const nums = (values || []).map(Number).filter((v) => Number.isFinite(v));
  if (!nums.length) {
    return { dataMin: -1, dataMax: 1, min: -1, max: 1, ticks: [0], step: 1 };
  }

  let dataMin = Math.min(...nums);
  let dataMax = Math.max(...nums);
  if (dataMin === dataMax) {
    const expand = Math.abs(dataMin) || 1;
    dataMin -= expand;
    dataMax += expand;
  }

  const range = dataMax - dataMin;
  const defaultPadPct = Math.max(0, Number(paddingPct) || 0);
  const lowPadPct = paddingMinPct == null ? defaultPadPct : Math.max(0, Number(paddingMinPct) || 0);
  const highPadPct = paddingMaxPct == null ? defaultPadPct : Math.max(0, Number(paddingMaxPct) || 0);
  const lowPad = Math.abs(range) * lowPadPct;
  const highPad = Math.abs(range) * highPadPct;
  dataMin -= lowPad;
  dataMax += highPad;

  if (minZero) dataMin = Math.min(0, dataMin);
  if (includeZeroTick) {
    if (dataMin > 0) dataMin = 0;
    if (dataMax < 0) dataMax = 0;
  }
  if (dataMin === dataMax) {
    dataMin -= 1;
    dataMax += 1;
  }

  const { ticks: rawTicks, step } = niceTicks(dataMin, dataMax, targetTicks);
  const eps = 1e-9;
  const ticks = rawTicks.filter((t) => t >= dataMin - eps && t <= dataMax + eps);
  if (includeZeroTick && !ticks.some((t) => Math.abs(t) < eps)) ticks.push(0);
  if (!includeZeroTick && includeZeroTickIfInRange && dataMin <= eps && dataMax >= -eps && !ticks.some((t) => Math.abs(t) < eps)) {
    ticks.push(0);
  }
  ticks.sort((a, b) => a - b);

  return {
    dataMin,
    dataMax,
    min: dataMin,
    max: dataMax,
    ticks,
    step
  };
}

function drawLineChart(canvas, datasets, labels, opts = {}) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  // Canvas buffer is kept in sync with display pixels by ResizeObserver,
  // so font sizes in canvas pixels equal their intended CSS-pixel size.
  const dpr = window.devicePixelRatio || 1;
  const pad = {
    l: Math.round(CHART_PAD.l * Math.min(1, Math.max(0.5, (width / dpr) / 900))),
    r: CHART_PAD.r,
    t: CHART_PAD.t,
    b: CHART_PAD.b
  };
  const fs = (px) => px;
  const canvasBg = themeValue("--canvas-bg") || "rgba(0,0,0,0.42)";
  const chartTick = themeValue("--chart-tick") || "#a2a2a2";
  const chartGrid = themeValue("--chart-grid") || "rgba(255,255,255,0.14)";
  const chartAxis = themeValue("--chart-axis") || "rgba(255,255,255,0.28)";
  const chartMarker = themeValue("--chart-marker") || "#f5f5f5";
  const tooltipBg = themeValue("--chart-tooltip-bg") || "rgba(10,10,10,0.78)";
  const tooltipBorder = themeValue("--chart-tooltip-border") || "rgba(255,255,255,0.18)";
  const tooltipTitle = themeValue("--chart-tooltip-title") || "#f3f3f3";
  const tooltipText = themeValue("--chart-tooltip-text") || "#d0d0d0";
  const snapshotHighlightDot = themeValue("--snapshot-highlight-dot") || "#66b2ff";
  const snapshotHighlightRing = themeValue("--snapshot-highlight-ring") || "rgba(102,178,255,0.22)";

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = canvasBg;
  ctx.fillRect(0, 0, width, height);

  const allValues = datasets.flatMap((d) => d.values);
  if (!allValues.length) {
    ctx.fillStyle = chartTick;
    ctx.font = `${fs(30)}px Space Grotesk`;
    ctx.fillText(opts.emptyMessage || "No saved data yet. Add an asset or liability.", 28, 46);
    return;
  }

  const axis = opts.yAxisScale || buildAxisScale(allValues, {
    paddingPct: opts.axisPaddingPct || 0,
    paddingMinPct: opts.axisPaddingMinPct,
    paddingMaxPct: opts.axisPaddingMaxPct,
    includeZeroTick: Boolean(opts.includeZeroTick),
    includeZeroTickIfInRange: Boolean(opts.includeZeroTickIfInRange),
    minZero: Boolean(opts.minZero)
  });
  const ticks = axis.ticks;
  const step = axis.step;
  const min = axis.min;
  const max = axis.max;

  const x0 = pad.l;
  const y0 = height - pad.b;
  const chartW = width - pad.l - pad.r;
  const chartH = height - pad.t - pad.b;
  if (chartInteractionState[canvas.id]) {
    chartInteractionState[canvas.id].plotX0 = x0;
    chartInteractionState[canvas.id].plotW = chartW;
  }

  ctx.strokeStyle = chartGrid;
  ctx.lineWidth = 1;

  ctx.fillStyle = chartTick;
  ctx.font = `${fs(23)}px IBM Plex Mono`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  ticks.forEach((tickVal) => {
    const y = pad.t + ((max - tickVal) / (max - min)) * chartH;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + chartW, y);
    ctx.stroke();

    const yTickLabel = opts.yTickFormatter
      ? opts.yTickFormatter(tickVal, step)
      : formatTickValue(tickVal, step, Boolean(opts.percent)) + (opts.percent ? "" : (opts.yTickSuffix || ""));
    ctx.fillText(yTickLabel, x0 - 10, y + 1);
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  ctx.strokeStyle = chartAxis;
  ctx.beginPath();
  ctx.moveTo(x0, pad.t);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + chartW, y0);
  ctx.stroke();

  const labelToIndex = new Map(labels.map((d, i) => [d, i]));
  const markerDates = Array.isArray(opts.historyMarkerDates) ? opts.historyMarkerDates : [];
  const markerIndices = markerDates
    .map((d) => labelToIndex.get(d))
    .filter((i) => Number.isInteger(i));
  const seenMarker = new Set();
  ctx.fillStyle = chartMarker;
  markerIndices.forEach((i) => {
    if (seenMarker.has(i)) return;
    seenMarker.add(i);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    ctx.beginPath();
    ctx.arc(x, y0, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  if (opts.selectedHistoryDate && labelToIndex.has(opts.selectedHistoryDate)) {
    const i = labelToIndex.get(opts.selectedHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    // Large dot at the baseline behind the history marker for the selected date.
    ctx.fillStyle = snapshotHighlightRing;
    ctx.beginPath();
    ctx.arc(x, y0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = snapshotHighlightDot;
    ctx.beginPath();
    ctx.arc(x, y0, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (opts.hoveredHistoryDate && labelToIndex.has(opts.hoveredHistoryDate)) {
    const i = labelToIndex.get(opts.hoveredHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);

    ctx.strokeStyle = tooltipBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, y0);
    ctx.stroke();
  }

  // Draw lines in reverse order so dataset[0] (BTC) renders on top.
  datasets.slice().reverse().forEach((ds, revIdx) => {
    const idx = datasets.length - 1 - revIdx;
    ctx.strokeStyle = ds.color || COLORS[idx % COLORS.length];
    ctx.lineWidth = 3;
    if (labels.length > 1) {
      ctx.beginPath();
      ds.values.forEach((v, i) => {
        const x = chartXAtIndex(i, labels.length, x0, chartW);
        const y = pad.t + ((max - v) / (max - min)) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else if (ds.values.length === 1) {
      // Single point: render a centered scatter marker instead of a degenerate line.
      const x = chartXAtIndex(0, labels.length, x0, chartW);
      const y = pad.t + ((max - ds.values[0]) / (max - min)) * chartH;
      ctx.fillStyle = ds.color || COLORS[idx % COLORS.length];
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (opts.drawLegend !== false) {
    // Draw legend in original order so labels match tooltip ordering.
    datasets.forEach((ds, idx) => {
      const lx = x0 + 10;
      const ly = pad.t + 26 + idx * 26;
      ctx.fillStyle = ds.color || COLORS[idx % COLORS.length];
      ctx.fillRect(lx, ly - 10, 18, 3);
      ctx.fillStyle = tooltipText;
      ctx.font = `${fs(23)}px Space Grotesk`;
      ctx.fillText(ds.label, lx + 26, ly);
    });
  }

  // Draw tooltip on top of everything.
  if (opts.hoveredHistoryDate && labelToIndex.has(opts.hoveredHistoryDate)) {
    const i = labelToIndex.get(opts.hoveredHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);

    // lines: array of segment arrays [{text, color}]
    const lines = [[{ text: formatDisplayDate(opts.hoveredHistoryDate), color: tooltipTitle }]];
    datasets.forEach((ds) => {
      const val = Number(ds.values[i] || 0);
      const dsColor = ds.color || tooltipText;
      if (ds.rawValues && ds.rawFormatter) {
        const rawStr = ds.rawFormatter(ds.rawValues[i]);
        const pctStr = formatChartTooltipValue(val, true);
        const pctColor = val >= 0 ? "#39d7a4" : "#ff5555";
        lines.push([
          { text: `${rawStr} `, color: dsColor },
          { text: pctStr, color: pctColor }
        ]);
      } else {
        const pctStr = formatChartTooltipValue(val, Boolean(opts.percent));
        const pctColor = val >= 0 ? "#39d7a4" : "#ff5555";
        const valColor = opts.percent
          ? (opts.percentValueColor || pctColor)
          : dsColor;
        const valStr = ds.valueFormatter ? ds.valueFormatter(val) : pctStr;
        lines.push([{ text: valStr, color: valColor }]);
      }
    });

    ctx.font = `${fs(26)}px IBM Plex Mono`;
    const textW = Math.max(...lines.map((segs) => segs.reduce((w, s) => w + ctx.measureText(s.text).width, 0)));
    const boxW = textW + 16;
    const boxH = lines.length * 28 + 14;
    let boxX = x + 10;
    if (boxX + boxW > x0 + chartW) boxX = x - boxW - 10;
    const cursorY = (opts.hoverY != null) ? opts.hoverY : (pad.t + chartH / 2);
    const boxY = Math.max(pad.t, cursorY - boxH - 14);

    ctx.fillStyle = tooltipBg;
    ctx.strokeStyle = tooltipBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    lines.forEach((segs, li) => {
      let xOff = boxX + 8;
      segs.forEach((seg) => {
        ctx.fillStyle = seg.color;
        ctx.fillText(seg.text, xOff, boxY + 26 + li * 28);
        xOff += ctx.measureText(seg.text).width;
      });
    });
  }

  let xTicks = buildDateLabelTicks(labels, 8);
  if (!xTicks.length) {
    const xEvery = Math.max(1, Math.floor(labels.length / 6));
    xTicks = labels
      .map((label, i) => ({ label, i }))
      .filter((p) => p.i % xEvery === 0 || p.i === labels.length - 1)
      .map((p) => ({ i: p.i, text: p.label }));
  }

  ctx.fillStyle = chartTick;
  ctx.font = `${fs(23)}px IBM Plex Mono`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  xTicks.forEach((tick) => {
    const x = chartXAtIndex(tick.i, labels.length, x0, chartW);
    ctx.fillText(tick.text, x, y0 + 18);
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawLineChartDualYAxis(canvas, datasets, labels, opts = {}) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  const pad = {
    l: Math.round(CHART_PAD.l * Math.min(1, Math.max(0.5, (width / dpr) / 900))),
    r: 130,
    t: CHART_PAD.t,
    b: CHART_PAD.b
  };
  const fs = (px) => px;
  const canvasBg = themeValue("--canvas-bg") || "rgba(0,0,0,0.42)";
  const chartTick = themeValue("--chart-tick") || "#a2a2a2";
  const chartGrid = themeValue("--chart-grid") || "rgba(255,255,255,0.14)";
  const chartAxis = themeValue("--chart-axis") || "rgba(255,255,255,0.28)";
  const chartMarker = themeValue("--chart-marker") || "#f5f5f5";
  const tooltipBg = themeValue("--chart-tooltip-bg") || "rgba(10,10,10,0.78)";
  const tooltipBorder = themeValue("--chart-tooltip-border") || "rgba(255,255,255,0.18)";
  const tooltipTitle = themeValue("--chart-tooltip-title") || "#f3f3f3";
  const tooltipText = themeValue("--chart-tooltip-text") || "#d0d0d0";
  const snapshotHighlightDot = themeValue("--snapshot-highlight-dot") || "#66b2ff";
  const snapshotHighlightRing = themeValue("--snapshot-highlight-ring") || "rgba(102,178,255,0.22)";

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = canvasBg;
  ctx.fillRect(0, 0, width, height);

  if (!datasets.length || !datasets[0]?.values?.length || !datasets[1]?.values?.length) {
    ctx.fillStyle = chartTick;
    ctx.font = `${fs(30)}px Space Grotesk`;
    ctx.fillText(opts.emptyMessage || "No saved data yet. Add an asset or liability.", 28, 46);
    return;
  }

  const leftAxis = opts.leftAxisScale || buildAxisScale(datasets[0].values, {
    paddingPct: opts.axisPaddingPct || 0,
    paddingMinPct: opts.axisPaddingMinPct,
    paddingMaxPct: opts.axisPaddingMaxPct,
    includeZeroTick: Boolean(opts.includeZeroTick),
    includeZeroTickIfInRange: Boolean(opts.includeZeroTickIfInRange),
    minZero: Boolean(opts.minZero)
  });
  const rightAxis = opts.rightAxisScale || buildAxisScale(datasets[1].values, {
    paddingPct: opts.axisPaddingPct || 0,
    paddingMinPct: opts.axisPaddingMinPct,
    paddingMaxPct: opts.axisPaddingMaxPct,
    includeZeroTick: Boolean(opts.includeZeroTick),
    includeZeroTickIfInRange: Boolean(opts.includeZeroTickIfInRange),
    minZero: Boolean(opts.minZero)
  });

  const resetAxisBounds = (axis, min, max) => {
    const scale = buildAxisScale([min, max], {
      paddingPct: opts.axisPaddingPct || 0,
      paddingMinPct: opts.axisPaddingMinPct,
      paddingMaxPct: opts.axisPaddingMaxPct,
      includeZeroTick: Boolean(opts.includeZeroTick),
      includeZeroTickIfInRange: Boolean(opts.includeZeroTickIfInRange),
      minZero: Boolean(opts.minZero)
    });
    axis.dataMin = scale.dataMin;
    axis.dataMax = scale.dataMax;
    axis.min = scale.min;
    axis.max = scale.max;
    axis.ticks = scale.ticks;
    axis.step = scale.step;
  };

  if (opts.alignZero) {
    const globalMin = Math.min(leftAxis.dataMin, rightAxis.dataMin);
    const globalMax = Math.max(leftAxis.dataMax, rightAxis.dataMax);
    const denom = globalMax - globalMin;
    const zeroPos = denom > 0 ? (globalMax / denom) : 0.5;

    const forceZeroPosition = (axis) => {
      if (zeroPos >= 1) {
        const forcedMax = Math.max(axis.dataMax, 0);
        resetAxisBounds(axis, 0, forcedMax === 0 ? 1 : forcedMax);
        return;
      }
      if (zeroPos <= 0) {
        const forcedMin = Math.min(axis.dataMin, 0);
        resetAxisBounds(axis, forcedMin === 0 ? -1 : forcedMin, 0);
        return;
      }

      const maxNeededForMin = (-axis.dataMin * zeroPos) / (1 - zeroPos);
      const forcedMax = Math.max(axis.dataMax, maxNeededForMin);
      const forcedMin = -(forcedMax * (1 - zeroPos)) / zeroPos;
      resetAxisBounds(axis, forcedMin, forcedMax);
    };

    forceZeroPosition(leftAxis);
    forceZeroPosition(rightAxis);
  }

  const x0 = pad.l;
  const y0 = height - pad.b;
  const chartW = width - pad.l - pad.r;
  const chartH = height - pad.t - pad.b;
  if (chartInteractionState[canvas.id]) {
    chartInteractionState[canvas.id].plotX0 = x0;
    chartInteractionState[canvas.id].plotW = chartW;
  }

  ctx.strokeStyle = chartGrid;
  ctx.lineWidth = 1;
  leftAxis.ticks.forEach((tickVal) => {
    const y = pad.t + ((leftAxis.max - tickVal) / (leftAxis.max - leftAxis.min)) * chartH;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + chartW, y);
    ctx.stroke();
  });

  if (opts.rightAxisGridLines !== false) {
    ctx.save();
    ctx.strokeStyle = opts.rightAxisGridColor || chartGrid;
    ctx.lineWidth = 1;
    rightAxis.ticks.forEach((tickVal) => {
      const y = pad.t + ((rightAxis.max - tickVal) / (rightAxis.max - rightAxis.min)) * chartH;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + chartW, y);
      ctx.stroke();
    });
    ctx.restore();
  }

  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = `${fs(23)}px IBM Plex Mono`;
  leftAxis.ticks.forEach((tickVal) => {
    const y = pad.t + ((leftAxis.max - tickVal) / (leftAxis.max - leftAxis.min)) * chartH;
    const label = opts.yTickFormatter
      ? opts.yTickFormatter(tickVal, leftAxis.step, 0)
      : formatTickValue(tickVal, leftAxis.step, Boolean(opts.percent)) + (opts.percent ? "" : (opts.yTickSuffix || ""));
    ctx.fillStyle = opts.leftAxisColor || datasets[0].color || chartTick;
    ctx.fillText(label, x0 - 10, y + 1);
  });

  ctx.textAlign = "left";
  rightAxis.ticks.forEach((tickVal) => {
    const y = pad.t + ((rightAxis.max - tickVal) / (rightAxis.max - rightAxis.min)) * chartH;
    const label = opts.yTickFormatter
      ? opts.yTickFormatter(tickVal, rightAxis.step, 1)
      : formatTickValue(tickVal, rightAxis.step, Boolean(opts.percent)) + (opts.percent ? "" : (opts.yTickSuffix || ""));
    ctx.fillStyle = opts.rightAxisColor || datasets[1].color || chartTick;
    ctx.fillText(label, x0 + chartW + 10, y + 1);
  });

  ctx.strokeStyle = chartAxis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, pad.t);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0 + chartW, y0);
  ctx.moveTo(x0 + chartW, pad.t);
  ctx.lineTo(x0 + chartW, y0);
  ctx.stroke();

  const labelToIndex = new Map(labels.map((d, i) => [d, i]));
  const markerDates = Array.isArray(opts.historyMarkerDates) ? opts.historyMarkerDates : [];
  const markerIndices = markerDates
    .map((d) => labelToIndex.get(d))
    .filter((i) => Number.isInteger(i));
  const seenMarker = new Set();
  ctx.fillStyle = chartMarker;
  markerIndices.forEach((i) => {
    if (seenMarker.has(i)) return;
    seenMarker.add(i);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    ctx.beginPath();
    ctx.arc(x, y0, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  if (opts.selectedHistoryDate && labelToIndex.has(opts.selectedHistoryDate)) {
    const i = labelToIndex.get(opts.selectedHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    ctx.fillStyle = snapshotHighlightRing;
    ctx.beginPath();
    ctx.arc(x, y0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = snapshotHighlightDot;
    ctx.beginPath();
    ctx.arc(x, y0, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (opts.hoveredHistoryDate && labelToIndex.has(opts.hoveredHistoryDate)) {
    const i = labelToIndex.get(opts.hoveredHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    ctx.strokeStyle = tooltipBorder;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, y0);
    ctx.stroke();
  }

  datasets.slice().reverse().forEach((ds, revIdx) => {
    const idx = datasets.length - 1 - revIdx;
    const axis = idx === 0 ? leftAxis : rightAxis;
    ctx.strokeStyle = ds.color || COLORS[idx % COLORS.length];
    ctx.lineWidth = 3;
    if (labels.length > 1) {
      ctx.beginPath();
      ds.values.forEach((v, i) => {
        const x = chartXAtIndex(i, labels.length, x0, chartW);
        const y = pad.t + ((axis.max - v) / (axis.max - axis.min)) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else if (ds.values.length === 1) {
      const x = chartXAtIndex(0, labels.length, x0, chartW);
      const y = pad.t + ((axis.max - ds.values[0]) / (axis.max - axis.min)) * chartH;
      ctx.fillStyle = ds.color || COLORS[idx % COLORS.length];
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (opts.drawLegend !== false) {
    datasets.forEach((ds, idx) => {
      const lx = x0 + 10;
      const ly = pad.t + 26 + idx * 26;
      ctx.fillStyle = ds.color || COLORS[idx % COLORS.length];
      ctx.fillRect(lx, ly - 10, 18, 3);
      ctx.fillStyle = tooltipText;
      ctx.font = `${fs(23)}px Space Grotesk`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(ds.label, lx + 26, ly);
    });
  }

  if (opts.hoveredHistoryDate && labelToIndex.has(opts.hoveredHistoryDate)) {
    const i = labelToIndex.get(opts.hoveredHistoryDate);
    const x = chartXAtIndex(i, labels.length, x0, chartW);
    const lines = [[{ text: formatDisplayDate(opts.hoveredHistoryDate), color: tooltipTitle }]];
    datasets.forEach((ds) => {
      const val = Number(ds.values[i] || 0);
      const dsColor = ds.color || tooltipText;
      if (ds.rawValues && ds.rawFormatter) {
        const rawStr = ds.rawFormatter(ds.rawValues[i]);
        const pctStr = formatChartTooltipValue(val, true);
        const pctColor = val >= 0 ? "#39d7a4" : "#ff5555";
        lines.push([
          { text: `${rawStr} `, color: dsColor },
          { text: pctStr, color: pctColor }
        ]);
      } else {
        const pctStr = formatChartTooltipValue(val, Boolean(opts.percent));
        const pctColor = val >= 0 ? "#39d7a4" : "#ff5555";
        const valColor = opts.percent
          ? (opts.percentValueColor || pctColor)
          : dsColor;
        const valStr = ds.valueFormatter ? ds.valueFormatter(val) : pctStr;
        lines.push([{ text: valStr, color: valColor }]);
      }
    });

    ctx.font = `${fs(26)}px IBM Plex Mono`;
    const textW = Math.max(...lines.map((segs) => segs.reduce((w, s) => w + ctx.measureText(s.text).width, 0)));
    const boxW = textW + 16;
    const boxH = lines.length * 28 + 14;
    let boxX = x + 10;
    if (boxX + boxW > x0 + chartW) boxX = x - boxW - 10;
    const cursorY = (opts.hoverY != null) ? opts.hoverY : (pad.t + chartH / 2);
    const boxY = Math.max(pad.t, cursorY - boxH - 14);

    ctx.fillStyle = tooltipBg;
    ctx.strokeStyle = tooltipBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    lines.forEach((segs, li) => {
      let xOff = boxX + 8;
      segs.forEach((seg) => {
        ctx.fillStyle = seg.color;
        ctx.fillText(seg.text, xOff, boxY + 26 + li * 28);
        xOff += ctx.measureText(seg.text).width;
      });
    });
  }

  let xTicks = buildDateLabelTicks(labels, 8);
  if (!xTicks.length) {
    const xEvery = Math.max(1, Math.floor(labels.length / 6));
    xTicks = labels
      .map((label, i) => ({ label, i }))
      .filter((p) => p.i % xEvery === 0 || p.i === labels.length - 1)
      .map((p) => ({ i: p.i, text: p.label }));
  }

  ctx.fillStyle = chartTick;
  ctx.font = `${fs(23)}px IBM Plex Mono`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  xTicks.forEach((tick) => {
    const x = chartXAtIndex(tick.i, labels.length, x0, chartW);
    ctx.fillText(tick.text, x, y0 + 18);
  });
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function formatSatsCompact(sats) {
  if (sats === 0) return "0 sats";
  const abs = Math.abs(sats);
  if (abs >= 1e9) return (sats / 1e9).toFixed(Number.isInteger(sats / 1e9) ? 0 : 1) + "B sats";
  if (abs >= 1e6) return (sats / 1e6).toFixed(Number.isInteger(sats / 1e6) ? 0 : 1) + "M sats";
  if (abs >= 1e3) return (sats / 1e3).toFixed(Number.isInteger(sats / 1e3) ? 0 : 1) + "k sats";
  return sats + " sats";
}

function renderChartLegendRow(container, datasets = []) {
  if (!container) return;
  container.innerHTML = "";
  datasets.forEach((ds) => {
    const item = document.createElement("span");
    item.className = "chart-legend-item";

    const swatch = document.createElement("span");
    swatch.className = "chart-legend-swatch";
    swatch.style.backgroundColor = ds.color || themeValue("--chart-tooltip-text") || "#d0d0d0";

    const label = document.createElement("span");
    label.textContent = String(ds.label || "");

    item.appendChild(swatch);
    item.appendChild(label);
    container.appendChild(item);
  });
}

function renderAssetLiabilityChart(chartSnapshots = snapshots) {
  if (el.alChartTitle) {
    el.alChartTitle.textContent = alChartMode === "ratio"
      ? "Liabilities-to-Assets Ratio"
      : "Assets & Liabilities";
  }

  if (alChartMode === "ratio") {
    const allAssetNames = getAllAssetNames();
    const allAssetsExcluded = allAssetNames.length > 0 && excludedAssets.size >= allAssetNames.length;
    const plottedSnapshots = chartSnapshots.filter((s) => {
      const assetsBtc = Number(s.totals?.assets_btc || 0);
      return assetsBtc > 0;
    });

    if (!plottedSnapshots.length) {
      chartInteractionState.alChart = { labels: [], markerDates: [] };
      renderChartLegendRow(el.alChartLegend, []);
      drawLineChart(el.alChart, [], [], {
        emptyMessage: allAssetsExcluded
          ? "No LTA Ratio to show because all assets are excluded by filters."
          : "No saved data yet. Add an asset or liability."
      });
      return;
    }

    const labels = plottedSnapshots.map((s) => s.date);
    const markerDates = historyDatesIncludingToday().filter((d) => labels.includes(d));
    chartInteractionState.alChart = { labels, markerDates };

    const ratiosPct = plottedSnapshots.map((s) => {
      const assets = Number(s.totals?.assets_btc || 0);
      const liabilities = Number(s.totals?.liabilities_btc || 0);
      if (assets <= 0) return 0;
      return (liabilities / assets) * 100;
    });

    const datasets = [
      {
        label: "LTA Ratio",
        color: "#2bb5ff",
        values: ratiosPct,
        valueFormatter: (v) => `${Number(v).toFixed(2)}%`
      }
    ];

    renderChartLegendRow(el.alChartLegend, datasets);

    drawLineChart(el.alChart, datasets, labels, {
      percent: true,
      percentValueColor: "#2bb5ff",
      axisPaddingMinPct: 0.05,
      axisPaddingMaxPct: 0.01,
      drawLegend: false,
      historyMarkerDates: markerDates,
      selectedHistoryDate: editingSnapshotDate,
      hoveredHistoryDate: hoveredSnapshotDate,
      hoverY: hoveredCanvasY
    });
    return;
  }

  const shouldSuppressZeroPoints = excludedAssets.size > 0 || excludedLiabilities.size > 0;
  const plottedSnapshots = shouldSuppressZeroPoints
    ? chartSnapshots.filter((s) => {
        const assetsBtc = Number(s.totals?.assets_btc || 0);
        const liabilitiesBtc = Number(s.totals?.liabilities_btc || 0);
        return assetsBtc !== 0 || liabilitiesBtc !== 0;
      })
    : chartSnapshots;

  if (!plottedSnapshots.length) {
    chartInteractionState.alChart = { labels: [], markerDates: [] };
    renderChartLegendRow(el.alChartLegend, []);
    drawLineChart(el.alChart, [], []);
    return;
  }

  const allBtcValues = plottedSnapshots.flatMap((s) => [
    Number(s.totals?.assets_btc || 0),
    Number(s.totals?.liabilities_btc || 0)
  ]);
  const maxBtcVal = Math.max(...allBtcValues.map(Math.abs), 0);
  // Use sats display when max value is below 0.001 BTC (100,000 sats)
  const useSats = maxBtcVal > 0 && maxBtcVal < 0.001;

  const labels = plottedSnapshots.map((s) => s.date);
  const markerDates = historyDatesIncludingToday().filter((d) => labels.includes(d));
  chartInteractionState.alChart = { labels, markerDates };
  const datasets = [
    {
      label: "Assets",
      color: "#39d7a4",
      values: plottedSnapshots.map((s) => Number(s.totals?.assets_btc || 0)),
      valueFormatter: useSats
        ? (v) => `${Math.round(Number(v) * 1e8).toLocaleString()} sats`
        : (v) => `${Number(v).toFixed(8)} BTC`
    },
    {
      label: "Liabilities",
      color: "#ff6f86",
      values: plottedSnapshots.map((s) => Number(s.totals?.liabilities_btc || 0)),
      valueFormatter: useSats
        ? (v) => `${Math.round(Number(v) * 1e8).toLocaleString()} sats`
        : (v) => `${Number(v).toFixed(8)} BTC`
    }
  ];

  renderChartLegendRow(el.alChartLegend, datasets);
  const chartOpts = {
    axisPaddingMinPct: 0.05,
    axisPaddingMaxPct: 0.01,
    includeZeroTickIfInRange: true,
    drawLegend: false,
    historyMarkerDates: markerDates,
    selectedHistoryDate: editingSnapshotDate,
    hoveredHistoryDate: hoveredSnapshotDate,
    hoverY: hoveredCanvasY,
    ...(useSats
      ? { yTickFormatter: (v) => formatSatsCompact(Math.round(v * 1e8)) }
      : { yTickSuffix: " BTC" })
  };

  if (alChartSeparateAxes) {
    drawLineChartDualYAxis(el.alChart, datasets, labels, {
      ...chartOpts,
      leftAxisColor: datasets[0].color,
      rightAxisColor: datasets[1].color,
      ...(useSats ? { yTickFormatter: (v) => formatSatsCompact(Math.round(v * 1e8)) } : {})
    });
  } else {
    drawLineChart(el.alChart, datasets, labels, chartOpts);
  }
}

function renderNetChangeChart(chartSnapshots = snapshots) {
  const plottedSnapshots = chartSnapshots.filter((s) => {
    const assetsBtc = Number(s.totals?.assets_btc || 0);
    const liabilitiesBtc = Number(s.totals?.liabilities_btc || 0);
    return assetsBtc !== 0 || liabilitiesBtc !== 0;
  });

  if (!plottedSnapshots.length) {
    chartInteractionState.netChart = { labels: [], markerDates: [] };
    renderChartLegendRow(el.netChartLegend, []);
    drawLineChart(el.netChart, [], []);
    return;
  }

  const labels = plottedSnapshots.map((s) => s.date);
  const markerDates = historyDatesIncludingToday().filter((d) => labels.includes(d));
  chartInteractionState.netChart = { labels, markerDates };
  const baseUsd = Number(plottedSnapshots[0].totals.net_usd) || 1e-12;
  const baseBtc = Number(plottedSnapshots[0].totals.net_btc) || 1e-12;

  const usdChanges = plottedSnapshots.map((s) => ((Number(s.totals.net_usd) - baseUsd) / baseUsd) * 100);
  const btcChanges = plottedSnapshots.map((s) => ((Number(s.totals.net_btc) - baseBtc) / baseBtc) * 100);
  const usdRaw = plottedSnapshots.map((s) => Number(s.totals.net_usd));
  const btcRaw = plottedSnapshots.map((s) => Number(s.totals.net_btc));

  const datasets = [
    { label: "BTC Net Worth", color: "#f7931a", values: btcChanges, rawValues: btcRaw, rawFormatter: formatBtc },
    {
      label: "USD Net Worth",
      color: themeValue("--networth-usd-line") || "#d7dde3",
      values: usdChanges,
      rawValues: usdRaw,
      rawFormatter: formatUsd
    }
  ];

  renderChartLegendRow(el.netChartLegend, datasets);

  if (netChartSeparateAxes) {
    drawLineChartDualYAxis(el.netChart, datasets, labels, {
      percent: true,
      axisPaddingMinPct: 0.05,
      axisPaddingMaxPct: 0.01,
      includeZeroTick: true,
      drawLegend: false,
      leftAxisColor: datasets[0].color,
      rightAxisColor: datasets[1].color,
      historyMarkerDates: markerDates,
      selectedHistoryDate: editingSnapshotDate,
      hoveredHistoryDate: hoveredSnapshotDate,
      hoverY: hoveredCanvasY
    });
  } else {
    drawLineChart(el.netChart, datasets, labels, {
      percent: true,
      axisPaddingMinPct: 0.05,
      axisPaddingMaxPct: 0.01,
      includeZeroTick: true,
      drawLegend: false,
      historyMarkerDates: markerDates,
      selectedHistoryDate: editingSnapshotDate,
      hoveredHistoryDate: hoveredSnapshotDate,
      hoverY: hoveredCanvasY
    });
  }
}

function parseCsvRow(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          field += line[i++];
        }
      }
      if (line[i] === ',') i++;
      fields.push(field);
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        i = line.length;
      } else {
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
  }
  return fields;
}

function parseCsv(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const lines = normalized.trim().split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = values[i] ?? ''; });
    return obj;
  });
}

async function fetchHistoricalPrices() {
  try {
    const res = await fetch(HIST_PRICE_URL, { cache: 'no-cache' });
    if (!res.ok) return;
    const text = await res.text();
    // Some rows have the ISO datetime split across two lines; join continuations
    const rawLines = text.split('\n');
    const fullLines = [];
    for (const rawLine of rawLines) {
      const t = rawLine.trim();
      if (!t) continue;
      if (/^\d+\/\d+\/\d+/.test(t)) {
        fullLines.push(t);
      } else if (fullLines.length > 0) {
        fullLines[fullLines.length - 1] += ',' + t;
      }
    }
    const prices = {};
    for (const line of fullLines) {
      const parts = line.split(',');
      const dateStr = parts[0].trim(); // M/D/YY
      const slash = dateStr.split('/');
      if (slash.length !== 3) continue;
      const [m, d, yy] = slash;
      const key = m.padStart(2, '0') + d.padStart(2, '0') + yy.padStart(2, '0');
      // Find first positive numeric field after date and ISO datetime columns
      let price = 0;
      for (let i = 2; i < parts.length; i++) {
        const v = Number(parts[i].trim());
        if (Number.isFinite(v) && v > 0) { price = v; break; }
      }
      if (price > 0) prices[key] = price;
    }
    historicalPrices = prices;
  } catch (e) {
    console.warn('Could not fetch historical prices:', e);
  }
}

function updateModeToggleUI() {
  document.getElementById("modeDemoBtn").classList.toggle("active", currentMode === "demo");
  document.getElementById("modeLiveBtn").classList.toggle("active", currentMode === "live");
  const isLive = currentMode === "live";
  const isEnc = isLive && liveHistoryFile && liveHistoryFile.endsWith(".enc");
  if (el.lockDataBtn) {
    el.lockDataBtn.disabled = !isEnc || liveAccessLocked;
    el.lockDataBtn.title = isEnc ? "Lock encrypted data" : "Only available when using an encrypted file";
  }
  // Always show encryption toggle and file selector; disable in demo mode
  if (el.encryptionToggleWrap) {
    el.encryptionToggleWrap.classList.add("visible");
    el.encryptionToggleWrap.classList.toggle("disabled", !isLive);
  }
  if (el.liveEncryptionEnabled) {
    el.liveEncryptionEnabled.checked = isLive ? liveEncryptionEnabled : false;
  }
  const isLiveLocked = isLive && liveAccessLocked;
  if (el.liveEncryptionEnabled) {
    el.liveEncryptionEnabled.disabled = !isLive || isLiveLocked;
  }
  // Show file selector always; disable interactions in demo mode or when server is unavailable.
  if (el.liveFileWrap) {
    el.liveFileWrap.classList.add("visible");
    if (el.liveFileBtn) {
      el.liveFileBtn.disabled = !isLive || !serverAvailable;
      el.liveFileBtn.title = !isLive ? "Switch to live mode to manage history files" : serverAvailable ? "Choose history file" : "Start local server to manage history files";
    }
    if (el.liveFileCreateBtn) {
      el.liveFileCreateBtn.disabled = !isLive || !serverAvailable || isLiveLocked;
    }
    if (isLive) {
      void populateLiveFileMenu();
    } else {
      closeLiveFileDropdown();
      if (el.liveFileValue) el.liveFileValue.textContent = "demo_history.csv";
    }
  }

  const lockableSelectors = [
    "#refreshQuoteBtn",
    "#manualBtcusd",
    "#chartStartDateBtn",
    "#chartEndDateBtn",
    "#assetsFilterBtn",
    "#liabilitiesFilterBtn",
    ".add-row-btn",
    ".small-btn",
    "#assetsRows input",
    "#assetsRows select",
    "#liabilitiesRows input",
    "#liabilitiesRows select"
  ];
  lockableSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      node.disabled = Boolean(isLiveLocked);
    });
  });
}

// Try to decrypt and load live encrypted data. Returns true on success.
async function unlockLiveEncryptedData(password) {
  const encSnap = localStorage.getItem(STORE_KEY_LIVE_ENC);
  const encForm = localStorage.getItem(FORM_KEY_LIVE_ENC);
  const defaultForm = DEFAULT_FORM_LIVE;
  try {
    if (encSnap) {
      const plain = await decryptText(encSnap, password);
      snapshots = parseSnapshotsRaw(plain);
    } else {
      snapshots = [];
    }
    if (encForm) {
      const plain = await decryptText(encForm, password);
      formState = parseFormFromRaw(plain, defaultForm);
    } else {
      formState = structuredClone(defaultForm);
    }
    return true;
  } catch {
    return false;
  }
}

async function enableLiveEncryption() {
  // Always prompt for a new password with confirm when encrypting a CSV file.
  const encFilename = liveHistoryFile.replace(/\.(csv|enc)$/, "") + ".enc";
  const pw = await promptForPassword({ confirm: true, message: `Set a password for ${encFilename}.` });
  if (!pw) { el.liveEncryptionEnabled.checked = false; return; }
  if (!serverAvailable) {
    el.liveEncryptionEnabled.checked = false;
    alert("Cannot enable encryption: server is not available.\nStart the local server and try again.");
    return;
  }

  let enc = "";
  try {
    // Encrypt current snapshots first.
    const csv = snapshotsToCsv(snapshots);
    enc = await encryptText(csv, pw);

    // Transactional server write: require successful write and verify the file exists.
    await writeLiveHistoryFile(enc, true, { strict: true, filename: encFilename });
    const verifyRaw = await fetchLiveHistoryFile(encFilename);
    if (verifyRaw === null) {
      throw new Error("Encrypted file verification failed: file not readable after write");
    }
  } catch (err) {
    // Roll back UI toggle on any failure so visible state matches storage/server state.
    el.liveEncryptionEnabled.checked = false;
    liveEncryptionEnabled = false;
    liveEncryptionPassword = null;
    try { localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0"); } catch { /* ignore */ }
    const reason = (err && err.message) ? err.message : String(err);
    console.error("enableLiveEncryption failed:", err);
    alert(`Could not enable encryption: ${reason}`);
    await populateLiveFileMenu();
    updateModeToggleUI();
    return;
  }

  // Commit app state after server conversion succeeds.
  liveEncryptionPassword = pw;
  liveEncryptionEnabled = true;
  liveHistoryFile = encFilename;
  liveFilePasswords.set(liveHistoryFile, liveEncryptionPassword);

  // Persisting local cache is best-effort. If storage quota is full, keep server state as source
  // of truth instead of showing a false conversion failure.
  try {
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "1");
    persistLiveFileSelection(liveHistoryFile);
    localStorage.setItem(STORE_KEY_LIVE_ENC, enc);
    localStorage.removeItem(STORE_KEY_LIVE);
    localStorage.removeItem(FORM_KEY_LIVE);
  } catch {
    console.warn("Live encryption enabled, but local encrypted cache could not be persisted.");
  }

  await populateLiveFileMenu();
  updateModeToggleUI();
}

async function disableLiveEncryption() {
  const hasEncFile = serverAvailable && (await fetchLiveHistoryFile()) !== null && liveHistoryFile.endsWith(".enc");
  const hasLocalEnc = Boolean(localStorage.getItem(STORE_KEY_LIVE_ENC));

  // No encrypted data source at all — just reset flags without touching file data.
  if (!hasEncFile && !hasLocalEnc) {
    el.liveEncryptionEnabled.checked = false;
    liveEncryptionEnabled = false;
    liveEncryptionPassword = null;
    localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0");
    await populateLiveFileMenu();
    updateModeToggleUI();
    return;
  }

  // When the encrypted file lives on the server, the server must be reachable so we can write
  // the decrypted CSV back. Refusing here prevents a partial state transition where the .csv
  // would be missing from the server and ensureLiveBaseFileIfMissing would reset all data on
  // the next page load.
  if (liveHistoryFile.endsWith(".enc") && !serverAvailable) {
    alert("Cannot disable encryption while the server is offline.\nStart the server and try again.");
    el.liveEncryptionEnabled.checked = true;
    return;
  }

  // Capture decrypted data in local variables. Never rely on the global `snapshots` being set
  // as a side-effect inside the validator — that was the original source of data loss.
  let decryptedSnapshots = null;
  let decryptedFormState = null;

  const pw = await promptForPassword({
    confirm: false,
    message: "Enter your encryption password to decrypt and disable encryption.",
    validator: async (p) => {
      if (hasEncFile) {
        try {
          const raw = await fetchLiveHistoryFile();
          if (!raw) return "Could not read encrypted file. Try again.";
          const plain = await decryptText(raw, p);
          decryptedSnapshots = parseLiveHistoryCsv(plain);
          return null;
        } catch {
          decryptedSnapshots = null;
          return "Incorrect password. Please try again.";
        }
      } else {
        // localStorage path: explicitly require encrypted data to exist before accepting any
        // password. The previous code used unlockLiveEncryptedData() here, which returned true
        // (success) even when STORE_KEY_LIVE_ENC was absent, silently setting snapshots = [].
        const encSnap = localStorage.getItem(STORE_KEY_LIVE_ENC);
        if (!encSnap) return "No encrypted data found in local storage.";
        try {
          const plain = await decryptText(encSnap, p);
          decryptedSnapshots = parseSnapshotsRaw(plain);
        } catch {
          decryptedSnapshots = null;
          return "Incorrect password. Please try again.";
        }
        const encForm = localStorage.getItem(FORM_KEY_LIVE_ENC);
        if (encForm) {
          try {
            decryptedFormState = parseFormFromRaw(await decryptText(encForm, p), DEFAULT_FORM_LIVE);
          } catch { /* form decrypt failure is non-fatal */ }
        }
        return null;
      }
    }
  });

  if (!pw) {
    el.liveEncryptionEnabled.checked = true;
    return;
  }

  // Guard: if decryptedSnapshots is somehow null after a successful password (should never
  // happen), abort rather than overwriting the file with empty data.
  if (decryptedSnapshots === null) {
    el.liveEncryptionEnabled.checked = true;
    return;
  }

  snapshots = decryptedSnapshots;
  if (decryptedFormState) formState = decryptedFormState;
  liveEncryptionPassword = pw;
  const csvFilename = liveHistoryFile.replace(/\.(csv|enc)$/, "") + ".csv";
  const csv = snapshotsToCsv(snapshots);
  liveHistoryFile = csvFilename;
  persistLiveFileSelection(liveHistoryFile);
  await writeLiveHistoryFile(csv, false);
  localStorage.setItem(STORE_KEY_LIVE, JSON.stringify(snapshots));
  localStorage.setItem(FORM_KEY_LIVE, JSON.stringify(formState));
  localStorage.removeItem(STORE_KEY_LIVE_ENC);
  localStorage.removeItem(FORM_KEY_LIVE_ENC);
  liveEncryptionEnabled = false;
  liveEncryptionPassword = null;
  localStorage.setItem(LIVE_ENCRYPTION_ENABLED_KEY, "0");
  await populateLiveFileMenu();
  updateModeToggleUI();
}

async function switchMode(newMode) {
  if (newMode === currentMode) return;

  currentMode = newMode;
  localStorage.setItem(MODE_KEY, currentMode);
  hoveredSnapshotDate = null;
  chartRange = { startDate: null, endDate: null };
  netChartRange = { startDate: null, endDate: null };
  alChartRange = { startDate: null, endDate: null };
  el.chartStartDate.value = "";
  el.chartEndDate.value = "";
  editingSnapshotDate = mmddyy(new Date());
  hasUnsavedAssetLiabilityChanges = false;
  loadFilters(currentMode);

  if (currentMode === "live") {
    if (!liveHistoryFile) {
      liveHistoryFile = localStorage.getItem(LIVE_LAST_VIEWED_FILE_KEY) || "my_history.csv";
      persistLiveFileSelection(liveHistoryFile);
    }
    await probeServer();
    updateModeToggleUI();
    formState = loadForm();
    if (serverAvailable) {
      await ensureLiveBaseFileIfMissing();
      if (liveHistoryFile.endsWith(".enc") && !liveEncryptionPassword) {
        const pw = await promptForPassword({
          confirm: false,
          message: `Enter password for ${liveHistoryFile}.`,
          validator: async (p) => {
            try {
              const raw = await fetchLiveHistoryFile();
              if (!raw) return "Could not read file from server.";
              await decryptText(raw, p); // throws on wrong password
              return null;
            } catch { return "Incorrect password. Please try again."; }
          }
        });
        if (!pw) {
          setLiveAccessLocked();
          return;
        }
        liveEncryptionPassword = pw;
        liveFilePasswords.set(liveHistoryFile, pw);
      }
      const loaded = await loadLiveSnapshotsFromServer();
      snapshots = loaded;
    } else if (liveEncryptionEnabled) {
      const hasEncData = Boolean(localStorage.getItem(STORE_KEY_LIVE_ENC));
      if (hasEncData && liveEncryptionPassword) {
        const ok = await unlockLiveEncryptedData(liveEncryptionPassword);
        if (!ok) {
          // Session password no longer valid — fall back to demo
          currentMode = "demo";
          localStorage.setItem(MODE_KEY, currentMode);
          formState = freshFormState("demo");
        }
      } else if (hasEncData) {
        const pw = await promptForPassword({
          confirm: false,
          validator: async (p) => {
            const ok = await unlockLiveEncryptedData(p);
            return ok ? null : "Incorrect password. Please try again.";
          }
        });
        if (pw) {
          liveEncryptionPassword = pw;
        } else {
          // Cancelled — revert to demo mode
          currentMode = "demo";
          localStorage.setItem(MODE_KEY, currentMode);
          formState = freshFormState("demo");
        }
      } else {
        snapshots = loadSnapshots();
      }
    } else {
      snapshots = loadSnapshots();
      if (!snapshots.length) {
        snapshots = await loadLiveSnapshotsFromStaticCsv();
      }
    }
  } else {
    // Switching to demo — clear session password so re-auth is required on return.
    liveEncryptionPassword = null;
    snapshots = loadSnapshots();
    formState = freshFormState("demo");
  }

  seedTodayFormStateFromHistory({ save: true });
  formState.useManualBtcusd = false;
  formState.manualBtcusd = null;
  renderAll();
  if (currentMode === "demo") {
    // Final guard: ensure charts are not constrained by any previous live range.
    chartRange = { startDate: null, endDate: null };
    el.chartStartDate.value = "";
    el.chartEndDate.value = "";
    renderChartsOnly();
  }
  updateModeToggleUI();
}

async function loadDemoData() {
  try {
    let response = await fetch("history_files/demo_history.csv", { cache: "no-cache" });
    if (!response.ok) {
      response = await fetch("/history_files/demo_history.csv", { cache: "no-cache" });
    }
    if (!response.ok) return false;
    const text = await response.text();
    const rows = parseCsv(text);
    if (!rows.length) return false;
    const parsedSnapshots = rows.map((row) => {
      try {
        const yyyymmddDate = String(row.date || "").trim();
        if (!/^\d{8}$/.test(yyyymmddDate)) return null;
        const mmddyyDate = yyyymmddToMMDDYY(yyyymmddDate);
        const btcusd = Number(historicalPrices[mmddyyDate] || formState.btcusd || 0);

        const assetsRaw = row.assets;
        const liabilitiesRaw = row.liabilities;
        const assets = typeof assetsRaw === "string" ? JSON.parse(assetsRaw) : (assetsRaw || []);
        const liabilities = typeof liabilitiesRaw === "string" ? JSON.parse(liabilitiesRaw) : (liabilitiesRaw || []);
        if (!Array.isArray(assets) || !Array.isArray(liabilities)) return null;

        return {
          date: mmddyyDate,
          timestamp: parseMMDDYY(mmddyyDate).toISOString(),
          btcusd,
          assets,
          liabilities,
          comments: row.comment || row.comments || "",
          totals: computeTotals(assets, liabilities, btcusd)
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    if (!parsedSnapshots.length) return false;
    await migrateCsvToIncludeCommentColumnIfMissing(text, parsedSnapshots, {
      encrypted: false,
      filename: "demo_history.csv"
    });
    snapshots = parsedSnapshots;
    editingSnapshotDate = mmddyy(new Date());
    hasUnsavedAssetLiabilityChanges = false;
    seedTodayFormStateFromHistory({ save: true });
    saveSnapshots();
    // Reset chart range so loading fresh demo data always shows the full history span.
    chartRange = { startDate: null, endDate: null };
    renderAll();
    return true;
  } catch (e) {
    console.warn("Could not load demo data:", e);
    return false;
  }
}

function toCsv(rows, headers) {
  const escape = (v) => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
      return `"${s.replaceAll("\"", "\"\"")}"`;
    }
    return s;
  };

  const lines = [headers.join(",")];
  rows.forEach((row) => {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  });
  return lines.join("\n");
}

function download(filename, content, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportNetWorthCsv() {
  const rows = snapshots.map((s) => ({
    date: s.date,
    usd: Number(s.totals.net_usd).toFixed(2),
    btc: Number(s.totals.net_btc).toFixed(8)
  }));
  const csv = toCsv(rows, ["date", "usd", "btc"]);
  download("total_net_worth_usd_vs_btc.csv", csv);
}

function exportHistoricCsv() {
  const sorted = snapshots.slice().sort((a, b) => parseMMDDYY(b.date) - parseMMDDYY(a.date));
  const rows = sorted.map((s) => ({
    date: s.date,
    assets: JSON.stringify(s.assets || []),
    liabilities: JSON.stringify(s.liabilities || [])
  }));
  const csv = toCsv(rows, ["date", "assets", "liabilities"]);
  download("historic_net_worth.csv", csv);
}
