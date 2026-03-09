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
    return hasPositiveValue(acc.collateral) ||
      hasPositiveValue(acc.available_balance);
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

  function getAccountStatus(acc) {
    if (!acc || typeof acc !== "object") return "idle";
    if (acc._hasPositions === true || hasRealPositions(acc.positions)) return "trading";
    if (hasBalance(acc)) return "check";
    return "idle";
  }

  return {
    getAccountStatus: getAccountStatus,
    hasBalance: hasBalance,
    hasRealPositions: hasRealPositions,
    isOpenPosition: positionIsOpen,
  };
});
