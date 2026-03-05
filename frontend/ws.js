(function () {
  "use strict";

  var ws = null;
  var wsUrl = "";
  var connected = false;
  var reconnectTimer = null;
  var reconnectDelay = 1000;
  var MAX_DELAY = 30000;
  var pingTimer = null;

  var subs = {};            // channel (with /) → callback
  var statusCallbacks = [];

  // ── Public API ──────────────────────────────────────────

  function init(config) {
    wsUrl = config.ws_url;
    if (!wsUrl) return;
    connect();
  }

  function subscribe(channel, callback) {
    subs[channel] = callback;
    if (connected) sendSubscribe(channel);
  }

  function unsubscribe(channel) {
    if (!subs[channel]) return;
    delete subs[channel];
    send({ type: "unsubscribe", channel: channel });
  }

  function onStatusChange(cb) {
    statusCallbacks.push(cb);
  }

  function destroy() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stopPing();
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    subs = {};
    statusCallbacks = [];
    connected = false;
  }

  // ── Connection ──────────────────────────────────────────

  function connect() {
    if (!wsUrl) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      reconnectDelay = 1000;
    };

    ws.onmessage = function (e) {
      try { handleMessage(JSON.parse(e.data)); }
      catch (err) { /* ignore parse errors */ }
    };

    ws.onclose = function () {
      setConnected(false);
      stopPing();
      scheduleReconnect();
    };

    ws.onerror = function () { /* onclose fires after */ };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connect();
    }, reconnectDelay);
  }

  // ── Heartbeat ───────────────────────────────────────────

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () { send({ type: "ping" }); }, 30000);
  }

  function stopPing() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  // ── Message handling ────────────────────────────────────

  function handleMessage(msg) {
    // Server confirms connection
    if (msg.type === "connected") {
      setConnected(true);
      startPing();
      resubscribeAll();
      return;
    }

    // Heartbeat
    if (msg.type === "ping") { send({ type: "pong" }); return; }
    if (msg.type === "pong") return;

    // Route by msg.channel (API uses ":" separator, we subscribe with "/")
    var ch = msg.channel;
    if (!ch) return;

    var norm = ch.replace(/:/g, "/");

    // Exact match
    if (subs[norm]) { subs[norm](msg); return; }

    // "all" prefix match: subscribed to "market_stats/all", msg channel "market_stats/0"
    var keys = Object.keys(subs);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].endsWith("/all")) {
        var prefix = keys[i].slice(0, -3); // "market_stats/"
        if (norm.startsWith(prefix)) { subs[keys[i]](msg); return; }
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────

  function sendSubscribe(channel) {
    send({ type: "subscribe", channel: channel });
  }

  function resubscribeAll() {
    var channels = Object.keys(subs);
    for (var i = 0; i < channels.length; i++) {
      sendSubscribe(channels[i]);
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function setConnected(val) {
    connected = val;
    for (var i = 0; i < statusCallbacks.length; i++) {
      statusCallbacks[i](val);
    }
  }

  // ── Expose ──────────────────────────────────────────────

  window.LighterWS = {
    init: init,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    onStatusChange: onStatusChange,
    destroy: destroy,
  };
})();
