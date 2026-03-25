#!/usr/bin/osascript -l JavaScript

ObjC.import("Foundation");

function readText(path) {
  var content = $.NSString.stringWithContentsOfFileEncodingError(
    $(path),
    $.NSUTF8StringEncoding,
    null
  );
  if (!content || content.isNil()) {
    throw new Error("Failed to read " + path);
  }
  return ObjC.unwrap(content);
}

function writeLine(text) {
  var data = $(String(text) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + " Expected: " + expected + ", got: " + actual);
  }
}

function assertTrue(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function run(argv) {
  if (!argv || argv.length === 0) {
    throw new Error("Repository root path argument is required.");
  }

  var repoRoot = argv[0];
  var global = this;
  global.window = global;
  eval(readText(repoRoot + "/frontend/traffic-saver.js"));

  var saver = global.LighterTrafficSaver;
  if (!saver) throw new Error("LighterTrafficSaver was not loaded.");

  var nextTimerId = 1;
  var timers = [];
  var transitions = [];

  function fakeSetTimeout(fn, delay) {
    var timer = { id: nextTimerId++, fn: fn, delay: delay, active: true };
    timers.push(timer);
    return timer.id;
  }

  function fakeClearTimeout(id) {
    for (var i = 0; i < timers.length; i++) {
      if (timers[i].id === id) timers[i].active = false;
    }
  }

  function activeTimers() {
    return timers.filter(function (timer) { return timer.active; });
  }

  function fireNextTimer() {
    var active = activeTimers();
    if (!active.length) throw new Error("No active timers to fire.");
    active[0].active = false;
    active[0].fn();
  }

  var controller = saver.createController({
    sleepDelayMs: 1234,
    setTimeoutFn: fakeSetTimeout,
    clearTimeoutFn: fakeClearTimeout,
    onStateChange: function (nextState, prevState) {
      transitions.push(prevState + "->" + nextState);
    },
  });

  assertEqual(controller.getState(), "active", "Controller should start active.");

  controller.setEnabled(true);
  assertEqual(controller.getState(), "active", "Visible tab must stay active.");

  controller.setHidden(true);
  assertEqual(controller.getState(), "quiet", "Hidden enabled tab must enter quiet mode first.");
  assertEqual(activeTimers().length, 1, "Quiet mode must arm one sleep timer.");
  assertEqual(activeTimers()[0].delay, 1234, "Sleep timer must use the configured delay.");

  controller.setHidden(false);
  assertEqual(controller.getState(), "active", "Visible tab must wake back to active.");
  assertEqual(activeTimers().length, 0, "Wake must cancel the pending sleep timer.");

  controller.setHidden(true);
  fireNextTimer();
  assertEqual(controller.getState(), "sleeping", "Quiet timer must transition to sleeping.");

  controller.setHidden(false);
  assertEqual(controller.getState(), "active", "Visible tab must wake from sleeping.");

  controller.setHidden(true);
  assertEqual(controller.getState(), "quiet", "Second hide should re-enter quiet mode.");
  controller.setEnabled(false);
  assertEqual(controller.getState(), "active", "Disabling saver must force active mode.");
  assertEqual(activeTimers().length, 0, "Disabling saver must clear sleep timers.");

  assertTrue(
    transitions.indexOf("active->quiet") !== -1 &&
    transitions.indexOf("quiet->sleeping") !== -1 &&
    transitions.indexOf("sleeping->active") !== -1,
    "Expected state transitions were not observed."
  );

  writeLine("traffic_saver_test: ok");
}
