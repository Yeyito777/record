import { describe, expect, test } from "bun:test";

import { createInitialState } from "./state";
import { createVoiceMessageController } from "./voice-message-controller";
import type { VoiceMessageClip } from "./voice-message";

const clip: VoiceMessageClip = {
  filename: "voice-message.ogg",
  mediaType: "audio/ogg",
  base64: Buffer.from("ogg").toString("base64"),
  sizeBytes: 3,
  durationSecs: 1,
  waveform: Buffer.alloc(256).toString("base64"),
};

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("voice message controller", () => {
  test("only arms hold-to-talk in prompt normal mode", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.editor.mode = "insert";
    state.auth.savedToken = "token";
    state.channelList.activeChannelId = "channel-1";
    let starts = 0;
    const controller = createVoiceMessageController(state, () => {}, {
      startRecorder: () => {
        starts++;
        return { stop: async () => clip, abort() {} };
      },
      sendVoiceMessage() {},
    });

    expect(controller.handleKey({ type: "char", char: " " })).toBe(false);
    expect(starts).toBe(0);

    state.editor.mode = "normal";
    expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
    expect(starts).toBe(1);
    controller.cleanup();
  });

  test("does not start when the prompt has a draft", () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.mode = "normal";
    state.editor.buffer = "draft";
    state.auth.savedToken = "token";
    state.channelList.activeChannelId = "channel-1";
    let starts = 0;
    const controller = createVoiceMessageController(state, () => {}, {
      startRecorder: () => {
        starts++;
        return { stop: async () => clip, abort() {} };
      },
      sendVoiceMessage() {},
    });

    expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
    expect(starts).toBe(0);
    expect(state.editor.buffer).toBe("draft");
    expect(state.notice.text).toContain("Clear the prompt");
  });

  test("sends a voice clip when space is released after minimum duration", async () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.mode = "normal";
    state.auth.savedToken = "token";
    state.channelList.activeChannelId = "channel-1";
    let clock = 1_000;
    const sent: VoiceMessageClip[] = [];
    const controller = createVoiceMessageController(state, () => {}, {
      now: () => clock,
      startRecorder: () => ({ stop: async () => clip, abort() {} }),
      sendVoiceMessage: (item) => sent.push(item),
    });

    expect(controller.handleKey({ type: "char", char: " ", event: "press" })).toBe(true);
    expect(state.voiceMessagePrompt?.phase).toBe("recording");
    clock += 750;
    expect(controller.handleKey({ type: "char", char: " ", event: "release" })).toBe(true);
    await flushPromises();

    expect(sent).toEqual([clip]);
    expect(state.voiceMessagePrompt).toBeNull();
  });

  test("drops very short recordings", async () => {
    const state = createInitialState(null, "/tmp/record-config.json");
    state.editor.mode = "normal";
    state.auth.savedToken = "token";
    state.channelList.activeChannelId = "channel-1";
    let clock = 1_000;
    let sent = 0;
    const controller = createVoiceMessageController(state, () => {}, {
      now: () => clock,
      startRecorder: () => ({ stop: async () => clip, abort() {} }),
      sendVoiceMessage: () => { sent++; },
    });

    controller.handleKey({ type: "char", char: " ", event: "press" });
    clock += 100;
    controller.handleKey({ type: "char", char: " ", event: "release" });
    await flushPromises();

    expect(sent).toBe(0);
    expect(state.voiceMessagePrompt).toBeNull();
  });
});
