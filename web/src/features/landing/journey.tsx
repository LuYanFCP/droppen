import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { HERO_CIPHERS } from "./hero-a";
import { chipOpacity, ease, place, pointAt, type Pt, setAttr, setText, span, useLoop, useReducedMotion, useSize } from "./motion";
import { CipherChip, InkMark, Ledger, ledgerH, LiveDot, MessageRow, PathTag, Stage, StepBadge, useRowRefs, Wire, WireLock } from "./kit";
import { type Chip, chipLabel, drawRow, type Message, type Shown, textOf } from "./story";

/*
 * "A message's journey": one reply from the agent on your computer to your
 * phone, in four steps that the list beside the diagram follows. The
 * computer seals the reply in place (a padlock, the text turning into its
 * ciphertext); a chip of that ciphertext goes to the Droppen relay, which
 * shows only that ciphertext; Droppen passes it on to the phone and keeps the
 * same ciphertext as a sealed page (their count goes up as it is written), on
 * a wire hanging off Droppen's card — the pages live with Droppen, not on the
 * computer; the phone opens it in place into the same reply. Every wire is
 * straight or one L.
 */

export const JOURNEY_LOOP = 10;
const LOOP = JOURNEY_LOOP;
/** The reply: the hero's "all tests pass", with the same ciphertext. */
export const JOURNEY_CIPHER = HERO_CIPHERS[1];
const J = { seal: [0.5, 1.7], send: [2.4, 3.3], pass: [4.8, 5.7], store: [4.8, 5.6], open: [7.4, 8.6], fade: [8.6, 9.3] } as const;
/** When the reply starts (is sealed): from then on the cards still holding the last one dim until it reaches them. */
export const JOURNEY_STARTS = [J.seal[0]] as const;
/** Sealed pages kept before the first loop. */
const PAGES_BEFORE = 11;

export interface JourneyFrame {
  computer: Shown;
  /** The Droppen relay's card: the ciphertext it passes on. */
  hub: Shown;
  phone: Shown;
  /** Sealed pages kept: one more each time the ciphertext is written. */
  pages: number;
  chips: Chip[];
}

/** What the journey shows at `t` seconds into its loop `round` (0, 1, 2, …). */
/** The still frame (reduced motion): the reply delivered and written, the phone's padlock open beside it. */
export function journeyStill(): JourneyFrame {
  const f = journeyFrame(J.fade[0] + 0.05);
  return { ...f, phone: { ...f.phone, lockOpacity: 1 }, chips: [] };
}

export function journeyFrame(t: number, round = 0): JourneyFrame {
  const between = (a: number, b: number) => t >= a && t < b;
  let computer: Shown = { msg: 0, kind: "plain" };
  if (between(J.seal[0], J.seal[1])) computer = { msg: 0, kind: "seal", p: span(t, J.seal[0], J.seal[1]), lock: "shut", lockOpacity: span(t, J.seal[0], J.seal[0] + 0.15) };
  else if (between(J.seal[1], J.send[0] + 0.25)) computer = { msg: 0, kind: "cipher", lock: "shut" };
  const chips: Chip[] = [];
  if (between(J.send[0], J.send[1])) chips.push({ msg: 0, wire: "toHub", at: ease(span(t, J.send[0], J.send[1])) });
  if (between(J.pass[0], J.pass[1])) chips.push({ msg: 0, wire: "toPhone", at: ease(span(t, J.pass[0], J.pass[1])) });
  if (between(J.store[0], J.store[1])) chips.push({ msg: 0, wire: "toStore", at: ease(span(t, J.store[0], J.store[1])) });
  let phone: Shown = { msg: 0, kind: "plain", dim: between(J.seal[0], J.pass[1]) };
  if (between(J.pass[1], J.open[0])) phone = { msg: 0, kind: "cipher", lock: "shut" };
  else if (between(J.open[0], J.open[1])) phone = { msg: 0, kind: "open", p: span(t, J.open[0], J.open[1]), lock: "open" };
  else if (between(J.fade[0], J.fade[1])) phone = { msg: 0, kind: "plain", lock: "open", lockOpacity: 1 - span(t, J.fade[0], J.fade[1]) };
  return {
    computer,
    hub: { msg: 0, kind: "cipher", dim: between(J.seal[0], J.send[1]) },
    phone,
    pages: PAGES_BEFORE + round + (t >= J.store[1] ? 1 : 0),
    chips,
  };
}
/** When each step starts, in seconds into the loop. */
export const JOURNEY_STEPS = [0, 2.4, 4.8, 7.2] as const;

export function stepAt(time: number): number {
  let step = 0;
  JOURNEY_STEPS.forEach((start, i) => {
    if (time >= start) step = i;
  });
  return step;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  h: number;
  narrow: boolean;
  machine: Box;
  droppen: Box;
  phone: Box;
  store: Box;
  toHub: Pt[];
  toPhone: Pt[];
  toStore: Pt[];
  badges: Pt[];
}

