/**
 * A command-line client of a bridge, for people and tests:
 *
 *   bun src/service/ctl.ts SERVICE CMD [key=value ...]     one request, the answer printed
 *   bun src/service/ctl.ts SERVICE subscribe              events until interrupted
 *
 * `--socket PATH` (or MOON_SOCIAL_SOCKET) picks another socket. Values that
 * parse as JSON (numbers, true, null, arrays) are sent as such.
 */

import { createConnection } from "node:net";

const args = process.argv.slice(2);
let socketPath = process.env.MOON_SOCIAL_SOCKET ?? null;
const socketFlag = args.indexOf("--socket");
if (socketFlag >= 0) {
  socketPath = args[socketFlag + 1] ?? null;
  args.splice(socketFlag, 2);
}
const [service, cmd, ...rest] = args;
if (!service || !cmd) {
  process.stderr.write("usage: ctl.ts [--socket PATH] SERVICE CMD [key=value ...]\n");
  process.exit(64);
}
const request: Record<string, unknown> = { id: 1, cmd };
for (const pair of rest) {
  const equals = pair.indexOf("=");
  if (equals <= 0) {
    process.stderr.write(`not key=value: ${pair}\n`);
    process.exit(64);
  }
  const value = pair.slice(equals + 1);
  try { request[pair.slice(0, equals)] = JSON.parse(value); } catch { request[pair.slice(0, equals)] = value; }
}

const socket = createConnection(socketPath ?? `/run/moon-social/${service}.sock`);
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
socket.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    process.stdout.write(`${line}\n`);
    if (cmd !== "subscribe" && JSON.parse(line).id === 1) {
      socket.end();
      process.exit(JSON.parse(line).ok ? 0 : 1);
    }
  }
});
socket.on("error", (error) => {
  process.stderr.write(`ctl: ${error.message}\n`);
  process.exit(69);
});
