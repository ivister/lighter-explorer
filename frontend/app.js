(() => {
  "use strict";

  const APP_VERSION = "0.1.2";
  const GITHUB_REPO = "ivister/lighter-explorer";

  // ── DOM references ──────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const form             = $("address-form");
  const input            = $("l1-input");
  const mainSection      = $("main-account");
  const subSection       = $("sub-accounts");
  const subTbody         = $("sub-tbody");
  const subSearch        = $("sub-search");
  const subCount         = $("sub-count");
  const filterBalance    = $("filter-balance");
  const filterActivated  = $("filter-activated");
  const filterZeroPos    = $("filter-zero-pos");
  const noResults        = $("no-results");
  const loadingEl        = $("loading");
  const errorEl          = $("error");
  const toastContainer   = $("toast-container");
  const singleSection    = $("single-account");
  const saHeader         = $("sa-header");
  const saContent        = $("sa-content");
  const appTitle         = $("app-title");
  const exportModal      = $("export-modal");
  const wsDot            = $("ws-dot");
  const wsStatusText     = $("ws-status-text");
  const blockHeight      = $("block-height");
  const blockChip        = $("block-chip");
  const exportAllLabel   = $("export-all-label");
  const exportFilteredBtn   = $("export-filtered");
  const exportFilteredLabel = $("export-filtered-label");
  const logsModal        = $("logs-modal");
  const logsAccountLabel = $("logs-account-id");
  const logsTbody        = $("logs-tbody");
  const logsTable        = $("logs-table");
  const logsLoading      = $("logs-loading");
  const logsEmpty        = $("logs-empty");
  const logsExportBtn    = $("logs-export-csv");
  const txModal          = $("tx-modal");
  const txDetails        = $("tx-details");
  const txLoading        = $("tx-loading");
  const txError          = $("tx-error");
  const settingsModal    = $("settings-modal");
  const logsExportModal    = $("logs-export-modal");
  const logsExportProgress = $("logs-export-progress");
  const logsExportFullBtn  = $("logs-export-full");
  const logsExportFullLabel = $("logs-export-full-label");
  const WS = window.LighterWS;
  const StatusHelpers = window.LighterStatusHelpers;

  if (!StatusHelpers) throw new Error("LighterStatusHelpers is not loaded.");

  const hasBalance = StatusHelpers.hasBalance;
  const hasRealPositions = StatusHelpers.hasRealPositions;
  const isOpenPosition = StatusHelpers.isOpenPosition;
  const getAccountStatus = StatusHelpers.getAccountStatus;

  // ── State ───────────────────────────────────────────────
  let allSubAccounts    = [];
  const subAccountMap   = new Map();
  let expandedIndexes   = new Set();
  let expandedColSpan   = 6;
  let sortKey           = "_accountStatus";
  let sortAsc           = false;

  let marketData        = {};
  let marketRenderTimer = null;
  let marketDataReceived = false;

  let mainAccountObj    = null;
  let singleAccountData = null;

  let masterTrackId     = null;
  let singleTrackId     = null;
  let trackedSubs       = new Set();
  let expandGeneration  = {};       // { index: counter } for race condition

  let explorerBaseUrl   = "https://explorer.elliot.ai";
  let currentTxData     = null;   // cached TX for re-render on TZ change
  let logsAccountId     = null;
  let logsOffset        = 0;
  let isLoadingLogs      = false;
  let logsAllLoaded     = false;
  let logsData          = [];
  const LOGS_LIMIT      = 50;
  const logsCache       = {};   // { accountId: { data: [], allLoaded: bool } }

  let marketIndexMap    = {};   // { market_index: symbol }

  let settingTz    = localStorage.getItem("lighter_tz") || "local";
  let settingTheme = localStorage.getItem("lighter_theme") || "auto";

  // ── Pure helpers ──────────────────────────────────────────

  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");
  const setField = (id, html) => { $(id).innerHTML = html; };

  // HTML-escape untrusted data to prevent XSS
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function syntaxHighlight(obj) {
    // Parse nested JSON strings (info, event_info)
    const clean = JSON.parse(JSON.stringify(obj), (k, v) => {
      if (typeof v === "string" && v.startsWith("{")) { try { return JSON.parse(v); } catch { return v; } }
      return v;
    });
    const json = JSON.stringify(clean, null, 2);
    return json.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return '<span class="' + cls + '">' + match + '</span>';
    });
  }

  function formatValue(val) {
    return (!val || val === "") ? "—" : esc(val);
  }

  function formatNumber(val, decimals) {
    if (val === undefined || val === null || val === "") return "—";
    const n = parseFloat(val);
    return isNaN(n) ? esc(String(val)) : n.toFixed(decimals);
  }

  function tradingMode(mode) {
    return mode === 1 ? "Unified" : "Classic";
  }

  // ── Fetch with proxy fallback ──────────────────────────

  async function fetchJson(proxyUrl, directUrl) {
    try {
      const resp = await fetch(proxyUrl);
      if (!resp.ok) throw new Error("proxy");
      return await resp.json();
    } catch {
      const resp = await fetch(directUrl);
      if (!resp.ok) throw new Error("request failed");
      return await resp.json();
    }
  }

  function logsUrl(accountId, limit, offset) {
    return [
      "/api/account-logs/" + encodeURIComponent(accountId) + "?limit=" + limit + "&offset=" + offset,
      explorerBaseUrl + "/api/accounts/" + encodeURIComponent(accountId) + "/logs?limit=" + limit + "&offset=" + offset,
    ];
  }
  function pnlClass(val) {
    return val === 0 ? "pnl-zero" : val > 0 ? "pnl-positive" : "pnl-negative";
  }

  function accountStatusBadge(acc, skipCheck) {
    const st = getAccountStatus(acc);
    if (st === "trading")
      return '<span class="badge badge-trading" title="Has balance and open positions">Trading</span>';
    if (st === "check" && !skipCheck)
      return '<span class="badge badge-check" title="Has balance but no open positions — review recommended">Need to check</span>';
    return '<span class="badge badge-idle" title="No open positions">Idle</span>';
  }

  function onlineBadge(acc) {
    return acc.status === 1
      ? ' <span class="badge badge-online" title="Account is active on the network">online</span>'
      : "";
  }

  function statusHtml(acc, skipCheck) {
    return accountStatusBadge(acc, skipCheck) + onlineBadge(acc);
  }

  function signLabel(sign) {
    if (sign === 1) return '<span class="badge badge-long">Long</span>';
    if (sign === -1) return '<span class="badge badge-short">Short</span>';
    return "—";
  }

  // ── Data helpers: positions & stats ────────────────────

  function wsPositionsToArray(posObj) {
    if (!posObj || typeof posObj !== "object") return [];
    const result = [];
    for (const key of Object.keys(posObj)) {
      const val = posObj[key];
      if (Array.isArray(val)) {
        for (let j = 0; j < val.length; j++) result.push(val[j]);
      } else if (val && typeof val === "object") {
        result.push(val);
      }
    }
    return result;
  }

  function calcLiqPrice(p) {
    const size = Math.abs(parseFloat(p.position));
    const entry = parseFloat(p.avg_entry_price);
    const margin = parseFloat(p.allocated_margin);
    if (!size || !entry || !margin) return "";
    return (p.sign === 1 ? entry - margin / size : entry + margin / size).toString();
  }

  function fillLiqPrices(positions) {
    for (const p of positions) {
      if (!p.liquidation_price || p.liquidation_price === "" || p.liquidation_price === "0") {
        p.liquidation_price = calcLiqPrice(p);
      }
    }
  }

  function applyWsPositions(acc, msg) {
    if (!msg.positions) return false;
    const posArr = wsPositionsToArray(msg.positions);
    fillLiqPrices(posArr);
    acc.positions = posArr;
    acc._hasPositions = hasRealPositions(posArr);
    return true;
  }

  const TRADE_STATS_KEYS = ["daily_trades_count", "daily_volume", "weekly_trades_count", "weekly_volume", "total_trades_count", "total_volume"];

  function applyTradeStats(acc, msg) {
    const keys = TRADE_STATS_KEYS;
    for (const k of keys) {
      if (msg[k] !== undefined) acc[k] = msg[k];
    }
  }

  function applyUserStats(acc, s) {
    if (s.portfolio_value !== undefined) acc.total_asset_value = s.portfolio_value;
    if (s.collateral !== undefined) acc.collateral = s.collateral;
    if (s.available_balance !== undefined) acc.available_balance = s.available_balance;
    if (s.account_trading_mode !== undefined) acc.account_trading_mode = s.account_trading_mode;
    if (s.leverage !== undefined) acc.leverage = s.leverage;
    if (s.margin_usage !== undefined) acc.margin_usage = s.margin_usage;
    if (s.cross_stats && s.cross_stats.portfolio_value !== undefined) {
      acc.cross_asset_value = s.cross_stats.portfolio_value;
    }
  }

  // ── Toast notifications (with deduplication) ───────────

  const recentToasts = new Map();

  function showToast(title, message, type) {
    type = type || "info";

    // Deduplicate: skip if same toast shown in last 5 seconds
    const key = type + ":" + title + ":" + message;
    const now = Date.now();
    if (recentToasts.has(key) && now - recentToasts.get(key) < 5000) return;
    recentToasts.set(key, now);

    // Prune old entries
    if (recentToasts.size > 50) {
      for (const [k, t] of recentToasts) {
        if (now - t > 10000) recentToasts.delete(k);
      }
    }

    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.innerHTML =
      '<div class="toast-body">' +
        '<div class="toast-title">' + esc(title) + '</div>' +
        '<div class="toast-message">' + esc(message) + '</div>' +
      '</div>' +
      '<button class="toast-close">&times;</button>';

    el.querySelector(".toast-close").addEventListener("click", () => el.remove());
    toastContainer.appendChild(el);

    setTimeout(() => {
      el.classList.add("toast-out");
      el.addEventListener("animationend", () => el.remove());
    }, 8000);

    while (toastContainer.children.length > 5) toastContainer.firstChild.remove();
  }

  // ── Click-to-copy ─────────────────────────────────────

  function copyIndex(value, el) {
    navigator.clipboard.writeText(String(value)).then(() => {
      const tip = document.createElement("span");
      tip.className = "copy-toast";
      tip.textContent = "Copied!";
      el.style.position = "relative";
      el.appendChild(tip);
      tip.addEventListener("animationend", () => tip.remove());
    });
  }

  function copyableHtml(value) {
    return '<span class="copyable" data-copy="' + esc(value) + '" title="Click to copy">' + esc(value) + '</span>';
  }

  function copyableShortAddr(addr) {
    if (!addr) return "";
    const short = shortAddr(addr);
    return '<span class="copyable l1-badge mono" data-copy="' + esc(addr) + '" title="' + esc(addr) + '">' + esc(short) + '</span>';
  }

  document.addEventListener("click", (e) => {
    const copyEl = e.target.closest(".copyable");
    if (!copyEl) return;
    e.stopPropagation();
    copyIndex(copyEl.dataset.copy, copyEl);
  });

  // ── Rendering: margin health bar ──────────────────────

  function marginHealthBar(margin, upnl, cssClass) {
    cssClass = cssClass || "";
    const health = Math.max(0, Math.min(100, (margin + upnl) / margin * 100));
    const barClass = health > 70 ? "margin-ok" : health > 30 ? "margin-warn" : "margin-danger";
    return '<div class="margin-bar ' + cssClass + '"><div class="margin-fill ' + barClass + '" style="width:' + health.toFixed(1) + '%"></div></div>' +
      '<span class="margin-pct ' + barClass + '">' + health.toFixed(0) + '%</span>';
  }

  function acctMarginBar(assetValue, totalMargin) {
    if (totalMargin <= 0 || assetValue <= 0) return "";
    const health = Math.max(0, Math.min(200, assetValue / totalMargin * 100));
    const barClass = health > 150 ? "margin-ok" : health > 110 ? "margin-warn" : "margin-danger";
    return '<div class="margin-bar margin-bar-lg"><div class="margin-fill ' + barClass + '" style="width:' + Math.min(health / 2, 100).toFixed(1) + '%"></div></div>' +
      '<span class="margin-pct ' + barClass + '">' + health.toFixed(1) + '% margin ratio</span>';
  }

  // ── Rendering: single position row ────────────────────

  function renderPositionRow(p, totals) {
    const size = Math.abs(parseFloat(p.position));
    const entry = parseFloat(p.avg_entry_price);
    const margin = parseFloat(p.allocated_margin) || 0;

    const mkt = marketData[p.symbol] || {};
    const markPrice = mkt.mark_price || "—";
    const mp = parseFloat(mkt.mark_price);
    const fundingRate = mkt.funding_rate;

    // Value = entry × size (static); notional = mark × size (for leverage)
    const posValue = p.position_value;
    let upnl;

    if (mp && size && entry) {
      upnl = p.sign === 1 ? (mp - entry) * size : (entry - mp) * size;
      totals.hasLive = true;
      totals.notional += mp * size;
    } else {
      upnl = parseFloat(p.unrealized_pnl) || 0;
      totals.notional += parseFloat(posValue) || 0;
    }
    totals.upnl += upnl;
    totals.margin += margin;

    const rpnl = parseFloat(p.realized_pnl) || 0;

    // uPnL % (return on margin / ROE)
    const upnlPct = margin > 0 ? (upnl / margin * 100) : 0;

    const leverage = parseFloat(p.initial_margin_fraction) > 0
      ? Math.round(100 / parseFloat(p.initial_margin_fraction)) + "x"
      : "—";

    const isolatedBadge = p.margin_mode === 1
      ? ' <span class="badge badge-isolated" title="Isolated margin · allocated ' + esc(p.allocated_margin) + '">Isolated</span>'
      : '';

    // Funding rate display
    let fundingHtml = "—";
    if (fundingRate !== undefined && fundingRate !== null) {
      const fr = parseFloat(fundingRate);
      if (!isNaN(fr)) {
        fundingHtml = (fr * 100).toFixed(4) + '%';
      }
    }

    // ELP tooltip with formula
    const liqRaw = p.liquidation_price;
    const liqPrice = (!liqRaw || liqRaw === "0" || liqRaw === "") ? "—" : formatNumber(liqRaw, 6);
    let liqTooltip = "Estimated Liquidation Price";
    if (liqPrice !== "—" && margin > 0 && size && entry) {
      const side = p.sign === 1 ? "Long" : "Short";
      const op = p.sign === 1 ? "\u2212" : "+";
      liqTooltip = "Estimated Liquidation Price\n" + side + ": entry " + op + " margin / size\n" +
        formatNumber(entry, 6) + " " + op + " " + formatNumber(margin, 6) + " / " + formatNumber(size, 6);
    }

    // Margin cell with health bar
    let marginHtml = formatNumber(p.allocated_margin, 6);
    if (margin > 0) marginHtml += marginHealthBar(margin, upnl);

    return '<tr data-pos-symbol="' + esc(p.symbol) + '">' +
      '<td>' + esc(p.symbol) + isolatedBadge + '</td>' +
      '<td>' + signLabel(p.sign) + '</td>' +
      '<td>' + leverage + '</td>' +
      '<td>' + esc(p.position) + '</td>' +
      '<td>' + esc(p.avg_entry_price) + '</td>' +
      '<td class="live-value">' + esc(markPrice) + '</td>' +
      '<td class="live-value">' + fundingHtml + '</td>' +
      '<td>' + marginHtml + '</td>' +
      '<td>' + esc(posValue) + '</td>' +
      '<td class="' + pnlClass(upnl) + '">' + formatNumber(upnl, 6) + (margin > 0 ? ' <span class="upnl-pct">(' + upnlPct.toFixed(2) + '%)</span>' : '') + '</td>' +
      '<td class="' + pnlClass(rpnl) + '">' + esc(p.realized_pnl) + '</td>' +
      '<td>' + esc(p.open_order_count) + '</td>' +
      '<td title="' + esc(liqTooltip) + '">' + liqPrice + '</td>' +
    '</tr>';
  }

  // ── Rendering: account content (shared) ───────────────

  function renderAccountContent(acc, skipCheck, refreshIndex) {
    if (acc._hasPositions === undefined) acc._hasPositions = hasRealPositions(acc.positions);

    const showZero = filterZeroPos.checked;
    const positions = showZero
      ? (acc.positions || [])
      : (acc.positions || []).filter(isOpenPosition);

    // Accumulate totals across positions
    const totals = { upnl: 0, notional: 0, margin: 0, hasLive: false };
    let positionsHtml = "";

    if (positions.length > 0) {
      const posRows = positions.map((p) => renderPositionRow(p, totals)).join("");

      positionsHtml =
        '<div class="detail-section">' +
          '<h4>Positions</h4>' +
          '<div class="table-wrap">' +
            '<table class="positions-table">' +
              '<thead><tr>' +
                '<th>Market</th><th>Side</th><th>Lev</th><th>Size</th>' +
                '<th>Entry</th><th>Mark</th><th>Funding</th><th>Margin</th>' +
                '<th>Value</th><th>uPnL</th><th>rPnL</th>' +
                '<th>OOC</th><th title="Estimated Liquidation Price">ELP</th>' +
              '</tr></thead>' +
              '<tbody>' + posRows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
    }

    // Positions count badge for status field
    const positionsTag = positions.length > 0
      ? ' <span class="count-badge">' + positions.length + ' pos</span>'
      : '';

    // Trade stats
    let tradeStatsHtml = '';
    if (acc.total_trades_count !== undefined) {
      tradeStatsHtml =
        '<div class="field"><span class="label">Trades (day / week / total)</span><span class="value">' +
          (acc.daily_trades_count || 0) + ' / ' + (acc.weekly_trades_count || 0) + ' / ' + (acc.total_trades_count || 0) +
        '</span></div>' +
        '<div class="field"><span class="label">Volume (day / week / total)</span><span class="value">' +
          formatNumber(acc.daily_volume, 2) + ' / ' + formatNumber(acc.weekly_volume, 2) + ' / ' + formatNumber(acc.total_volume, 2) +
        '</span></div>';
    }

    // Live-recalculated account-level values
    const collateral = parseFloat(acc.collateral) || 0;
    const liveAsset = collateral + totals.upnl;
    const displayAsset = totals.hasLive ? liveAsset.toFixed(6) : acc.total_asset_value;
    // FIX: available = total_asset_value - allocated_margin (not - collateral)
    const displayAvail = totals.hasLive ? Math.max(0, liveAsset - totals.margin).toFixed(6) : acc.available_balance;

    let displayLeverage = acc.leverage ? parseFloat(acc.leverage).toFixed(2) + "x" : "—";
    if (totals.hasLive && liveAsset > 0 && totals.notional > 0) {
      displayLeverage = (totals.notional / liveAsset).toFixed(2) + "x";
    }

    const leverageMarginHtml = acctMarginBar(liveAsset, totals.margin);

    // Action buttons
    const refreshBtn = refreshIndex
      ? '<div class="field"><span class="label">&nbsp;</span>' +
        '<div style="display:flex;gap:0.4rem">' +
        '<button class="btn-refresh" data-refresh="' + esc(refreshIndex) + '" title="Re-fetch account data">&#x21bb; Refresh</button>' +
        '<button class="btn-refresh" data-history="' + esc(refreshIndex) + '" title="View transaction history">History</button>' +
        '</div></div>'
      : '';

    return '<div class="detail-grid">' +
      '<div class="field"><span class="label">Total Asset Value</span><span class="value live-value">' + formatNumber(displayAsset, 6) + '</span></div>' +
      '<div class="field"><span class="label">Collateral</span><span class="value">' + formatValue(acc.collateral) + '</span></div>' +
      '<div class="field"><span class="label">Available Balance</span><span class="value live-value">' + formatNumber(displayAvail, 6) + '</span></div>' +
      '<div class="field"><span class="label">Cross Asset Value</span><span class="value">' + formatValue(acc.cross_asset_value) + '</span></div>' +
      '<div class="field"><span class="label">Leverage</span><span class="value live-value">' + displayLeverage + leverageMarginHtml + '</span></div>' +
      '<div class="field"><span class="label">Trading Mode</span><span class="value">' + tradingMode(acc.account_trading_mode) + '</span></div>' +
      '<div class="field"><span class="label">Status</span><span class="value">' + statusHtml(acc, skipCheck) + positionsTag + '</span></div>' +
      refreshBtn +
      tradeStatsHtml +
    '</div>' +
    positionsHtml;
  }

  // ── Rendering: main account card ──────────────────────

  function renderMainAccount(acc, subs) {
    mainAccountObj = acc;
    acc._hasPositions = hasRealPositions(acc.positions);

    const tradingSubs = subs.filter((s) => getAccountStatus(s) === "trading").length;
    const onlineSubs = subs.filter((s) => s.status === 1).length;

    $("ma-header").innerHTML = 'Main Account <span class="badge badge-type">Main</span> ' +
      (acc.l1_address ? copyableShortAddr(acc.l1_address) : '');
    setField("ma-index", copyableHtml(acc.index));
    setField("ma-status", statusHtml(acc, true));
    setField("ma-total-asset", formatNumber(acc.total_asset_value, 6));
    setField("ma-collateral", formatValue(acc.collateral));
    setField("ma-balance", formatValue(acc.available_balance));
    setField("ma-mode", tradingMode(acc.account_trading_mode));
    setField("ma-orders", esc(acc.total_order_count));
    setField("ma-pending", esc(acc.pending_order_count));
    setField("ma-active-subs", tradingSubs + " / " + subs.length);
    setField("ma-online", onlineSubs);
    show(mainSection);
  }

  function refreshMainCard() {
    if (!mainAccountObj) return;
    setField("ma-total-asset", formatNumber(mainAccountObj.total_asset_value, 6));
    setField("ma-collateral", formatValue(mainAccountObj.collateral));
    setField("ma-balance", formatValue(mainAccountObj.available_balance));
    setField("ma-mode", tradingMode(mainAccountObj.account_trading_mode));
    setField("ma-status", statusHtml(mainAccountObj, true));
  }

  // ── Rendering: detail panel (expanded sub) ────────────

  function renderDetailRow(detail, colSpan, index) {
    const acc = detail.accounts && detail.accounts[0];
    const attr = index ? ' data-detail-for="' + esc(index) + '"' : '';
    if (!acc) return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">No data</td></tr>';
    return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">' +
      '<div class="detail-panel">' + renderAccountContent(acc, false, index) + '</div>' +
    '</td></tr>';
  }

  // ── Rendering: single account card (ID search) ────────

  function renderSingleAccount(acc) {
    if (acc._hasPositions === undefined) acc._hasPositions = hasRealPositions(acc.positions);
    const typeLabel = acc.account_type === 0 ? "Main" : "Sub";
    const skipCheck = acc.account_type === 0;
    saHeader.innerHTML =
      'Account ' + copyableHtml('#' + acc.index) + ' ' +
      '<span class="badge badge-type">' + typeLabel + '</span> ' +
      (acc.l1_address ? copyableShortAddr(acc.l1_address) + ' ' : '') +
      statusHtml(acc, skipCheck);
    saContent.innerHTML = renderAccountContent(acc, skipCheck, acc.index);
    show(singleSection);
  }

  // ── Rendering: sub-accounts table ─────────────────────

  function renderSubRow(acc) {
    return '<tr class="sub-row" data-index="' + esc(acc.index) + '">' +
      '<td class="mono">' + copyableHtml(acc.index) + '</td>' +
      '<td>' + statusHtml(acc) + '</td>' +
      '<td>' + formatNumber(acc.total_asset_value, 6) + '</td>' +
      '<td>' + tradingMode(acc.account_trading_mode) + '</td>' +
      '<td>' + esc(acc.total_order_count) + '</td>' +
      '<td>' + esc(acc.pending_order_count) + '</td>' +
    '</tr>';
  }

  function renderSubAccounts(accounts) {
    expandedIndexes.clear();
    if (accounts.length === 0) {
      subTbody.innerHTML = "";
      show(noResults);
      return;
    }
    hide(noResults);
    subTbody.innerHTML = accounts.map(renderSubRow).join("");
  }

  // ── Sub-row DOM helpers ───────────────────────────────

  function getSubRow(index) {
    return subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
  }

  function getDetailRow(index) {
    return subTbody.querySelector('.detail-row[data-detail-for="' + index + '"]');
  }

  function updateSubRowCells(index, sub) {
    const row = getSubRow(index);
    if (!row) return;
    if (row.children[1]) row.children[1].innerHTML = statusHtml(sub);
    if (row.children[2]) row.children[2].textContent = formatNumber(sub.total_asset_value, 6);
  }

  function reRenderDetail(index) {
    if (!expandedIndexes.has(index)) return;
    const sub = findSub(index);
    if (!sub || !sub._cachedDetail) return;
    const detailRow = getDetailRow(index);
    if (detailRow) detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, index);
  }

  function reRenderAllExpanded() {
    expandedIndexes.forEach(reRenderDetail);
  }

  // ── Collapse helpers ──────────────────────────────────

  function collapseRow(index) {
    const detailRow = getDetailRow(index);
    if (detailRow) detailRow.remove();
    const subRow = getSubRow(index);
    if (subRow) subRow.classList.remove("expanded");
    expandedIndexes.delete(String(index));
  }

  // ── Sort logic ────────────────────────────────────────

  function getSortValue(acc, key) {
    if (key === "_accountStatus") {
      const st = getAccountStatus(acc);
      return st === "trading" ? 2 : st === "check" ? 1 : 0;
    }
    const val = acc[key];
    if (val === undefined || val === null || val === "") return -Infinity;
    const num = Number(val);
    return isNaN(num) ? val : num;
  }

  function sortAccounts(accounts) {
    if (!sortKey) return accounts;
    return [...accounts].sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return (parseFloat(b.total_asset_value) || 0) - (parseFloat(a.total_asset_value) || 0);
    });
  }

  function updateSortIndicators() {
    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.key === sortKey) th.classList.add(sortAsc ? "sort-asc" : "sort-desc");
    });
  }

  // ── Filter logic ──────────────────────────────────────

  function getFilteredSubs() {
    const q = subSearch.value.trim();
    const onlyBalance = filterBalance.checked;
    const onlyNoPos = filterActivated.checked;

    let filtered = allSubAccounts;
    if (q) filtered = filtered.filter((acc) => String(acc.index).includes(q));
    if (onlyBalance) filtered = filtered.filter(hasBalance);
    if (onlyNoPos) filtered = filtered.filter((acc) => acc._hasPositions !== true);

    return sortAccounts(filtered);
  }

  function hasActiveFilters() {
    return !!(subSearch.value.trim() || filterBalance.checked || filterActivated.checked);
  }

  function applyFilters() {
    renderSubAccounts(getFilteredSubs());
  }

  // ── CSV export ────────────────────────────────────────

  const CSV_HEADER = [
    "type", "index", "status", "online", "total_asset_value", "collateral",
    "available_balance", "cross_asset_value", "trading_mode", "total_orders",
    "pending_orders",
  ];

  function csvEscape(val) {
    const s = String(val == null ? "" : val);
    return (s.includes(",") || s.includes('"') || s.includes("\n"))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  function accCsvRow(acc, type) {
    return [
      type, acc.index, getAccountStatus(acc),
      acc.status === 1 ? "yes" : "no",
      acc.total_asset_value || "0", acc.collateral || "0",
      acc.available_balance || "0", acc.cross_asset_value || "0",
      tradingMode(acc.account_trading_mode),
      acc.total_order_count || 0, acc.pending_order_count || 0,
    ].map(csvEscape).join(",");
  }

  function csvTimestamp() {
    const now = new Date();
    return now.toISOString().slice(0, 10) + "_" +
      String(now.getUTCHours()).padStart(2, "0") + "_" +
      String(now.getUTCMinutes()).padStart(2, "0") + "utc";
  }

  function downloadCsv(subs) {
    const rows = [CSV_HEADER.join(",")];
    if (mainAccountObj) rows.push(accCsvRow(mainAccountObj, "main"));
    for (const sub of subs) rows.push(accCsvRow(sub, "sub"));

    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lighter_accounts_" + csvTimestamp() + ".csv";
    a.click();
    URL.revokeObjectURL(url);

    showToast("CSV Export", (rows.length - 1) + " accounts exported", "success");
  }

  function showExportModal() {
    const allCount = allSubAccounts.length + (mainAccountObj ? 1 : 0);
    const filteredCount = getFilteredSubs().length + (mainAccountObj ? 1 : 0);
    const active = hasActiveFilters();

    exportAllLabel.textContent = "All accounts (" + allCount + ")";
    exportFilteredLabel.textContent = "With current filters (" + filteredCount + ")";
    exportFilteredBtn.disabled = !active;
    exportFilteredBtn.style.opacity = active ? "1" : "0.4";

    show(exportModal);
  }

  function hideExportModal() { hide(exportModal); }

  // ── Account logs ───────────────────────────────────────

  const LOG_LABELS = {
    Trade: ["Trade", "log-trade"],
    TradeWithFunding: ["Trade", "log-trade"],
    LiquidationTrade: ["Liquidation", "log-liq"],
    LiquidationTradeWithFunding: ["Liquidation", "log-liq"],
    L2UpdateLeverage: ["Leverage", "log-leverage"],
    L2TransferV2: ["Transfer", "log-transfer"],
    L2Transfer: ["Transfer", "log-transfer"],
    L1Deposit: ["Deposit", "log-deposit"],
    Withdraw: ["Withdraw", "log-withdraw"],
    L2UpdateMargin: ["Margin", "log-leverage"],
    L2CreateSubAccount: ["New Sub", "log-other"],
    ExitPosition: ["Exit", "log-trade"],
    ExitPositionWithFunding: ["Exit", "log-trade"],
    Deleverage: ["Deleverage", "log-liq"],
    DeleverageWithFunding: ["Deleverage", "log-liq"],
  };

  async function fetchMarkets() {
    if (Object.keys(marketIndexMap).length > 0) return;
    try {
      const data = await fetchJson("/api/markets", explorerBaseUrl + "/api/markets");
      if (Array.isArray(data)) {
        for (const m of data) marketIndexMap[m.market_index] = m.symbol;
      }
    } catch { /* ignore */ }
  }

  function marketSymbol(idx) {
    return marketIndexMap[idx] || ("Mkt#" + idx);
  }

  function logTypeBadge(pubdataType) {
    const info = LOG_LABELS[pubdataType] || [pubdataType, "log-other"];
    return '<span class="badge badge-log ' + info[1] + '">' + esc(info[0]) + '</span>';
  }

  function logDetails(log) {
    const pd = log.pubdata || {};

    // Trade
    const trade = pd.trade_pubdata || pd.trade_pubdata_with_funding;
    if (trade) {
      const side = trade.is_taker_ask === 0 ? "Buy" : "Sell";
      const sideClass = trade.is_taker_ask === 0 ? "pnl-positive" : "pnl-negative";
      return '<span class="' + sideClass + '">' + side + '</span>' +
        ' ' + esc(marketSymbol(trade.market_index)) +
        ' @ ' + esc(trade.price) + ' &times; ' + esc(trade.size);
    }

    // Leverage
    const lev = pd.l2_update_leverage_pubdata;
    if (lev) {
      const mult = lev.initial_margin_fraction > 0 ? Math.round(10000 / lev.initial_margin_fraction) + "x" : "?";
      const mode = lev.margin_mode === 1 ? "isolated" : "cross";
      return esc(marketSymbol(lev.market_index)) + ' &rarr; ' + mult + ' ' + mode;
    }

    // Margin
    const margin = pd.l2_update_margin_pubdata;
    if (margin) {
      const isAdd = margin.direction === 0;
      const arrow = isAdd ? '<span class="pnl-positive">+</span> ' : '<span class="pnl-negative">&minus;</span> ';
      return esc(marketSymbol(margin.market_index)) + ' ' + arrow + esc(margin.usdc_amount) + ' USDC';
    }

    // Transfer
    const xfer = pd.l2_transfer_pubdata_v2 || pd.l2_transfer_pubdata;
    if (xfer) {
      const isFrom = String(xfer.from_account_index) === String(logsAccountId);
      if (isFrom) {
        return '<span class="pnl-negative">&rarr;</span> #' + esc(xfer.to_account_index) + ' ' + esc(xfer.amount) + ' ' + esc(xfer.asset_index || "USDC");
      }
      return '<span class="pnl-positive">&larr;</span> #' + esc(xfer.from_account_index) + ' ' + esc(xfer.amount) + ' ' + esc(xfer.asset_index || "USDC");
    }

    // Deposit
    const dep = pd.l1_deposit_pubdata;
    if (dep) {
      return '<span class="pnl-positive">+</span> ' + esc(dep.amount) + ' ' + esc(dep.asset_index || "USDC");
    }

    // Withdraw
    const wd = pd.withdraw_pubdata;
    if (wd) {
      return '<span class="pnl-negative">&minus;</span> ' + esc(wd.amount) + ' ' + esc(wd.asset_index || "USDC");
    }

    return "—";
  }

  function formatLogTime(isoStr) {
    const d = new Date(isoStr);
    const utcStr = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const localStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (settingTz === "utc") {
      const shown = d.toLocaleDateString("en-US", { month: 'short', day: 'numeric', timeZone: 'UTC' }) + ' ' +
        d.toLocaleTimeString("en-US", { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', hour12: false });
      return { display: shown, tooltip: localStr + ' (local)' };
    }
    return { display: localStr, tooltip: utcStr };
  }

  const LOG_STATUS_CSS = {
    executed:            "log-status-ok",
    nothing_to_execute:  "log-status-skip",
    failed:              "log-status-fail",
    pending:             "log-status-pending"
  };

  function logStatusBadge(status) {
    if (!status) return "";
    const cls = LOG_STATUS_CSS[status] || "log-status-other";
    const label = status.replace(/_/g, " ");
    return '<span class="badge badge-log ' + cls + '">' + esc(label) + '</span>';
  }

  function renderLogRow(log) {
    const type = log.pubdata_type || log.tx_type || "Unknown";
    const time = formatLogTime(log.time);

    let badge = logTypeBadge(type);
    if (type === "L2TransferV2" || type === "L2Transfer") {
      const xfer = (log.pubdata || {}).l2_transfer_pubdata_v2 || (log.pubdata || {}).l2_transfer_pubdata;
      if (xfer) {
        const dir = String(xfer.from_account_index) === String(logsAccountId) ? "OUT" : "IN";
        badge = '<span class="badge badge-log log-transfer">Transfer (' + dir + ')</span>';
      }
    }

    const hashAttr = log.hash ? ' data-tx="' + esc(log.hash) + '"' : '';

    return '<tr class="log-row"' + hashAttr + '>' +
      '<td style="white-space:nowrap" title="' + esc(time.tooltip) + '">' + esc(time.display) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + logDetails(log) + '</td>' +
      '<td>' + logStatusBadge(log.status) + '</td>' +
    '</tr>';
  }

  function rerenderLogs() {
    if (!logsData.length) return;
    logsTbody.innerHTML = logsData.map(renderLogRow).join("");
  }

  async function loadLogs(append) {
    if (isLoadingLogs) return;
    if (append && logsAllLoaded) return;

    if (!append) {
      logsTbody.innerHTML = "";
      logsOffset = 0;
      logsAllLoaded = false;
      logsData = [];
      hide(logsEmpty);
    }

    isLoadingLogs = true;
    show(logsLoading);

    try {
      const [proxyUrl, directUrl] = logsUrl(logsAccountId, LOGS_LIMIT, logsOffset);
      const logs = await fetchJson(proxyUrl, directUrl);

      hide(logsLoading);

      if (logs.length === 0 && logsOffset === 0) {
        show(logsEmpty);
        hide(logsTable);
        hide(logsExportBtn);
        logsAllLoaded = true;
        isLoadingLogs = false;
        return;
      }

      show(logsTable);
      show(logsExportBtn);
      logsData = logsData.concat(logs);
      logsTbody.insertAdjacentHTML("beforeend", logs.map(renderLogRow).join(""));
      logsOffset += logs.length;

      if (logs.length < LOGS_LIMIT) {
        logsAllLoaded = true;
      }
      if (logsAccountId) {
        logsCache[logsAccountId] = { data: logsData.slice(), allLoaded: logsAllLoaded };
      }
    } catch (err) {
      hide(logsLoading);
      showToast("Error", "Failed to load account history", "error");
    }
    isLoadingLogs = false;
  }

  async function openLogsModal(accountId) {
    logsAccountId = String(accountId);
    logsAccountLabel.textContent = "#" + logsAccountId;
    show(logsModal);
    hide(logsExportBtn);
    await fetchMarkets();

    const cached = logsCache[logsAccountId];
    if (cached && cached.data.length > 0) {
      logsData = cached.data.slice();
      logsOffset = logsData.length;
      logsAllLoaded = cached.allLoaded;
      logsTbody.innerHTML = logsData.map(renderLogRow).join("");
      show(logsTable);
      show(logsExportBtn);
      hide(logsEmpty);
      // Fetch new logs that appeared since cache
      await loadNewLogs();
    } else {
      loadLogs(false);
    }
  }

  async function loadNewLogs() {
    if (!logsAccountId || !logsData.length) return;
    const firstTime = logsData[0].time;

    try {
      let newLogs = [];
      let off = 0;
      while (true) {
        let batch;
        try {
          const [proxyUrl, directUrl] = logsUrl(logsAccountId, LOGS_LIMIT, off);
          batch = await fetchJson(proxyUrl, directUrl);
        } catch { break; }
        if (!batch.length) break;

        let hitExisting = false;
        for (const log of batch) {
          if (log.time <= firstTime) { hitExisting = true; break; }
          newLogs.push(log);
        }
        if (hitExisting || batch.length < LOGS_LIMIT) break;
        off += batch.length;
      }

      if (newLogs.length > 0) {
        logsData = newLogs.concat(logsData);
        logsOffset = logsData.length;
        logsTbody.innerHTML = logsData.map(renderLogRow).join("");
        showToast("History", newLogs.length + " new entries", "info");
      }
    } catch { /* ignore */ }
  }

  function closeLogsModal() {
    // Save to cache before closing
    if (logsAccountId && logsData.length > 0) {
      logsCache[logsAccountId] = { data: logsData.slice(), allLoaded: logsAllLoaded };
    }
    hide(logsModal);
    logsAccountId = null;
    logsData = [];
    logsTbody.innerHTML = "";
    hide(logsTable);
    hide(logsEmpty);
    hide(logsLoading);
  }

  // ── Transaction lookup ──────────────────────────────────

  const TX_TYPES = {
    1:"Deposit", 2:"ChangePubKey (L1)", 3:"CreateMarket", 4:"UpdateMarket",
    5:"CancelAll (L1)", 6:"Withdraw (L1)", 7:"CreateOrder (L1)",
    8:"ChangePubKey", 9:"CreateSubAccount", 10:"CreatePool", 11:"UpdatePool",
    12:"Transfer", 13:"Withdraw", 14:"CreateOrder", 15:"CancelOrder",
    16:"CancelAllOrders", 17:"ModifyOrder", 18:"MintShares", 19:"BurnShares",
    20:"UpdateLeverage", 21:"ClaimOrder", 22:"CancelOrder (int)",
    23:"Deleverage", 24:"ExitPosition", 25:"CancelAll (int)",
    26:"Liquidation", 27:"CreateOrder (int)", 28:"GroupedOrders",
    29:"UpdateMargin", 30:"BurnShares (L1)"
  };

  const TX_STATUSES = {
    0: ["Failed",   "tx-failed"],
    1: ["Pending",  "tx-pending"],
    2: ["Executed", "tx-executed"],
    3: ["Executed", "tx-executed"]
  };

  function txTypeBadge(typeNum) {
    const label = TX_TYPES[typeNum] || ("Type " + typeNum);
    return '<span class="badge badge-log log-other">' + esc(label) + '</span>';
  }

  function txStatusBadge(status) {
    const info = TX_STATUSES[status] || ["Unknown", "tx-pending"];
    return '<span class="badge badge-log ' + info[1] + '">' + esc(info[0]) + '</span>';
  }

  function formatTxTime(tsMs) {
    if (!tsMs) return { display: "—", tooltip: "" };
    // transaction_time is in microseconds, others in ms
    const ms = tsMs > 1e15 ? Math.floor(tsMs / 1000) : tsMs;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return { display: "—", tooltip: "" };
    const utcStr = d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
    const localStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (settingTz === "utc") {
      const shown = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) + " " +
        d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC", hour12: false });
      return { display: shown, tooltip: localStr + " (local)" };
    }
    return { display: localStr, tooltip: utcStr };
  }

  function parseTxField(val) {
    if (!val) return {};
    if (typeof val === "string") { try { return JSON.parse(val); } catch { return {}; } }
    return val;
  }

  const ORDER_TYPES = { 0:"Limit", 1:"Market", 2:"Stop Loss", 3:"Stop Loss Limit", 4:"Take Profit", 5:"TP Limit", 6:"TWAP", 7:"TWAP Sub", 8:"Liquidation" };
  const TIF_LABELS  = { 0:"IOC", 1:"GoodTillTime", 2:"PostOnly" };

  // helpers
  function txF(label, value, full) {
    return '<div class="field' + (full ? ' full' : '') + '"><span class="label">' + esc(label) + '</span><span class="value">' + value + '</span></div>';
  }
  function txAccLink(index) {
    return '<a href="#" class="tx-account-link mono" data-index="' + esc(index) + '">#' + esc(index) + '</a>';
  }
  function txUsdcAmt(raw) { return (raw / 1e6).toFixed(2) + ' USDC'; }
  function pick(info, key, ev, abbr) {
    return info[key] !== undefined ? info[key] : (ev && ev[abbr] !== undefined ? ev[abbr] : undefined);
  }

  // ── Hero section per tx type ───────────────────────
  function renderTxHero(tx, info, ev) {
    const t = tx.type;

    // Transfer (12)
    if (t === 12) {
      const from = pick(info, "FromAccountIndex", ev, "fa");
      const to = pick(info, "ToAccountIndex", ev, "ta");
      const amt = info.Amount !== undefined ? txUsdcAmt(info.Amount) : (ev.c !== undefined ? txUsdcAmt(ev.c) : "—");
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">Transfer</div>' +
        '<div class="tx-hero-value">' + esc(amt) + '</div>' +
        '<div class="tx-hero-sub">' + (from ? txAccLink(from) : '?') + ' <span style="color:var(--text-muted)">&rarr;</span> ' + (to ? txAccLink(to) : '?') + '</div>' +
      '</div>';
    }

    // CreateOrder / ModifyOrder / GroupedOrders (14,17,28)
    if (t === 14 || t === 17 || t === 28) {
      const isAsk = pick(info, "IsAsk", ev, "ia");
      const side = isAsk === 0 ? '<span class="pnl-positive">Buy</span>' : '<span class="pnl-negative">Sell</span>';
      const mkt = pick(info, "MarketIndex", ev, "m");
      const price = pick(info, "Price", ev, "p");
      const size = pick(info, "Size", ev, "s");
      const ot = pick(info, "OrderType", ev, "ot");
      const otLabel = ot !== undefined ? ORDER_TYPES[ot] || ("Type " + ot) : "";
      const sym = mkt !== undefined ? marketSymbol(mkt) : "—";
      const action = t === 17 ? "Modify" : (t === 28 ? "Grouped" : otLabel || "Order");
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">' + esc(action) + '</div>' +
        '<div class="tx-hero-value">' + side + ' ' + esc(sym) + '</div>' +
        (price !== undefined ? '<div class="tx-hero-sub">@ ' + esc(price) + (size !== undefined ? ' &times; ' + esc(size) : '') + '</div>' : '') +
      '</div>';
    }

    // CancelOrder (15) / CancelAllOrders (16)
    if (t === 15 || t === 16) {
      const mkt = pick(info, "MarketIndex", ev, "m");
      const oi = pick(info, "OrderIndex", ev, "i");
      const sym = mkt !== undefined ? marketSymbol(mkt) : "";
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">' + (t === 16 ? 'Cancel All Orders' : 'Cancel Order') + '</div>' +
        '<div class="tx-hero-value">' + (sym ? esc(sym) : '—') + '</div>' +
        (oi !== undefined ? '<div class="tx-hero-sub">Order #' + esc(oi) + '</div>' : '') +
      '</div>';
    }

    // UpdateMargin (29)
    if (t === 29) {
      const amt = pick(info, "USDCAmount", ev, "c");
      const dir = pick(info, "Direction", ev, "d");
      const mkt = pick(info, "MarketIndex", ev, "m");
      const dirLabel = dir === 0 ? '<span class="pnl-positive">+ Add</span>' : '<span class="pnl-negative">− Remove</span>';
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">Update Margin</div>' +
        '<div class="tx-hero-value">' + dirLabel + ' ' + (amt !== undefined ? txUsdcAmt(amt) : '—') + '</div>' +
        (mkt !== undefined ? '<div class="tx-hero-sub">' + esc(marketSymbol(mkt)) + '</div>' : '') +
      '</div>';
    }

    // UpdateLeverage (20)
    if (t === 20) {
      const mkt = pick(info, "MarketIndex", ev, "m");
      const mm = ev.mm;
      const imf = ev.imf;
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">Update Leverage</div>' +
        '<div class="tx-hero-value">' + (mkt !== undefined ? esc(marketSymbol(mkt)) : '—') + '</div>' +
        '<div class="tx-hero-sub">' + (mm !== undefined ? (mm === 0 ? 'Cross' : 'Isolated') : '') + (imf !== undefined ? ' &middot; IMF ' + esc(imf) : '') + '</div>' +
      '</div>';
    }

    // Deposit (1) / Withdraw (13,6)
    if (t === 1 || t === 13 || t === 6) {
      const amt = pick(info, "USDCAmount", ev, "c") || pick(info, "Amount", ev, "c");
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">' + (t === 1 ? 'Deposit' : 'Withdraw') + '</div>' +
        '<div class="tx-hero-value">' + (amt !== undefined ? txUsdcAmt(amt) : '—') + '</div>' +
      '</div>';
    }

    // MintShares (18) / BurnShares (19,30)
    if (t === 18 || t === 19 || t === 30) {
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">' + (t === 18 ? 'Mint Shares' : 'Burn Shares') + '</div>' +
        '<div class="tx-hero-value">' + (TX_TYPES[t] || 'Shares') + '</div>' +
      '</div>';
    }

    // CreateSubAccount (9)
    if (t === 9) {
      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">New Sub-Account</div>' +
        '<div class="tx-hero-value">Create Sub-Account</div>' +
      '</div>';
    }

    // Internal ops (21-27) — ClaimOrder, Deleverage, Liquidation, etc.
    if (t >= 21 && t <= 27) {
      const mkt = pick(info, "MarketIndex", ev, "m");
      const trade = ev.t;  // { p, s, tf, mf }
      const label = TX_TYPES[t] || "Type " + t;

      if (trade && trade.p !== undefined) {
        // Has trade data — show as trade execution
        const takerOrd = ev.to;
        const isAsk = takerOrd ? takerOrd.ia : undefined;
        const side = isAsk === 0 ? '<span class="pnl-positive">Buy</span>' : (isAsk === 1 ? '<span class="pnl-negative">Sell</span>' : '');
        const sym = mkt !== undefined ? marketSymbol(mkt) : "—";
        return '<div class="tx-hero">' +
          '<div class="tx-hero-label">' + esc(label) + '</div>' +
          '<div class="tx-hero-value">' + side + (side ? ' ' : '') + esc(sym) + '</div>' +
          '<div class="tx-hero-sub">@ ' + esc(trade.p) + ' &times; ' + esc(trade.s) + '</div>' +
        '</div>';
      }

      return '<div class="tx-hero">' +
        '<div class="tx-hero-label">Internal</div>' +
        '<div class="tx-hero-value">' + esc(label) + '</div>' +
        (mkt !== undefined ? '<div class="tx-hero-sub">' + esc(marketSymbol(mkt)) + '</div>' : '') +
      '</div>';
    }

    // Fallback
    return '<div class="tx-hero">' +
      '<div class="tx-hero-label">Transaction</div>' +
      '<div class="tx-hero-value">' + esc(TX_TYPES[t] || 'Type ' + t) + '</div>' +
    '</div>';
  }

  // ── Details section per tx type ────────────────────
  function renderTxTypeDetails(tx, info, ev) {
    let fields = "";
    const t = tx.type;

    // Order-specific
    if (t === 14 || t === 17 || t === 28 || t === 7) {
      const ot = pick(info, "OrderType", ev, "ot");
      if (ot !== undefined) fields += txF("Order Type", esc(ORDER_TYPES[ot] || ot));
      const tif = pick(info, "TimeInForce", ev, "f");
      if (tif !== undefined) fields += txF("Time in Force", esc(TIF_LABELS[tif] || tif));
      const ro = pick(info, "ReduceOnly", ev, "ro");
      if (ro !== undefined) fields += txF("Reduce Only", ro ? "Yes" : "No");
      const tp = pick(info, "TriggerPrice", ev, "tp");
      if (tp !== undefined && tp !== 0 && tp !== "0") fields += txF("Trigger Price", esc(tp));
      if (ev.is !== undefined) fields += txF("Initial Size", esc(ev.is));
      if (ev.rs !== undefined) fields += txF("Remaining Size", esc(ev.rs));
      const oi = pick(info, "OrderIndex", ev, "i");
      if (oi !== undefined) fields += txF("Order Index", '<span class="mono">' + esc(oi) + '</span>');
    }

    // Cancel-specific
    if (t === 15) {
      const oi = pick(info, "OrderIndex", ev, "i");
      if (oi !== undefined) fields += txF("Order Index", '<span class="mono">' + esc(oi) + '</span>');
    }

    // Transfer-specific
    if (t === 12) {
      const fee = info.USDCFee !== undefined ? info.USDCFee : ev.uf;
      if (fee !== undefined && fee !== 0) fields += txF("Fee", txUsdcAmt(fee));
      const asset = info.AssetIndex;
      if (asset !== undefined) fields += txF("Asset", esc(asset));
    }

    // Margin/Leverage
    if (t === 29) {
      if (ev.mm !== undefined) fields += txF("Margin Mode", ev.mm === 0 ? "Cross" : "Isolated");
    }
    if (t === 20) {
      const mkt = pick(info, "MarketIndex", ev, "m");
      if (mkt !== undefined) fields += txF("Market", esc(marketSymbol(mkt)));
    }

    // Fees (top-level)
    if (ev.tf !== undefined && !ev.t) fields += txF("Taker Fee", esc(ev.tf));
    if (ev.mf !== undefined && !ev.t) fields += txF("Maker Fee", esc(ev.mf));

    // Internal trade ops (21-27)
    if (t >= 21 && t <= 27) {
      const trade = ev.t;
      if (trade) {
        if (trade.tf !== undefined) fields += txF("Taker Fee", esc(trade.tf));
        if (trade.mf !== undefined) fields += txF("Maker Fee", esc(trade.mf));
      }
    }

    if (!fields) { /* may still have order sections below */ }

    let sections = "";
    if (fields) {
      sections += '<div class="tx-section">' +
        '<div class="tx-section-title">Details</div>' +
        '<div class="tx-grid">' + fields + '</div>' +
      '</div>';
    }

    // Maker / Taker order cards for internal ops
    if (t >= 21 && t <= 27) {
      const mo = ev.mo;
      const to = ev.to;
      if (mo || to) {
        const renderOrd = (ord, label) => {
          if (!ord) return "";
          const side = ord.ia === 0 ? '<span class="pnl-positive">Buy</span>' : '<span class="pnl-negative">Sell</span>';
          const ot = ORDER_TYPES[ord.ot] || ord.ot;
          const tif = TIF_LABELS[ord.f] || ord.f;
          const st = ord.st === 2 ? "Filled" : (ord.st === 3 ? "Closed" : (ord.st === 1 ? "Open" : "st:" + ord.st));
          let r = '<div class="tx-section">' +
            '<div class="tx-section-title">' + label + '</div>' +
            '<div class="tx-grid">';
          r += txF("Side", side);
          r += txF("Order Type", esc(ot));
          if (ord.p !== undefined) r += txF("Price", esc(ord.p));
          r += txF("Status", esc(st));
          if (ord.is !== undefined) r += txF("Initial Size", esc(ord.is));
          if (ord.rs !== undefined) r += txF("Remaining", esc(ord.rs));
          if (ord.a !== undefined) r += txF("Account", txAccLink(ord.a));
          if (tif) r += txF("TIF", esc(tif));
          if (ord.i !== undefined) r += txF("Order ID", '<span class="mono">' + esc(ord.i) + '</span>');
          if (ord.ro) r += txF("Reduce Only", "Yes");
          r += '</div></div>';
          return r;
        };
        sections += renderOrd(mo, "Maker Order");
        sections += renderOrd(to, "Taker Order");
      }
    }

    return sections;
  }

  let txRawVisible = false;

  function renderTxDetails(tx) {
    const hash = tx.hash || "";
    const info = parseTxField(tx.info);
    const ev = parseTxField(tx.event_info);
    const time = formatTxTime(tx.executed_at || tx.transaction_time || tx.queued_at);
    const shortHash = hash.slice(0, 10) + "\u2026" + hash.slice(-8);

    let html = '<div class="tx-card">';

    // ── Header: type + status + hash ─────────────
    html += '<div class="tx-header">' +
      txTypeBadge(tx.type) + txStatusBadge(tx.status) +
      '<span class="tx-hash-display copy-target" data-copy="' + esc(hash) + '" title="Click to copy full hash">' + esc(shortHash) + '</span>' +
    '</div>';

    // ── Hero ──────────────────────────────────────
    html += renderTxHero(tx, info, ev);

    // ── Error banner ─────────────────────────────
    if (ev.ae && ev.ae !== "") {
      html += '<div class="tx-error-banner">\u26A0 ' + esc(ev.ae) + '</div>';
    }

    // ── Type-specific details ────────────────────
    html += renderTxTypeDetails(tx, info, ev);

    // ── Meta info ────────────────────────────────
    let meta = "";
    if (tx.account_index) meta += txF("Account", txAccLink(tx.account_index));
    if (tx.l1_address) meta += txF("L1 Address", '<span class="mono" style="font-size:0.72rem">' + esc(tx.l1_address) + '</span>', true);
    if (tx.block_height) meta += txF("Block", Number(tx.block_height).toLocaleString());
    meta += txF("Time", '<span title="' + esc(time.tooltip) + '">' + esc(time.display) + '</span>');
    if (tx.nonce !== undefined) meta += txF("Nonce", esc(tx.nonce));
    if (tx.parent_hash) {
      const ph = tx.parent_hash;
      const shortPh = ph.slice(0, 10) + "\u2026" + ph.slice(-8);
      meta += txF("Parent TX", '<a href="#" class="tx-hash-link mono" data-hash="' + esc(ph) + '">' + esc(shortPh) + '</a>');
    }

    html += '<div class="tx-section">' +
      '<div class="tx-section-title">Transaction Info</div>' +
      '<div class="tx-grid">' + meta + '</div>' +
    '</div>';

    // ── Raw JSON toggle ──────────────────────────
    html += '<div class="tx-section" style="border-bottom:none">' +
      '<button class="btn-export tx-raw-toggle" style="font-size:0.75rem">{} JSON</button>' +
      '<pre class="tx-raw-json' + (txRawVisible ? '' : ' hidden') + '">' +
      syntaxHighlight(tx) + '</pre>' +
    '</div>';

    html += '</div>';
    txDetails.innerHTML = html;
  }

  function rerenderTx() {
    if (!currentTxData || txModal.classList.contains("hidden")) return;
    renderTxDetails(currentTxData);
  }

  async function openTxModal(hash) {
    show(txModal);
    show(txLoading);
    hide(txDetails);
    hide(txError);
    txDetails.innerHTML = "";
    currentTxData = null;
    txRawVisible = false;

    await fetchMarkets();

    try {
      const resp = await fetch("/api/tx?hash=" + encodeURIComponent(hash));
      if (!resp.ok) throw new Error("not found");
      const tx = await resp.json();
      hide(txLoading);

      currentTxData = tx;
      renderTxDetails(tx);
      show(txDetails);
    } catch {
      hide(txLoading);
      show(txError);
    }
  }

  function closeTxModal() {
    hide(txModal);
    txDetails.innerHTML = "";
    hide(txDetails);
    hide(txError);
    hide(txLoading);
    currentTxData = null;
    txRawVisible = false;
  }

  // ── Logs CSV export ─────────────────────────────────────

  function logCsvRow(log) {
    const pd = log.pubdata || {};
    const type = log.pubdata_type || log.tx_type || "";
    const time = log.time || "";

    let side = "", market = "", price = "", size = "", leverage = "", direction = "", amount = "";

    const trade = pd.trade_pubdata || pd.trade_pubdata_with_funding;
    if (trade) {
      side = trade.is_taker_ask === 0 ? "Buy" : "Sell";
      market = marketSymbol(trade.market_index);
      price = trade.price || "";
      size = trade.size || "";
    }

    const lev = pd.l2_update_leverage_pubdata;
    if (lev) {
      market = marketSymbol(lev.market_index);
      leverage = lev.initial_margin_fraction > 0 ? Math.round(10000 / lev.initial_margin_fraction) + "x" : "";
    }

    const mgn = pd.l2_update_margin_pubdata;
    if (mgn) {
      market = marketSymbol(mgn.market_index);
      direction = mgn.direction === 0 ? "add" : "remove";
      amount = mgn.usdc_amount || "";
    }

    const xfer = pd.l2_transfer_pubdata_v2 || pd.l2_transfer_pubdata;
    if (xfer) {
      const isFrom = String(xfer.from_account_index) === String(logsAccountId);
      direction = isFrom ? "send to #" + xfer.to_account_index : "receive from #" + xfer.from_account_index;
      amount = xfer.amount || "";
    }

    const dep = pd.l1_deposit_pubdata;
    if (dep) { direction = "deposit"; amount = dep.amount || ""; }

    const wd = pd.withdraw_pubdata;
    if (wd) { direction = "withdraw"; amount = wd.amount || ""; }

    return [time, type, side, market, price, size, leverage, direction, amount, log.status || "", log.hash || ""]
      .map(csvEscape).join(",");
  }

  function downloadLogsCsv(logs) {
    const header = "time,type,side,market,price,size,leverage,transfer,amount,status,hash";
    const rows = [header].concat(logs.map(logCsvRow));
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lighter_history_" + logsAccountId + "_" + csvTimestamp() + ".csv";
    a.click();
    URL.revokeObjectURL(url);
    showToast("CSV Export", logs.length + " log entries exported", "success");
  }

  async function fetchAllLogs() {
    const all = [];
    let offset = 0;
    const limit = 100;

    logsExportFullBtn.disabled = true;
    show(logsExportProgress);

    try {
      while (true) {
        logsExportProgress.textContent = "Loading... " + all.length + " entries";

        const [proxyUrl, directUrl] = logsUrl(logsAccountId, limit, offset);
        const logs = await fetchJson(proxyUrl, directUrl);

        all.push(...logs);
        offset += logs.length;

        if (logs.length < limit) break;
      }

      // Update the visible table with all data
      logsData = all;
      logsOffset = all.length;
      logsAllLoaded = true;
      logsCache[logsAccountId] = { data: all.slice(), allLoaded: true };
      logsTbody.innerHTML = all.map(renderLogRow).join("");
      show(logsTable);

      hide(logsExportModal);
      downloadLogsCsv(all);
    } catch {
      showToast("Error", "Failed to load full history", "error");
    } finally {
      logsExportFullBtn.disabled = false;
      hide(logsExportProgress);
    }
  }

  function showLogsExportModal() {
    logsExportFullLabel.textContent = logsAllLoaded
      ? "Full history (" + logsData.length + ")"
      : "Full history (load all)";
    $("logs-export-loaded-label").textContent = "Loaded (" + logsData.length + ")";
    hide(logsExportProgress);
    logsExportFullBtn.disabled = false;
    show(logsExportModal);
  }

  // ── WS: subscription management ───────────────────────

  function subscribeMasterAccount(accountIndex) {
    unsubscribeMasterAccount();
    masterTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + masterTrackId, handleMainUserStats);
    WS.subscribe("account_all/" + masterTrackId, handleMainAccountAll);
  }

  function unsubscribeMasterAccount() {
    if (!masterTrackId) return;
    WS.unsubscribe("user_stats/" + masterTrackId);
    WS.unsubscribe("account_all/" + masterTrackId);
    masterTrackId = null;
  }

  function subscribeSubAccount(accountIndex) {
    const key = String(accountIndex);
    if (trackedSubs.has(key)) return;
    WS.subscribe("user_stats/" + key, makeSubUserStatsHandler(key));
    WS.subscribe("account_all/" + key, makeSubAccountAllHandler(key));
    trackedSubs.add(key);
  }

  function unsubscribeSubAccount(accountIndex) {
    const key = String(accountIndex);
    if (!trackedSubs.has(key)) return;
    trackedSubs.delete(key);
    WS.unsubscribe("user_stats/" + key);
    WS.unsubscribe("account_all/" + key);
    // No individual toast — reduces spam
  }

  function refreshSubAccount(accountIndex) {
    const key = String(accountIndex);
    unsubscribeSubAccount(key);
    subscribeSubAccount(key);
  }

  function unsubscribeAllSubs() {
    for (const key of trackedSubs) {
      WS.unsubscribe("user_stats/" + key);
      WS.unsubscribe("account_all/" + key);
    }
    trackedSubs.clear();
  }

  function subscribeSingleAccount(accountIndex) {
    unsubscribeSingleAccount();
    singleTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + singleTrackId, handleSingleUserStats);
    WS.subscribe("account_all/" + singleTrackId, handleSingleAccountAll);
  }

  function unsubscribeSingleAccount() {
    if (!singleTrackId) return;
    WS.unsubscribe("user_stats/" + singleTrackId);
    WS.unsubscribe("account_all/" + singleTrackId);
    singleTrackId = null;
  }

  // ── WS: message handlers ──────────────────────────────

  function findSub(index) {
    return subAccountMap.get(String(index));
  }

  function handleMainUserStats(msg) {
    if (!mainAccountObj || !msg.stats) return;
    applyUserStats(mainAccountObj, msg.stats);
    refreshMainCard();
  }

  function handleMainAccountAll(msg) {
    if (!mainAccountObj) return;
    applyWsPositions(mainAccountObj, msg);
    applyTradeStats(mainAccountObj, msg);
    setField("ma-status", statusHtml(mainAccountObj, true));
  }

  function makeSubUserStatsHandler(index) {
    return (msg) => {
      if (!msg.stats) return;
      const sub = findSub(index);
      if (!sub) return;

      applyUserStats(sub, msg.stats);
      if (sub._cachedDetail) applyUserStats(sub._cachedDetail.accounts[0], msg.stats);

      updateSubRowCells(index, sub);
      reRenderDetail(index);
    };
  }

  function makeSubAccountAllHandler(index) {
    return (msg) => {
      const sub = findSub(index);
      if (!sub) return;

      if (!sub._cachedDetail) sub._cachedDetail = { accounts: [sub] };
      const acc = sub._cachedDetail.accounts[0];

      if (applyWsPositions(acc, msg)) sub._hasPositions = acc._hasPositions;
      applyTradeStats(acc, msg);

      updateSubRowCells(index, sub);
      reRenderDetail(index);
    };
  }

  function getSingleAcc() {
    return singleAccountData && singleAccountData.accounts && singleAccountData.accounts[0];
  }

  function handleSingleUserStats(msg) {
    const acc = getSingleAcc();
    if (!acc || !msg.stats) return;
    applyUserStats(acc, msg.stats);
    renderSingleAccount(acc);
  }

  function handleSingleAccountAll(msg) {
    const acc = getSingleAcc();
    if (!acc) return;
    applyWsPositions(acc, msg);
    applyTradeStats(acc, msg);
    renderSingleAccount(acc);
  }

  // ── WS: market data & height ──────────────────────────

  function handleMarketStats(msg) {
    const raw = msg.market_stats;
    if (!raw) return;

    const statsList = raw.symbol ? [raw] : Object.values(raw).filter((v) => v && typeof v === "object");

    for (const m of statsList) {
      if (m.symbol) {
        marketData[m.symbol] = {
          mark_price: m.mark_price,
          index_price: m.index_price,
          funding_rate: m.funding_rate,
          next_funding_rate: m.next_funding_rate,
          open_interest: m.open_interest,
          daily_volume: m.daily_quote_token_volume,
        };
      }
    }

    const count = Object.keys(marketData).length;
    if (count > 0) wsStatusText.textContent = "Live \u00b7 " + count + " mkts";

    if (!marketDataReceived && count > 0) {
      marketDataReceived = true;
      showToast("Market Data", count + " markets streaming", "success");
    }

    // Throttled re-render of expanded panels
    const needsRender = expandedIndexes.size > 0 ||
      (singleAccountData && !singleSection.classList.contains("hidden"));

    if (!marketRenderTimer && needsRender) {
      marketRenderTimer = setTimeout(() => {
        marketRenderTimer = null;
        reRenderAllExpanded();
        const sa = getSingleAcc();
        if (sa && !singleSection.classList.contains("hidden")) renderSingleAccount(sa);
      }, 2000);
    }
  }

  let heightFlashTimer = null;

  function handleHeight(msg) {
    if (msg.height === undefined) return;
    blockHeight.textContent = Number(msg.height).toLocaleString();
    blockChip.classList.add("chip-flash");
    if (heightFlashTimer) clearTimeout(heightFlashTimer);
    heightFlashTimer = setTimeout(() => blockChip.classList.remove("chip-flash"), 600);
  }

  // ── WS initialization ────────────────────────────────

  async function initWebSocket() {
    try {
      const resp = await fetch("/api/config");
      if (!resp.ok) return;
      const config = await resp.json();

      WS.onStatusChange((isConnected) => {
        wsDot.classList.toggle("ws-connected", isConnected);
        wsStatusText.textContent = isConnected ? "Live" : "Reconnecting...";
        if (isConnected) showToast("WebSocket", "Connected to Lighter", "success");
      });

      if (config.explorer_url) explorerBaseUrl = config.explorer_url;
      WS.init(config);
      WS.subscribe("market_stats/all", handleMarketStats);
      WS.subscribe("height", handleHeight);
    } catch (e) {
      console.warn("WebSocket init failed:", e);
    }
  }

  // ── URL deep linking ──────────────────────────────────

  function updateUrlHash(query) {
    if (query) {
      history.replaceState(null, "", "#q=" + encodeURIComponent(query));
    } else {
      history.replaceState(null, "", window.location.pathname);
    }
  }

  function loadFromUrlHash() {
    const hash = window.location.hash;
    if (hash.startsWith("#q=")) {
      const q = decodeURIComponent(hash.slice(3));
      if (q) {
        input.value = q;
        doSearch();
      }
    }
  }

  // ── Navigation: reset & load ──────────────────────────

  function resetView() {
    input.value = "";
    hide(mainSection);
    hide(subSection);
    hide(singleSection);
    hide(errorEl);
    hide(loadingEl);
    subSearch.value = "";
    filterBalance.checked = false;
    filterActivated.checked = false;
    allSubAccounts = [];
    subAccountMap.clear();
    expandedIndexes.clear();
    expandGeneration = {};
    mainAccountObj = null;
    singleAccountData = null;
    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();
    updateUrlHash("");
  }

  async function loadAddress(l1Address) {
    hide(mainSection); hide(subSection); hide(singleSection); hide(errorEl);
    show(loadingEl);
    subSearch.value = "";
    filterBalance.checked = false;
    filterActivated.checked = false;

    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();

    try {
      const resp = await fetch("/api/account?by=l1_address&value=" + encodeURIComponent(l1Address));
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error(detail.detail || "HTTP " + resp.status);
      }

      const data = await resp.json();
      const accounts = data.accounts || [];
      if (accounts.length === 0) throw new Error("No accounts found for address " + l1Address);

      const main = accounts.find((a) => a.account_type === 0);
      subAccountMap.clear();
      allSubAccounts = accounts.filter((a) => a.account_type === 1).map((acc) => {
        acc._hasPositions = hasRealPositions(acc.positions);
        acc._cachedDetail = { accounts: [acc] };
        subAccountMap.set(String(acc.index), acc);
        return acc;
      });

      if (main) {
        renderMainAccount(main, allSubAccounts);
        subscribeMasterAccount(main.index);
        updateL1HistoryIndex(l1Address, main.index);
      }

      subCount.textContent = allSubAccounts.length;
      updateSortIndicators();
      applyFilters();
      show(subSection);
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    } finally {
      hide(loadingEl);
    }
  }

  async function loadAccountById(accountId) {
    hide(mainSection); hide(subSection); hide(singleSection); hide(errorEl);
    show(loadingEl);

    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();

    try {
      const resp = await fetch("/api/account?by=index&value=" + encodeURIComponent(accountId));
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error(detail.detail || "HTTP " + resp.status);
      }

      const data = await resp.json();
      const accounts = data.accounts || [];
      if (accounts.length === 0) throw new Error("Account #" + accountId + " not found");

      const acc = accounts[0];

      // main account → redirect to full L1 view
      if (acc.account_type === 0 && acc.l1_address) {
        hide(loadingEl);
        input.value = acc.l1_address;
        updateUrlHash(acc.l1_address);
        saveL1ToHistory(acc.l1_address);
        loadAddress(acc.l1_address);
        return;
      }

      singleAccountData = data;
      renderSingleAccount(acc);
      subscribeSingleAccount(accountId);
      saveIndexToHistory(accountId, acc.l1_address);
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    } finally {
      hide(loadingEl);
    }
  }

  // ── Search history (localStorage, grouped) ─────────────

  const HISTORY_KEY_OLD = "lighter_l1_history";
  const HISTORY_KEY     = "lighter_search_history";
  const STORAGE_VER_KEY = "lighter_storage_ver";
  const STORAGE_VER     = 2;   // bump when localStorage format changes
  const historyDropdown = $("history-dropdown");
  const MAX_HIST = 10;

  // Reset localStorage only when storage format changes
  (function migrateStorage() {
    const stored = Number(localStorage.getItem(STORAGE_VER_KEY)) || 0;
    if (stored < STORAGE_VER) {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(HISTORY_KEY_OLD);
      localStorage.setItem(STORAGE_VER_KEY, String(STORAGE_VER));
    }
  })();

  // L1 entries: { addr, index? }   Index entries: { id, l1? }

  function shortAddr(a) { return a && a.length > 16 ? a.slice(0, 8) + "…" + a.slice(-6) : a || ""; }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return { l1: Array.isArray(p.l1) ? p.l1 : [], index: Array.isArray(p.index) ? p.index : [] };
      }
    } catch { /* fall through */ }
    // migrate old flat format
    let old = [];
    try { old = JSON.parse(localStorage.getItem(HISTORY_KEY_OLD)) || []; } catch { /* ignore */ }
    const m = { l1: [], index: [] };
    for (const e of old) {
      if (typeof e === "string" && e.startsWith("0x")) m.l1.push({ addr: e });
      else if (typeof e === "string" && /^\d+$/.test(e)) m.index.push({ id: e });
    }
    m.l1 = m.l1.slice(0, MAX_HIST);
    m.index = m.index.slice(0, MAX_HIST);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(m));
    localStorage.removeItem(HISTORY_KEY_OLD);
    return m;
  }

  function commitHistory(h) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    renderHistory(h);
  }

  function saveL1ToHistory(addr) {
    const h = loadHistory();
    h.l1 = h.l1.filter((e) => e.addr !== addr);
    h.l1.unshift({ addr });
    if (h.l1.length > MAX_HIST) h.l1 = h.l1.slice(0, MAX_HIST);
    commitHistory(h);
  }

  function updateL1HistoryIndex(addr, index) {
    const h = loadHistory();
    const entry = h.l1.find((e) => e.addr === addr);
    if (entry) { entry.index = index; commitHistory(h); }
  }

  function saveIndexToHistory(id, l1) {
    const h = loadHistory();
    h.index = h.index.filter((e) => String(e.id) !== String(id));
    h.index.unshift({ id: String(id), l1: l1 || undefined });
    if (h.index.length > MAX_HIST) h.index = h.index.slice(0, MAX_HIST);
    commitHistory(h);
  }

  function removeFromHistory(val, group) {
    const h = loadHistory();
    if (group === "l1") h.l1 = h.l1.filter((e) => e.addr !== val);
    else h.index = h.index.filter((e) => String(e.id) !== String(val));
    commitHistory(h);
    if (!h.l1.length && !h.index.length) hideHistory();
  }

  function renderHistory(h) {
    if (!h.l1.length && !h.index.length) { historyDropdown.innerHTML = ""; return; }
    let html = "";
    if (h.l1.length) {
      html += '<div class="history-group"><div class="history-group-header">L1 Addresses</div>';
      for (const e of h.l1) {
        const hint = e.index != null ? ' <span class="history-item-idx">(#' + esc(String(e.index)) + ')</span>' : '';
        const label = esc(e.addr) + hint;
        html += '<div class="history-item" data-value="' + esc(e.addr) + '" data-group="l1">'
              + '<span class="history-item-text">' + label + '</span>'
              + '<button class="history-item-remove" data-val="' + esc(e.addr) + '" data-group="l1" title="Remove">&times;</button></div>';
      }
      html += '</div>';
    }
    if (h.index.length) {
      html += '<div class="history-group"><div class="history-group-header">Accounts</div>';
      for (const e of h.index) {
        const hint = e.l1 ? ' <span class="history-item-idx">(' + esc(shortAddr(e.l1)) + ')</span>' : '';
        const label = '#' + esc(e.id) + hint;
        html += '<div class="history-item" data-value="' + esc(e.id) + '" data-group="index">'
              + '<span class="history-item-text">' + label + '</span>'
              + '<button class="history-item-remove" data-val="' + esc(e.id) + '" data-group="index" title="Remove">&times;</button></div>';
      }
      html += '</div>';
    }
    historyDropdown.innerHTML = html;
  }

  function showHistory(filter) {
    const h = loadHistory();
    const q = (filter || "").toLowerCase();
    const filtered = {
      l1: q ? h.l1.filter((e) => e.addr.toLowerCase().includes(q) || (e.index != null && String(e.index).includes(q))) : h.l1,
      index: q ? h.index.filter((e) => String(e.id).includes(q) || (e.l1 && e.l1.toLowerCase().includes(q))) : h.index
    };
    if (!filtered.l1.length && !filtered.index.length) { hideHistory(); return; }
    renderHistory(filtered);
    show(historyDropdown);
  }

  function hideHistory() { hide(historyDropdown); }

  function doSearch() {
    const val = input.value.trim();
    if (!val) return;
    hideHistory();

    if (/^[0-9a-fA-F]{40,80}$/.test(val) && !val.startsWith("0x")) {
      updateUrlHash(val);
      openTxModal(val);
      return;
    }

    updateUrlHash(val);

    if (val.startsWith("0x")) {
      saveL1ToHistory(val);
      loadAddress(val);
    } else if (/^\d+$/.test(val)) {
      loadAccountById(val);
    } else {
      errorEl.textContent = "Invalid input. Enter a 0x... L1 address, account ID, or tx hash.";
      show(errorEl);
    }
  }

  // ── Event listeners ───────────────────────────────────

  // Sub-account row expand/collapse + refresh
  subTbody.addEventListener("click", async (e) => {
    const refreshBtn = e.target.closest(".btn-refresh[data-refresh]");
    if (refreshBtn) {
      e.stopPropagation();
      refreshSubAccount(refreshBtn.dataset.refresh);
      return;
    }

    const historyBtn = e.target.closest("[data-history]");
    if (historyBtn) {
      e.stopPropagation();
      openLogsModal(historyBtn.dataset.history);
      return;
    }

    if (e.target.closest(".detail-row")) return;
    if (e.target.closest(".copyable")) return;

    const row = e.target.closest("tr.sub-row");
    if (!row) return;

    const index = row.dataset.index;

    if (expandedIndexes.has(index)) {
      collapseRow(index);
      return;
    }

    // Expand — with race condition protection via generation counter
    expandedIndexes.add(index);
    const gen = (expandGeneration[index] || 0) + 1;
    expandGeneration[index] = gen;
    expandedColSpan = row.children.length;
    row.classList.add("expanded");

    const colSpan = expandedColSpan;
    const sub = findSub(index);

    if (sub && sub._cachedDetail) {
      const tmp = document.createElement("tr");
      tmp.className = "detail-row-tmp";
      row.after(tmp);
      tmp.outerHTML = renderDetailRow(sub._cachedDetail, colSpan, index);
      subscribeSubAccount(index);
    } else {
      const loadingRow = document.createElement("tr");
      loadingRow.className = "detail-row";
      loadingRow.setAttribute("data-detail-for", index);
      loadingRow.innerHTML = '<td colspan="' + colSpan + '"><div class="detail-panel detail-loading"><div class="spinner"></div> Loading...</div></td>';
      row.after(loadingRow);

      try {
        const resp = await fetch("/api/account?by=index&value=" + encodeURIComponent(index));
        if (!resp.ok) throw new Error("Failed to load");
        const data = await resp.json();

        // Race condition guard: check if expand is still current
        if (!expandedIndexes.has(index) || expandGeneration[index] !== gen) return;

        loadingRow.outerHTML = renderDetailRow(data, colSpan, index);

        const detailAcc = data.accounts && data.accounts[0];
        if (sub && detailAcc) {
          sub._cachedDetail = data;
          sub._hasPositions = hasRealPositions(detailAcc.positions);
          updateSubRowCells(index, sub);
        }

        subscribeSubAccount(index);
      } catch (err) {
        if (!expandedIndexes.has(index) || expandGeneration[index] !== gen) return;
        loadingRow.innerHTML = '<td colspan="' + colSpan + '"><div class="detail-panel detail-error">Failed to load account details</div></td>';
      }
    }
  });

  // Sort headers
  document.querySelector("#sub-accounts thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.key;
    if (sortKey === key) { sortAsc = !sortAsc; }
    else { sortKey = key; sortAsc = true; }
    updateSortIndicators();
    applyFilters();
  });

  // Filters (debounce text input for large account lists)
  let _filterTimer = null;
  subSearch.addEventListener("input", () => {
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(applyFilters, 120);
  });
  filterBalance.addEventListener("change", applyFilters);
  filterActivated.addEventListener("change", applyFilters);

  filterZeroPos.addEventListener("change", () => {
    reRenderAllExpanded();

    const sa = getSingleAcc();
    if (sa) saContent.innerHTML = renderAccountContent(sa, sa.account_type === 0, sa.index);
  });

  // Export modal
  $("btn-export-csv").addEventListener("click", showExportModal);
  $("export-all").addEventListener("click", () => { hideExportModal(); downloadCsv(allSubAccounts); });
  exportFilteredBtn.addEventListener("click", function () {
    if (this.disabled) return;
    hideExportModal();
    downloadCsv(getFilteredSubs());
  });
  $("export-cancel").addEventListener("click", hideExportModal);
  exportModal.addEventListener("click", (e) => { if (e.target === exportModal) hideExportModal(); });

  // Single account refresh + history
  singleSection.addEventListener("click", (e) => {
    const historyBtn = e.target.closest("[data-history]");
    if (historyBtn) {
      e.stopPropagation();
      openLogsModal(historyBtn.dataset.history);
      return;
    }

    const refreshBtn = e.target.closest(".btn-refresh[data-refresh]");
    if (!refreshBtn || !singleTrackId) return;
    e.stopPropagation();
    const idx = singleTrackId;
    unsubscribeSingleAccount();
    subscribeSingleAccount(idx);
  });

  // Main account history
  $("ma-history").addEventListener("click", () => {
    if (mainAccountObj) openLogsModal(mainAccountObj.index);
  });

  // Title click resets
  appTitle.addEventListener("click", resetView);

  // Form submit
  form.addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    else if (e.key === "Escape") { hideHistory(); input.blur(); }
  });
  input.addEventListener("focus", () => showHistory(input.value.trim()));
  input.addEventListener("input", () => showHistory(input.value.trim()));
  document.addEventListener("mousedown", (e) => {
    if (!historyDropdown.contains(e.target) && e.target !== input) hideHistory();
  });
  historyDropdown.addEventListener("mousedown", (e) => {
    e.preventDefault();                 // keep input focus, prevent blur
    e.stopPropagation();                // prevent document listener from closing
    const rm = e.target.closest(".history-item-remove");
    if (rm) { removeFromHistory(rm.dataset.val, rm.dataset.group); return; }
    const item = e.target.closest(".history-item");
    if (item) { input.value = item.dataset.value; hideHistory(); doSearch(); }
  });

  // Logs modal
  $("logs-close").addEventListener("click", closeLogsModal);
  logsModal.addEventListener("click", (e) => { if (e.target === logsModal) closeLogsModal(); });
  logsTbody.addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-tx]");
    if (row) openTxModal(row.dataset.tx);
  });
  $("logs-content").addEventListener("scroll", (e) => {
    const el = e.target;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      loadLogs(true);
    }
  });
  // Logs export
  $("logs-export-csv").addEventListener("click", showLogsExportModal);
  $("logs-export-full").addEventListener("click", () => {
    if (logsAllLoaded) {
      hide(logsExportModal);
      downloadLogsCsv(logsData);
    } else {
      fetchAllLogs();
    }
  });
  $("logs-export-loaded").addEventListener("click", () => {
    hide(logsExportModal);
    downloadLogsCsv(logsData);
  });
  $("logs-export-cancel").addEventListener("click", () => hide(logsExportModal));
  logsExportModal.addEventListener("click", (e) => { if (e.target === logsExportModal) hide(logsExportModal); });

  // TX modal
  $("tx-close").addEventListener("click", closeTxModal);
  txModal.addEventListener("click", (e) => { if (e.target === txModal) closeTxModal(); });
  txDetails.addEventListener("click", (e) => {
    // Click-to-copy hash
    const copyEl = e.target.closest(".copy-target");
    if (copyEl && copyEl.dataset.copy) {
      navigator.clipboard.writeText(copyEl.dataset.copy).then(() => showToast("Copied", "", "info"));
      return;
    }
    // Account link
    const accLink = e.target.closest(".tx-account-link");
    if (accLink) {
      e.preventDefault();
      closeTxModal();
      input.value = accLink.dataset.index;
      doSearch();
      return;
    }
    // Parent tx link
    const txLink = e.target.closest(".tx-hash-link");
    if (txLink) {
      e.preventDefault();
      openTxModal(txLink.dataset.hash);
      return;
    }
    // Raw JSON toggle
    const rawBtn = e.target.closest(".tx-raw-toggle");
    if (rawBtn) {
      const pre = txDetails.querySelector(".tx-raw-json");
      if (pre) {
        txRawVisible = !txRawVisible;
        pre.classList.toggle("hidden", !txRawVisible);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!txModal.classList.contains("hidden")) { closeTxModal(); return; }
    if (!logsExportModal.classList.contains("hidden")) { hide(logsExportModal); return; }
    if (!settingsModal.classList.contains("hidden")) { hide(settingsModal); return; }
    if (!logsModal.classList.contains("hidden")) closeLogsModal();
  });

  // Handle browser back/forward for deep links
  window.addEventListener("hashchange", () => {
    loadFromUrlHash();
  });

  // ── Scroll-to-top button ─────────────────────────────────

  const scrollBtn = $("scroll-top");
  const logsContent = $("logs-content");
  const SCROLL_THRESHOLD = 400;

  function updateScrollBtn() {
    // Check page scroll OR logs modal scroll
    const logsOpen = !logsModal.classList.contains("hidden");
    const scrollY = logsOpen ? logsContent.scrollTop : window.scrollY;
    scrollBtn.classList.toggle("visible", scrollY > SCROLL_THRESHOLD);
  }

  window.addEventListener("scroll", updateScrollBtn, { passive: true });
  logsContent.addEventListener("scroll", updateScrollBtn, { passive: true });

  scrollBtn.addEventListener("click", () => {
    const logsOpen = !logsModal.classList.contains("hidden");
    if (logsOpen) {
      logsContent.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // ── Settings ────────────────────────────────────────────

  function resolveTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function applyTheme(pref) {
    const resolved = resolveTheme(pref);
    if (resolved === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function updateSettingsUI() {
    settingsModal.querySelectorAll("[data-tz]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tz === settingTz);
    });
    settingsModal.querySelectorAll("[data-theme]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.theme === settingTheme);
    });
  }

  applyTheme(settingTheme);

  // Listen for OS theme changes when set to auto
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (settingTheme === "auto") applyTheme("auto");
  });

  function openSettings() {
    updateSettingsUI();
    show(settingsModal);
  }

  $("settings-btn").addEventListener("click", openSettings);

  $("settings-close").addEventListener("click", () => hide(settingsModal));

  settingsModal.addEventListener("click", (e) => {
    const tzBtn = e.target.closest("[data-tz]");
    if (tzBtn) {
      settingTz = tzBtn.dataset.tz;
      localStorage.setItem("lighter_tz", settingTz);
      updateSettingsUI();
      rerenderLogs();
      rerenderTx();
      return;
    }
    const themeBtn = e.target.closest("[data-theme]");
    if (themeBtn) {
      settingTheme = themeBtn.dataset.theme;
      localStorage.setItem("lighter_theme", settingTheme);
      applyTheme(settingTheme);
      updateSettingsUI();
      return;
    }
    // Close only on overlay click (not on inner modal content)
    if (e.target === settingsModal) hide(settingsModal);
  });

  // ── Version check ───────────────────────────────────────

  function compareVersions(a, b) {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pb[i] || 0) - (pa[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  async function checkForUpdates() {
    try {
      const dismissed = localStorage.getItem("lighter_dismissed_ver");
      const resp = await fetch("https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest", {
        headers: { "Accept": "application/vnd.github.v3+json" }
      });
      if (!resp.ok) return;
      const rel = await resp.json();
      const remoteVer = rel.tag_name || "";
      if (!remoteVer || compareVersions(APP_VERSION, remoteVer) <= 0) return;
      if (dismissed === remoteVer) return;

      const banner = document.createElement("div");
      banner.className = "update-banner";
      const releaseUrl = rel.html_url || ("https://github.com/" + GITHUB_REPO + "/releases/tag/" + encodeURIComponent(remoteVer));
      banner.innerHTML =
        '<div class="update-banner-content">' +
          '<div class="update-banner-title">' +
            '<a href="' + esc(releaseUrl) + '" target="_blank" rel="noopener" class="update-banner-link">' +
              '<strong>' + esc(remoteVer) + '</strong> available &#x2197;' +
            '</a>' +
            '<span class="update-banner-current">current: v' + esc(APP_VERSION) + '</span>' +
          '</div>' +
          '<div class="update-banner-body">' + formatChangelog(rel.body || "") + '</div>' +
        '</div>' +
        '<button class="update-banner-close" title="Dismiss">&times;</button>';

      banner.querySelector(".update-banner-close").addEventListener("click", () => {
        banner.remove();
        localStorage.setItem("lighter_dismissed_ver", remoteVer);
      });

      document.body.insertBefore(banner, document.body.firstChild);
    } catch { /* silent */ }
  }

  function formatChangelog(md) {
    // Minimal markdown → HTML for changelog
    return md
      .split("\n")
      .map((line) => {
        line = line.trim();
        if (!line) return "";
        if (line.startsWith("## ")) return '<div class="cl-heading">' + esc(line.slice(3)) + '</div>';
        if (line.startsWith("- ")) return '<div class="cl-item">&bull; ' + esc(line.slice(2)) + '</div>';
        if (line.startsWith("* ")) return '<div class="cl-item">&bull; ' + esc(line.slice(2)) + '</div>';
        return '<div class="cl-item">' + esc(line) + '</div>';
      })
      .filter(Boolean)
      .join("");
  }

  // ── Init ──────────────────────────────────────────────

  renderHistory(loadHistory());
  updateSortIndicators();
  initWebSocket();
  loadFromUrlHash();
  checkForUpdates();
})();
