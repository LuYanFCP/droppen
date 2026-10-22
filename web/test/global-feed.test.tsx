// What the global feed makes each consumer re-render for.
//
// The feed used to be a `useState` object published as a context value, and a
// changed context value re-renders every consumer of that context whatever
// `React.memo` says — so a `sessions:delta` for any session on the machine
// re-rendered all ten consumers, including every mounted transcript. It is now
// an external store read through `useSyncExternalStore`, and the contract that
// buys the narrowing is exact and small: **React re-renders a subscriber if and
// only if its selector returns a value that is not `Object.is`-equal to the one
// it last returned.** So the tests that matter here run the selectors against
// the store the way React would and assert on that comparison; there is no
// headless browser in this repo, so an actual client re-render cannot be
// counted, and asserting on the thing the count is decided by is the honest
// substitute.
//
// The `react-dom/server` pass at the bottom is the other half: it proves the
// hooks really are wired to the store on the context rather than to a snapshot
// of their own, so the selectors under test are the ones the app runs.
//
// `import * as React` because the test directory is outside the tsconfig's
// `include`, so tsx compiles JSX here with the classic runtime.
import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { components } from "../src/api/schema.js";
import {
  createGlobalFeedStore,
  feedRow,
  GlobalFeedContext,
  GlobalFeedProvider,
  useGlobalFeedSelector,
  useFeedConnected,
  useFeedSessions,
  useFeedSessionTitle,
  useFeedSettings,
  type GlobalFeedState,
  type GlobalFeedStore,
  type ServerInfo,
} from "../src/app/global-feed.js";
import { LOCAL } from "../src/lib/machines/key.js";
import { MachineProvider } from "../src/lib/machines/context.js";

type SessionSummary = components["schemas"]["SessionSummary"];

function session(over: Partial<SessionSummary> & Pick<SessionSummary, "id">): SessionSummary {
  return {
    accountId: null,
    attentionAt: null,
    createdAt: "2024-05-01T10:00:00.000Z",
    cwd: "/Users/k/Projects/app",
    filePath: `/root/${over.id}.jsonl`,
    gitBranch: null,
    repoKey: null,
    scope: "owned",
    sizeBytes: 10,
    source: "claude",
    status: "idle",
    title: `session ${over.id}`,
    unread: false,
    updatedAt: "2024-05-01T10:00:00.000Z",
    ...over,
  } as SessionSummary;
}

const SETTINGS = {
  hostname: "kbox",
  platform: "darwin",
  nodeVersion: "22.0.0",
  homeDir: "/Users/k",
  claudeDir: "/Users/k/.claude",
  codexDir: "/Users/k/.codex",
  serverStartedAt: "2024-05-01T09:00:00.000Z",
} satisfies ServerInfo;

/**
 * A consumer, modelled exactly as `useSyncExternalStore` models one: it holds
 * the last value its selector returned and counts the times that value changed,
 * which is the number of renders React would have performed.
 */
function consumer<T>(store: GlobalFeedStore, select: (state: GlobalFeedState) => T) {
  let last = select(store.getSnapshot());
  const seen = { renders: 0, value: last };
  store.subscribe(() => {
    const next = select(store.getSnapshot());
    if (Object.is(next, last)) return;
    last = next;
    seen.renders += 1;
    seen.value = next;
  });
  return seen;
}

test("a patch that changes nothing wakes nobody", () => {
  const store = createGlobalFeedStore(LOCAL);
  let notifications = 0;
  store.subscribe(() => {
    notifications += 1;
  });

  store.publish({ connected: false });
  assert.equal(notifications, 0, "the socket was already down");
  store.publish({ connected: true });
  assert.equal(notifications, 1);
  store.publish({ connected: true });
  assert.equal(notifications, 1, "a repeat of the same state is not news");
  // A failing reconnect publishes `connected: false` every few seconds for as
  // long as the server is down; none of those may cost the app a render.
  store.publish({ connected: false });
  store.publish({ connected: false });
  store.publish({ connected: false });
  assert.equal(notifications, 2);
});

