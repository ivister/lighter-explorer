(function () {
  "use strict";

  var DEFAULT_SLEEP_DELAY_MS = 5 * 60 * 1000;

  function noop() {}

  function createController(options) {
    options = options || {};

    var onStateChange = options.onStateChange || noop;
    var setTimer = options.setTimeoutFn || setTimeout;
    var clearTimer = options.clearTimeoutFn || clearTimeout;
    var sleepDelayMs = options.sleepDelayMs || DEFAULT_SLEEP_DELAY_MS;

    var enabled = false;
    var hidden = false;
    var state = "active";
    var sleepTimer = null;

    function transition(nextState) {
      if (state === nextState) return;
      var prevState = state;
      state = nextState;
      onStateChange(nextState, prevState);
    }

    function stopSleepTimer() {
      if (sleepTimer === null) return;
      clearTimer(sleepTimer);
      sleepTimer = null;
    }

    function scheduleSleep() {
      stopSleepTimer();
      sleepTimer = setTimer(function () {
        sleepTimer = null;
        if (enabled && hidden && state === "quiet") {
          transition("sleeping");
        }
      }, sleepDelayMs);
    }

    function syncState() {
      if (!enabled || !hidden) {
        stopSleepTimer();
        transition("active");
        return;
      }

      if (state === "sleeping") return;

      transition("quiet");
      scheduleSleep();
    }

    return {
      setEnabled: function (value) {
        enabled = !!value;
        syncState();
      },
      setHidden: function (value) {
        hidden = !!value;
        syncState();
      },
      getState: function () {
        return state;
      },
      isEnabled: function () {
        return enabled;
      },
      dispose: function () {
        stopSleepTimer();
        state = "active";
        enabled = false;
        hidden = false;
      },
    };
  }

  window.LighterTrafficSaver = {
    DEFAULT_SLEEP_DELAY_MS: DEFAULT_SLEEP_DELAY_MS,
    createController: createController,
  };
})();
