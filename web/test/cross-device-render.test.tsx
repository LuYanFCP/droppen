// The cross-device wiring mounted for real (`docs/local-aggregator.md` §6.5,
// §6.7 M-2): React renders into a stand-in DOM (`fake-dom.ts`), effects run,
// and what is pinned is what a person would see and what the shell is told —
// a pane of a device the page does not have, holds as panes mount, change
// and go, the list feed a view of another device starts, and the
// `/m/<machine>` route's redirect and refusal.
//
// `import * as React` because the test directory is outside the tsconfig's
// `include`, so tsx compiles JSX here with the classic runtime.
import * as React from "react";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { register } from "node:module";
import { installFakeDom, type FakeNode } from "./fake-dom.js";

// The build's plugin list (`virtual:droppen/bundled-plugins`, made by Vite):
// the open distribution's, none, for the panes' plugin code to import.
const bundled = `data:text/javascript,${encodeURIComponent('export const distribution = "public"; export const bundledPlugins = [];')}`;
register(
  `data:text/javascript,${encodeURIComponent(
    `export async function resolve(specifier, context, next) { return specifier === "virtual:droppen/bundled-plugins" ? { url: ${JSON.stringify(bundled)}, shortCircuit: true } : next(specifier, context); }`,
  )}`,
);

const container = installFakeDom();
// Query caches, feeds and React's scheduler keep timers this file does not own: once every test has run, go.
after(() => void setTimeout(() => process.exit(), 50));
const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// After the stand-in DOM: React and the app's modules read it as they load.
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const router = await import("@tanstack/react-router");
const { PaneLeafContent } = await import("../src/app/secondary-pane.js");
const { PaneTreeView, RoutedViewBoundary, usePaneTreeMixed } = await import("../src/app/pane-tree-view.js");
const { PreferencesSection } = await import("../src/features/settings/settings-view.js");
const { paneTreeApi } = await import("../src/app/pane-tree.js");
const { GlobalFeedProvider, machineFeedFor } = await import("../src/app/global-feed.js");
const { MachineRoute, MachineView } = await import("../src/app/machine-route.js");
const { MachineProvider, useMachine } = await import("../src/lib/machines/context.js");
const { LOCAL } = await import("../src/lib/machines/key.js");
const registry = await import("../src/lib/machines/registry.js");
const { constantStore } = await import("../src/lib/machines/store.js");
type PaneContent = import("../src/app/pane-tree.js").PaneContent;
type Transport = import("../src/lib/transport/index.js").Transport;

/** A transport whose requests never answer (a view waits; nothing is sent anywhere) and whose sockets never open. */
const silent: Transport = {
  fetch: () => new Promise(() => undefined),
  socketUrl: async (path) => path,
  openSocket: () => ({ readyState: 0, binaryType: "blob", send() {}, close() {}, onopen: null, onmessage: null, onclose: null }),
};

/** Open `key` with a driver that counts what holds it. */
function openCounted(key: string, name = key) {
  const counted = { holds: 0, live: 0 };
  registry.openMachine(key, silent, {
    info: constantStore({ key, name, state: "online" as const, since: 0, canManage: true, live: "copy" as const }),
    ensureLive: () => void counted.live++,
    hold: () => {
      counted.holds++;
      return () => void counted.holds--;
    },
    dispose: () => undefined,
  });
  return counted;
}

function reset() {
  registry.setShell("local", LOCAL);
  for (const key of registry.openMachines()) if (key !== LOCAL) registry.closeMachine(key);
}

/** Render `node` into the stand-in page; returns the root and what it drew, as text. */
function mount(node: React.ReactNode) {
  const errors: unknown[] = [];
  const root = createRoot(container as never, {
    onUncaughtError: (error) => void errors.push(error),
    onCaughtError: (error) => void errors.push(error),
  });
  root.render(node);
  return { root, errors, text: () => (container as FakeNode).textContent };
}

/** What a pane's content needs around it on the page: a query cache, and a router for its links. */
function withQueries(node: React.ReactNode) {
  const links = router.createRouter({ routeTree: router.createRootRoute(), history: router.createMemoryHistory() });
  return (
    <router.RouterContextProvider router={links}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
    </router.RouterContextProvider>
  );
}

const noop = () => undefined;

test("B1a: the local page reading a screen arranged on droppen.app shows another device's pane as such, and does not crash", async (t) => {
  reset();
  t.after(reset);
  const content: PaneContent = { kind: "session", source: "claude", id: "s-1", machine: "d-elsewhere" };
  const { root, errors, text } = mount(withQueries(<PaneLeafContent content={content} onChange={noop} onClose={noop} />));
  t.after(() => root.unmount());
  await flush();
  assert.deepEqual(errors, [], "nothing thrown");
  assert.match(text(), /this device is not on this page/);
  assert.match(text(), /Open this screen on droppen\.app/, "the local page says where to see it");
  assert.match(text(), /d-elsewhere/, "and which device it is");
  assert.equal((container as FakeNode).findAll("data-pane-missing-device").length, 1);
});

