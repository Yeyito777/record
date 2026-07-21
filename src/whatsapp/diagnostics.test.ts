import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWhatsAppDiagnosticsServer, WhatsAppDiagnostics } from "./diagnostics";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function request(path: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => { output += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
    socket.on("error", reject);
  });
}

describe("WhatsApp diagnostics IPC", () => {
  test("exposes private metadata-only unsupported-message diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "record-wa-diagnostics-"));
    temporaryDirectories.push(root);
    const socketPath = join(root, "private", "diagnostics.sock");
    const diagnostics = new WhatsAppDiagnostics();
    diagnostics.record("messages", {
      kind: "upsert",
      upsertType: "notify",
      skippedMessages: 2,
      messages: [{
        key: { id: "message", chatId: "group@g.us" },
        id: "message",
        chatId: "group@g.us",
        fromMe: false,
        timestampMs: 10,
        content: {
          kind: "unsupported",
          sourceType: "futureMessage",
          sourceFields: ["futureMessage"],
        },
      }],
    });
    const server = await startWhatsAppDiagnosticsServer(
      socketPath,
      () => diagnostics.snapshot({ status: "connected", resumed: true, connectedAtMs: 1 }),
    );

    expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
    const response = await request(socketPath, { command: "summary" }) as {
      result: { skippedMessages: number; recentUnsupported: unknown[]; eventCounts: Record<string, number> };
    };
    expect(response.result.skippedMessages).toBe(2);
    expect(response.result.eventCounts.messages).toBe(1);
    expect(response.result.recentUnsupported).toEqual([expect.objectContaining({
      event: "messages",
      chatId: "group@g.us",
      messageId: "message",
      sourceType: "futureMessage",
      sourceFields: ["futureMessage"],
    })]);
    expect(JSON.stringify(response)).not.toContain("message text");

    await server.close();
    await expect(lstat(socketPath)).rejects.toThrow();
  });
});