/** Every drawn wire of a journey layout, for the geometry checks. */
export function journeyWires(L: Layout): Pt[][] {
  return [L.toHub, L.toPhone, L.toStore];
}

/** The padlock on the one wire leaving the computer, just outside it: everything past it is ciphertext. */
export function journeyLocks(L: Layout): Pt[] {
  const p = pointAt(L.toHub, 0);
  return [L.narrow ? { x: p.x, y: p.y + 12 } : { x: p.x + 10, y: p.y }];
}

/** A step number sits on a card's top edge, near its right corner. */
const badgeOn = (b: Box): Pt => ({ x: b.x + b.w - 18, y: b.y });

export function journeyLayout(w: number): Layout {
  const pad = 12;
  if (w < 560) {
    // A column: the computer; under it, on the left, the Droppen relay over the phone, and on the right
    // the store, reached out of Droppen's side and down (the sealed pages are kept by Droppen).
    const full = w - 2 * pad;
    const machine = { x: pad, y: 14, w: full, h: ledgerH(1) };
    const phoneW = Math.round(full * 0.56);
    const droppen = { x: pad, y: machine.y + machine.h + 34, w: phoneW, h: ledgerH(1) };
    const phone = { x: pad, y: droppen.y + droppen.h + 34, w: phoneW, h: ledgerH(1) };
    const store = { x: pad + phoneW + 14, y: phone.y, w: full - phoneW - 14, h: ledgerH(1) };
    const trunk = Math.round(pad + phoneW / 2);
    const drop = Math.round(store.x + store.w / 2);
    const side = Math.round(droppen.y + droppen.h / 2);
    return {
      h: phone.y + phone.h + 14,
      narrow: true,
      machine,
      droppen,
      phone,
      store,
      toHub: [{ x: trunk, y: machine.y + machine.h }, { x: trunk, y: droppen.y }],
      toPhone: [{ x: trunk, y: droppen.y + droppen.h }, { x: trunk, y: phone.y }],
      toStore: [{ x: droppen.x + droppen.w, y: side }, { x: drop, y: side }, { x: drop, y: store.y }],
      badges: [badgeOn(machine), badgeOn(droppen), badgeOn(store), badgeOn(phone)],
    };
  }
  // Room between the cards for a packet and a sealed page to travel in.
  const gap = 56;
  const cardW = Math.min(188, Math.floor((w - 2 * pad - 2 * gap) / 3));
  const x0 = Math.round((w - (3 * cardW + 2 * gap)) / 2);
  const top = 30;
  // Three cards of two rows each (a title and the one thing that matters) on one line, the store under the relay.
  const machine = { x: x0, y: top + 12, w: cardW, h: ledgerH(1) };
  const droppen = { x: x0 + cardW + gap, y: top + 12, w: cardW, h: ledgerH(1) };
  const phone = { x: droppen.x + cardW + gap, y: top + 12, w: cardW, h: ledgerH(1) };
  const store = { x: droppen.x, y: droppen.y + droppen.h + 48, w: cardW, h: ledgerH(1) };
  const mid = Math.round(top + 12 + ledgerH(1) / 2);
  const dx = Math.round(droppen.x + cardW / 2);
  return {
    h: store.y + store.h + 30,
    narrow: false,
    machine,
    droppen,
    phone,
    store,
    toHub: [{ x: machine.x + cardW, y: mid }, { x: droppen.x, y: mid }],
    toPhone: [{ x: droppen.x + cardW, y: mid }, { x: phone.x, y: mid }],
    // Straight down out of Droppen into the store: the sealed pages are kept by Droppen, not on the computer.
    toStore: [{ x: dx, y: droppen.y + droppen.h }, { x: dx, y: store.y }],
    badges: [badgeOn(machine), badgeOn(droppen), badgeOn(store), badgeOn(phone)],
  };
}

