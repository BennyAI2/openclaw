import { pinRuntimePaths } from "../config/paths.js";
import { startGatewayServer } from "../gateway/server.js";

pinRuntimePaths();
const port = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "0", 10);
const token = process.env.OPENCLAW_TEST_GATEWAY_TOKEN ?? "";
const server = await startGatewayServer(port, {
  bind: "loopback",
  auth: { mode: "token", token },
  controlUiEnabled: false,
});
await server.startupSettled;
// Minimal startup skips maintenance, including its initial health refresh. Settle
// that real work before readiness so it cannot starve the next test handshake.
const { refreshGatewayHealthSnapshot } = await import("../gateway/server/health-state.js");
await refreshGatewayHealthSnapshot({ probe: false });
process.send?.({ port });

const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
setInterval(() => {}, 1_000);
