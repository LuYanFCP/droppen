import createClient, { type Client, type Middleware } from "openapi-fetch";
import { authHeader, noteUnauthorized } from "@/lib/auth";
import { homeMachine, runtimeFor } from "@/lib/machines/registry";
import type { Transport } from "@/lib/transport/types";
import type { paths } from "./schema";

/** A typed client for one machine's `/api/*`. */
export type ApiClient = Client<paths>;

/**
 * Auth, once, for every typed call.
 *
 * Both halves belong together and neither belongs at a call site: the request
 * carries the bearer token, and a 401 back means the token is gone — so the
 * browser drops it and goes to the login page. Raw `fetch`es elsewhere in the
 * app do the same two things by hand with `authHeader()`/`noteUnauthorized()`.
 */
const auth: Middleware = {
  onRequest({ request }) {
    const header = authHeader().Authorization;
    if (header) request.headers.set("Authorization", header);
    return request;
  },
  onResponse({ request, response }) {
    if (response.status === 401) noteUnauthorized(new URL(request.url).pathname);
    return response;
  },
};

/**
 * A typed client sent through `via()` — one machine's transport
 * (`lib/machines`), looked up per request: the middleware above runs on the
 * `Request` before it is handed over and on the `Response` after, whichever
 * way it travelled.
 */
export function createApiClient(via: () => Transport): ApiClient {
  const client = createClient<paths>({ baseUrl: "/", fetch: (request) => via().fetch(request) });
  client.use(auth);
  return client;
}

/**
 * The home machine's client, its transport looked up per request.
 *
 * @deprecated Everything on a machine is addressed by it: `useApi()` in a
 * component (the machine of the view it is in), `apiFor(machine)` elsewhere
 * (`lib/machines`). Kept as an alias of the home machine's;
 * `scripts/check-machine-keys.mjs` refuses new uses of it in `web/src`.
 */
export const api: ApiClient = createApiClient(() => runtimeFor(homeMachine()).transport);
