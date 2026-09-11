import { afterEach, describe, expect, it } from "vitest";
import { hasPlatformAccelerator, isApplePlatform } from "./hotkey";

/**
 * The platform as `navigator` reports it — the source `hotkey.ts` reads.
 * jsdom answers `""` by default, so every case says which machine it is on.
 */
function onPlatform(platform: string, userAgentPlatform?: string): void {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
  Object.defineProperty(window.navigator, "userAgentData", {
    value: userAgentPlatform === undefined ? undefined : { platform: userAgentPlatform },
    configurable: true,
  });
}

const key = (mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

afterEach(() => onPlatform(""));

describe("isApplePlatform", () => {
  it("reads the frozen navigator.platform when userAgentData is absent", () => {
    onPlatform("MacIntel");
    expect(isApplePlatform()).toBe(true);
    onPlatform("Win32");
    expect(isApplePlatform()).toBe(false);
  });

  it("prefers userAgentData.platform, including the spec's own 'iOS'", () => {
    onPlatform("Win32", "macOS");
    expect(isApplePlatform()).toBe(true);
    onPlatform("Win32", "iOS");
    expect(isApplePlatform()).toBe(true);
    onPlatform("MacIntel", "Windows");
    expect(isApplePlatform()).toBe(false);
  });

  it("falls back on an EMPTY userAgentData.platform rather than trusting it", () => {
    // A browser that ships the object but withholds the value must not turn a
    // Mac into "not Apple" — that is Ctrl+K taken on a Mac again.
    onPlatform("MacIntel", "");
    expect(isApplePlatform()).toBe(true);
  });
});

describe("hasPlatformAccelerator", () => {
  it("is ⌘ alone on a Mac — not Ctrl, and not both", () => {
    onPlatform("MacIntel");
    expect(hasPlatformAccelerator(key({ metaKey: true }))).toBe(true);
    expect(hasPlatformAccelerator(key({ ctrlKey: true }))).toBe(false);
    expect(hasPlatformAccelerator(key({ metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("is Ctrl alone elsewhere — not Meta, and not both", () => {
    onPlatform("Win32");
    expect(hasPlatformAccelerator(key({ ctrlKey: true }))).toBe(true);
    expect(hasPlatformAccelerator(key({ metaKey: true }))).toBe(false);
    expect(hasPlatformAccelerator(key({ metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("never fires with Alt held: AltGr on Windows arrives as Ctrl+Alt", () => {
    onPlatform("Win32");
    expect(hasPlatformAccelerator(key({ ctrlKey: true, altKey: true }))).toBe(false);
    onPlatform("MacIntel");
    expect(hasPlatformAccelerator(key({ metaKey: true, altKey: true }))).toBe(false);
  });
});
