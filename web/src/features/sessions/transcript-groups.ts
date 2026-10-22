import type { components } from "@/api/schema";

type TranscriptItem = components["schemas"]["TranscriptItem"];

export type Chunk =
  | { kind: "item"; item: TranscriptItem; index: number }
  | { kind: "group"; items: TranscriptItem[]; index: number };

/**
 * How an item takes part in a folded run of work.
 *
 * `transparent` is the class this file exists for. The CLI writes bookkeeping
 * lines into the middle of a long tool run — a finished background task's `⏱`
 * notice above all — and a rule that treats every line it does not recognise as
 * a boundary let one of those cut a twelve-step run into a five and a six, both
 * under the fold threshold, so a run that should have been one collapsed line
 * rendered fully expanded twice over. A transparent line rides *inside* the run,
 * keeps its position (so it is still there when the fold is opened), and neither
 * counts towards the threshold nor separates the steps on either side of it.
 *
 * A `tool_result` is transparent for the same accounting reason: it is the
 * answer to a step, not a step, and the summary line has always said so. Having
 * the threshold count it while the summary did not is how a group could fold
 * itself and then announce "3 steps".
 */
export type FoldClass = "step" | "transparent" | "break";

/**
 * Which class an item belongs to.
 *
 * Exported because the group's own summary must count with exactly this rule:
 * two opinions about what a step is are what put "⚙ 3 steps" on a fold that
 * only happened because five *items* were counted.
 */
export function foldClassOf(item: TranscriptItem): FoldClass {
  // Every result, answered before `agent` and `background` are looked at.
  //
  // A result is the answer to a step and never a step itself, and it is never a
  // boundary either: the call that made it renders it (see `pairToolResults`),
  // so the row it leaves behind is empty, and an empty boundary would cut a run
  // in half around nothing. That now includes a *subagent's* result, which the
  // server stamps with the same `agent` id as its call — read as a drill-down
  // it would have been exactly such a boundary.
  if (item.kind === "tool_result") return "transparent";
  // Subagent drill-downs draw their own card and must stay clickable.
  if (item.agent) return "break";
  // The `⏱ background task finished` notice and anything else the CLI files as
  // background chatter: real news when read, invisible to the run structure.
  if (item.role === "system" && item.kind === "text" && item.background) return "transparent";
  // A background launch lands out of order among the steps.
  if (item.background) return "break";
  if (item.kind === "tool_use") {
    return item.toolName === "AskUserQuestion" ? "break" : "step"; // questions must stay visible
  }
  if (item.kind === "thinking") return "step";
  return "break";
}

/** How many steps a window of items would report — `tool_use` and `thinking`. */
export function countSteps(items: readonly TranscriptItem[]): number {
  let steps = 0;
  for (const item of items) if (foldClassOf(item) === "step") steps++;
  return steps;
}

/**
 * How many visible steps a run needs before it is worth folding.
 *
 * Counted in steps, not in items, which is the same threshold the old
 * five-*item* rule reached for an ordinary call/result run (three calls and two
 * results) and a stricter one for everything else. The number the fold is
 * decided on is now the number it prints.
 */
const GROUP_MIN = 3;

/**
 * While the agent is working, the newest tool call (and whatever follows it)
 * must not disappear into the fold — it is the "currently executing" line.
 * Returns the index to keep visible from, or -1 when nothing qualifies.
 */
function liveTailCut(items: TranscriptItem[]): number {
  let lastUse = -1;
  for (let i = items.length - 1; i >= 0 && foldClassOf(items[i]!) !== "break"; i--) {
    if (items[i]!.kind === "tool_use") {
      lastUse = i;
      break; // the run continues left of here, but this is the newest call
    }
  }
  return lastUse;
}

/**
 * Which model wrote an item, or `null` when the transcript does not say.
 *
 * The field exists because both CLIs downgrade in silence: an answer arrives
 * from a smaller model, reads worse, and the only record of why is the id the
 * entry was written with.
 *
 * A `synthetic` item counts as unknown however it is stamped. The CLI wrote
 * that sentence itself in the model's voice — naming a model on it would credit
 * one with words it never said, which is the confusion `synthetic` exists to
 * undo.
 */
export function modelOf(item: TranscriptItem): string | null {
  if (item.synthetic) return null;
  const model = item.model?.trim();
  return model ? model : null;
}