test("B1b: a device leaving droppen.app while a pane shows it turns the pane into a not-on-this-page one, not a crash", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  openCounted("m-b", "studio");
  registry.setShell("hub", "m-a");
  const content: PaneContent = { kind: "chat", chatKind: "api", id: "c-1", machine: "m-b" };
  const { root, errors, text } = mount(withQueries(<PaneLeafContent content={content} onChange={noop} onClose={noop} />));
  t.after(() => root.unmount());
  await flush();
  assert.doesNotMatch(text(), /not on this page/, "on the page: its content");
  registry.closeMachine("m-b");
  await flush();
  assert.deepEqual(errors, [], "nothing thrown");
  assert.match(text(), /this device is not on this page/);
  assert.match(text(), /removed from the account/, "droppen.app says why it may be gone");
});

test("B1c: a picker naming a device gone from the page picks from the routed view's device instead", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  openCounted("m-b", "studio");
  registry.setShell("hub", "m-a");
  const content: PaneContent = { kind: "picker", machine: "m-gone" };
  const { root, errors } = mount(withQueries(<PaneLeafContent content={content} onChange={noop} onClose={noop} defaultMachine="m-b" />));
  t.after(() => root.unmount());
  await flush();
  assert.deepEqual(errors, []);
  const trigger = (container as FakeNode).findAll("data-testid").find((n) => n.getAttribute("data-testid") === "device-picker");
  assert.ok(trigger, "the device picker is there");
  assert.equal(trigger.textContent.trim(), "studio", "on the routed view's device, not the gone one");
});

test("a pane whose content fails to draw keeps the failure to itself", async (t) => {
  reset();
  t.after(reset);
  function Broken(): React.ReactNode {
    throw new Error("drawing failed");
  }
  let state = {
    root: {
      type: "split" as const,
      id: "s",
      direction: "row" as const,
      ratio: 0.5,
      children: [
        { type: "leaf" as const, id: "ok", content: { kind: "files" } as PaneContent },
        { type: "leaf" as const, id: "bad", content: { kind: "terminal", id: "t" } as PaneContent },
      ] as [never, never],
    },
    focusedId: "ok",
  };
  const actions: string[] = [];
  const api = paneTreeApi(state, (action) => void actions.push(action.type));
  const { root, text } = mount(
    <PaneTreeView api={api} renderLeaf={(leaf) => (leaf.id === "bad" ? <Broken /> : <span>the other pane</span>)} />,
  );
  t.after(() => root.unmount());
  await flush();
  assert.match(text(), /the other pane/, "the rest of the page draws");
  assert.match(text(), /this pane could not be drawn/);
  assert.equal((container as FakeNode).findAll("data-pane-failed").length, 1);
  state = { ...state };
});

test("holds follow what is mounted: a device's view holds it on mount, lets go on unmount, and moves with its content", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  const b = openCounted("m-b");
  const c = openCounted("m-c");
  registry.setShell("hub", "m-a");
  const Probe = () => <span>{useMachine()}</span>;
  const { root, text } = mount(
    <MachineProvider machine="m-a">
      <MachineView machine="m-b" hold>
        <Probe />
      </MachineView>
    </MachineProvider>,
  );
  await flush();
  assert.equal(text(), "m-b", "the view is about its device");
  assert.equal(b.holds, 1, "held while mounted");
  root.render(
    <MachineProvider machine="m-a">
      <MachineView machine="m-c" hold>
        <Probe />
      </MachineView>
    </MachineProvider>,
  );
  await flush();
  assert.deepEqual([b.holds, c.holds], [0, 1], "content moved to another device: the hold moves with it");
  root.render(
    <MachineProvider machine="m-a">
      <MachineView machine="m-c">
        <Probe />
      </MachineView>
    </MachineProvider>,
  );
  await flush();
  assert.equal(c.holds, 0, "a view that does not use its device (a picker) holds nothing");
  root.render(
    <MachineProvider machine="m-a">
      <MachineView machine="m-b" hold>
        <Probe />
      </MachineView>
    </MachineProvider>,
  );
  await flush();
  assert.equal(b.holds, 1);
  root.unmount();
  await flush();
  assert.deepEqual([b.holds, c.holds], [0, 0], "unmounted: nothing held");
});

