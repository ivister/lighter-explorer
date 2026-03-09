(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LighterStatusHelpers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function toNumber(val) {
    var n = parseFloat(val);
    return isNaN(n) ? 0 : n;
  }

  function hasPositiveValue(val) {
    return toNumber(val) > 0;
  }

  function hasBalance(acc) {
    if (!acc || typeof acc !== "object") return false;
    return hasPositiveValue(acc.total_asset_value) ||
      hasPositiveValue(acc.collateral) ||
      hasPositiveValue(acc.available_balance) ||
      hasPositiveValue(acc.cross_asset_value);
  }

  function positionIsOpen(position) {
    if (!position || typeof position !== "object") return false;
    return Math.abs(toNumber(position.position)) > 0 ||
      Math.abs(toNumber(position.position_value)) > 0;
  }

  function hasRealPositions(positions) {
    if (!Array.isArray(positions) || positions.length === 0) return false;
    return positions.some(positionIsOpen);
  }

  function shouldHydrateSubAccount(acc) {
    if (!acc || acc._detailHydrated === true) return false;

    return hasBalance(acc) ||
      hasRealPositions(acc.positions) ||
      (Number(acc.total_order_count) || 0) > 0 ||
      (Number(acc.pending_order_count) || 0) > 0 ||
      acc.status === 1;
  }

  function getAccountStatus(acc) {
    if (!acc || typeof acc !== "object") return "idle";
    if (acc._hasPositions === true || hasRealPositions(acc.positions)) return "trading";
    if (hasBalance(acc) || shouldHydrateSubAccount(acc)) return "check";
    return "idle";
  }

  return {
    getAccountStatus: getAccountStatus,
    hasBalance: hasBalance,
    hasRealPositions: hasRealPositions,
    isOpenPosition: positionIsOpen,
    shouldHydrateSubAccount: shouldHydrateSubAccount,
  };
});