/** The model a run of items is on: the first one any of them names. */
export function runModelOf(items: readonly TranscriptItem[]): string | null {
  for (const item of items) {
    const model = modelOf(item);
    if (model !== null) return model;
  }
  return null;
}

/**
 * Whether a run already on `runModel` must end before an item on `model`.
 *
 * Every merge in this file puts one header over several items, and a header
 * names a model — so a run may only ever hold one. A mid-turn downgrade ends
 * the run and the next model opens a fresh one with its own header, which is
 * the whole point: the reader sees where the answers started coming from
 * somewhere else instead of reading one bubble credited to two models.
 *
 * An item the transcript says nothing about never splits anything by itself:
 * tool results and the CLI's own bookkeeping lines carry no model, and letting
 * them break a run would cut it in half around nothing (the same reasoning as
 * `transparent` in [`foldClassOf`]). It rides along and leaves `runModel`
 * alone. A *known* model after a run of those does split, because until it
 * arrived the run's header said nothing and from here on it says something.
 */
export function modelRunBreaks(runModel: string | null, model: string | null): boolean {
  if (model === null) return false;
  return runModel !== model;
}

export function chunkItems(items: TranscriptItem[], liveTail = false): Chunk[] {
  const cut = liveTail ? liveTailCut(items) : -1;
  const out: Chunk[] = [];
  let run: { item: TranscriptItem; index: number }[] = [];
  let steps = 0;
  /** The one model the open run is allowed to hold — see [`modelRunBreaks`]. */
  let runModel: string | null = null;
  const flush = () => {
    if (steps >= GROUP_MIN) {
      out.push({ kind: "group", items: run.map((r) => r.item), index: run[0]!.index });
    } else {
      for (const r of run) out.push({ kind: "item", item: r.item, index: r.index });
    }
    run = [];
    steps = 0;
    runModel = null;
  };
  items.forEach((item, index) => {
    const cls = foldClassOf(item);
    if (cls === "break" || (cut >= 0 && index >= cut)) {
      flush();
      out.push({ kind: "item", item, index });
      return;
    }
    const model = modelOf(item);
    // One fold, one summary line, one model.
    if (run.length > 0 && modelRunBreaks(runModel, model)) flush();
    run.push({ item, index });
    if (runModel === null) runModel = model;
    if (cls === "step") steps++;
  });
  flush();
  return out;
}

export interface ToolPairing {
  /** The result item answering each `tool_use` id present in this window. */
  resultFor: Map<string, TranscriptItem>;
  /**
   * Results whose call is in this same window, so the call's card renders them
   * and the standalone row must not. A result whose call scrolled out of the
   * loaded window is absent here and keeps rendering on its own.
   */
  consumed: Set<TranscriptItem>;
  /**
   * How a background task ended, keyed by the `tool_use` that launched it.
   *
   * Read off the `⏱` notification's `taskStatus`, which is the only place the
   * outcome of an *async* child is written down: the launching call was
   * answered by a receipt seconds after it went out, so its own result says
   * nothing about how the work went. This is what puts a ✓, ✗ or ⊘ on the card.
   */
  taskStatusFor: Map<string, string>;
  /**
   * Notifications whose launching call is a subagent card in this same window.
   *
   * The `⏱` line is news wherever it lands, but when the card that started the
   * task is on screen the card is already wearing the outcome — so the notice
   * stops shouting and reads as the receipt it is. A notice whose call scrolled
   * out of the window (or that the CLI wrote with no `tool-use-id` at all) is
   * absent here and keeps its full colour, because then it is the only place
   * the news appears.
   *
   * Deliberately only the calls that draw a card. A `run_in_background` Bash is
   * an ordinary tool row and has nowhere to put a ✓, so quieting its notice
   * would take the news off the screen and put it nowhere.
   */
  noticeJoined: Set<TranscriptItem>;
}

export const EMPTY_PAIRING: ToolPairing = {
  resultFor: new Map(),
  consumed: new Set(),
  taskStatusFor: new Map(),
  noticeJoined: new Set(),
};

/**
 * Match `tool_result` items to the `tool_use` they answer, and `⏱` task
 * notifications to the call that launched the task.
 *
 * Every item stays in the array — dropping one would shift every later index
 * and invalidate the paging window the client holds — so the pairing is
 * expressed as identity sets the renderer consults instead.
 */
