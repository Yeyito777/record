import { describe, expect, test } from "bun:test";

import {
  TerminalGraphicsClient,
  kittyGraphicsDeleteImageRange,
  kittyGraphicsPlace,
  kittyGraphicsQuery,
  kittyGraphicsTransmitPng,
} from "./terminalgraphics";

const ST = "\x1b\\";

describe("Kitty terminal graphics", () => {
  test("queries with a direct validated PNG rather than relying on TERM", () => {
    const query = kittyGraphicsQuery();
    expect(query).toStartWith("\x1b_Ga=q,t=d,f=100,i=1879048190;");
    expect(query).toEndWith(ST);
  });

  test("chunks direct PNG data and places it without moving the cursor", () => {
    const transfer = kittyGraphicsTransmitPng(0x72000000, "A".repeat(8192));
    const commands = transfer.split(ST).filter(Boolean);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("a=t,t=d,f=100,i=1912602624,q=2,m=1;");
    expect(commands[1]).toContain("q=2,m=0;");

    const placement = kittyGraphicsPlace(0x72000000, { columns: 1, rows: 1, z: 1478 });
    expect(placement).toBe("\x1b_Ga=p,i=1912602624,c=1,r=1,C=1,z=1478,q=2\x1b\\");

    const selected = kittyGraphicsPlace(0x72000000, { columns: 2, rows: 1, z: 1478, selected: true });
    expect(selected).toBe("\x1b_Ga=p,i=1912602624,c=2,r=1,C=1,z=1478,V=1,q=2\x1b\\");
  });

  test("recognizes the matching capability response and consumes graphics replies", () => {
    const writes: string[] = [];
    const support: boolean[] = [];
    const client = new TerminalGraphicsClient({
      write: (sequence) => writes.push(sequence),
      onSupportChanged: (supported) => support.push(supported),
      queryTimeoutMs: 10_000,
    });

    client.query();
    expect(writes).toEqual([kittyGraphicsQuery()]);
    expect(client.handleControlSequence(`\x1b_Gi=1879048190;OK${ST}`)).toBe(true);
    expect(client.isSupported()).toBe(true);
    expect(support).toEqual([true]);
    expect(client.handleControlSequence(`\x1b_Gi=123;ENOENT${ST}`)).toBe(true);
    expect(client.handleControlSequence("\x1b[?5522;1$y")).toBe(false);
    client.dispose();
  });

  test("uses a hard image-range deletion for lifecycle cleanup", () => {
    expect(kittyGraphicsDeleteImageRange(0x72000000, 0x720018ff)).toBe(
      "\x1b_Ga=d,d=R,x=1912602624,y=1912609023,q=2\x1b\\",
    );
  });
});
