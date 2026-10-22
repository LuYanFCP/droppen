import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { OutboxList } from "../src/features/sessions/outbox-list.js";
import { DeliveryPreviews } from "../src/features/sessions/delivery-preview-view.js";
import { ServerQueueList, queuedRowState } from "../src/features/sessions/server-queue.js";
import { zhCN } from "../src/i18n/zh-CN.js";
import type { OutgoingMessage } from "../src/features/sessions/send-receipts.js";

void i18next.use(initReactI18next).init({
  lng: "zh-CN",
  resources: { "zh-CN": { translation: zhCN } },
  keySeparator: false,
  nsSeparator: false,
});

const noop = () => {};
const outbox = (queue: OutgoingMessage[]) =>
  renderToStaticMarkup(
    <OutboxList
      queue={queue}
      paused={false}
      steering={false}
      headAction="send"
      checking={false}
      onSendHead={noop}
      onSteerHead={noop}
      onResend={noop}
      onCheck={noop}
      onRemove={noop}
    />,
  );

test("the local queue labels each message, in the words the spec gives", () => {
  const html = outbox([
    { clientMessageId: "a", text: "first", state: "unknown" },
    { clientMessageId: "b", text: "second" },
    { clientMessageId: "c", text: "third", state: "unsent" },
  ]);
  assert.match(html, /data-delivery="unknown"/);
  assert.match(html, /未知/);
  assert.match(html, /发出去了但没收到回应，不知道服务端收到没有/, "the title says what unknown means");
  assert.match(html, /已保存/);
  assert.match(html, /只在这台设备上，还没发出/);
  assert.match(html, /未送达，可安全重发/);
  assert.match(html, /正在向服务端确认状态未知的消息是否已送达/, "an unknown head says why nothing behind it moves");
  assert.match(html, /用同一消息 ID 重发/, "the resend of an unsent message keeps its id");
});

test("a message in flight is the preview's to show, not the queue's", () => {
  assert.equal(outbox([{ clientMessageId: "a", text: "going", state: "sending" }]), "");
});

test("server queue rows carry their receipt, and a row nobody named is delivered", () => {
  const messages = [
    { id: "q1", text: "named", steered: false },
    { id: "q2", text: "unnamed", steered: false },
    { id: "q3", text: "steered", steered: true },
  ];
  const receipts = [{ clientMessageId: "c1", status: "queued" as const, qid: "q1", at: "2026-10-01T00:00:00.000Z" }];
  assert.equal(queuedRowState(messages[0]!, receipts, "claude"), "delivered");
  assert.equal(queuedRowState(messages[1]!, receipts, "claude"), "delivered");
  assert.equal(queuedRowState(messages[2]!, receipts, "claude"), "executed", "in claude's stdin is handed over");
  assert.equal(queuedRowState(messages[2]!, receipts, "codex"), "delivered", "codex has not acknowledged it yet");
  const html = renderToStaticMarkup(
    <ServerQueueList
      source="claude"
      messages={messages}
      receipts={receipts}
      pendingId={null}
      restartId={null}
      notice={null}
      onSteer={noop}
      onDrop={noop}
    />,
  );
  assert.match(html, /已送达/);
  assert.match(html, /已执行/);
});

test("the preview says delivered or executed, and offers a way back only for a dropped message", () => {
  const html = renderToStaticMarkup(
    <DeliveryPreviews
      messages={[
        { id: "d", text: "queued one", after: 0, sending: false, receipt: "queued" },
        { id: "e", text: "running one", after: 0, sending: false, receipt: "sent" },
      ]}
      onRequeue={noop}
      onDismiss={noop}
    />,
  );
  assert.match(html, /已送达/);
  assert.match(html, /已执行/);
  assert.doesNotMatch(html, /<button/, "nothing to do about a message that is fine");

  const dropped = renderToStaticMarkup(
    <DeliveryPreviews
      messages={[{ id: "f", text: "dropped", after: 0, sending: false, receipt: "failed", resend: { text: "dropped" } }]}
      onRequeue={noop}
      onDismiss={noop}
    />,
  );
  assert.match(dropped, /放回待发队列/);
  assert.match(dropped, /<button/);
});
