import assert from "node:assert/strict";
import test from "node:test";
import { installState, isIosPlatform } from "../src/lib/install.js";

test("installState prefers the installed state over any offer", () => {
  // A standalone window can still be handed a stale deferred prompt; being
  // installed always wins, or the app offers to install itself.
  assert.equal(installState({ standalone: true, promptable: true, ios: false }), "installed");
  assert.equal(installState({ standalone: true, promptable: false, ios: true }), "installed");
});

test("installState offers the real prompt where there is one, the recipe on iOS", () => {
  assert.equal(installState({ standalone: false, promptable: true, ios: false }), "promptable");
  assert.equal(installState({ standalone: false, promptable: false, ios: true }), "ios-hint");
});

test("installState hides the section when there is nothing to offer", () => {
  // A desktop browser, or a prompt already spent: no API and no recipe.
  assert.equal(installState({ standalone: false, promptable: false, ios: false }), "hidden");
});

test("isIosPlatform catches iPadOS, which reports itself as a Mac", () => {
  assert.equal(isIosPlatform("… iPhone OS 17_0 like Mac OS X …", "iPhone", 5), true);
  assert.equal(isIosPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), true);
  assert.equal(isIosPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0), false);
  assert.equal(isIosPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Linux armv8l", 5), false);
});