export function pairToolResults(items: TranscriptItem[]): ToolPairing {
  const uses = new Set<string>();
  /** The subset of `uses` that draws a subagent card — see `noticeJoined`. */
  const cards = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool_use" || !item.toolUseId) continue;
    // A question card draws its own body, so its result is not absorbed and
    // keeps rendering where it is.
    //
    // A subagent's result used to be excluded here for the same reason, and is
    // not any more — a deliberate change. The server now stamps the result with
    // the launching call's `agent`, so it arrives as its own top-level row: a
    // second line saying "the subagent answered" directly under the card that
    // is already showing the subagent's outcome. The card absorbs it and folds
    // it, which is where a terminal receipt belongs.
    if (item.toolName === "AskUserQuestion") continue;
    uses.add(item.toolUseId);
    if (item.agent) cards.add(item.toolUseId);
  }
  const resultFor = new Map<string, TranscriptItem>();
  const consumed = new Set<TranscriptItem>();
  const taskStatusFor = new Map<string, string>();
  const noticeJoined = new Set<TranscriptItem>();
  for (const item of items) {
    if (item.kind === "tool_result" && item.resultOf) {
      // A retried call can answer the same id twice; the first result is the
      // one that sits next to the call, so it wins.
      if (!resultFor.has(item.resultOf)) resultFor.set(item.resultOf, item);
      if (uses.has(item.resultOf)) consumed.add(item);
      continue;
    }
    const launcher = item.taskToolUseId;
    if (!launcher) continue;
    // The last word wins: a task can be reported on more than once, and the
    // newest report is the one that describes how it actually ended.
    if (item.taskStatus) taskStatusFor.set(launcher, item.taskStatus);
    if (cards.has(launcher)) noticeJoined.add(item);
  }
  return { resultFor, consumed, taskStatusFor, noticeJoined };
}

export type BubbleRole = "assistant" | "user" | "system";

/** Which side of the conversation a chunk belongs to, for bubble grouping. */
export function bubbleRoleOf(chunk: Chunk): BubbleRole {
  if (chunk.kind === "group") return "assistant"; // a folded run of tool/thinking steps is agent work
  const item = chunk.item;
  // tool_result carries role "user" but is agent activity, so key on kind first.
  if (item.kind === "tool_use" || item.kind === "tool_result" || item.kind === "thinking") return "assistant";
  if (item.role === "system") return "system";
  return item.role === "user" ? "user" : "assistant";
}

/** The model a chunk is on — a group holds only one, by construction. */
function chunkModelOf(chunk: Chunk): string | null {
  return chunk.kind === "group" ? runModelOf(chunk.items) : modelOf(chunk.item);
}

/** One bubble: whose turn it is, which model wrote it, and what it holds. */
export interface BubbleRunOf {
  role: BubbleRole;
  /** `null` when the transcript never said — then the header wears no id. */
  model: string | null;
  chunks: Chunk[];
}

/**
 * Fold consecutive chunks from the same side into one bubble, so a turn that
 * reads "text → tool calls → more text" stays a single bubble instead of being
 * split into one bubble per text block.
 *
 * Except across a model change: the bubble's header names one model, so a turn
 * that was downgraded halfway through becomes two bubbles, each headed by the
 * model that actually wrote it. See [`modelRunBreaks`].
 */
export function bubbleRuns(chunks: Chunk[]): BubbleRunOf[] {
  const runs: BubbleRunOf[] = [];
  for (const chunk of chunks) {
    const role = bubbleRoleOf(chunk);
    const model = chunkModelOf(chunk);
    const last = runs[runs.length - 1];
    // System lines (slash commands, notifications) belong to neither party.
    if (last && last.role === role && role !== "system" && !modelRunBreaks(last.model, model)) {
      last.chunks.push(chunk);
    } else runs.push({ role, model, chunks: [chunk] });
  }
  return runs;
}

/** The turn's time, taken from the first item that carries one. */
export function firstTimestamp(chunks: Chunk[]): string | null {
  for (const chunk of chunks) {
    for (const item of chunk.kind === "group" ? chunk.items : [chunk.item]) {
      if (item.timestamp) return item.timestamp;
    }
  }
  return null;
}