test("unsubscribing during a notification does not skip the next listener", () => {
  const store = createGlobalFeedStore(LOCAL);
  const ran: string[] = [];
  const off = store.subscribe(() => {
    ran.push("first");
    off();
  });
  store.subscribe(() => ran.push("second"));

  store.publish({ connected: true });
  assert.deepEqual(ran, ["first", "second"]);
});

// The fix, stated as the thing it prevents: one session working must not
// re-render the panes of the sessions that are not.
test("a delta for one session does not re-render the readers of another", () => {
  const idle = session({ id: "idle" });
  const live = session({ id: "live", title: "live one" });
  const store = createGlobalFeedStore(LOCAL, {
    connected: true,
    settings: SETTINGS,
    sessions: [live, idle],
  });

  const idleTitle = consumer(store, (s) => feedRow(s, { machine: LOCAL, source: "claude", id: "idle" })?.title);
  const liveTitle = consumer(store, (s) => feedRow(s, { machine: LOCAL, source: "claude", id: "live" })?.title);
  const connected = consumer(store, (s) => s.connected);
  const settings = consumer(store, (s) => s.settings);
  const list = consumer(store, (s) => s.sessions);

  // Ten deltas of the kind a working session produces: a new `updatedAt` on its
  // own row and nothing else. The array is rebuilt each time, as the real
  // provider rebuilds it.
  for (let i = 0; i < 10; i++) {
    store.publish({
      sessions: [{ ...live, updatedAt: `2024-05-01T10:00:0${i}.000Z` }, idle],
    });
  }

  assert.equal(idleTitle.renders, 0, "the idle pane never re-rendered");
  assert.equal(liveTitle.renders, 0, "nor did the live pane: its title did not move");
  assert.equal(connected.renders, 0);
  assert.equal(settings.renders, 0);
  // The session list is the one consumer that has to see every delta, because
  // the rows it draws are what changed.
  assert.equal(list.renders, 10);
});

test("a rename reaches the transcript that is showing the old title", () => {
  const live = session({ id: "live", title: "old name" });
  const store = createGlobalFeedStore(LOCAL, { connected: true, settings: null, sessions: [live] });
  const title = consumer(store, (s) => feedRow(s, { machine: LOCAL, source: "claude", id: "live" })?.title);

  store.publish({ sessions: [{ ...live, title: "new name" }] });
  assert.equal(title.renders, 1);
  assert.equal(title.value, "new name");
});

test("a reconnect wakes the health dot and nothing else", () => {
  const only = session({ id: "one" });
  const store = createGlobalFeedStore(LOCAL, { connected: false, settings: null, sessions: [only] });
  const connected = consumer(store, (s) => s.connected);
  const title = consumer(store, (s) => feedRow(s, { machine: LOCAL, source: "claude", id: "one" })?.title);
  const list = consumer(store, (s) => s.sessions);

  store.publish({ connected: true });
  assert.equal(connected.renders, 1);
  assert.equal(title.renders, 0);
  assert.equal(list.renders, 0, "the sessions array was not replaced");
});

// The wiring: each hook must read the store off the context, or every assertion
// above would be about functions the app does not call.
function Probe({ source, id }: { source: string; id: string }) {
  const connected = useFeedConnected();
  const settings = useFeedSettings();
  const sessions = useFeedSessions();
  const title = useFeedSessionTitle(React.useMemo(() => ({ machine: LOCAL, source, id }), [source, id]));
  return (
    <ul>
      <li>{String(connected)}</li>
      <li>{settings?.hostname ?? "—"}</li>
      <li>{String(sessions?.length ?? 0)}</li>
      <li>{title ?? "—"}</li>
    </ul>
  );
}

test("the hooks read the store handed down the context", () => {
  const store = createGlobalFeedStore(LOCAL, {
    connected: true,
    settings: SETTINGS,
    sessions: [session({ id: "a" }), session({ id: "b", title: "the second" })],
  });

  const html = renderToStaticMarkup(
    <GlobalFeedContext.Provider value={store}>
      <Probe source="claude" id="b" />
    </GlobalFeedContext.Provider>,
  );
  assert.equal(html, "<ul><li>true</li><li>kbox</li><li>2</li><li>the second</li></ul>");
});