test("a view of another device starts that device's list, and the last view to go stops it", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  openCounted("m-f");
  registry.setShell("hub", "m-a");
  const feed = machineFeedFor("m-f");
  const tree = (n: number) => (
    <MachineProvider machine="m-a">
      {Array.from({ length: n }, (_, i) => (
        <MachineView key={i} machine="m-f">
          <span>{i}</span>
        </MachineView>
      ))}
    </MachineProvider>
  );
  const { root } = mount(tree(2));
  await flush();
  assert.equal(feed.holders, 2, "each view of it counts");
  root.render(tree(1));
  await flush();
  assert.equal(feed.holders, 1);
  root.unmount();
  await flush();
  assert.equal(feed.holders, 0);
  // The home's own provider is the root's (`GlobalFeedProvider` under the home's `MachineProvider`).
  const home = machineFeedFor("m-a");
  const second = mount(
    <MachineProvider machine="m-a">
      <GlobalFeedProvider>
        <span>home</span>
      </GlobalFeedProvider>
    </MachineProvider>,
  );
  await flush();
  assert.equal(home.holders, 1);
  second.root.unmount();
  await flush();
  assert.equal(home.holders, 0);
});

/** A small app router: plain `/sessions`, and `/m/$machine/sessions` under the real `MachineRoute`. */
function machineRouter(at: string) {
  const { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = router;
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const plain = createRoute({ getParentRoute: () => rootRoute, path: "sessions", component: () => <span>plain sessions of {useMachine()}</span> });
  const machineRoute = createRoute({ getParentRoute: () => rootRoute, path: "m/$machine", component: MachineRoute });
  const machineSessions = createRoute({ getParentRoute: () => machineRoute, path: "sessions", component: () => <span>sessions of {useMachine()}</span> });
  return createRouter({
    routeTree: rootRoute.addChildren([plain, machineRoute.addChildren([machineSessions])]),
    history: createMemoryHistory({ initialEntries: [at] }),
  });
}

test("/m/<device>: another device's page is about it and holds it; the home's goes to its plain address; an unknown device says so", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  const b = openCounted("m-b");
  registry.setShell("hub", "m-a");

  const onB = machineRouter("/m/m-b/sessions");
  await onB.load();
  const first = mount(<router.RouterProvider router={onB} />);
  await flush(50);
  assert.match(first.text(), /sessions of m-b/);
  assert.equal(b.holds, 1, "its page holds it");
  assert.equal(machineFeedFor("m-b").holders, 1, "and runs its list");
  first.root.unmount();
  await flush();
  assert.equal(b.holds, 0);

  const onHome = machineRouter("/m/m-a/sessions?x=1");
  await onHome.load();
  const second = mount(<router.RouterProvider router={onHome} />);
  for (let i = 0; i < 100 && onHome.state.location.pathname !== "/sessions"; i++) await flush(10);
  await flush(50);
  assert.equal(onHome.state.location.pathname, "/sessions", "one address per page: the home's is plain");
  assert.equal(onHome.state.location.searchStr, "?x=1", "its search kept");
  second.root.unmount();

  const unknown = machineRouter("/m/m-nowhere/sessions");
  await unknown.load();
  const third = mount(<router.RouterProvider router={unknown} />);
  await flush(50);
  assert.match(third.text(), /this device is not on this page/);
  assert.doesNotMatch(third.text(), /sessions of/);
  third.root.unmount();
});

test("a pane of a device the page does not have does not make the other panes name their device", async (t) => {
  reset();
  t.after(reset);
  const state = {
    root: {
      type: "split" as const,
      id: "s",
      direction: "row" as const,
      ratio: 0.5,
      children: [
        { type: "leaf" as const, id: "here", content: { kind: "files" } as PaneContent },
        { type: "leaf" as const, id: "away", content: { kind: "terminal", id: "t", machine: "d-elsewhere" } as PaneContent },
      ] as [never, never],
    },
    focusedId: "here",
  };
  const Mixed = () => <span>{usePaneTreeMixed() ? "mixed" : "one"}|</span>;
  const { root, text } = mount(<PaneTreeView api={paneTreeApi(state, noop)} renderLeaf={() => <Mixed />} />);
  t.after(() => root.unmount());
  await flush();
  assert.equal(text(), "one|one|", "only the local page's own device is here");
  // A second device on the page: now the tree does show two.
  openCounted("m-b");
  const two = { ...state, root: { ...state.root, children: [state.root.children[0], { type: "leaf" as const, id: "b", content: { kind: "terminal", id: "t", machine: "m-b" } as PaneContent }] as [never, never] } };
  root.render(<PaneTreeView api={paneTreeApi(two, noop)} renderLeaf={() => <Mixed />} />);
  await flush();
  assert.equal(text(), "mixed|mixed|");
});

