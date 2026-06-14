import { createLocalDemoApp, createLocalDemoServer } from "./local-demo.js";

const host = process.env["WATASU_HTTP_HOST"] ?? "127.0.0.1";
const port = Number.parseInt(process.env["WATASU_HTTP_PORT"] ?? "8787", 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error("WATASU_HTTP_PORT must be an integer between 1 and 65535.");
}

const baseUrl = `http://${host}:${port}`;
const server = createLocalDemoServer(createLocalDemoApp({ baseUrl }));

server.listen(port, host, () => {
  process.stdout.write(`watasu local HTTP demo listening on ${baseUrl}\n`);
  process.stdout.write(`agent card: ${baseUrl}/.well-known/agent-card.json\n`);
});
