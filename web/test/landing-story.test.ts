/*
 * The landing diagrams tell one story, checked frame by frame: a message is
 * one fixed pair (plaintext P, ciphertext C); the sender seals P into C in
 * place before anything leaves it; the very same C is the chip on the wire,
 * the value in the Droppen relay (in Droppen Hub, for the offline copy) and
 * the page written to the store; the receiver
 * opens that C into that P. One message moves at a time: a card still
 * holding the one before shows it dimmed, never blank, and never a value
 * that is not the message in flight or the one just delivered.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HERO_CIPHERS, HERO_LOOP, HERO_STARTS, heroFrame, heroStill } from "../src/features/landing/hero-a.js";
import { JOURNEY_CIPHER, JOURNEY_LOOP, JOURNEY_STARTS, journeyFrame, journeyStill } from "../src/features/landing/journey.js";
import { OFFLINE_CIPHERS, OFFLINE_LOOP, OFFLINE_STARTS, offlineFrame, offlineStill } from "../src/features/landing/offline-copy.js";
import { chipLabel, currentMessage, type Message, type Shown, textOf } from "../src/features/landing/story.js";
import { morph } from "../src/features/landing/motion.js";

const STEP = 0.02;

/** Times over two loops; only the second is checked (the first one delivers what the second starts from). */
function* samples(loop: number): Generator<{ t: number; round: number; checked: boolean }> {
  for (let i = 0; i * STEP < 2 * loop; i++) {
    const abs = i * STEP;
    yield { t: abs % loop, round: Math.floor(abs / loop), checked: abs >= loop };
  }
}

const isCipher = (s: Shown) => s.kind !== "plain";

/**
 * The rules, for one diagram: `cards(t)` names every row on screen; `sender`
 * and `receivers` are the rows that seal and open; `chips` what is on a wire.
 */
function checkStory({
  name,
  loop,
  starts,
  messages,
  frame,
  sender,
  middle,
  receivers,
}: {
  name: string;
  loop: number;
  starts: readonly number[];
  messages: Message[];
  frame: (t: number, round: number) => { chips: { msg: number; wire: string; at: number }[] } & Record<string, unknown>;
  sender?: (f: ReturnType<typeof frame>) => Shown;
  middle: (f: ReturnType<typeof frame>) => Shown[];
  receivers: (f: ReturnType<typeof frame>) => Shown[];
}) {
  /** Messages whose ciphertext the receiver has shown (so their plaintext may stand there undimmed). */
  const opened = new Set<number>();
  /** Messages the sender has sealed this time round (a chip may only leave after). */
  const sealed = new Set<number>();
  let before = -1;
  for (const { t, round, checked } of samples(loop)) {
    const f = frame(t, round);
    const current = currentMessage(starts, t);
    // A message's turn starts (again, the next time round): it has to be sealed, sent and opened anew.
    const crossed = starts.some((start) => (before <= t ? before < start && start <= t : before < start || start <= t));
    if (before >= 0 && crossed) {
      sealed.delete(current);
      opened.delete(current);
    }
    before = t;
    const at = `${name} at ${t.toFixed(2)}s`;
    const s = sender?.(f);
    const all = [...(s ? [s] : []), ...middle(f), ...receivers(f)];
    for (const shown of all) {
      // Never blank, and the text is exactly the message's P or C (or one turning into the other).
      const text = textOf(shown, messages, Math.floor(t * 14));
      assert.ok(text.trim().length > 0, `${at}: a blank row`);
      const m = messages[shown.msg]!;
      if (shown.kind === "cipher") assert.equal(text, m.c, at);
      if (shown.kind === "plain" && shown.typed === undefined) assert.equal(text, m.p, at);
    }
    if (s) {
      assert.notEqual(s.kind, "open", `${at}: the sender never opens`);
      if (s.kind === "cipher" || (s.kind === "seal" && (s.p ?? 0) >= 1)) sealed.add(s.msg);
    }
    for (const shown of middle(f)) {
      // The card in the middle (the Droppen relay, or Droppen Hub handing out sealed pages) only ever holds ciphertext, and changes nothing.
      assert.equal(shown.kind, "cipher", `${at}: the middle card shows ciphertext only`);
      assert.equal(shown.lock, undefined, `${at}: nothing is sealed or opened in the middle`);
    }
    for (const shown of receivers(f)) {
      assert.notEqual(shown.kind, "seal", `${at}: the receiver never seals`);
      if (shown.kind === "cipher" || shown.kind === "open") opened.add(shown.msg);
    }
    if (!checked) continue;
    // Every ciphertext on screen that is not dimmed is the message in flight's.
    for (const shown of all) {
      if (!shown.dim && isCipher(shown)) assert.equal(shown.msg, current, `${at}: undimmed ciphertext of message ${shown.msg}, but ${current} has the turn`);
    }
    // Every chip on a wire is the message in flight's ciphertext, and leaves only once the sender sealed it.
    for (const chip of f.chips) {
      assert.equal(chip.msg, current, `${at}: a chip of message ${chip.msg} on ${chip.wire}, but ${current} has the turn`);
      assert.equal(chipLabel(messages[chip.msg]!.c), messages[current]!.c.slice(0, 4), at);
      if (sender) assert.ok(sealed.has(chip.msg), `${at}: a chip of message ${chip.msg} left before it was sealed`);
    }
    // Plaintext on the receiver, undimmed, is a delivered message whose ciphertext it showed and opened.
    for (const shown of receivers(f)) {
      if (shown.kind === "plain" && !shown.dim) assert.ok(opened.has(shown.msg), `${at}: plaintext of message ${shown.msg} the receiver never opened`);
    }
  }
}

