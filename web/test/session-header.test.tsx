import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionHeader } from "../src/features/sessions/session-header.js";

const title = <span className="min-w-0 flex-1 truncate">remote hand 开发</span>;
const controls = <><button>switch</button><button aria-label="close pane">×</button></>;

test("split controls live beside the title, with metadata in a second row", () => {
  const html = renderToStaticMarkup(
    <SessionHeader titleRow={title} paneActions={controls} metadata={<span>claude · main</span>} />,
  );
  assert.equal(html.match(/<header/g)?.length, 1);
  assert.match(html, /remote hand 开发.*switch.*close pane.*<div class="flex min-h-7/s);
  assert.match(html, /overflow-hidden[^"]*">.*claude · main/);
  assert.doesNotMatch(html, /flex-wrap|session ·/);
});

test("loading or missing sessions can retain pane controls without metadata", () => {
  const html = renderToStaticMarkup(<SessionHeader titleRow={title} paneActions={controls} />);
  assert.match(html, /switch/);
  assert.match(html, /close pane/);
  assert.doesNotMatch(html, /min-h-7/);
});

test("a routed session has the same two rows without split controls", () => {
  const html = renderToStaticMarkup(<SessionHeader titleRow={title} metadata={<span>claude</span>} />);
  assert.match(html, /remote hand 开发/);
  assert.match(html, /min-h-7/);
  assert.doesNotMatch(html, /switch|close pane/);
});
