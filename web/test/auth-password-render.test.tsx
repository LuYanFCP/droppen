// The sign-up form's password (`features/cloud/cloud-app.tsx` `AuthScreen`),
// drawn for real: one shorter than the hub takes (rh-hub `auth::MIN_PASSWORD`,
// 10) is said in words on the form, in the reader's language, and never sent
// — the hub would refuse it with a bare 400 and the human check's token would
// be spent on that. One long enough is sent.
//
// React renders into a stand-in DOM (`fake-dom.ts`) where effects run.
// `import * as React` because the test directory is outside the tsconfig's
// `include`.
import * as React from "react";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { installFakeDom, type FakeNode } from "./fake-dom.js";

Object.assign(globalThis, { location: { pathname: "/", search: "", hash: "", reload: () => undefined, replace: () => undefined } });
const container = installFakeDom();
after(() => void setTimeout(() => process.exit(), 50));

const { createRoot } = await import("react-dom/client");
const { I18nextProvider } = await import("react-i18next");
const { default: i18n } = await import("../src/i18n/index.js");
const { AuthScreen } = await import("../src/features/cloud/cloud-app.js");

const noop = () => undefined;
const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(done: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await flush(5);
  }
}

function find(node: FakeNode, match: (n: FakeNode) => boolean): FakeNode | null {
  if (match(node)) return node;
  for (const c of node.childNodes) {
    const hit = find(c, match);
    if (hit) return hit;
  }
  return null;
}

/** The handlers React gave `node` (`onChange`, `onSubmit`, …). */
function props(node: FakeNode | null): Record<string, (e: unknown) => void> {
  assert.ok(node);
  return Object.entries(node as unknown as Record<string, unknown>).find(([k]) => k.startsWith("__reactProps$"))?.[1] as Record<string, (e: unknown) => void>;
}

const byTestId = (id: string) => find(container, (n) => n.getAttribute?.("data-testid") === id);
const type = (id: string, value: string) => props(byTestId(id)).onChange({ target: { value } });
const submit = () => props(find(container, (n) => n.nodeName === "FORM")).onSubmit({ preventDefault: noop });

test("sign-up: a password under 10 characters is said on the form and never sent; one of 10 is", async () => {
  const sent: { email: string; password: string }[] = [];
  const api = {
    signupConfig: async () => ({ signup: "open", inviteRequired: false, turnstile: null, verification: "off", passkeys: null }),
    signUp: async (email: string, password: string) => {
      sent.push({ email, password });
      return new Promise(() => undefined); // left waiting: what was sent is what this pins
    },
  };
  await i18n.changeLanguage("zh-CN");
  const root = createRoot(container as never);
  root.render(
    <I18nextProvider i18n={i18n}>
      <AuthScreen api={api as never} onSignedIn={noop} initialMode="signup" />
    </I18nextProvider>,
  );
  try {
    await until(() => byTestId("auth-password") !== null && byTestId("password-submit") !== null);
    type("auth-email", "me@example.test");
    type("auth-password", "short-pw1");
    await flush();
    submit();
    await until(() => (container as FakeNode).textContent.includes("密码至少需要 10 个字符"));
    assert.deepEqual(sent, [], "not sent: the hub would refuse it");
    assert.doesNotMatch((container as FakeNode).textContent, /邮箱地址/, "the e-mail is not blamed");
    // Characters, not bytes: four of them are twelve bytes, and still too few.
    type("auth-password", "密码太短");
    await flush();
    submit();
    await flush();
    assert.deepEqual(sent, []);
    type("auth-password", "long-enough");
    await flush();
    submit();
    await until(() => sent.length === 1);
    assert.deepEqual(sent, [{ email: "me@example.test", password: "long-enough" }]);
  } finally {
    root.unmount();
    await i18n.changeLanguage("en");
  }
});