const heroMessages: Message[] = [
  { p: "sign-in fixed", c: HERO_CIPHERS[0] },
  { p: "all tests pass", c: HERO_CIPHERS[1] },
];

test("hero: sealed on the computer, the same ciphertext on the wire and in the Droppen relay, opened on the phone, one message at a time", () => {
  checkStory({
    name: "hero",
    loop: HERO_LOOP,
    starts: HERO_STARTS,
    messages: heroMessages,
    frame: (t) => heroFrame(t) as never,
    sender: (f) => (f as unknown as ReturnType<typeof heroFrame>).computer,
    middle: (f) => [(f as unknown as ReturnType<typeof heroFrame>).hub],
    receivers: (f) => [(f as unknown as ReturnType<typeof heroFrame>).phone],
  });
});

test("hero: both paths are end to end — the direct beat seals and opens the same way, its chip on the green line, the Droppen relay dimmed", () => {
  let sawSeal = false;
  let sawOpen = false;
  let sawChip = false;
  for (let t = 0; t < HERO_LOOP; t += STEP) {
    const f = heroFrame(t);
    if (!f.direct) continue;
    if (f.computer.msg === 1 && f.computer.kind === "seal") sawSeal = true;
    if (f.phone.msg === 1 && f.phone.kind === "open") sawOpen = true;
    for (const chip of f.chips) {
      assert.equal(chip.wire, "direct", `at ${t.toFixed(2)}s: on the direct beat nothing goes through the relay`);
      sawChip = true;
    }
    // The relay holds the message before, dimmed: it never sees this one.
    assert.equal(f.hub.msg, 0);
    assert.ok(f.hub.dim);
  }
  assert.ok(sawSeal && sawOpen && sawChip);
  // And the relay: a chip through the Droppen relay, the phone's round trip then relay 220 ms.
  const relay = heroFrame(4.0);
  assert.deepEqual(relay.chips.map((c) => c.wire), ["toPhone"]);
  assert.equal(heroFrame(5.0).path, "hub");
  assert.equal(heroFrame(10.0).path, "direct");
});

test("hero: the still frame tells it whole — plaintext on the computer, ciphertext in the Droppen relay, the phone's padlock open over the same message", () => {
  const f = heroStill();
  assert.equal(f.computer.kind, "plain");
  assert.equal(f.computer.msg, 0);
  assert.deepEqual([f.hub.kind, f.hub.msg, f.hub.dim], ["cipher", 0, false]);
  assert.deepEqual([f.phone.kind, f.phone.msg, f.phone.lock, f.phone.lockOpacity], ["plain", 0, "open", 1]);
  assert.equal(f.chips.length, 0);
});

test("journey: the reply's ciphertext is the chip, the Droppen relay's value and the page written; the page count goes up as it is written", () => {
  const messages: Message[] = [{ p: "all tests pass", c: JOURNEY_CIPHER }];
  checkStory({
    name: "journey",
    loop: JOURNEY_LOOP,
    starts: JOURNEY_STARTS,
    messages,
    frame: (t, round) => journeyFrame(t, round) as never,
    sender: (f) => (f as unknown as ReturnType<typeof journeyFrame>).computer,
    middle: (f) => [(f as unknown as ReturnType<typeof journeyFrame>).hub],
    receivers: (f) => [(f as unknown as ReturnType<typeof journeyFrame>).phone],
  });
  // The count only ever grows, by one, at the moment the page chip reaches the store.
  let last = journeyFrame(0, 0).pages;
  let wasInStore = false;
  for (const { t, round } of samples(JOURNEY_LOOP)) {
    const f = journeyFrame(t, round);
    const inStore = f.chips.some((c) => c.wire === "toStore");
    assert.ok(f.pages === last || (f.pages === last + 1 && wasInStore && !inStore), `at ${t.toFixed(2)}s (round ${round}): ${last} → ${f.pages}`);
    last = f.pages;
    wasInStore = inStore;
  }
  assert.equal(last, journeyFrame(0, 0).pages + 2);
  const still = journeyStill();
  assert.deepEqual([still.phone.kind, still.phone.lock, still.hub.dim], ["plain", "open", false]);
});

test("offline copy: each page's ciphertext rides to Droppen Hub and the phone, and opens there into its line", () => {
  const messages: Message[] = [
    { p: "make it ink", c: OFFLINE_CIPHERS[0] },
    { p: "done, tests pass", c: OFFLINE_CIPHERS[1] },
  ];
  checkStory({
    name: "offline",
    loop: OFFLINE_LOOP,
    starts: OFFLINE_STARTS,
    messages,
    frame: (t) => offlineFrame(t) as never,
    middle: (f) => [(f as unknown as ReturnType<typeof offlineFrame>).hub],
    receivers: (f) => (f as unknown as ReturnType<typeof offlineFrame>).rows,
  });
  const still = offlineStill();
  assert.deepEqual(still.rows.map((r) => [r.kind, r.dim ?? false]), [["plain", false], ["plain", false]]);
});

test("sealing and opening turn one value into the other in place, never through a blank", () => {
  for (const [from, to] of [["sign-in fixed", "5c1e 88d0 a3f7"], ["登录 bug 已修复", "5c1e 88d0 a3f7"], ["2930 bf24 1db9", "テスト全件通過"]] as const) {
    assert.equal(morph(from, to, 0), from);
    assert.equal(morph(from, to, 1), to);
    for (let p = 0.05; p < 1; p += 0.05) {
      const mid = morph(from, to, p, 3);
      assert.ok(mid.trim().length > 0);
      assert.ok([...mid].length <= Math.max([...from].length, [...to].length));
    }
  }
});