export function Journey() {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const { w, h: boxH } = useSize(box, 680);
  const L = journeyLayout(w);
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);
  const stepRef = useRef(0);
  const messages: Message[] = [{ p: t("all tests pass"), c: JOURNEY_CIPHER }];
  const titles = { shut: t("encrypted locally"), open: t("decrypted locally") };

  const root = useRef<HTMLDivElement>(null);
  const computer = useRowRefs();
  const hub = useRowRefs();
  const phone = useRowRefs();
  const pageCount = useRef<HTMLSpanElement>(null);
  const chips = useRef<Record<string, SVGGElement | null>>({});

  const draw = (f: JourneyFrame, tick: number) => {
    drawRow(computer, f.computer, messages, tick);
    drawRow(hub, f.hub, messages, tick);
    drawRow(phone, f.phone, messages, tick);
    setText(pageCount.current, String(f.pages));
    const wires: Record<string, Pt[]> = { toHub: L.toHub, toPhone: L.toPhone, toStore: L.toStore };
    for (const wire of Object.keys(wires)) {
      const chip = f.chips.find((c) => c.wire === wire);
      place(chips.current[wire], chip ? pointAt(wires[wire]!, chip.at) : null, chip ? chipOpacity(chip.at) : 0);
    }
  };

  const loop = useLoop(
    box,
    LOOP,
    {
      frame: (time, round) => {
        const s = stepAt(time);
        if (s !== stepRef.current) {
          stepRef.current = s;
          setStep(s);
        }
        setAttr(root.current, "data-step", String(s));
        draw(journeyFrame(time, round), Math.floor(time * 14));
      },
      still: () => {
        // Every step at once, numbered where it happens: the reply delivered, its padlock open on the phone.
        setAttr(root.current, "data-step", "all");
        draw(journeyStill(), 0);
      },
    },
    reduced,
    [w, t],
  );
  const first = reduced ? journeyStill() : journeyFrame(0);

  const steps = [
    { title: t("Locked before it leaves your computer"), body: t("The agent encrypts every message on your computer. The keys exist only on your computers and on the devices you approved.") },
    { title: t("All we see is noise"), body: t("The Droppen relay carrying it knows that about 1 KB went to one of your devices at 14:02. Not what it says, not the session's name, its folder or the model.") },
    { title: t("Delivered, with an encrypted copy kept"), body: t("The Droppen relay passes it on to your device. The agent also leaves an encrypted copy with Droppen Hub, so you can still read the session when your computer is off.") },
    { title: t("Opened only in your hand"), body: t("Your phone or browser decrypts it on the spot, with keys made in that browser that stay in it.") },
  ];
  const n = L.narrow;

  return (
    <div ref={root} data-step="0" className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.55fr)]">
      <ol className="flex flex-col border-border max-lg:order-2 max-lg:border-t lg:border-r">
        {steps.map((s, i) => {
          const current = !reduced && step === i;
          return (
            <li key={i} className="border-b border-border last:border-b-0">
              <button
                type="button"
                aria-current={current ? "step" : undefined}
                onClick={() => {
                  loop.seek(JOURNEY_STEPS[i]! + 0.01);
                }}
                disabled={reduced}
                className={cn(
                  "flex w-full gap-3 px-6 py-4 text-left max-md:px-4 disabled:cursor-default",
                  current ? "bg-raised" : "hover:bg-hover disabled:hover:bg-transparent",
                )}
              >
                <span
                  className={cn(
                    "mt-px flex size-[18px] shrink-0 items-center justify-center border font-mono text-[10px] font-medium tabular-nums",
                    current || reduced ? "border-fg bg-fg text-bg" : "border-border-strong text-muted",
                  )}
                >
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span className={cn("text-[13px] leading-5 font-semibold", current || reduced ? "text-fg" : "text-muted")}>{s.title}</span>
                  <span className="text-xs leading-5 text-muted">{s.body}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <Stage
        name="journey"
        ref={box}
        width={w}
        height={Math.max(boxH, L.h)}
        drawn={L.h}
        className="h-full"
        still={reduced}
        svg={
          <>
            <Wire points={L.toHub} />
            <Wire points={L.toPhone} />
            <Wire points={L.toStore} />
            {journeyLocks(L).map((at, i) => (
              <WireLock key={i} at={at} title={titles.shut} />
            ))}
          </>
        }
        over={(["toHub", "toPhone", "toStore"] as const).map((wire) => (
          <CipherChip key={wire} ref={(el) => void (chips.current[wire] = el)} label={chipLabel(JOURNEY_CIPHER)} />
        ))}
      >
        <Ledger
          box={L.machine}
          head={
            <>
              {t("your computer")}
            </>
          }
          status={<LiveDot />}
          rows={[
            <MessageRow key="m" refs={computer} titles={titles}>
              {textOf(first.computer, messages)}
            </MessageRow>,
          ]}
        />
        <Ledger
          box={L.droppen}
          ink
          head={
            <>
              <InkMark size={14} />
              {t("Droppen relay")}
            </>
          }
          rows={[
            <MessageRow key="c" refs={hub} lock={false} className="text-[13px] font-medium tabular-nums">
              {textOf(first.hub, messages)}
            </MessageRow>,
          ]}
        />
        <Ledger
          box={L.store}
          head={
            <>
              {t("encrypted copy")}
            </>
          }
          status={
            n ? undefined : (
              <span ref={pageCount} className="text-muted tabular-nums">
                {first.pages}
              </span>
            )
          }
          rows={[
            <span key="r" className="text-fg">
              {t("readable offline")}
            </span>,
          ]}
        />
        <Ledger
          box={L.phone}
          head={
            <>
              {t("your phone")}
            </>
          }
          status={<PathTag ms={220} label={t("relay")} />}
          rows={[
            <MessageRow key="m" refs={phone} titles={titles}>
              {textOf(first.phone, messages)}
            </MessageRow>,
          ]}
        />
        {reduced && L.badges.map((at, i) => <StepBadge key={i} n={i + 1} at={at} />)}
      </Stage>
    </div>
  );
}
