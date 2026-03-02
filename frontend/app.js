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

  let allSubAccounts = [];
  let expandedIndex = null;   // currently expanded sub-account index
  let expandedData = null;    // cached detail response for expanded row
  let expandedColSpan = 7;    // column count
  let sortKey = null;         // current sort column key
  let sortAsc = true;         // sort direction

  // ── Helpers ──────────────────────────────────────────────

  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function statusBadge(status) {
    // status: 1 = has open positions, 0 = no positions
    const hasPositions = status === 1;
    return `<span class="badge ${hasPositions ? "badge-active" : "badge-inactive"}">${hasPositions ? "In position" : "No positions"}</span>`;
  }

  function tradingMode(mode) {
    return mode === 1 ? "Unified" : "Classic";
  }

  function formatValue(val) {
    if (!val || val === "") return "—";
    return val;
  }

  function hasBalance(acc) {
    const col = parseFloat(acc.collateral);
    const bal = parseFloat(acc.available_balance);
    return (col > 0) || (bal > 0);
  }

  function setField(id, html) {
    document.getElementById(id).innerHTML = html;
  }

  function signLabel(sign) {
    if (sign === 1) return '<span class="badge badge-long">Long</span>';
    if (sign === -1) return '<span class="badge badge-short">Short</span>';
    return "—";
  }

  // ── Render main account ─────────────────────────────────

  function renderMainAccount(acc, subs) {
    const activeSubs = subs.filter((s) => s.status === 1).length;
    setField("ma-index", acc.index);
    setField("ma-status", statusBadge(acc.status));
    setField("ma-collateral", formatValue(acc.collateral));
    setField("ma-balance", formatValue(acc.available_balance));
    setField("ma-mode", tradingMode(acc.account_trading_mode));
    setField("ma-orders", acc.total_order_count);
    setField("ma-pending", acc.pending_order_count);
    setField("ma-active-subs", `${activeSubs} / ${subs.length}`);
    setField("ma-l1", acc.l1_address || "—");
    show(mainSection);
  }

  // ── Render detail panel for expanded sub-account ────────

  function renderDetailRow(detail, colSpan) {
    const acc = detail.accounts?.[0];
    if (!acc) return `<tr class="detail-row"><td colspan="${colSpan}">No data</td></tr>`;

    let positionsHtml = "";
    const showZero = filterZeroPos.checked;
    const positions = showZero
      ? (acc.positions || [])
      : (acc.positions || []).filter((p) => parseFloat(p.position_value) !== 0);
    if (positions.length > 0) {
      const posRows = positions.map((p) => {
        const leverage = parseFloat(p.initial_margin_fraction) > 0
          ? Math.round(100 / parseFloat(p.initial_margin_fraction)) + "x"
          : "—";
        return `<tr>
          <td>${p.symbol}</td>
          <td>${signLabel(p.sign)}</td>
          <td>${leverage}</td>
          <td>${p.position}</td>
          <td>${p.avg_entry_price}</td>
          <td>${p.position_value}</td>
          <td class="${parseFloat(p.unrealized_pnl) >= 0 ? "pnl-positive" : "pnl-negative"}">${p.unrealized_pnl}</td>
          <td class="${parseFloat(p.realized_pnl) >= 0 ? "pnl-positive" : "pnl-negative"}">${p.realized_pnl}</td>
          <td>${p.open_order_count}</td>
          <td>${p.liquidation_price === "0" ? "—" : p.liquidation_price}</td>
        </tr>`;
      }).join("");

      positionsHtml = `
        <div class="detail-section">
          <h4>Positions</h4>
          <div class="table-wrap">
            <table class="positions-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Leverage</th>
                  <th>Size</th>
                  <th>Avg Entry</th>
                  <th>Value</th>
                  <th>Unrealized PnL</th>
                  <th>Realized PnL</th>
                  <th>OOC</th>
                  <th>Liq. Price</th>
                </tr>
              </thead>
              <tbody>${posRows}</tbody>
            </table>
          </div>
        </div>
      `;
    } else {
      positionsHtml = '<div class="detail-section"><h4>Positions</h4><p class="detail-empty">No positions</p></div>';
    }

    return `<tr class="detail-row"><td colspan="${colSpan}">
      <div class="detail-panel">
        <div class="detail-grid">
          <div class="field"><span class="label">Collateral</span><span class="value">${formatValue(acc.collateral)}</span></div>
          <div class="field"><span class="label">Available Balance</span><span class="value">${formatValue(acc.available_balance)}</span></div>
          <div class="field"><span class="label">Total Asset Value</span><span class="value">${formatValue(acc.total_asset_value)}</span></div>
          <div class="field"><span class="label">Cross Asset Value</span><span class="value">${formatValue(acc.cross_asset_value)}</span></div>
          <div class="field"><span class="label">Trading Mode</span><span class="value">${tradingMode(acc.account_trading_mode)}</span></div>
          <div class="field"><span class="label">Status</span><span class="value">${statusBadge(acc.status)}</span></div>
        </div>
        ${positionsHtml}
      </div>
    </td></tr>`;
  }

  // ── Collapse any open detail ────────────────────────────

  function collapseExpanded() {
    const prev = subTbody.querySelector(".detail-row");
    if (prev) prev.remove();
    const prevActive = subTbody.querySelector("tr.expanded");
    if (prevActive) prevActive.classList.remove("expanded");
    expandedIndex = null;
    expandedData = null;
  }

  // ── Render sub-accounts table ───────────────────────────

  function renderSubRow(acc) {
    return `<tr class="sub-row" data-index="${acc.index}">
      <td class="mono">${acc.index}</td>
      <td>${statusBadge(acc.status)}</td>
      <td>${formatValue(acc.collateral)}</td>
      <td>${formatValue(acc.available_balance)}</td>
      <td>${tradingMode(acc.account_trading_mode)}</td>
      <td>${acc.total_order_count}</td>
      <td>${acc.pending_order_count}</td>
    </tr>`;
  }

  function renderSubAccounts(accounts) {
    expandedIndex = null;
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
    const row = e.target.closest("tr.sub-row");
    if (!row) return;

    const index = row.dataset.index;

    // If clicking the already-expanded row, collapse it
    if (expandedIndex === index) {
      collapseExpanded();
      return;
    }

    // Collapse previous
    collapseExpanded();

    // Mark this row as expanded
    expandedIndex = index;
    expandedData = null;
    expandedColSpan = row.children.length;
    row.classList.add("expanded");

    // Insert loading placeholder
    const colSpan = expandedColSpan;
    const loadingRow = document.createElement("tr");
    loadingRow.className = "detail-row";
    loadingRow.innerHTML = `<td colspan="${colSpan}"><div class="detail-panel detail-loading"><div class="spinner"></div> Loading...</div></td>`;
    row.after(loadingRow);

    try {
      const resp = await fetch(`/api/account?by=index&value=${encodeURIComponent(index)}`);
      if (!resp.ok) throw new Error("Failed to load");
      const data = await resp.json();

      // Check we're still expanded on the same index
      if (expandedIndex !== index) return;

      expandedData = data;
      loadingRow.outerHTML = renderDetailRow(data, colSpan);
    } catch {
      if (expandedIndex !== index) return;
      loadingRow.innerHTML = `<td colspan="${colSpan}"><div class="detail-panel detail-error">Failed to load account details</div></td>`;
    }
  });

  // ── Click outside table collapses detail ────────────────

  document.addEventListener("click", (e) => {
    if (expandedIndex === null) return;
    if (e.target.closest("#sub-accounts")) return;
    collapseExpanded();
  });

  // ── Sort logic ──────────────────────────────────────────

  function getSortValue(acc, key) {
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
      return 0;
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
      filtered = filtered.filter((acc) => acc.status === 1);
    }

    filtered = sortAccounts(filtered);
    renderSubAccounts(filtered);
  }

  subSearch.addEventListener("input", applyFilters);
  filterBalance.addEventListener("change", applyFilters);
  filterActivated.addEventListener("change", applyFilters);

  // Re-render expanded detail row when "show zero positions" changes
  filterZeroPos.addEventListener("change", () => {
    if (expandedIndex === null || !expandedData) return;
    const detailRow = subTbody.querySelector(".detail-row");
    if (detailRow) {
      detailRow.outerHTML = renderDetailRow(expandedData, expandedColSpan);
    }
  });

  // ── Fetch & display ─────────────────────────────────────

  async function loadAddress(l1Address) {
    hide(mainSection);
    hide(subSection);
    hide(errorEl);
    show(loadingEl);
    subSearch.value = "";
    filterBalance.checked = false;
    filterActivated.checked = false;

    try {
      const resp = await fetch(`/api/accounts?l1_address=${encodeURIComponent(l1Address)}`);
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({}));
        throw new Error(detail.detail || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const accounts = data.sub_accounts || [];

      if (accounts.length === 0) {
        throw new Error("No accounts found for this L1 address.");
      }

      // Main account: account_type === 0 (exactly one)
      const main = accounts.find((a) => a.account_type === 0);
      // Sub-accounts: account_type === 1
      allSubAccounts = accounts.filter((a) => a.account_type === 1);

      if (main) {
        renderMainAccount(main, allSubAccounts);
      }

      subCount.textContent = allSubAccounts.length;
      renderSubAccounts(allSubAccounts);
      show(subSection);
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
    catch { return []; }
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
      .map((a) => `<option value="${a}">`)
      .join("");
  }

  renderHistory(loadHistory());

  // ── Form submit ─────────────────────────────────────────

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const addr = input.value.trim();
    if (!addr) return;
    saveToHistory(addr);
    loadAddress(addr);
  });
})();
