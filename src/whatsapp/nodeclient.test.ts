import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NodeWhatsAppBackendClient } from "./nodeclient";

function worker() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
}

test("carries reaction keys and empty removal text through worker IPC", async () => {
  const child = worker();
  const client = new NodeWhatsAppBackendClient({
    authDirectory: "/mock/auth",
    spawnWorker: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const key = { id: "target", chatId: "group@g.us", fromMe: false, participantId: "person@lid" };
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    expect(request).toMatchObject({ method: "send-reaction", params: { key, emoji: "" } });
    child.stdout.write(JSON.stringify({ type: "response", id: request.id,
      result: { target: key, reaction: { senderId: "self", fromMe: true, emoji: "" } },
    }) + "\n");
  });
  expect((await client.sendReaction(key, "")).reaction.emoji).toBe("");
  child.emit("close", 0, null);
  await client.shutdown();
});

test("carries caller-chosen text and image IDs through worker IPC", async () => {
  const child = worker();
  const client = new NodeWhatsAppBackendClient({
    authDirectory: "/mock/auth",
    spawnWorker: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    requests.push(request);
    child.stdout.write(JSON.stringify({
      type: "response", id: request.id,
      result: request.method === "send-text"
        ? { id: request.params.messageId }
        : request.params.messageIds.map((id: string) => ({ id })),
    }) + "\n");
  });
  expect((await client.sendText("person@s.whatsapp.net", "hi", undefined, 60, "text-id")).id).toBe("text-id");
  const images = [{ mediaType: "image/png" as const, base64: "b25l", sizeBytes: 3 }];
  expect((await client.sendImages("person@s.whatsapp.net", images, "caption", undefined, 60, ["image-id"])).map((message) => message.id))
    .toEqual(["image-id"]);
  expect(requests[0]).toMatchObject({ method: "send-text", params: { messageId: "text-id", ephemeralExpirationSeconds: 60 } });
  expect(requests[1]).toMatchObject({ method: "send-images", params: { messageIds: ["image-id"], ephemeralExpirationSeconds: 60 } });
  child.emit("close", 0, null);
  await client.shutdown();
});

test("drains history, live events and replies arriving after worker exit", async () => {
  const child = worker();
  const client = new NodeWhatsAppBackendClient({
    authDirectory: "/mock/auth",
    spawnWorker: () => child as unknown as ChildProcessWithoutNullStreams,
  });
  const received: string[] = [];
  client.on("history", () => { received.push("history"); });
  client.on("messages", () => { received.push("messages"); });
  const login = client.startLogin();
  child.emit("exit", 0, null);
  const lines = [
    { type: "event", event: "history", data: { chats: [], contacts: [], messages: [] } },
    { type: "event", event: "messages", data: { kind: "upsert", messages: [] } },
    { type: "response", id: 1, result: { status: "connected", resumed: true } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  child.stdout.write(lines.slice(0, 37));
  child.stdout.write(lines.slice(37));
  child.emit("close", 0, null);
  expect(await login).toEqual({ status: "connected", resumed: true });
  expect(received).toEqual(["history", "messages"]);
  await client.shutdown();
});

test("ignores retired worker data and errors after a replacement starts", async () => {
  const old = worker();
  const replacement = worker();
  const workers = [old, replacement];
  const client = new NodeWhatsAppBackendClient({
    authDirectory: "/mock/auth",
    spawnWorker: () => workers.shift() as unknown as ChildProcessWithoutNullStreams,
  });
  const first = client.startLogin();
  const rejected = first.catch((error: Error) => error.message);
  old.emit("error", new Error("spawn failed"));
  expect(await rejected).toBe("spawn failed");
  const second = client.startLogin();
  old.stdout.write('{"type":"event","event":"state","data":{"status":"stopped"}}\n');
  old.emit("error", new Error("late failure"));
  old.emit("close", 1, null);
  replacement.stdout.write('{"type":"response","id":2,"result":{"status":"connected","resumed":true}}\n');
  expect(await second).toEqual({ status: "connected", resumed: true });
  expect(client.state.status).not.toBe("stopped");
  replacement.emit("close", 0, null);
  await client.shutdown();
});