test("a routed view that throws keeps the error to itself, and the next address draws afresh", async (t) => {
  reset();
  t.after(reset);
  const at = router.createRouter({
    routeTree: router.createRootRoute().addChildren([]),
    history: router.createMemoryHistory({ initialEntries: ["/broken"] }),
  });
  await at.load();
  function Routed() {
    const href = router.useRouterState({ select: (s) => s.location.href });
    if (href === "/broken") throw new Error("this page broke");
    return <span>next view</span>;
  }
  const tree = () => (
    <router.RouterContextProvider router={at}>
      <RoutedViewBoundary>
        <Routed />
      </RoutedViewBoundary>
      <span>|screens and apps</span>
    </router.RouterContextProvider>
  );
  const { root, text } = mount(tree());
  t.after(() => root.unmount());
  await flush();
  assert.match(text(), /this pane could not be drawn/);
  assert.match(text(), /\|screens and apps/, "the layers beside the routed view stay");
  // A navigation (the rail, Back): the routed view's address moves, and it draws again.
  await at.navigate({ to: "/next" as never });
  root.render(tree());
  await flush();
  assert.equal(text(), "next view|screens and apps");
});

test("a device that goes between the commit and the effects is neither held nor started, and nothing throws", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  const b = openCounted("m-b");
  registry.setShell("hub", "m-a");
  // Runs after the commit and before the passive effects, as a chain change landing in between would.
  function Closer() {
    React.useLayoutEffect(() => registry.closeMachine("m-b"), []);
    return null;
  }
  const { root, errors } = mount(
    <MachineProvider machine="m-a">
      <MachineView machine="m-b" hold>
        <span>b</span>
      </MachineView>
      <Closer />
    </MachineProvider>,
  );
  t.after(() => root.unmount());
  await flush();
  assert.deepEqual(errors, [], "nothing thrown");
  assert.equal(b.holds, 0);
  assert.equal(machineFeedFor("m-b").holders, 0, "its list not started");
});

test("S2: font size and language are set on the main device's settings, and another device's say so", async (t) => {
  reset();
  t.after(reset);
  registry.openMachine("m-a", silent);
  registry.openMachine("m-b", silent);
  registry.setShell("hub", "m-a");
  const draw = (machine: string) =>
    mount(
      withQueries(
        <MachineProvider machine={machine}>
          <PreferencesSection />
        </MachineProvider>,
      ),
    );
  const onMain = draw("m-a");
  await flush();
  assert.match(onMain.text(), /font size/);
  assert.match(onMain.text(), /language/);
  assert.equal((container as FakeNode).findAll("data-appearance-on-main").length, 0);
  onMain.root.unmount();
  const onOther = draw("m-b");
  t.after(() => onOther.root.unmount());
  await flush();
  assert.doesNotMatch(onOther.text(), /font size/);
  assert.match(onOther.text(), /follow the main device/);
  assert.equal((container as FakeNode).findAll("data-appearance-on-main").length, 1);
});

test("S1: the page draws at an address with escaped characters: the router caught up compares the address as the browser writes it", async (t) => {
  reset();
  t.after(reset);
  const { routerCaughtUp, useRouterCaughtUp } = await import("../src/app/machine-route.js");
  assert.equal(routerCaughtUp("/sessions/claude/a%20b?x=1", "/sessions/claude/a%20b"), true);
  assert.equal(routerCaughtUp("/p/tasks/%E4%B8%AD", "/p/tasks/%E4%B8%AD"), true);
  assert.equal(routerCaughtUp("/p/tasks/", "/p/tasks"), true, "a trailing slash is the same page");
  assert.equal(routerCaughtUp("/sessions/claude/x", "/m/m-b/sessions/claude/x"), false, "another page");
  // Mounted: a router at an escaped address, the browser's address the same.
  const place = globalThis.location as unknown as { pathname: string } | undefined;
  const before = place?.pathname;
  Object.defineProperty(globalThis, "location", { value: { pathname: "/sessions/claude/a%20b", search: "" }, configurable: true, writable: true });
  t.after(() => {
    if (place) (globalThis.location as unknown as { pathname: string }).pathname = before ?? "/";
  });
  const at = router.createRouter({ routeTree: router.createRootRoute(), history: router.createMemoryHistory({ initialEntries: ["/sessions/claude/a%20b"] }) });
  await at.load();
  const Probe = () => <span>{useRouterCaughtUp() ? "drawn" : "blank"}</span>;
  const { root, text } = mount(
    <router.RouterContextProvider router={at}>
      <Probe />
    </router.RouterContextProvider>,
  );
  t.after(() => root.unmount());
  await flush();
  assert.equal(text(), "drawn");
});