test("a tree with no provider reads an empty feed instead of throwing", () => {
  const html = renderToStaticMarkup(<Probe source="claude" id="b" />);
  assert.equal(html, "<ul><li>false</li><li>—</li><li>0</li><li>—</li></ul>");
});

// A session being watched while it works must not flash a count on every
// answer for the length of the seen round trip: while somebody is reading it,
// every consumer sees it read.
test("a session being read reads as read everywhere, and only while it is", () => {
  const store = createGlobalFeedStore(LOCAL);
  const quiet = session({ id: "quiet" });
  const busy = session({ id: "busy", unread: true, unreadCount: 2 } as Partial<SessionSummary> & { id: string });
  store.publish({ sessions: [busy, quiet] });
  const sessions = consumer(store, (state) => state.sessions);
  const quietRow = consumer(store, (state) => feedRow(state, { machine: LOCAL, source: "claude", id: "quiet" }));

  const stop = store.markReading({ machine: LOCAL, source: "claude", id: "busy" });
  const read = feedRow(store.getSnapshot(), { machine: LOCAL, source: "claude", id: "busy" })!;
  assert.equal(read.unreadCount, 0);
  assert.equal(read.unread, false);
  assert.equal(quietRow.renders, 0, "a row nobody is reading keeps its identity");

  // A second reader (the same session in another pane) outlives the first.
  const again = store.markReading({ machine: LOCAL, source: "claude", id: "busy" });
  stop();
  assert.equal(feedRow(store.getSnapshot(), { machine: LOCAL, source: "claude", id: "busy" })!.unreadCount, 0);

  // A reconnect touches neither the rows nor the readers: nobody re-renders.
  const before = sessions.renders;
  store.publish({ connected: true });
  assert.equal(sessions.renders, before);

  // The server's next delta still applies underneath the local read.
  const more = session({ id: "busy", unread: true, unreadCount: 3 } as Partial<SessionSummary> & { id: string });
  store.publish({ sessions: [more, quiet] });
  assert.equal(feedRow(store.getSnapshot(), { machine: LOCAL, source: "claude", id: "busy" })!.unreadCount, 0);

  again();
  assert.equal(feedRow(store.getSnapshot(), { machine: LOCAL, source: "claude", id: "busy" }), more, "the reader gone, the server's row is back as it is");
});

// One feed per machine, and a session is its machine's: the same `source/id`
// on another device is another session, read or not on its own.
test("a feed is one machine's: rows and readers of another machine's session do not reach it", () => {
  const here = createGlobalFeedStore(LOCAL);
  const there = createGlobalFeedStore("m-other");
  const busy = session({ id: "busy", unread: true, unreadCount: 2 } as Partial<SessionSummary> & { id: string });
  here.publish({ sessions: [busy] });
  there.publish({ sessions: [busy] });
  assert.equal(here.getSnapshot().machine, LOCAL);
  assert.equal(there.getSnapshot().machine, "m-other");

  assert.equal(feedRow(here.getSnapshot(), { machine: "m-other", source: "claude", id: "busy" }), undefined, "another machine's ref finds nothing here");
  const stop = there.markReading({ machine: "m-other", source: "claude", id: "busy" });
  const ignored = here.markReading({ machine: "m-other", source: "claude", id: "busy" });
  assert.equal(feedRow(there.getSnapshot(), { machine: "m-other", source: "claude", id: "busy" })!.unreadCount, 0);
  assert.equal(feedRow(here.getSnapshot(), { machine: LOCAL, source: "claude", id: "busy" })!.unreadCount, 2, "reading it there leaves it unread here");
  stop();
  ignored();
});

const selectMachine = (state: GlobalFeedState) => state.machine;
function WhoseFeed() {
  return <b>{useGlobalFeedSelector(selectMachine)}</b>;
}

test("a feed provider's store is its own machine's, whichever machine its tree is about", () => {
  for (const machine of ["m-a", "m-b"]) {
    const html = renderToStaticMarkup(
      <MachineProvider machine={machine}>
        <GlobalFeedProvider>
          <WhoseFeed />
        </GlobalFeedProvider>
      </MachineProvider>,
    );
    assert.equal(html, `<b>${machine}</b>`);
  }
});
