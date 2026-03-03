(() => {
  const form = document.getElementById("address-form");
  const input = document.getElementById("l1-input");
  const mainSection = document.getElementById("main-account");
  const subSection = document.getElementById("sub-accounts");
  const subTbody = document.getElementById("sub-tbody");
  const subSearch = document.getElementById("sub-search");
  const subCount = document.getElementById("sub-count");
  const filterBalance = document.getElementById("filter-balance");
  const filterActivated = document.getElementById("filter-activated");
  const filterZeroPos = document.getElementById("filter-zero-pos");
  const noResults = document.getElementById("no-results");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const toastContainer = document.getElementById("toast-container");
  const singleAccountSection = document.getElementById("single-account");
  const appTitle = document.getElementById("app-title");

  let allSubAccounts = [];
  let expandedIndexes = new Set();  // set of expanded sub-account indexes (strings)
  let expandedColSpan = 6;    // column count
  let sortKey = "_accountStatus";  // default sort: by account status
  let sortAsc = false;        // descending so accounts with positions come first

  // ── Market data from WebSocket ─────────────────────────
  let marketData = {};
  let marketRenderTimer = null;

  // ── WS polling (request/response, not streaming) ───────
  let mainAccountObj = null;
  let singleAccountData = null;
  let masterTrackId = null;        // main account ID being polled
  let singleTrackId = null;        // single account ID being polled
  let trackedSubs = {};            // { index: timerId } — expanded subs, each with own timer
  let masterPollTimer = null;
  let singlePollTimer = null;
  const POLL_INTERVAL = 5000;

  // ── Helpers ──────────────────────────────────────────────

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  // ── 3-state account status: trading / idle / need to check ──

  function getAccountStatus(acc) {
    var hasBal = hasBalance(acc);
    var hasPos = acc._hasPositions === true;
    if (hasBal && hasPos) return "trading";
    if (hasBal && !hasPos) return "check";
    return "idle";
  }

  function accountStatusBadge(acc, skipCheck) {
    var st = getAccountStatus(acc);
    if (st === "trading") {
      return '<span class="badge badge-trading" title="Has balance and open positions">Trading</span>';
    }
    if (st === "check" && !skipCheck) {
      return '<span class="badge badge-check" title="Has balance but no open positions — review recommended">Need to check</span>';
    }
    return '<span class="badge badge-idle" title="No open positions">Idle</span>';
  }

  function onlineBadge(acc) {
    if (acc.status === 1) {
      return ' <span class="badge badge-online" title="Account is active on the network">online</span>';
    }
    return "";
  }

  function tradingMode(mode) {
    return mode === 1 ? "Unified" : "Classic";
  }

  function formatValue(val) {
    if (!val || val === "") return "—";
    return val;
  }

  function formatNumber(val, decimals) {
    if (val === undefined || val === null || val === "") return "—";
    var n = parseFloat(val);
    if (isNaN(n)) return val;
    return n.toFixed(decimals);
  }

  function hasBalance(acc) {
    const col = parseFloat(acc.collateral);
    const bal = parseFloat(acc.available_balance);
    return (col > 0) || (bal > 0);
  }

  function hasRealPositions(detailData) {
    const acc = detailData && detailData.accounts && detailData.accounts[0];
    if (!acc || !acc.positions) return false;
    return acc.positions.some((p) => parseFloat(p.position_value) !== 0);
  }

  // Convert WS positions object { market_index: Position } to flat array
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

  function syncSubStatus(index, detailData) {
    const hasPos = hasRealPositions(detailData);

    // Update cached sub-account
    const sub = allSubAccounts.find((a) => String(a.index) === String(index));
    if (sub) {
      sub._hasPositions = hasPos;
    }

    // Update the table row status cell (index 1)
    const row = subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
    if (row && sub) {
      var statusCell = row.children[1];
      if (statusCell) {
        statusCell.innerHTML = accountStatusBadge(sub) + onlineBadge(sub);
      }
    }
  }

  function setField(id, html) {
    document.getElementById(id).innerHTML = html;
  }

  // ── Copy to clipboard with inline tooltip ────────────
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

  function signLabel(sign) {
    if (sign === 1) return '<span class="badge badge-long">Long</span>';
    if (sign === -1) return '<span class="badge badge-short">Short</span>';
    return "—";
  }

  // ── Toast notifications ────────────────────────────────

  function showToast(title, message, type) {
    if (!type) type = "info";
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

    // Max 5 visible
    while (toastContainer.children.length > 5) {
      toastContainer.firstChild.remove();
    }
  }

  // ── Render main account ─────────────────────────────────

  function renderMainAccount(acc, subs) {
    mainAccountObj = acc;
    var tradingSubs = subs.filter(function (s) { return getAccountStatus(s) === "trading"; }).length;
    var onlineSubs = subs.filter(function (s) { return s.status === 1; }).length;
    // Determine main account positions
    var mainRealPos = (acc.positions || []).filter((p) => parseFloat(p.position_value) !== 0);
    acc._hasPositions = mainRealPos.length > 0;
    setField("ma-index", '<span class="copyable" data-copy="' + acc.index + '" title="Click to copy">' + acc.index + '</span>');
    setField("ma-status", accountStatusBadge(acc, true) + onlineBadge(acc));
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

  // ── Shared account content renderer ─────────────────────

  function renderAccountContent(acc, skipCheck) {
    if (acc._hasPositions === undefined) {
      acc._hasPositions = (acc.positions || []).some((p) => parseFloat(p.position_value) !== 0);
    }

    var positionsHtml = "";
    const showZero = filterZeroPos.checked;
    const positions = showZero
      ? (acc.positions || [])
      : (acc.positions || []).filter((p) => parseFloat(p.position_value) !== 0);

    if (positions.length > 0) {
      const posRows = positions.map((p) => {
        const leverage = parseFloat(p.initial_margin_fraction) > 0
          ? Math.round(100 / parseFloat(p.initial_margin_fraction)) + "x"
          : "—";

        const mkt = marketData[p.symbol] || {};
        const markPrice = mkt.mark_price || "—";

        var pnlVal = parseFloat(p.unrealized_pnl) || 0;

        var isolatedBadge = p.margin_mode === 1
          ? ' <span class="badge badge-isolated" title="Isolated margin · allocated ' + formatValue(p.allocated_margin) + '">Isolated</span>'
          : '';

        return '<tr>' +
          '<td>' + p.symbol + isolatedBadge + '</td>' +
          '<td>' + signLabel(p.sign) + '</td>' +
          '<td>' + leverage + '</td>' +
          '<td>' + p.position + '</td>' +
          '<td>' + p.avg_entry_price + '</td>' +
          '<td class="live-value">' + markPrice + '</td>' +
          '<td>' + p.position_value + '</td>' +
          '<td class="' + (pnlVal >= 0 ? "pnl-positive" : "pnl-negative") + '">' + p.unrealized_pnl + '</td>' +
          '<td class="' + (parseFloat(p.realized_pnl) >= 0 ? "pnl-positive" : "pnl-negative") + '">' + p.realized_pnl + '</td>' +
          '<td>' + p.open_order_count + '</td>' +
          '<td>' + (p.liquidation_price === "0" ? "—" : p.liquidation_price) + '</td>' +
        '</tr>';
      }).join("");

      positionsHtml =
        '<div class="detail-section">' +
          '<h4>Positions</h4>' +
          '<div class="table-wrap">' +
            '<table class="positions-table">' +
              '<thead><tr>' +
                '<th>Market</th>' +
                '<th>Side</th>' +
                '<th>Leverage</th>' +
                '<th>Size</th>' +
                '<th>Avg Entry</th>' +
                '<th>Mark Price</th>' +
                '<th>Value</th>' +
                '<th>Unrealized PnL</th>' +
                '<th>Realized PnL</th>' +
                '<th>OOC</th>' +
                '<th>Liq. Price</th>' +
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
      '<div class="field"><span class="label">Status</span><span class="value">' + accountStatusBadge(acc, skipCheck) + onlineBadge(acc) + '</span></div>' +
      positionsField +
    '</div>' +
    positionsHtml;
  }

  // ── Click-to-copy delegation on main account index ─────

  document.getElementById("ma-index").addEventListener("click", function (e) {
    var copyEl = e.target.closest(".copyable");
    if (!copyEl) return;
    copyIndex(copyEl.dataset.copy, copyEl);
  });

  // ── Render detail panel for expanded sub-account ────────

  function renderDetailRow(detail, colSpan, index) {
    const acc = detail.accounts && detail.accounts[0];
    var attr = index ? ' data-detail-for="' + index + '"' : '';
    if (!acc) return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">No data</td></tr>';

    return '<tr class="detail-row"' + attr + '><td colspan="' + colSpan + '">' +
      '<div class="detail-panel">' + renderAccountContent(acc) + '</div>' +
    '</td></tr>';
  }

  // ── Render single account card (ID search) ────────────

  function renderSingleAccount(acc) {
    if (acc._hasPositions === undefined) {
      acc._hasPositions = (acc.positions || []).some((p) => parseFloat(p.position_value) !== 0);
    }
    var typeLabel = acc.account_type === 0 ? 'Main' : 'Sub';
    var skipCheck = acc.account_type === 0;
    document.getElementById("sa-header").innerHTML =
      'Account <span class="copyable" data-copy="' + acc.index + '" title="Click to copy">#' + acc.index + '</span> ' +
      '<span class="badge badge-type">' + typeLabel + '</span> ' +
      accountStatusBadge(acc, skipCheck) + onlineBadge(acc);
    document.getElementById("sa-content").innerHTML = renderAccountContent(acc, skipCheck);
    show(singleAccountSection);
  }

  // ── Click-to-copy on single account header ─────────────

  document.getElementById("sa-header").addEventListener("click", function (e) {
    var copyEl = e.target.closest(".copyable");
    if (!copyEl) return;
    copyIndex(copyEl.dataset.copy, copyEl);
  });

  // ── Collapse helpers ────────────────────────────────────

  function collapseRow(index) {
    var detailRow = subTbody.querySelector('.detail-row[data-detail-for="' + index + '"]');
    if (detailRow) detailRow.remove();
    var subRow = subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
    if (subRow) subRow.classList.remove("expanded");
    expandedIndexes.delete(String(index));
    unsubscribeSubAccount(index);
  }

  function collapseAllExpanded() {
    subTbody.querySelectorAll(".detail-row").forEach(function (r) { r.remove(); });
    subTbody.querySelectorAll("tr.expanded").forEach(function (r) { r.classList.remove("expanded"); });
    expandedIndexes.clear();
  }

  // ── Render sub-accounts table ───────────────────────────

  function renderSubRow(acc) {
    return '<tr class="sub-row" data-index="' + acc.index + '">' +
      '<td class="mono"><span class="copyable" data-copy="' + acc.index + '" title="Click to copy">' + acc.index + '</span></td>' +
      '<td>' + accountStatusBadge(acc) + onlineBadge(acc) + '</td>' +
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

  // ── Click handler for sub-account rows ──────────────────

  subTbody.addEventListener("click", async (e) => {
    // Ignore clicks inside detail panel — only collapse via sub-row click
    if (e.target.closest(".detail-row")) return;

    // Click-to-copy on index
    var copyEl = e.target.closest(".copyable");
    if (copyEl) {
      e.stopPropagation();
      copyIndex(copyEl.dataset.copy, copyEl);
      return;
    }

    const row = e.target.closest("tr.sub-row");
    if (!row) return;

    const index = row.dataset.index;

    // If clicking an already-expanded row, collapse it
    if (expandedIndexes.has(index)) {
      collapseRow(index);
      return;
    }

    // Expand this row (without collapsing others)
    expandedIndexes.add(index);
    expandedColSpan = row.children.length;
    row.classList.add("expanded");

    const colSpan = expandedColSpan;

    // Use cached detail from initial load if available
    const sub = allSubAccounts.find((a) => String(a.index) === String(index));
    if (sub && sub._cachedDetail) {
      const detailHtml = renderDetailRow(sub._cachedDetail, colSpan, index);
      const detailRow = document.createElement("tr");
      detailRow.className = "detail-row-tmp";
      row.after(detailRow);
      detailRow.outerHTML = detailHtml;

      // Subscribe to live updates for this sub-account
      subscribeSubAccount(index);
    } else {
      // Fallback: fetch detail if no cached data
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
        syncSubStatus(index, data);
        subscribeSubAccount(index);
      } catch (err) {
        if (!expandedIndexes.has(index)) return;
        loadingRow.innerHTML = '<td colspan="' + colSpan + '"><div class="detail-panel detail-error">Failed to load account details</div></td>';
      }
    }
  });

  // ── Sort logic ──────────────────────────────────────────

  function getSortValue(acc, key) {
    // Account status sort: trading (2) > check (1) > idle (0)
    if (key === "_accountStatus") {
      var st = getAccountStatus(acc);
      if (st === "trading") return 2;
      if (st === "check") return 1;
      return 0;
    }
    const val = acc[key];
    if (val === undefined || val === null || val === "") return -Infinity;
    const num = Number(val);
    return isNaN(num) ? val : num;
  }

  function sortAccounts(accounts) {
    if (!sortKey) return accounts;
    const sorted = [...accounts];
    sorted.sort((a, b) => {
      const va = getSortValue(a, sortKey);
      const vb = getSortValue(b, sortKey);
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      // Secondary sort by total_asset_value descending
      const ta = parseFloat(a.total_asset_value) || 0;
      const tb = parseFloat(b.total_asset_value) || 0;
      return tb - ta;
    });
    return sorted;
  }

  function updateSortIndicators() {
    document.querySelectorAll("th.sortable").forEach((th) => {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.dataset.key === sortKey) {
        th.classList.add(sortAsc ? "sort-asc" : "sort-desc");
      }
    });
  }

  document.querySelector("#sub-accounts thead").addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.key;
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = true;
    }
    updateSortIndicators();
    applyFilters();
  });

  // ── Filter logic ────────────────────────────────────────

  function applyFilters() {
    const q = subSearch.value.trim();
    const onlyBalance = filterBalance.checked;
    const onlyActivated = filterActivated.checked;

    let filtered = allSubAccounts;

    if (q) {
      filtered = filtered.filter((acc) => String(acc.index).includes(q));
    }
    if (onlyBalance) {
      filtered = filtered.filter(hasBalance);
    }
    if (onlyActivated) {
      filtered = filtered.filter((acc) => acc._hasPositions !== true);
    }

    filtered = sortAccounts(filtered);
    renderSubAccounts(filtered);
  }

  subSearch.addEventListener("input", applyFilters);
  filterBalance.addEventListener("change", applyFilters);
  filterActivated.addEventListener("change", applyFilters);

  // Re-render positions when "show zero positions" changes
  filterZeroPos.addEventListener("change", () => {
    // Re-render all expanded sub-account detail rows
    expandedIndexes.forEach(function (idx) {
      var sub = allSubAccounts.find(function (a) { return String(a.index) === idx; });
      if (sub && sub._cachedDetail) {
        var detailRow = subTbody.querySelector('.detail-row[data-detail-for="' + idx + '"]');
        if (detailRow) {
          detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, idx);
        }
      }
    });
    // Re-render single account view
    if (singleAccountData && singleAccountData.accounts && singleAccountData.accounts[0]) {
      var sa = singleAccountData.accounts[0];
      var skipCheck = sa.account_type === 0;
      document.getElementById("sa-content").innerHTML = renderAccountContent(sa, skipCheck);
    }
  });

  // ── WS polling — each account on its own timer ─────────

  function refreshAccount(id) {
    window.LighterWS.refresh("user_stats/" + id);
    window.LighterWS.refresh("account_all/" + id);
  }

  // ── Master account ────────────────────────────────────────

  function subscribeMasterAccount(accountIndex) {
    unsubscribeMasterAccount();
    masterTrackId = String(accountIndex);
    window.LighterWS.subscribe("user_stats/" + masterTrackId, handleMainUserStats);
    window.LighterWS.subscribe("account_all/" + masterTrackId, handleMainAccountAll);
    masterPollTimer = setInterval(function () { refreshAccount(masterTrackId); }, POLL_INTERVAL);
  }

  function unsubscribeMasterAccount() {
    if (!masterTrackId) return;
    if (masterPollTimer) { clearInterval(masterPollTimer); masterPollTimer = null; }
    window.LighterWS.unsubscribe("user_stats/" + masterTrackId);
    window.LighterWS.unsubscribe("account_all/" + masterTrackId);
    masterTrackId = null;
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

  function handleMainUserStats(msg) {
    if (!mainAccountObj || !msg.stats) return;
    var s = msg.stats;
    applyUserStats(mainAccountObj, s);
    setField("ma-total-asset", formatNumber(mainAccountObj.total_asset_value, 6));
    setField("ma-collateral", formatValue(mainAccountObj.collateral));
    setField("ma-balance", formatValue(mainAccountObj.available_balance));
    setField("ma-mode", tradingMode(mainAccountObj.account_trading_mode));
    setField("ma-status", accountStatusBadge(mainAccountObj, true) + onlineBadge(mainAccountObj));
  }

  function handleMainAccountAll(msg) {
    if (!mainAccountObj) return;
    if (msg.positions) {
      var posArr = wsPositionsToArray(msg.positions);
      mainAccountObj.positions = posArr;
      mainAccountObj._hasPositions = posArr.some(function (p) {
        return parseFloat(p.position_value) !== 0;
      });
    }
    setField("ma-status", accountStatusBadge(mainAccountObj, true) + onlineBadge(mainAccountObj));
  }

  // ── Sub-accounts (track only expanded) ────────────────────

  function subscribeSubAccount(accountIndex) {
    var key = String(accountIndex);
    if (trackedSubs[key]) return;
    window.LighterWS.subscribe("user_stats/" + key, makeSubUserStatsHandler(key));
    window.LighterWS.subscribe("account_all/" + key, makeSubAccountAllHandler(key));
    trackedSubs[key] = setInterval(function () { refreshAccount(key); }, POLL_INTERVAL);
  }

  function unsubscribeSubAccount(accountIndex) {
    var key = String(accountIndex);
    if (!trackedSubs[key]) return;
    clearInterval(trackedSubs[key]);
    delete trackedSubs[key];
    window.LighterWS.unsubscribe("user_stats/" + key);
    window.LighterWS.unsubscribe("account_all/" + key);
  }

  function unsubscribeAllSubs() {
    var keys = Object.keys(trackedSubs);
    for (var i = 0; i < keys.length; i++) {
      clearInterval(trackedSubs[keys[i]]);
      window.LighterWS.unsubscribe("user_stats/" + keys[i]);
      window.LighterWS.unsubscribe("account_all/" + keys[i]);
    }
    trackedSubs = {};
  }

  function makeSubUserStatsHandler(index) {
    return function (msg) {
      if (!msg.stats) return;
      var sub = allSubAccounts.find(function (a) { return String(a.index) === index; });
      if (!sub) return;

      applyUserStats(sub, msg.stats);
      if (sub._cachedDetail) {
        applyUserStats(sub._cachedDetail.accounts[0], msg.stats);
      }

      // Update table row TAV
      var row = subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
      if (row) {
        var tavCell = row.children[2];
        if (tavCell) tavCell.textContent = formatNumber(sub.total_asset_value, 6);
      }

      // Re-render detail if expanded
      if (expandedIndexes.has(index) && sub._cachedDetail) {
        var detailRow = subTbody.querySelector('.detail-row[data-detail-for="' + index + '"]');
        if (detailRow) {
          detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, index);
        }
      }
    };
  }

  function makeSubAccountAllHandler(index) {
    return function (msg) {
      var sub = allSubAccounts.find(function (a) { return String(a.index) === index; });
      if (!sub) return;

      if (!sub._cachedDetail) sub._cachedDetail = { accounts: [sub] };
      var acc = sub._cachedDetail.accounts[0];

      if (msg.positions) {
        var posArr = wsPositionsToArray(msg.positions);
        acc.positions = posArr;
        acc._hasPositions = posArr.some(function (p) {
          return parseFloat(p.position_value) !== 0;
        });
        sub._hasPositions = acc._hasPositions;
      }

      // Update table row status
      var row = subTbody.querySelector('tr.sub-row[data-index="' + index + '"]');
      if (row) {
        var statusCell = row.children[1];
        if (statusCell) statusCell.innerHTML = accountStatusBadge(sub) + onlineBadge(sub);
      }

      // Re-render detail if expanded
      if (expandedIndexes.has(index) && sub._cachedDetail) {
        var detailRow = subTbody.querySelector('.detail-row[data-detail-for="' + index + '"]');
        if (detailRow) {
          detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, index);
        }
      }
    };
  }

  // ── Single account (ID search) ────────────────────────────

  function subscribeSingleAccount(accountIndex) {
    unsubscribeSingleAccount();
    singleTrackId = String(accountIndex);
    window.LighterWS.subscribe("user_stats/" + singleTrackId, handleSingleUserStats);
    window.LighterWS.subscribe("account_all/" + singleTrackId, handleSingleAccountAll);
    singlePollTimer = setInterval(function () { refreshAccount(singleTrackId); }, POLL_INTERVAL);
  }

  function unsubscribeSingleAccount() {
    if (!singleTrackId) return;
    if (singlePollTimer) { clearInterval(singlePollTimer); singlePollTimer = null; }
    window.LighterWS.unsubscribe("user_stats/" + singleTrackId);
    window.LighterWS.unsubscribe("account_all/" + singleTrackId);
    singleTrackId = null;
  }

  function handleSingleUserStats(msg) {
    if (!singleAccountData || !msg.stats) return;
    var acc = singleAccountData.accounts && singleAccountData.accounts[0];
    if (!acc) return;
    applyUserStats(acc, msg.stats);
    renderSingleAccount(acc);
  }

  function handleSingleAccountAll(msg) {
    if (!singleAccountData) return;
    var acc = singleAccountData.accounts && singleAccountData.accounts[0];
    if (!acc) return;
    if (msg.positions) {
      var posArr = wsPositionsToArray(msg.positions);
      acc.positions = posArr;
      acc._hasPositions = posArr.some(function (p) {
        return parseFloat(p.position_value) !== 0;
      });
    }
    renderSingleAccount(acc);
  }

  // ── WebSocket: market data ──────────────────────────────

  let marketDataReceived = false;

  function handleMarketStats(msg) {
    var raw = msg.market_stats;
    if (!raw) return;

    var statsList;
    if (raw.symbol) {
      statsList = [raw];
    } else {
      statsList = [];
      var keys = Object.keys(raw);
      for (var i = 0; i < keys.length; i++) {
        if (raw[keys[i]] && typeof raw[keys[i]] === "object") {
          statsList.push(raw[keys[i]]);
        }
      }
    }

    for (var i = 0; i < statsList.length; i++) {
      var m = statsList[i];
      var sym = m.symbol || "";
      if (sym) {
        marketData[sym] = {
          mark_price: m.mark_price,
          index_price: m.index_price,
          open_interest: m.open_interest,
          daily_volume: m.daily_quote_token_volume,
        };
      }
    }

    var count = Object.keys(marketData).length;
    if (count > 0) {
      var text = document.getElementById("ws-status-text");
      if (text) text.textContent = "Live · " + count + " mkts";
    }

    if (!marketDataReceived && count > 0) {
      marketDataReceived = true;
      showToast("Market Data", count + " markets streaming", "success");
    }

    // Throttle mark price re-render for expanded detail panels
    if (!marketRenderTimer && expandedIndexes.size > 0) {
      marketRenderTimer = setTimeout(function () {
        marketRenderTimer = null;
        expandedIndexes.forEach(function (idx) {
          var sub = allSubAccounts.find(function (a) { return String(a.index) === idx; });
          if (sub && sub._cachedDetail) {
            var detailRow = subTbody.querySelector('.detail-row[data-detail-for="' + idx + '"]');
            if (detailRow) {
              detailRow.outerHTML = renderDetailRow(sub._cachedDetail, expandedColSpan, idx);
            }
          }
        });
      }, 2000);
    }
  }

  // ── WebSocket initialization ────────────────────────────

  async function initWebSocket() {
    try {
      var resp = await fetch("/api/config");
      if (!resp.ok) return;
      var config = await resp.json();

      window.LighterWS.onStatusChange(function (isConnected) {
        var dot = document.getElementById("ws-dot");
        var text = document.getElementById("ws-status-text");
        dot.classList.toggle("ws-connected", isConnected);
        text.textContent = isConnected ? "Live" : "Reconnecting...";
        if (isConnected) {
          showToast("WebSocket", "Connected to Lighter", "success");
        }
      });

      window.LighterWS.init(config);

      window.LighterWS.subscribe("market_stats/all", handleMarketStats);
      window.LighterWS.subscribe("height", handleHeight);
    } catch (e) {
      console.warn("WebSocket init failed:", e);
    }
  }

  // ── WebSocket: blockchain height ──────────────────────────

  var heightFlashTimer = null;

  function handleHeight(msg) {
    var h = msg.height;
    if (h === undefined) return;
    var el = document.getElementById("block-height");
    if (el) el.textContent = Number(h).toLocaleString();

    // Flash the chip border on update
    var chip = document.getElementById("block-chip");
    if (chip) {
      chip.classList.add("chip-flash");
      if (heightFlashTimer) clearTimeout(heightFlashTimer);
      heightFlashTimer = setTimeout(function () {
        chip.classList.remove("chip-flash");
      }, 600);
    }
  }

  initWebSocket();

  // ── Reset view ──────────────────────────────────────────

  function resetView() {
    input.value = "";
    hide(mainSection);
    hide(subSection);
    hide(singleAccountSection);
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

  // ── Title click → reset ────────────────────────────────

  appTitle.addEventListener("click", () => {
    resetView();
  });

  // ── Fetch & display ─────────────────────────────────────

  async function loadAddress(l1Address) {
    hide(mainSection);
    hide(subSection);
    hide(singleAccountSection);
    hide(errorEl);
    show(loadingEl);
    subSearch.value = "";
    filterBalance.checked = false;
    filterActivated.checked = false;

    // Clean up previous WS subscriptions
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

      if (accounts.length === 0) {
        throw new Error("No accounts found for address " + l1Address);
      }

      // Main account: account_type === 0 (exactly one)
      const main = accounts.find((a) => a.account_type === 0);
      // Sub-accounts: account_type === 1, with positions cached
      allSubAccounts = accounts.filter((a) => a.account_type === 1).map((acc) => {
        const realPositions = (acc.positions || []).filter((p) => parseFloat(p.position_value) !== 0);
        acc._hasPositions = realPositions.length > 0;
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

  // ── Fetch single account by ID ─────────────────────────

  async function loadAccountById(accountId) {
    hide(mainSection);
    hide(subSection);
    hide(singleAccountSection);
    hide(errorEl);
    show(loadingEl);

    // Clean up previous WS subscriptions
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

      if (accounts.length === 0) {
        throw new Error("Account #" + accountId + " not found");
      }

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

  // ── Address history (localStorage + datalist) ───────────

  const HISTORY_KEY = "lighter_l1_history";
  const historyDatalist = document.getElementById("l1-history");

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
    catch (e) { return []; }
  }

  function saveToHistory(addr) {
    let history = loadHistory();
    history = history.filter((a) => a !== addr);
    history.unshift(addr);
    if (history.length > 20) history = history.slice(0, 20);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    renderHistory(history);
  }

  function renderHistory(history) {
    historyDatalist.innerHTML = history
      .map((a) => '<option value="' + a + '">')
      .join("");
  }

  renderHistory(loadHistory());

  // Apply default sort indicator on page load
  updateSortIndicators();

  // ── Form submit ─────────────────────────────────────────

  function doSearch() {
    const val = input.value.trim();
    if (!val) return;
    saveToHistory(val);

    // Detect input type: 0x... = L1 address, integer = account ID
    if (val.startsWith("0x")) {
      loadAddress(val);
    } else if (/^\d+$/.test(val)) {
      loadAccountById(val);
    } else {
      errorEl.textContent = "Invalid input. Enter a 0x... L1 address or a numeric account ID.";
      show(errorEl);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch();
  });

  // Explicit Enter key handler (datalist can intercept form submit)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSearch();
    }
  });
})();
