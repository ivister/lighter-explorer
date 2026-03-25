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
  var sockets = [];
  var timeouts = [];
  var intervals = [];
  var nextTimerId = 1;

  function FakeWebSocket(url) {
    this.url = url;
    this.sent = [];
    this.readyState = FakeWebSocket.CONNECTING;
    this.closeCount = 0;
    sockets.push(this);
  }

  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  FakeWebSocket.prototype.send = function (payload) {
    this.sent.push(payload);
  };

  FakeWebSocket.prototype.close = function () {
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
    if (typeof this.onclose === "function") this.onclose();
  };

  function fakeSetTimeout(fn, delay) {
    var timer = { id: nextTimerId++, fn: fn, delay: delay, active: true };
    timeouts.push(timer);
    return timer.id;
  }

  function fakeClearTimeout(id) {
    for (var i = 0; i < timeouts.length; i++) {
      if (timeouts[i].id === id) timeouts[i].active = false;
    }
  }

  function fakeSetInterval(fn, delay) {
    var timer = { id: nextTimerId++, fn: fn, delay: delay, active: true };
    intervals.push(timer);
    return timer.id;
  }

  function fakeClearInterval(id) {
    for (var i = 0; i < intervals.length; i++) {
      if (intervals[i].id === id) intervals[i].active = false;
    }
  }

  global.window = global;
  global.WebSocket = FakeWebSocket;
  global.setTimeout = fakeSetTimeout;
  global.clearTimeout = fakeClearTimeout;
  global.setInterval = fakeSetInterval;
  global.clearInterval = fakeClearInterval;

  eval(readText(repoRoot + "/frontend/ws.js"));

  var wsApi = global.LighterWS;
  if (!wsApi) throw new Error("LighterWS was not loaded.");

  var statuses = [];
  wsApi.onStatusChange(function (value) {
    statuses.push(value);
  });

  wsApi.subscribe("market_stats/all", function () {});
  wsApi.init({ ws_url: "wss://example.test/stream" });

  assertEqual(sockets.length, 1, "init() must create one socket.");
  assertEqual(sockets[0].url, "wss://example.test/stream", "Socket must use the configured URL.");

  var firstSocket = sockets[0];
  firstSocket.readyState = FakeWebSocket.OPEN;
  if (typeof firstSocket.onopen === "function") firstSocket.onopen();
  firstSocket.onmessage({ data: JSON.stringify({ type: "connected" }) });

  assertEqual(statuses[statuses.length - 1], true, "Connected handshake must report connected status.");
  assertEqual(intervals.filter(function (timer) { return timer.active; }).length, 1, "Connected socket must start one ping interval.");
  assertTrue(firstSocket.sent.length > 0, "Connected socket must resubscribe desired channels.");
  assertEqual(JSON.parse(firstSocket.sent[0]).channel, "market_stats/all", "Resubscribe must use the desired channel name.");

  wsApi.sleep();

  assertEqual(firstSocket.closeCount, 1, "sleep() must close the active socket intentionally.");
  assertEqual(statuses[statuses.length - 1], false, "sleep() must report disconnected status.");
  assertEqual(timeouts.filter(function (timer) { return timer.active; }).length, 0, "Intentional sleep must not schedule reconnect timers.");
  assertEqual(intervals.filter(function (timer) { return timer.active; }).length, 0, "sleep() must stop ping intervals.");

  wsApi.wake();
  assertEqual(sockets.length, 2, "wake() must create a fresh socket.");

  var secondSocket = sockets[1];
  secondSocket.readyState = FakeWebSocket.OPEN;
  if (typeof secondSocket.onopen === "function") secondSocket.onopen();
  secondSocket.onmessage({ data: JSON.stringify({ type: "connected" }) });

  assertEqual(statuses[statuses.length - 1], true, "wake() handshake must restore connected status.");
  assertTrue(secondSocket.sent.length > 0, "wake() must resubscribe desired channels.");
  assertEqual(JSON.parse(secondSocket.sent[0]).channel, "market_stats/all", "Desired subscriptions must survive sleep/wake.");

  writeLine("ws_lifecycle_test: ok");
}
