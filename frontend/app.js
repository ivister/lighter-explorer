(() => {
  // ── DOM references ──────────────────────────────────────
  const $ = (id) => document.getElementById(id);

  const form         = $("address-form");
  const input        = $("l1-input");
  const mainSection  = $("main-account");
  const subSection   = $("sub-accounts");
  const subTbody     = $("sub-tbody");
  const subSearch    = $("sub-search");
  const subCount     = $("sub-count");
  const filterBalance   = $("filter-balance");
  const filterActivated = $("filter-activated");
  const filterZeroPos   = $("filter-zero-pos");
  const noResults    = $("no-results");
  const loadingEl    = $("loading");
  const errorEl      = $("error");
  const toastContainer  = $("toast-container");
  const singleSection   = $("single-account");
  const saHeader     = $("sa-header");
  const saContent    = $("sa-content");
  const appTitle     = $("app-title");
  const exportModal  = $("export-modal");
  const wsDot        = $("ws-dot");
  const wsStatusText = $("ws-status-text");
  const blockHeight  = $("block-height");
  const blockChip    = $("block-chip");

  // ── State ───────────────────────────────────────────────
  let allSubAccounts  = [];
  let expandedIndexes = new Set();
  let expandedColSpan = 6;
  let sortKey         = "_accountStatus";
  let sortAsc         = false;

  let marketData      = {};
  let marketRenderTimer = null;
  let marketDataReceived = false;

  let mainAccountObj  = null;
  let singleAccountData = null;

  // WS polling (request/response, not streaming)
  let masterTrackId   = null;
  let singleTrackId   = null;
  let trackedSubs     = {};   // { index: timerId }
  let masterPollTimer = null;
  let singlePollTimer = null;
  const POLL_INTERVAL = 5000;

  // ── Helpers ─────────────────────────────────────────────

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function setField(id, html) { $(id).innerHTML = html; }

  function formatValue(val) {
    return (!val || val === "") ? "—" : val;
  }

  function formatNumber(val, decimals) {
    if (val === undefined || val === null || val === "") return "—";
    var n = parseFloat(val);
    return isNaN(n) ? val : n.toFixed(decimals);
  }

  function tradingMode(mode) {
    return mode === 1 ? "Unified" : "Classic";
  }

  function hasBalance(acc) {
    return parseFloat(acc.collateral) > 0 || parseFloat(acc.available_balance) > 0;
  }

  function hasRealPositions(positions) {
    if (!positions || !positions.length) return false;
    return positions.some(function (p) { return parseFloat(p.position_value) !== 0; });
  }

  function pnlClass(val) {
    return val === 0 ? "pnl-zero" : val > 0 ? "pnl-positive" : "pnl-negative";
  }

  // ── Account status ────────────────────────────────────

  function getAccountStatus(acc) {
    var hasBal = hasBalance(acc);
    if (hasBal && acc._hasPositions) return "trading";
    if (hasBal) return "check";
    return "idle";
  }

  function accountStatusBadge(acc, skipCheck) {
    var st = getAccountStatus(acc);
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

  // ── WS positions helpers ──────────────────────────────

  function wsPositionsToArray(posObj) {
    if (!posObj || typeof posObj !== "object") return [];
    var result = [];
    var keys = Object.keys(posObj);
    for (var i = 0; i < keys.length; i++) {
      var val = posObj[keys[i]];
      if (Array.isArray(val)) {
        for (var j = 0; j < val.length; j++) result.push(val[j]);
      } else if (val && typeof val === "object") {
        result.push(val);
      }
    }
    return result;
  }

  // WS does not return liquidation_price — preserve from previous (REST) data
  function mergePositions(newPositions, oldPositions) {
    if (!oldPositions || !oldPositions.length) return newPositions;
    var oldMap = {};
    for (var i = 0; i < oldPositions.length; i++) {
      var o = oldPositions[i];
      oldMap[o.market_id || o.symbol] = o;
    }
    for (var j = 0; j < newPositions.length; j++) {
      var p = newPositions[j];
      if (!p.liquidation_price || p.liquidation_price === "" || p.liquidation_price === "0") {
        var old = oldMap[p.market_id || p.symbol];
        if (old && old.liquidation_price) p.liquidation_price = old.liquidation_price;
      }
    }
    return newPositions;
  }

  // Parse WS positions msg and merge into account object, returns true if positions changed
  function applyWsPositions(acc, msg) {
    if (!msg.positions) return false;
    var posArr = wsPositionsToArray(msg.positions);
    mergePositions(posArr, acc.positions);
    acc.positions = posArr;
    acc._hasPositions = hasRealPositions(posArr);
    return true;
  }

  // ── Sub-row DOM helpers ───────────────────────────────

  function getSubRow(index) {
    return subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
  }

  function getDetailRow(index) {
    return subTbody.querySelector('.detail-row[data-detail-for="' + index + '"]');
  }

  function updateSubRowCells(index, sub) {
    var row = getSubRow(index);
    if (!row) return;
    var statusCell = row.children[1];
    if (statusCell) statusCell.innerHTML = statusHtml(sub);
    var tavCell = row.children[2];
    if (tavCell) tavCell.textContent = formatNumber(sub.total_asset_value, 6);
  }

  function reRenderDetail(index) {
    if (!expandedIndexes.has(index)) return;
    var sub = allSubAccounts.find(function (a) { return String(a.index) === index; });
    if (!sub || !sub._cachedDetail) return;
    var detailRow = getDetailRow(index);
    if (detailRow) detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, index);
  }

  function reRenderAllExpanded() {
    expandedIndexes.forEach(reRenderDetail);
  }

  // ── Click-to-copy ─────────────────────────────────────

  function copyIndex(value, el) {
    navigator.clipboard.writeText(String(value)).then(function () {
      var tip = document.createElement("span");
      tip.className = "copy-toast";
      tip.textContent = "Copied!";
      el.style.position = "relative";
      el.appendChild(tip);
      tip.addEventListener("animationend", function () { tip.remove(); });
    });
  }

  function copyableHtml(value) {
    return '<span class="copyable" data-copy="' + value + '" title="Click to copy">' + value + '</span>';
  }

  // Single delegated handler for all copyable elements
  document.addEventListener("click", function (e) {
    var copyEl = e.target.closest(".copyable");
    if (!copyEl) return;
    e.stopPropagation();
    copyIndex(copyEl.dataset.copy, copyEl);
  });

  // ── Toast notifications ───────────────────────────────

  function showToast(title, message, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.innerHTML =
      '<div class="toast-body">' +
        '<div class="toast-title">' + title + '</div>' +
        '<div class="toast-message">' + message + '</div>' +
      '</div>' +
      '<button class="toast-close">&times;</button>';

    el.querySelector(".toast-close").addEventListener("click", function () { el.remove(); });
    toastContainer.appendChild(el);

    setTimeout(function () {
      el.classList.add("toast-out");
      el.addEventListener("animationend", function () { el.remove(); });
    }, 8000);

    while (toastContainer.children.length > 5) toastContainer.firstChild.remove();
  }

  // ── Render main account ───────────────────────────────

  function renderMainAccount(acc, subs) {
    mainAccountObj = acc;
    var tradingSubs = subs.filter(function (s) { return getAccountStatus(s) === "trading"; }).length;
    var onlineSubs = subs.filter(function (s) { return s.status === 1; }).length;
    acc._hasPositions = hasRealPositions(acc.positions);

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

  // ── Shared account content renderer ───────────────────

  function renderAccountContent(acc, skipCheck) {
    if (acc._hasPositions === undefined) {
      acc._hasPositions = hasRealPositions(acc.positions);
    }

    var positionsHtml = "";
    var showZero = filterZeroPos.checked;
    var positions = showZero
      ? (acc.positions || [])
      : (acc.positions || []).filter(function (p) { return parseFloat(p.position_value) !== 0; });

    if (positions.length > 0) {
      var posRows = positions.map(function (p) {
        var leverage = parseFloat(p.initial_margin_fraction) > 0
          ? Math.round(100 / parseFloat(p.initial_margin_fraction)) + "x"
          : "—";

        var mkt = marketData[p.symbol] || {};
        var markPrice = mkt.mark_price || "—";
        var upnl = parseFloat(p.unrealized_pnl) || 0;
        var rpnl = parseFloat(p.realized_pnl) || 0;

        var isolatedBadge = p.margin_mode === 1
          ? ' <span class="badge badge-isolated" title="Isolated margin · allocated ' + formatValue(p.allocated_margin) + '">Isolated</span>'
          : '';

        var liqPrice = (!p.liquidation_price || p.liquidation_price === "0" || p.liquidation_price === "") ? "—" : p.liquidation_price;

        return '<tr>' +
          '<td>' + p.symbol + isolatedBadge + '</td>' +
          '<td>' + signLabel(p.sign) + '</td>' +
          '<td>' + leverage + '</td>' +
          '<td>' + p.position + '</td>' +
          '<td>' + p.avg_entry_price + '</td>' +
          '<td class="live-value">' + markPrice + '</td>' +
          '<td>' + p.position_value + '</td>' +
          '<td class="' + pnlClass(upnl) + '">' + p.unrealized_pnl + '</td>' +
          '<td class="' + pnlClass(rpnl) + '">' + p.realized_pnl + '</td>' +
          '<td>' + p.open_order_count + '</td>' +
          '<td>' + liqPrice + '</td>' +
        '</tr>';
      }).join("");

      positionsHtml =
        '<div class="detail-section">' +
          '<h4>Positions</h4>' +
          '<div class="table-wrap">' +
            '<table class="positions-table">' +
              '<thead><tr>' +
                '<th>Market</th><th>Side</th><th>Leverage</th><th>Size</th>' +
                '<th>Avg Entry</th><th>Mark Price</th><th>Value</th>' +
                '<th>Unrealized PnL</th><th>Realized PnL</th><th>OOC</th><th>Liq. Price</th>' +
              '</tr></thead>' +
              '<tbody>' + posRows + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';
    }

    var positionsField = positions.length > 0
      ? '<div class="field"><span class="label">Positions</span><span class="value">' + positions.length + ' open</span></div>'
      : '<div class="field"><span class="label">Positions</span><span class="value" style="color:var(--text-muted)">No positions</span></div>';

    return '<div class="detail-grid">' +
      '<div class="field"><span class="label">Total Asset Value</span><span class="value">' + formatNumber(acc.total_asset_value, 6) + '</span></div>' +
      '<div class="field"><span class="label">Collateral</span><span class="value">' + formatValue(acc.collateral) + '</span></div>' +
      '<div class="field"><span class="label">Available Balance</span><span class="value">' + formatValue(acc.available_balance) + '</span></div>' +
      '<div class="field"><span class="label">Cross Asset Value</span><span class="value">' + formatValue(acc.cross_asset_value) + '</span></div>' +
      '<div class="field"><span class="label">Trading Mode</span><span class="value">' + tradingMode(acc.account_trading_mode) + '</span></div>' +
      '<div class="field"><span class="label">Status</span><span class="value">' + statusHtml(acc, skipCheck) + '</span></div>' +
      positionsField +
    '</div>' +
    positionsHtml;
  }

  // ── Render detail panel for expanded sub-account ──────

  function renderDetailRow(detail, colSpan, index) {
    var acc = detail.accounts && detail.accounts[0];
    var attr = index ? ' data-detail-for="' + index + '"' : '';
    if (!acc) return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">No data</td></tr>';
    return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">' +
      '<div class="detail-panel">' + renderAccountContent(acc) + '</div>' +
    '</td></tr>';
  }

  // ── Render single account card (ID search) ────────────

  function renderSingleAccount(acc) {
    if (acc._hasPositions === undefined) acc._hasPositions = hasRealPositions(acc.positions);
    var typeLabel = acc.account_type === 0 ? 'Main' : 'Sub';
    var skipCheck = acc.account_type === 0;
    saHeader.innerHTML =
      'Account ' + copyableHtml('#' + acc.index) + ' ' +
      '<span class="badge badge-type">' + typeLabel + '</span> ' +
      statusHtml(acc, skipCheck);
    saContent.innerHTML = renderAccountContent(acc, skipCheck);
    show(singleSection);
  }

  // ── Collapse helpers ──────────────────────────────────

  function collapseRow(index) {
    var detailRow = getDetailRow(index);
    if (detailRow) detailRow.remove();
    var subRow = getSubRow(index);
    if (subRow) subRow.classList.remove("expanded");
    expandedIndexes.delete(String(index));
    unsubscribeSubAccount(index);
  }

  function collapseAllExpanded() {
    subTbody.querySelectorAll(".detail-row").forEach(function (r) { r.remove(); });
    subTbody.querySelectorAll("tr.expanded").forEach(function (r) { r.classList.remove("expanded"); });
    expandedIndexes.clear();
    unsubscribeAllSubs();
  }

  // ── Render sub-accounts table ─────────────────────────

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

  // ── Click handler for sub-account rows ────────────────

  subTbody.addEventListener("click", async function (e) {
    if (e.target.closest(".detail-row")) return;
    if (e.target.closest(".copyable")) return; // handled by document-level handler

    var row = e.target.closest("tr.sub-row");
    if (!row) return;

    var index = row.dataset.index;

    if (expandedIndexes.has(index)) {
      collapseRow(index);
      return;
    }

    // Expand
    expandedIndexes.add(index);
    expandedColSpan = row.children.length;
    row.classList.add("expanded");

    var colSpan = expandedColSpan;
    var sub = allSubAccounts.find(function (a) { return String(a.index) === String(index); });

    if (sub && sub._cachedDetail) {
      var tmp = document.createElement("tr");
      tmp.className = "detail-row-tmp";
      row.after(tmp);
      tmp.outerHTML = renderDetailRow(sub._cachedDetail, colSpan, index);
      subscribeSubAccount(index);
    } else {
      var loadingRow = document.createElement("tr");
      loadingRow.className = "detail-row";
      loadingRow.setAttribute("data-detail-for", index);
      loadingRow.innerHTML = '<td colspan="' + colSpan + '"><div class="detail-panel detail-loading"><div class="spinner"></div> Loading...</div></td>';
      row.after(loadingRow);

      try {
        var resp = await fetch("/api/account?by=index&value=" + encodeURIComponent(index));
        if (!resp.ok) throw new Error("Failed to load");
        var data = await resp.json();
        if (!expandedIndexes.has(index)) return;

        loadingRow.outerHTML = renderDetailRow(data, colSpan, index);

        // Sync status from fetched detail
        var detailAcc = data.accounts && data.accounts[0];
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

  // ── Sort logic ────────────────────────────────────────

  function getSortValue(acc, key) {
    if (key === "_accountStatus") {
      var st = getAccountStatus(acc);
      return st === "trading" ? 2 : st === "check" ? 1 : 0;
    }
    var val = acc[key];
    if (val === undefined || val === null || val === "") return -Infinity;
    var num = Number(val);
    return isNaN(num) ? val : num;
  }

  function sortAccounts(accounts) {
    if (!sortKey) return accounts;
    return [...accounts].sort(function (a, b) {
      var va = getSortValue(a, sortKey);
      var vb = getSortValue(b, sortKey);
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return (parseFloat(b.total_asset_value) || 0) - (parseFloat(a.total_asset_value) || 0);
    });
  }

  function updateSortIndicators() {
    document.querySelectorAll("th.sortable").forEach(function (th) {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.key === sortKey) th.classList.add(sortAsc ? "sort-asc" : "sort-desc");
    });
  }

  document.querySelector("#sub-accounts thead").addEventListener("click", function (e) {
    var th = e.target.closest("th.sortable");
    if (!th) return;
    var key = th.dataset.key;
    if (sortKey === key) { sortAsc = !sortAsc; }
    else { sortKey = key; sortAsc = true; }
    updateSortIndicators();
    applyFilters();
  });

  // ── Filter logic ──────────────────────────────────────

  function getFilteredSubs() {
    var q = subSearch.value.trim();
    var onlyBalance = filterBalance.checked;
    var onlyNoPos = filterActivated.checked;

    var filtered = allSubAccounts;
    if (q) filtered = filtered.filter(function (acc) { return String(acc.index).includes(q); });
    if (onlyBalance) filtered = filtered.filter(hasBalance);
    if (onlyNoPos) filtered = filtered.filter(function (acc) { return acc._hasPositions !== true; });

    return sortAccounts(filtered);
  }

  function hasActiveFilters() {
    return !!(subSearch.value.trim() || filterBalance.checked || filterActivated.checked);
  }

  function applyFilters() {
    renderSubAccounts(getFilteredSubs());
  }

  subSearch.addEventListener("input", applyFilters);
  filterBalance.addEventListener("change", applyFilters);
  filterActivated.addEventListener("change", applyFilters);

  filterZeroPos.addEventListener("change", function () {
    reRenderAllExpanded();
    if (singleAccountData && singleAccountData.accounts && singleAccountData.accounts[0]) {
      var sa = singleAccountData.accounts[0];
      saContent.innerHTML = renderAccountContent(sa, sa.account_type === 0);
    }
  });

  // ── CSV export ────────────────────────────────────────

  var CSV_HEADER = ["type", "index", "status", "online", "total_asset_value", "collateral", "available_balance", "cross_asset_value", "trading_mode", "total_orders", "pending_orders"];

  function csvEscape(val) {
    var s = String(val == null ? "" : val);
    return (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1)
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
    var now = new Date();
    return now.toISOString().slice(0, 10) + "_" +
      String(now.getUTCHours()).padStart(2, "0") + "_" +
      String(now.getUTCMinutes()).padStart(2, "0") + "utc";
  }

  function downloadCsv(subs) {
    var rows = [CSV_HEADER.join(",")];
    if (mainAccountObj) rows.push(accCsvRow(mainAccountObj, "main"));
    for (var i = 0; i < subs.length; i++) rows.push(accCsvRow(subs[i], "sub"));

    var blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "lighter_accounts_" + csvTimestamp() + ".csv";
    a.click();
    URL.revokeObjectURL(url);

    showToast("CSV Export", (rows.length - 1) + " accounts exported", "success");
  }

  // ── Export modal ──────────────────────────────────────

  var exportAllLabel    = $("export-all-label");
  var exportFilteredBtn = $("export-filtered");
  var exportFilteredLabel = $("export-filtered-label");

  function showExportModal() {
    var allCount = allSubAccounts.length + (mainAccountObj ? 1 : 0);
    var filteredCount = getFilteredSubs().length + (mainAccountObj ? 1 : 0);
    var active = hasActiveFilters();

    exportAllLabel.textContent = "All accounts (" + allCount + ")";
    exportFilteredLabel.textContent = "With current filters (" + filteredCount + ")";
    exportFilteredBtn.disabled = !active;
    exportFilteredBtn.style.opacity = active ? "1" : "0.4";

    show(exportModal);
  }

  function hideExportModal() { hide(exportModal); }

  $("btn-export-csv").addEventListener("click", showExportModal);
  $("export-all").addEventListener("click", function () { hideExportModal(); downloadCsv(allSubAccounts); });
  exportFilteredBtn.addEventListener("click", function () {
    if (this.disabled) return;
    hideExportModal();
    downloadCsv(getFilteredSubs());
  });
  $("export-cancel").addEventListener("click", hideExportModal);
  exportModal.addEventListener("click", function (e) { if (e.target === exportModal) hideExportModal(); });

  // ── WS: shared helpers ────────────────────────────────

  var WS = window.LighterWS;

  function refreshAccount(id) {
    WS.refresh("user_stats/" + id);
    WS.refresh("account_all/" + id);
  }

  function applyUserStats(acc, s) {
    if (s.portfolio_value !== undefined) acc.total_asset_value = s.portfolio_value;
    if (s.collateral !== undefined) acc.collateral = s.collateral;
    if (s.available_balance !== undefined) acc.available_balance = s.available_balance;
    if (s.account_trading_mode !== undefined) acc.account_trading_mode = s.account_trading_mode;
    if (s.cross_stats && s.cross_stats.portfolio_value !== undefined) {
      acc.cross_asset_value = s.cross_stats.portfolio_value;
    }
  }

  // ── WS: master account ────────────────────────────────

  function subscribeMasterAccount(accountIndex) {
    unsubscribeMasterAccount();
    masterTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + masterTrackId, handleMainUserStats);
    WS.subscribe("account_all/" + masterTrackId, handleMainAccountAll);
    masterPollTimer = setInterval(function () { refreshAccount(masterTrackId); }, POLL_INTERVAL);
  }

  function unsubscribeMasterAccount() {
    if (!masterTrackId) return;
    if (masterPollTimer) { clearInterval(masterPollTimer); masterPollTimer = null; }
    WS.unsubscribe("user_stats/" + masterTrackId);
    WS.unsubscribe("account_all/" + masterTrackId);
    masterTrackId = null;
  }

  function handleMainUserStats(msg) {
    if (!mainAccountObj || !msg.stats) return;
    applyUserStats(mainAccountObj, msg.stats);
    refreshMainCard();
  }

  function handleMainAccountAll(msg) {
    if (!mainAccountObj) return;
    applyWsPositions(mainAccountObj, msg);
    setField("ma-status", statusHtml(mainAccountObj, true));
  }

  // ── WS: sub-accounts (expanded only) ─────────────────

  function subscribeSubAccount(accountIndex) {
    var key = String(accountIndex);
    if (trackedSubs[key]) return;
    WS.subscribe("user_stats/" + key, makeSubUserStatsHandler(key));
    WS.subscribe("account_all/" + key, makeSubAccountAllHandler(key));
    trackedSubs[key] = setInterval(function () { refreshAccount(key); }, POLL_INTERVAL);
  }

  function unsubscribeSubAccount(accountIndex) {
    var key = String(accountIndex);
    if (!trackedSubs[key]) return;
    clearInterval(trackedSubs[key]);
    delete trackedSubs[key];
    WS.unsubscribe("user_stats/" + key);
    WS.unsubscribe("account_all/" + key);
  }

  function unsubscribeAllSubs() {
    Object.keys(trackedSubs).forEach(function (key) {
      clearInterval(trackedSubs[key]);
      WS.unsubscribe("user_stats/" + key);
      WS.unsubscribe("account_all/" + key);
    });
    trackedSubs = {};
  }

  function findSub(index) {
    return allSubAccounts.find(function (a) { return String(a.index) === index; });
  }

  function makeSubUserStatsHandler(index) {
    return function (msg) {
      if (!msg.stats) return;
      var sub = findSub(index);
      if (!sub) return;

      applyUserStats(sub, msg.stats);
      if (sub._cachedDetail) applyUserStats(sub._cachedDetail.accounts[0], msg.stats);

      updateSubRowCells(index, sub);
      reRenderDetail(index);
    };
  }

  function makeSubAccountAllHandler(index) {
    return function (msg) {
      var sub = findSub(index);
      if (!sub) return;

      if (!sub._cachedDetail) sub._cachedDetail = { accounts: [sub] };
      var acc = sub._cachedDetail.accounts[0];

      if (applyWsPositions(acc, msg)) {
        sub._hasPositions = acc._hasPositions;
      }

      updateSubRowCells(index, sub);
      reRenderDetail(index);
    };
  }

  // ── WS: single account (ID search) ───────────────────

  function subscribeSingleAccount(accountIndex) {
    unsubscribeSingleAccount();
    singleTrackId = String(accountIndex);
    WS.subscribe("user_stats/" + singleTrackId, handleSingleUserStats);
    WS.subscribe("account_all/" + singleTrackId, handleSingleAccountAll);
    singlePollTimer = setInterval(function () { refreshAccount(singleTrackId); }, POLL_INTERVAL);
  }

  function unsubscribeSingleAccount() {
    if (!singleTrackId) return;
    if (singlePollTimer) { clearInterval(singlePollTimer); singlePollTimer = null; }
    WS.unsubscribe("user_stats/" + singleTrackId);
    WS.unsubscribe("account_all/" + singleTrackId);
    singleTrackId = null;
  }

  function getSingleAcc() {
    return singleAccountData && singleAccountData.accounts && singleAccountData.accounts[0];
  }

  function handleSingleUserStats(msg) {
    var acc = getSingleAcc();
    if (!acc || !msg.stats) return;
    applyUserStats(acc, msg.stats);
    renderSingleAccount(acc);
  }

  function handleSingleAccountAll(msg) {
    var acc = getSingleAcc();
    if (!acc) return;
    applyWsPositions(acc, msg);
    renderSingleAccount(acc);
  }

  // ── WS: market data ──────────────────────────────────

  function handleMarketStats(msg) {
    var raw = msg.market_stats;
    if (!raw) return;

    var statsList = raw.symbol ? [raw] : Object.values(raw).filter(function (v) { return v && typeof v === "object"; });

    for (var i = 0; i < statsList.length; i++) {
      var m = statsList[i];
      if (m.symbol) {
        marketData[m.symbol] = {
          mark_price: m.mark_price,
          index_price: m.index_price,
          open_interest: m.open_interest,
          daily_volume: m.daily_quote_token_volume,
        };
      }
    }

    var count = Object.keys(marketData).length;
    if (count > 0) wsStatusText.textContent = "Live · " + count + " mkts";

    if (!marketDataReceived && count > 0) {
      marketDataReceived = true;
      showToast("Market Data", count + " markets streaming", "success");
    }

    // Throttle mark price re-render
    if (!marketRenderTimer && expandedIndexes.size > 0) {
      marketRenderTimer = setTimeout(function () {
        marketRenderTimer = null;
        reRenderAllExpanded();
      }, 2000);
    }
  }

  // ── WS: blockchain height ─────────────────────────────

  var heightFlashTimer = null;

  function handleHeight(msg) {
    if (msg.height === undefined) return;
    blockHeight.textContent = Number(msg.height).toLocaleString();

    blockChip.classList.add("chip-flash");
    if (heightFlashTimer) clearTimeout(heightFlashTimer);
    heightFlashTimer = setTimeout(function () { blockChip.classList.remove("chip-flash"); }, 600);
  }

  // ── WS initialization ────────────────────────────────

  async function initWebSocket() {
    try {
      var resp = await fetch("/api/config");
      if (!resp.ok) return;
      var config = await resp.json();

      WS.onStatusChange(function (isConnected) {
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

  initWebSocket();

  // ── Reset view ────────────────────────────────────────

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

  appTitle.addEventListener("click", resetView);

  // ── Fetch & display ───────────────────────────────────

  async function loadAddress(l1Address) {
    hide(mainSection);
    hide(subSection);
    hide(singleSection);
    hide(errorEl);
    show(loadingEl);
    subSearch.value = "";
    filterBalance.checked = false;
    filterActivated.checked = false;

    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();

    try {
      var resp = await fetch("/api/account?by=l1_address&value=" + encodeURIComponent(l1Address));
      if (!resp.ok) {
        var detail = await resp.json().catch(function () { return {}; });
        throw new Error(detail.detail || "HTTP " + resp.status);
      }

      var data = await resp.json();
      var accounts = data.accounts || [];
      if (accounts.length === 0) throw new Error("No accounts found for address " + l1Address);

      var main = accounts.find(function (a) { return a.account_type === 0; });
      allSubAccounts = accounts.filter(function (a) { return a.account_type === 1; }).map(function (acc) {
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
    hide(mainSection);
    hide(subSection);
    hide(singleSection);
    hide(errorEl);
    show(loadingEl);

    unsubscribeMasterAccount();
    unsubscribeAllSubs();
    unsubscribeSingleAccount();

    try {
      var resp = await fetch("/api/account?by=index&value=" + encodeURIComponent(accountId));
      if (!resp.ok) {
        var detail = await resp.json().catch(function () { return {}; });
        throw new Error(detail.detail || "HTTP " + resp.status);
      }

      var data = await resp.json();
      var accounts = data.accounts || [];
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

  // ── Address history (localStorage + datalist) ─────────

  var HISTORY_KEY = "lighter_l1_history";
  var historyDatalist = $("l1-history");

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }

  function saveToHistory(addr) {
    var history = loadHistory().filter(function (a) { return a !== addr; });
    history.unshift(addr);
    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory(history);
  }

  function renderHistory(history) {
    historyDatalist.innerHTML = history.map(function (a) { return '<option value="' + a + '">'; }).join("");
  }

  renderHistory(loadHistory());
  updateSortIndicators();

  // ── Form submit ───────────────────────────────────────

  function doSearch() {
    var val = input.value.trim();
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

  form.addEventListener("submit", function (e) { e.preventDefault(); doSearch(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); doSearch(); }
  });
})();
