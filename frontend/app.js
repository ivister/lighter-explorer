(() => {
  "use strict";

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
  const shouldHydrateSubAccount = StatusHelpers.shouldHydrateSubAccount;

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
  let viewGeneration    = 0;

  const SUB_HYDRATE_CONCURRENCY = 6;

  let explorerBaseUrl   = "https://explorer.elliot.ai";
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
    acc._detailHydrated = true;
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

  function mergeHydratedDetail(sub, data) {
    const detailAcc = data.accounts && data.accounts[0];
    if (!detailAcc) return false;

    Object.assign(sub, detailAcc);
    sub._hasPositions = hasRealPositions(detailAcc.positions);
    sub._detailHydrated = true;
    sub._cachedDetail = data;
    return true;
  }

  async function fetchAccountDetail(index) {
    const resp = await fetch("/api/account?by=index&value=" + encodeURIComponent(index));
    if (!resp.ok) throw new Error("Failed to load");
    return resp.json();
  }

  function refreshMainSubSummary() {
    if (!mainAccountObj) return;

    const tradingSubs = allSubAccounts.filter((s) => getAccountStatus(s) === "trading").length;
    const onlineSubs = allSubAccounts.filter((s) => s.status === 1).length;

    setField("ma-active-subs", tradingSubs + " / " + allSubAccounts.length);
    setField("ma-online", onlineSubs);
  }

  async function hydrateSubAccounts(gen) {
    const targets = allSubAccounts.filter(shouldHydrateSubAccount);
    if (targets.length === 0) return;

    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const sub = targets[cursor++];
        if (gen !== viewGeneration) return;
        if (!sub || sub._detailHydrated) continue;

        try {
          const data = await fetchAccountDetail(sub.index);
          if (gen !== viewGeneration) return;
          if (!mergeHydratedDetail(sub, data)) continue;
          updateSubRowCells(String(sub.index), sub);
          reRenderDetail(String(sub.index));
        } catch (err) {
          // Keep the summary state; the row can still self-heal via manual expand + WS.
        }
      }
    }

    const workers = [];
    const workerCount = Math.min(SUB_HYDRATE_CONCURRENCY, targets.length);
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);

    if (gen === viewGeneration) refreshMainSubSummary();
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
    acc._detailHydrated = true;

    setField("ma-index", copyableHtml(acc.index));
    setField("ma-status", statusHtml(acc, true));
    setField("ma-total-asset", formatNumber(acc.total_asset_value, 6));
    setField("ma-collateral", formatValue(acc.collateral));
    setField("ma-balance", formatValue(acc.available_balance));
    setField("ma-mode", tradingMode(acc.account_trading_mode));
    setField("ma-orders", esc(acc.total_order_count));
    setField("ma-pending", esc(acc.pending_order_count));
    setField("ma-active-subs", "0 / " + subs.length);
    setField("ma-online", "0");
    refreshMainSubSummary();
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
    if (row) {
      if (row.children[1]) row.children[1].innerHTML = statusHtml(sub);
      if (row.children[2]) row.children[2].textContent = formatNumber(sub.total_asset_value, 6);
    }
    refreshMainSubSummary();
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

    // Transfer
    const xfer = pd.l2_transfer_pubdata_v2 || pd.l2_transfer_pubdata;
    if (xfer) {
      const isFrom = String(xfer.from_account_index) === String(logsAccountId);
      if (isFrom) {
        return '<span class="pnl-negative">&rarr;</span> #' + esc(xfer.to_account_index) + ' ' + esc(xfer.amount) + ' ' + esc(xfer.asset_index || "USDC");
      }
      return '<span class="pnl-positive">&larr;</span> #' + esc(xfer.from_account_index) + ' ' + esc(xfer.amount) + ' ' + esc(xfer.asset_index || "USDC");
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

    return '<tr>' +
      '<td style="white-space:nowrap" title="' + esc(time.tooltip) + '">' + esc(time.display) + '</td>' +
      '<td>' + badge + '</td>' +
      '<td>' + logDetails(log) + '</td>' +
      '<td><span class="badge badge-log log-other">' + esc(log.status || "") + '</span></td>' +
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

    const xfer = pd.l2_transfer_pubdata_v2 || pd.l2_transfer_pubdata;
    if (xfer) {
      const isFrom = String(xfer.from_account_index) === String(logsAccountId);
      direction = isFrom ? "send to #" + xfer.to_account_index : "receive from #" + xfer.from_account_index;
      amount = xfer.amount || "";
    }

    return [time, type, side, market, price, size, leverage, direction, amount, log.status || ""]
      .map(csvEscape).join(",");
  }

  function downloadLogsCsv(logs) {
    const header = "time,type,side,market,price,size,leverage,transfer,amount,status";
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

      if (applyWsPositions(acc, msg)) {
        sub._hasPositions = acc._hasPositions;
        sub._detailHydrated = true;
      }
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
    viewGeneration += 1;
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
    const loadGen = ++viewGeneration;
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
      if (loadGen !== viewGeneration) return;
      const accounts = data.accounts || [];
      if (accounts.length === 0) throw new Error("No accounts found for address " + l1Address);

      const main = accounts.find((a) => a.account_type === 0);
      subAccountMap.clear();
      allSubAccounts = accounts.filter((a) => a.account_type === 1).map((acc) => {
        acc._hasPositions = hasRealPositions(acc.positions);
        acc._detailHydrated = false;
        acc._cachedDetail = null;
        subAccountMap.set(String(acc.index), acc);
        return acc;
      });

      if (main) {
        renderMainAccount(main, allSubAccounts);
        subscribeMasterAccount(main.index);
      }

      subCount.textContent = allSubAccounts.length;
      updateSortIndicators();
      applyFilters();
      show(subSection);
      void hydrateSubAccounts(loadGen);
    } catch (err) {
      if (loadGen !== viewGeneration) return;
      errorEl.textContent = err.message;
      show(errorEl);
    } finally {
      if (loadGen === viewGeneration) hide(loadingEl);
    }
  }

  async function loadAccountById(accountId) {
    const loadGen = ++viewGeneration;
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
      if (loadGen !== viewGeneration) return;
      const accounts = data.accounts || [];
      if (accounts.length === 0) throw new Error("Account #" + accountId + " not found");

      singleAccountData = data;
      accounts[0]._detailHydrated = true;
      accounts[0]._hasPositions = hasRealPositions(accounts[0].positions);
      renderSingleAccount(accounts[0]);
      subscribeSingleAccount(accountId);
    } catch (err) {
      if (loadGen !== viewGeneration) return;
      errorEl.textContent = err.message;
      show(errorEl);
    } finally {
      if (loadGen === viewGeneration) hide(loadingEl);
    }
  }

  // ── Address history (localStorage) ─────────────────────

  const HISTORY_KEY = "lighter_l1_history";
  const historyDatalist = $("l1-history");

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }

  function saveToHistory(addr) {
    let history = loadHistory().filter((a) => a !== addr);
    history.unshift(addr);
    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory(history);
  }

  function renderHistory(history) {
    historyDatalist.innerHTML = history.map((a) => '<option value="' + esc(a) + '">').join("");
  }

  function doSearch() {
    const val = input.value.trim();
    if (!val) return;
    saveToHistory(val);
    updateUrlHash(val);

    if (val.startsWith("0x")) {
      loadAddress(val);
    } else if (/^\d+$/.test(val)) {
      loadAccountById(val);
    } else {
      errorEl.textContent = "Invalid input. Enter a 0x... L1 address or a numeric account ID.";
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
        const data = await fetchAccountDetail(index);

        // Race condition guard: check if expand is still current
        if (!expandedIndexes.has(index) || expandGeneration[index] !== gen) return;

        loadingRow.outerHTML = renderDetailRow(data, colSpan, index);

        if (sub && mergeHydratedDetail(sub, data)) {
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
  });

  // Logs modal
  $("logs-close").addEventListener("click", closeLogsModal);
  logsModal.addEventListener("click", (e) => { if (e.target === logsModal) closeLogsModal(); });
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

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!logsExportModal.classList.contains("hidden")) { hide(logsExportModal); return; }
    if (!settingsModal.classList.contains("hidden")) { hide(settingsModal); return; }
    if (!logsModal.classList.contains("hidden")) closeLogsModal();
  });

  // Handle browser back/forward for deep links
  window.addEventListener("hashchange", () => {
    loadFromUrlHash();
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

  // ── Init ──────────────────────────────────────────────

  renderHistory(loadHistory());
  updateSortIndicators();
  initWebSocket();
  loadFromUrlHash();
})();
