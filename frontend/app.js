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

  const WS = window.LighterWS;

  // ── State ───────────────────────────────────────────────
  let allSubAccounts    = [];
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
  let trackedSubs       = {};  // { index: true }

  // ── Pure helpers ──────────────────────────────────────────

  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");
  const setField = (id, html) => { $(id).innerHTML = html; };

  function formatValue(val) {
    return (!val || val === "") ? "—" : val;
  }

  function formatNumber(val, decimals) {
    if (val === undefined || val === null || val === "") return "—";
    const n = parseFloat(val);
    return isNaN(n) ? String(val) : n.toFixed(decimals);
  }

  function tradingMode(mode) {
    return mode === 1 ? "Unified" : "Classic";
  }

  function hasBalance(acc) {
    return parseFloat(acc.collateral) > 0 || parseFloat(acc.available_balance) > 0;
  }

  function hasRealPositions(positions) {
    if (!positions || !positions.length) return false;
    return positions.some((p) => parseFloat(p.position_value) !== 0);
  }

  function pnlClass(val) {
    return val === 0 ? "pnl-zero" : val > 0 ? "pnl-positive" : "pnl-negative";
  }

  // ── Account status helpers ─────────────────────────────

  function getAccountStatus(acc) {
    const hasBal = hasBalance(acc);
    if (hasBal && acc._hasPositions) return "trading";
    if (hasBal) return "check";
    return "idle";
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

  function applyTradeStats(acc, msg) {
    const keys = ["daily_trades_count", "daily_volume", "weekly_trades_count", "weekly_volume", "total_trades_count", "total_volume"];
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

  // ── Toast notifications ───────────────────────────────

  function showToast(title, message, type) {
    type = type || "info";
    const el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.innerHTML =
      '<div class="toast-body">' +
        '<div class="toast-title">' + title + '</div>' +
        '<div class="toast-message">' + message + '</div>' +
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
    return '<span class="copyable" data-copy="' + value + '" title="Click to copy">' + value + '</span>';
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

    const leverage = parseFloat(p.initial_margin_fraction) > 0
      ? Math.round(100 / parseFloat(p.initial_margin_fraction)) + "x"
      : "—";

    const isolatedBadge = p.margin_mode === 1
      ? ' <span class="badge badge-isolated" title="Isolated margin · allocated ' + formatValue(p.allocated_margin) + '">Isolated</span>'
      : '';

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

    return '<tr>' +
      '<td>' + p.symbol + isolatedBadge + '</td>' +
      '<td>' + signLabel(p.sign) + '</td>' +
      '<td>' + leverage + '</td>' +
      '<td>' + p.position + '</td>' +
      '<td>' + p.avg_entry_price + '</td>' +
      '<td class="live-value">' + markPrice + '</td>' +
      '<td>' + marginHtml + '</td>' +
      '<td>' + posValue + '</td>' +
      '<td class="' + pnlClass(upnl) + '">' + formatNumber(upnl, 6) + '</td>' +
      '<td class="' + pnlClass(rpnl) + '">' + p.realized_pnl + '</td>' +
      '<td>' + p.open_order_count + '</td>' +
      '<td title="' + liqTooltip + '">' + liqPrice + '</td>' +
    '</tr>';
  }

  // ── Rendering: account content (shared) ───────────────

  function renderAccountContent(acc, skipCheck, refreshIndex) {
    if (acc._hasPositions === undefined) acc._hasPositions = hasRealPositions(acc.positions);

    const showZero = filterZeroPos.checked;
    const positions = showZero
      ? (acc.positions || [])
      : (acc.positions || []).filter((p) => parseFloat(p.position_value) !== 0);

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
                '<th>Market</th><th>Side</th><th>Leverage</th><th>Size</th>' +
                '<th>Avg Entry</th><th>Mark Price</th><th>Margin</th>' +
                '<th>Value</th><th>Unrealized PnL</th><th>Realized PnL</th>' +
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
    const displayAvail = totals.hasLive ? Math.max(0, liveAsset - collateral).toFixed(6) : acc.available_balance;

    let displayLeverage = acc.leverage ? parseFloat(acc.leverage).toFixed(2) + "x" : "—";
    if (totals.hasLive && liveAsset > 0 && totals.notional > 0) {
      displayLeverage = (totals.notional / liveAsset).toFixed(2) + "x";
    }

    const leverageMarginHtml = acctMarginBar(liveAsset, totals.margin);

    // Refresh button
    const refreshBtn = refreshIndex
      ? '<div class="field"><span class="label">&nbsp;</span>' +
        '<button class="btn-refresh" data-refresh="' + refreshIndex + '" title="Re-fetch account data">&#x21bb; Refresh</button></div>'
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

    setField("ma-index", copyableHtml(acc.index));
    setField("ma-status", statusHtml(acc, true));
    setField("ma-total-asset", formatNumber(acc.total_asset_value, 6));
    setField("ma-collateral", formatValue(acc.collateral));
    setField("ma-balance", formatValue(acc.available_balance));
    setField("ma-mode", tradingMode(acc.account_trading_mode));
    setField("ma-orders", acc.total_order_count);
    setField("ma-pending", acc.pending_order_count);
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
    const attr = index ? ' data-detail-for="' + index + '"' : '';
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
    return '<tr class="sub-row" data-index="' + acc.index + '">' +
      '<td class="mono">' + copyableHtml(acc.index) + '</td>' +
      '<td>' + statusHtml(acc) + '</td>' +
      '<td>' + formatNumber(acc.total_asset_value, 6) + '</td>' +
      '<td>' + tradingMode(acc.account_trading_mode) + '</td>' +
      '<td>' + acc.total_order_count + '</td>' +
      '<td>' + acc.pending_order_count + '</td>' +
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
    const sub = allSubAccounts.find((a) => String(a.index) === index);
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

  function collapseAllExpanded() {
    subTbody.querySelectorAll(".detail-row").forEach((r) => r.remove());
    subTbody.querySelectorAll("tr.expanded").forEach((r) => r.classList.remove("expanded"));
    expandedIndexes.clear();
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
    "pending_orders", "daily_trades", "daily_volume", "weekly_trades",
    "weekly_volume", "total_trades", "total_volume",
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
      acc.daily_trades_count || 0, acc.daily_volume || 0,
      acc.weekly_trades_count || 0, acc.weekly_volume || 0,
      acc.total_trades_count || 0, acc.total_volume || 0,
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

  // ── WS: subscription management ───────────────────────

  function subscribeMasterAccount(accountIndex) {
    unsubscribeMasterAccount();
    masterTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + masterTrackId, handleMainUserStats);
    WS.subscribe("account_all/" + masterTrackId, handleMainAccountAll);
    showToast("WebSocket", "Subscribed to user #" + masterTrackId + " updates", "success");
  }

  function unsubscribeMasterAccount() {
    if (!masterTrackId) return;
    const id = masterTrackId;
    WS.unsubscribe("user_stats/" + masterTrackId);
    WS.unsubscribe("account_all/" + masterTrackId);
    masterTrackId = null;
    showToast("WebSocket", "Unsubscribed from user #" + id, "info");
  }

  function subscribeSubAccount(accountIndex) {
    const key = String(accountIndex);
    if (trackedSubs[key]) return;
    WS.subscribe("user_stats/" + key, makeSubUserStatsHandler(key));
    WS.subscribe("account_all/" + key, makeSubAccountAllHandler(key));
    trackedSubs[key] = true;
    showToast("WebSocket", "Subscribed to user #" + key + " updates", "success");
  }

  function unsubscribeSubAccount(accountIndex) {
    const key = String(accountIndex);
    if (!trackedSubs[key]) return;
    delete trackedSubs[key];
    WS.unsubscribe("user_stats/" + key);
    WS.unsubscribe("account_all/" + key);
    showToast("WebSocket", "Unsubscribed from user #" + key, "info");
  }

  function refreshSubAccount(accountIndex) {
    const key = String(accountIndex);
    unsubscribeSubAccount(key);
    subscribeSubAccount(key);
  }

  function unsubscribeAllSubs() {
    for (const key of Object.keys(trackedSubs)) {
      WS.unsubscribe("user_stats/" + key);
      WS.unsubscribe("account_all/" + key);
    }
    trackedSubs = {};
  }

  function subscribeSingleAccount(accountIndex) {
    unsubscribeSingleAccount();
    singleTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + singleTrackId, handleSingleUserStats);
    WS.subscribe("account_all/" + singleTrackId, handleSingleAccountAll);
    showToast("WebSocket", "Subscribed to user #" + singleTrackId + " updates", "success");
  }

  function unsubscribeSingleAccount() {
    if (!singleTrackId) return;
    const id = singleTrackId;
    WS.unsubscribe("user_stats/" + singleTrackId);
    WS.unsubscribe("account_all/" + singleTrackId);
    singleTrackId = null;
    showToast("WebSocket", "Unsubscribed from user #" + id, "info");
  }

  // ── WS: message handlers ──────────────────────────────

  function findSub(index) {
    return allSubAccounts.find((a) => String(a.index) === index);
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
    const needsRender = expandedIndexes.size > 0 || (singleAccountData && !singleSection.classList.contains("hidden"));
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

      WS.init(config);
      WS.subscribe("market_stats/all", handleMarketStats);
      WS.subscribe("height", handleHeight);
    } catch (e) {
      console.warn("WebSocket init failed:", e);
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
    expandedIndexes.clear();
    mainAccountObj = null;
    singleAccountData = null;
    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();
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
      allSubAccounts = accounts.filter((a) => a.account_type === 1).map((acc) => {
        acc._hasPositions = hasRealPositions(acc.positions);
        acc._cachedDetail = { accounts: [acc] };
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

      singleAccountData = data;
      renderSingleAccount(accounts[0]);
      subscribeSingleAccount(accountId);
    } catch (err) {
      errorEl.textContent = err.message;
      show(errorEl);
    } finally {
      hide(loadingEl);
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
    historyDatalist.innerHTML = history.map((a) => '<option value="' + a + '">').join("");
  }

  function doSearch() {
    const val = input.value.trim();
    if (!val) return;
    saveToHistory(val);

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
    const refreshBtn = e.target.closest(".btn-refresh");
    if (refreshBtn) {
      e.stopPropagation();
      refreshSubAccount(refreshBtn.dataset.refresh);
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

    // Expand
    expandedIndexes.add(index);
    expandedColSpan = row.children.length;
    row.classList.add("expanded");

    const colSpan = expandedColSpan;
    const sub = allSubAccounts.find((a) => String(a.index) === String(index));

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
        if (!expandedIndexes.has(index)) return;

        loadingRow.outerHTML = renderDetailRow(data, colSpan, index);

        const detailAcc = data.accounts && data.accounts[0];
        if (sub && detailAcc) {
          sub._hasPositions = hasRealPositions(detailAcc.positions);
          updateSubRowCells(index, sub);
        }

        subscribeSubAccount(index);
      } catch (err) {
        if (!expandedIndexes.has(index)) return;
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

  // Filters
  subSearch.addEventListener("input", applyFilters);
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

  // Single account refresh
  singleSection.addEventListener("click", (e) => {
    const refreshBtn = e.target.closest(".btn-refresh");
    if (!refreshBtn || !singleTrackId) return;
    e.stopPropagation();
    const idx = singleTrackId;
    unsubscribeSingleAccount();
    subscribeSingleAccount(idx);
  });

  // Title click resets
  appTitle.addEventListener("click", resetView);

  // Form submit
  form.addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
  });

  // ── Init ──────────────────────────────────────────────

  renderHistory(loadHistory());
  updateSortIndicators();
  initWebSocket();
})();
