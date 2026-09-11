/**
 * Which modifier key this platform means by "the application shortcut".
 *
 * ⌘ on Apple hardware, Ctrl everywhere else — and **never both**, which is the
 * bug this exists to close. Accepting `metaKey || ctrlKey` looks generous and
 * is not: on macOS `Ctrl+K` is the field's own kill-line (readline's
 * `kill-line`, which every Cocoa text control including `<textarea>`
 * implements), so a screen that takes it has quietly deleted a shortcut the
 * reader uses to edit the text they are about to refine. The mirror case is
 * Windows and Linux, where `Meta` is the OS key and an app has no business
 * claiming combinations with it.
 *
 * **`navigator.userAgentData.platform` first, `navigator.platform` as the
 * fallback.** The second is deprecated and frozen (Chromium reports
 * `"MacIntel"` on every Mac forever), which is exactly why it is the fallback
 * rather than the source: it is still the ONLY answer Safari and Firefox give,
 * and a frozen value is a correct one for this question — it never stops
 * saying "Mac" on a Mac. The first is the API that is supposed to replace it
 * and is Chromium-only today.
 *
 * **Hand-rolled, deliberately** (repo convention: prefer a maintained library,
 * and name the alternative). `is-hotkey` resolves a `"mod+k"` string to the
 * platform's accelerator and would be the exact fit — but it was last
 * published in 2020, and its own detection is the same `navigator.platform`
 * regex, so the dependency would buy a maintenance risk and no knowledge.
 * `react-hotkeys-hook` is maintained, and it is the rejected alternative for a
 * different reason: it owns the listener and its scoping, and the shortcut
 * here is scoped by "focus is inside this card" *and* by a live selection,
 * checked against state the hook cannot see — adopting it would replace ten
 * lines of listener with a 10 kB dependency plus an adapter, which is the
 * opposite of the rule's "smaller than the code it replaces".
 */
export function isApplePlatform(nav: Navigator = navigator): boolean {
  const modern = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = modern?.platform ?? nav.platform ?? "";
  // "macOS" (userAgentData), "MacIntel" (navigator.platform), and the iPad
  // Safari that reports "iPad" while asking for a desktop site.
  return /^(mac|iphone|ipad|ipod)/i.test(platform);
}

/**
 * Is this key event holding THIS platform's accelerator — and only it?
 *
 * The other modifier is required to be absent for the same reason the choice
 * is made at all: `Ctrl+⌘+K` on a Mac is not this app's shortcut, and taking
 * it would be the `metaKey || ctrlKey` bug wearing a different hat.
 */
export function hasPlatformAccelerator(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
