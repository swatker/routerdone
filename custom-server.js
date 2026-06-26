const http = require("http");

const origCreate = http.createServer.bind(http);

// Graceful shutdown coordinator: on SIGTERM/SIGINT, stop accepting new
// connections and let in-flight requests finish before exiting. The
// process.exit deferral below keeps the process alive during the drain
// window so other modules’ immediate-exit signal handlers (DB flush,
// tunnel cleanup) do not abort in-flight requests prematurely.
let drainServer = null;
let draining = false;
const DRAIN_TIMEOUT_MS = 25000;
const origExit = process.exit.bind(process);

function coordinatedShutdown(signal) {
  if (draining) return;
  draining = true;
  console.log(`[custom-server] ${signal} received, draining in-flight requests...`);
  if (drainServer) {
    // Close idle keep-alive connections so the drain is not blocked by them.
    if (typeof drainServer.closeIdleConnections === "function") {
      drainServer.closeIdleConnections();
    }
    drainServer.close(() => {
      console.log("[custom-server] drain complete, exiting.");
      origExit(0);
    });
  }
  // Force exit after the drain timeout (must stay under stop_grace_period).
  setTimeout(() => {
    console.log("[custom-server] drain timeout, forcing exit.");
    origExit(0);
  }, DRAIN_TIMEOUT_MS).unref();
}

// Defer process.exit while draining so the HTTP drain is not aborted by
// other signal handlers that call process.exit() immediately.
process.exit = function (code) {
  if (draining) return;
  return origExit(code);
};

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) {
    const s = origCreate(...args);
    if (!drainServer) drainServer = s;
    return s;
  }
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  const s = origCreate(...rest, wrapped);
  if (!drainServer) drainServer = s;
  return s;
};

process.on("SIGTERM", () => coordinatedShutdown("SIGTERM"));
process.on("SIGINT", () => coordinatedShutdown("SIGINT"));

require("./server.js");
