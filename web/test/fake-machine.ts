// A machine at the far end of a channel, played by a test: every pipe the
// page opens is one request, answered by a handler once its body has ended —
// the agent bridge's side of `lib/transport/tunnel.ts`, without a channel.
import { type Pipe, type PipeKind, type PipeMessage, type PipeMeta, type PipeOpener, tunnelTransport } from "../src/lib/transport/tunnel.js";

export interface Exchange {
  kind: PipeKind;
  meta: PipeMeta;
  /** The request body as it arrived (complete once `ended`). */
  body: Uint8Array;
  ended: boolean;
  /** The page let go of the pipe. */
  closedHere: boolean;
  /** Body chunks the page sent. */
  chunks: number;
}

export interface Answer {
  status: number;
  headers?: [string, string][];
  /** The response body, in the pieces it is delivered in. */
  chunks?: (Uint8Array | string)[];
  /** Close with an error code after the head (and any chunks) instead of finishing. */
  hangUp?: number;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export function fakeMachine(answer: (exchange: Exchange) => Answer | Promise<Answer>) {
  const exchanges: Exchange[] = [];
  const opener: PipeOpener = {
    open(kind, meta) {
      const exchange: Exchange = { kind, meta, body: new Uint8Array(0), ended: false, closedHere: false, chunks: 0 };
      exchanges.push(exchange);
      const pipe: Pipe = {
        onmessage: null,
        onclose: null,
        send(message: PipeMessage) {
          if (exchange.closedHere) return;
          if (message.kind === "binary") {
            const next = new Uint8Array(exchange.body.length + message.data.length);
            next.set(exchange.body);
            next.set(message.data, exchange.body.length);
            exchange.body = next;
            exchange.chunks++;
          } else if (message.kind === "end") {
            exchange.ended = true;
            void respond();
          }
        },
        close() {
          exchange.closedHere = true;
        },
      };
      const respond = async () => {
        const a = await answer(exchange);
        await tick();
        if (exchange.closedHere) return;
        pipe.onmessage?.({ kind: "head", status: a.status, headers: a.headers ?? [] });
        for (const chunk of a.chunks ?? []) {
          await tick();
          if (exchange.closedHere) return;
          pipe.onmessage?.({ kind: "binary", data: typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk });
        }
        await tick();
        if (exchange.closedHere) return;
        pipe.onclose?.(a.hangUp ?? 0);
      };
      return pipe;
    },
  };
  return { exchanges, opener, transport: tunnelTransport(opener) };
}

export const json = (status: number, body: unknown): Answer => ({
  status,
  headers: [["content-type", "application/json"]],
  chunks: [JSON.stringify(body)],
});
