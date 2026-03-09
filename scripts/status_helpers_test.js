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
  eval(readText(repoRoot + "/frontend/status-helpers.js"));

  var helpers = global.LighterStatusHelpers;
  if (!helpers) throw new Error("LighterStatusHelpers was not loaded.");

  assertTrue(
    helpers.hasBalance({
      total_asset_value: "21.687984",
      collateral: "0",
      available_balance: "0",
    }),
    "Positive total_asset_value must count as balance."
  );

  assertEqual(
    helpers.getAccountStatus({
      _detailHydrated: false,
      _hasPositions: false,
      positions: [],
      total_asset_value: "21.687984",
      collateral: "0",
      available_balance: "0",
      status: 0,
    }),
    "check",
    "Summary rows with value but no hydrated detail must not render as idle."
  );

  assertTrue(
    helpers.hasRealPositions([{ position: "0.5", position_value: "0" }]),
    "Non-zero position size must be treated as an open position."
  );

  assertEqual(
    helpers.getAccountStatus({
      _detailHydrated: true,
      _hasPositions: true,
      positions: [{ position: "0.5", position_value: "0" }],
      total_asset_value: "0",
      collateral: "0",
      available_balance: "0",
      status: 0,
    }),
    "trading",
    "Open positions must render as trading even when free balance is zero."
  );

  assertTrue(
    helpers.shouldHydrateSubAccount({
      _detailHydrated: false,
      _hasPositions: false,
      positions: [],
      total_asset_value: "0",
      collateral: "0",
      available_balance: "0",
      status: 1,
      total_order_count: 0,
      pending_order_count: 0,
    }),
    "Online sub-account should be hydrated in the background."
  );

  assertEqual(
    helpers.getAccountStatus({
      _detailHydrated: false,
      _hasPositions: false,
      positions: [],
      total_asset_value: "0",
      collateral: "0",
      available_balance: "0",
      status: 0,
      total_order_count: 0,
      pending_order_count: 0,
    }),
    "idle",
    "Truly empty accounts should stay idle."
  );

  writeLine("status_helpers_test: ok");
}
