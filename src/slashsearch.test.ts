import { describe, expect, test } from "bun:test";

import { acceptAutocomplete, cycleAutocomplete, updateAutocomplete } from "./autocomplete";
import { commandCompletions, findSlashShorthand, macroCompletions, resolveSlashShorthands } from "./slashsearch";
import { createInitialState } from "./state";

const state = () => createInitialState(null, "/tmp/record-config.json", { alice: "t1" });
const names = (input: string) => commandCompletions(state(), input).map((item) => item.insertText ?? item.name);

describe("slash search", () => {
  test("matches anywhere in a command name, word starts first", () => {
    expect(names("/supp")).toEqual(["/noise-suppression"]);
    expect(names("/act")[0]).toBe("/react"); // "react", "quickreact", "unreact" and "accept" all contain it
    expect(names("/act")).toContain("/unreact");
    expect(names("/st").slice(0, 2)).toEqual(["/stream", "/status"]);
  });

  test("later words search nested arguments", () => {
    expect(names("/stat idl")).toEqual(["/status idle"]);
    expect(names("/chan hidden on")).toEqual(["/channels show-hidden on"]);
    expect(names("/status ")).toContain("/status dnd");
  });

  test("macros match too, at the start and mid-message", () => {
    expect(names("/kao hap")).toEqual(["/kao happy"]);
    expect(macroCompletions("/kao sle").map((item) => item.insertText ?? item.name)).toEqual(["/kao sleepy"]);
  });

  test("rows carry the matched characters for the popup", () => {
    const [row] = commandCompletions(state(), "/supp");
    expect(row?.matchRanges).toEqual([{ start: 7, end: 11 }]);
  });
});

describe("slash shorthands on Enter", () => {
  test("a prompt-start shorthand sends as the popup's first row", () => {
    expect(resolveSlashShorthands(state(), "/stat idl")).toBe("/status idle");
    expect(resolveSlashShorthands(state(), "/noise simp")).toBe("/noise-suppression simple");
    expect(resolveSlashShorthands(state(), "/kao hap")).toBe("/kao happy");
  });

  test("free text after a command, plain messages and app commands stay as typed", () => {
    for (const text of ["/thread my new thread", "/react 👍", "/status quote out for lunch", "hi /stat idl",
      "/@poll_bot create", "/s", "/j", "no slash", "/stat idl\nsecond line"]) {
      expect(resolveSlashShorthands(state(), text)).toBe(text);
    }
  });

  test("quitting, hanging up and logins are never guessed", () => {
    for (const text of ["/qui", "/hang", "/logo whats", "/logout wh", "/login whats", "/login ali"]) {
      expect(findSlashShorthand(state(), text)).toBeNull();
    }
    // Typed out in full they still complete normally.
    expect(resolveSlashShorthands(state(), "/logout whatsapp")).toBe("/logout whatsapp");
  });
});

describe("autocomplete popup with slash search", () => {
  test("Tab fills the full command text for a nested match", () => {
    const s = state();
    s.editor.buffer = "/stat idl";
    s.editor.cursor = s.editor.buffer.length;
    updateAutocomplete(s);
    cycleAutocomplete(s, 1);
    expect(s.editor.buffer).toBe("/status idle");
    acceptAutocomplete(s);
  });

  test("a mid-message macro argument replaces only its token", () => {
    const s = state();
    s.editor.buffer = "hey /kao sle";
    s.editor.cursor = s.editor.buffer.length;
    updateAutocomplete(s);
    cycleAutocomplete(s, 1);
    expect(s.editor.buffer).toBe("hey /kao sleepy");
  });
});

describe("popup match accents", () => {
  test("matched characters are accented, the rest keep the row colour", async () => {
    const { renderAutocompleteName } = await import("./render");
    const { theme } = await import("./theme");
    const [row] = commandCompletions(state(), "/supp");
    const out = renderAutocompleteName(row!, row!.name, 20, theme.text);
    expect(out).toBe(`/noise-${theme.accent}${theme.bold}supp${theme.boldOff}${theme.text}ression  `);
  });
});
