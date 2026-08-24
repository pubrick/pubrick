import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "./crypto.js";

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const OTHER_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");

describe("crypto", () => {
  it("round-trips JSON values", () => {
    const secret = { botToken: "12345:abc", chatId: "@channel" };
    const payload = encryptJson(secret, KEY);
    expect(payload).not.toContain("12345:abc");
    expect(decryptJson(payload, KEY)).toEqual(secret);
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    expect(encryptJson("x", KEY)).not.toBe(encryptJson("x", KEY));
  });

  it("rejects a tampered payload", () => {
    const payload = encryptJson({ a: 1 }, KEY);
    const raw = Buffer.from(payload, "base64");
    const byte = raw[raw.length - 1];
    if (byte !== undefined) {
      raw[raw.length - 1] = byte ^ 0xff;
    }
    expect(() => decryptJson(raw.toString("base64"), KEY)).toThrow();
  });

  it("rejects the wrong key and a malformed key", () => {
    const payload = encryptJson({ a: 1 }, KEY);
    expect(() => decryptJson(payload, OTHER_KEY)).toThrow();
    expect(() => encryptJson("x", "dG9vLXNob3J0")).toThrow(/32 bytes/);
  });
});
