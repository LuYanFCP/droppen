/*
 * Passkeys for signing in to the hub (docs/passkeys.md §3, K1): what this
 * browser can do (§5.2), WebAuthn's JSON both ways, and the sign-up, sign-in
 * and autofill ceremonies. Plain browser APIs, no library (§3.8 rule 4).
 *
 * Binary values travel as base64url without padding, WebAuthn's own JSON
 * encoding (`PublicKeyCredential.parseCreationOptionsFromJSON`, `toJSON()`),
 * not the hex the rest of the hub API uses. Where the browser lacks those
 * functions, the conversion here does the same.
 *
 * What goes back to the hub is exactly what it checks: the response's own
 * fields, and of the client extension results only `credProps.rk` and
 * `prf.enabled`. A PRF output never leaves this page (from K4 on it is a
 * secret), even where the browser's `toJSON()` includes it.
 *
 * Nothing here calls the hub by itself: the calls come in as arguments, so
 * every step can be tested without a browser. In particular a sign-up asks
 * the hub first and makes a passkey only once the hub has said yes (§3.4 A):
 * a taken e-mail, a bad invite or a failed human check never leaves an
 * orphan passkey in the person's password manager.
 */
import { type AccountPasskey, authErrorKind, HubApiError, type HubApi, type PasskeySignedIn, type Reauth, type SignedIn } from "./api";

/** Bytes as WebAuthn's JSON writes them: base64url, no padding. */
export type Base64Url = string;

export interface CredentialDescriptorJSON {
  type: "public-key";
  id: Base64Url;
  transports?: string[];
}

export interface PrfValuesJSON {
  first: Base64Url;
  second?: Base64Url;
}

export interface ExtensionInputsJSON {
  credProps?: boolean;
  prf?: { eval?: PrfValuesJSON; evalByCredential?: Record<string, PrfValuesJSON> };
  [name: string]: unknown;
}

/** `PublicKeyCredentialCreationOptionsJSON`. */
export interface CreationOptionsJSON {
  rp: { id?: string; name: string };
  user: { id: Base64Url; name: string; displayName: string };
  challenge: Base64Url;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: CredentialDescriptorJSON[];
  authenticatorSelection?: { authenticatorAttachment?: string; residentKey?: string; requireResidentKey?: boolean; userVerification?: string };
  hints?: string[];
  attestation?: string;
  extensions?: ExtensionInputsJSON;
}

/** `PublicKeyCredentialRequestOptionsJSON`. */
export interface RequestOptionsJSON {
  challenge: Base64Url;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorJSON[];
  userVerification?: string;
  hints?: string[];
  extensions?: ExtensionInputsJSON;
}

/** The only client extension results the hub is ever sent. */
export interface ExtensionResultsJSON {
  credProps?: { rk: boolean };
  prf?: { enabled: boolean };
}

/** `RegistrationResponseJSON`, as much of it as the hub reads. */
export interface RegistrationResponseJSON {
  id: Base64Url;
  rawId: Base64Url;
  type: "public-key";
  response: { clientDataJSON: Base64Url; attestationObject: Base64Url; transports?: string[] };
  clientExtensionResults: ExtensionResultsJSON;
  authenticatorAttachment?: string;
}

/** `AuthenticationResponseJSON`, as much of it as the hub reads. */
export interface AuthenticationResponseJSON {
  id: Base64Url;
  rawId: Base64Url;
  type: "public-key";
  response: { clientDataJSON: Base64Url; authenticatorData: Base64Url; signature: Base64Url; userHandle?: Base64Url };
  clientExtensionResults: ExtensionResultsJSON;
  authenticatorAttachment?: string;
}

/** A hub challenge (stateless, 2 minutes, answered once) and the options built around it. */
export interface PasskeyChallenge<T> {
  challenge: Base64Url;
  options: T;
}

// ------------------------------------------------------------ base64url

const B64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Bytes as base64url, no padding (only the view's own bytes, for a view into a larger buffer). */
export function toBase64Url(data: ArrayBuffer | ArrayBufferView): Base64Url {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (padding tolerated, when right) as bytes; anything else is a `TypeError`. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !B64URL.test(text)) throw new TypeError("not base64url");
  const bare = text.replace(/=+$/, "");
  if (bare.length % 4 === 1 || (bare.length !== text.length && text.length % 4 !== 0)) throw new TypeError("not base64url: bad length");
  const bin = atob(bare.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (bare.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------ the browser

/** `PublicKeyCredential`'s static functions, each only where the browser has it. */
export interface PasskeyBrowser {
  parseCreationOptionsFromJSON?(options: CreationOptionsJSON): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON?(options: RequestOptionsJSON): PublicKeyCredentialRequestOptions;
  signalUnknownCredential?(options: { rpId: string; credentialId: Base64Url }): Promise<void>;
  isUserVerifyingPlatformAuthenticatorAvailable?(): Promise<boolean>;
  isConditionalMediationAvailable?(): Promise<boolean>;
  getClientCapabilities?(): Promise<Record<string, boolean | undefined>>;
}

/** `navigator.credentials`, as much of it as passkeys use. */
export interface CredentialsLike {
  create(options: { publicKey: PublicKeyCredentialCreationOptions; signal?: AbortSignal }): Promise<unknown>;
  get(options: { publicKey: PublicKeyCredentialRequestOptions; mediation?: CredentialMediationRequirement; signal?: AbortSignal }): Promise<unknown>;
}

/** Where the probes look: the page by default, a fake in tests. */
export interface PasskeyEnv {
  PublicKeyCredential?: unknown;
  navigator?: { credentials?: unknown };
  isSecureContext?: boolean;
}

const pageEnv = (): PasskeyEnv => globalThis as unknown as PasskeyEnv;

/**
 * Whether this browser does WebAuthn at all (§5.2: `window.PublicKeyCredential`,
 * and `navigator.credentials` to call). Never throws: no, when in doubt.
 */
export function webAuthnAvailable(env: PasskeyEnv = pageEnv()): boolean {
  try {
    if (env.isSecureContext === false) return false;
    const pkc = env.PublicKeyCredential;
    if (typeof pkc !== "function" && (typeof pkc !== "object" || pkc === null)) return false;
    const creds = env.navigator?.credentials as Partial<CredentialsLike> | undefined;
    return !!creds && typeof creds.create === "function" && typeof creds.get === "function";
  } catch {
    return false;
  }
}

/** `PublicKeyCredential`'s statics (`null`: no WebAuthn here). */
export function passkeyBrowser(env: PasskeyEnv = pageEnv()): PasskeyBrowser | null {
  return webAuthnAvailable(env) ? (env.PublicKeyCredential as PasskeyBrowser) : null;
}

/** `navigator.credentials` (`null`: no WebAuthn here). */
export function pageCredentials(env: PasskeyEnv = pageEnv()): CredentialsLike | null {
  return webAuthnAvailable(env) ? (env.navigator!.credentials as CredentialsLike) : null;
}

/** What this browser says it can do (§5.2). Plain booleans; `prf` is `null` where the browser cannot say. */
export interface PasskeySupport {
  /** WebAuthn at all: without it, no passkey wording anywhere (§5.3). */
  webauthn: boolean;
  /** A user-verifying platform authenticator (Touch ID, Windows Hello, …). Without one a passkey still works, from a security key or a phone. */
  platform: boolean;
  /** Passkeys offered in the e-mail field's autofill (`mediation: "conditional"`). */
  conditional: boolean;
  /** The browser (never the authenticator) says it does PRF. Only a hint: §5.2. */
  prf: boolean | null;
}

/** How long a probe may take before it counts as "no" (a browser that never answers must not hold the page). */
const PROBE_MS = 3_000;

/** `fn` of `browser`, called with no arguments: its answer, or `null` (absent, threw, or took too long). */
async function ask(browser: PasskeyBrowser, name: keyof PasskeyBrowser, timeoutMs: number): Promise<unknown> {
  let fn: unknown;
  try {
    fn = browser[name];
  } catch {
    return null;
  }
  if (typeof fn !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => (fn as () => unknown).call(browser)),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the browser what it can do. Every probe is guarded: a missing
 * function, one that throws (a page that is not a secure context, say) or one
 * that never answers is a no.
 */
export async function probePasskeys(env: PasskeyEnv = pageEnv(), opts: { timeoutMs?: number } = {}): Promise<PasskeySupport> {
  const browser = passkeyBrowser(env);
  if (!browser) return { webauthn: false, platform: false, conditional: false, prf: null };
  const timeoutMs = opts.timeoutMs ?? PROBE_MS;
  const [platform, conditional, caps] = await Promise.all([
    ask(browser, "isUserVerifyingPlatformAuthenticatorAvailable", timeoutMs),
    ask(browser, "isConditionalMediationAvailable", timeoutMs),
    ask(browser, "getClientCapabilities", timeoutMs),
  ]);
  const cap = (key: string): boolean | null => {
    if (!caps || typeof caps !== "object") return null;
    const v = (caps as Record<string, unknown>)[key];
    return typeof v === "boolean" ? v : null;
  };
  return {
    webauthn: true,
    // The older probe where the browser has it; the capability where only that answers.
    platform: typeof platform === "boolean" ? platform : cap("userVerifyingPlatformAuthenticator") === true,
    conditional: typeof conditional === "boolean" ? conditional : cap("conditionalGet") === true,
    prf: cap("extension:prf"),
  };
}

/**
 * Have the passkey provider hide a credential the hub does not know (§3.3,
 * §3.4 A step 4). Only where the browser has the function (Firefox has none;
 * Safari's capability bits are not to be trusted, so its existence decides).
 * `true`: the browser took it. Never throws.
 */
export async function signalUnknownCredential(rpId: string, credentialId: Base64Url, browser: PasskeyBrowser | null = passkeyBrowser()): Promise<boolean> {
  if (!browser || !rpId || !credentialId) return false;
  try {
    const fn = browser.signalUnknownCredential;
    if (typeof fn !== "function") return false;
    await fn.call(browser, { rpId, credentialId });
    return true;
  } catch {
    return false;
  }
}

/** The person closed the browser's prompt, or let it time out (`NotAllowedError`, `AbortError`): nothing went wrong. */
export function passkeyCancelled(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  return name === "NotAllowedError" || name === "AbortError";
}

// ------------------------------------------------------------ options from JSON

function descriptorFromJSON(d: CredentialDescriptorJSON): Record<string, unknown> {
  return { ...d, id: fromBase64Url(d.id) };
}

function prfValuesFromJSON(v: PrfValuesJSON): Record<string, unknown> {
  const out: Record<string, unknown> = { first: fromBase64Url(v.first) };
  if (v.second !== undefined) out.second = fromBase64Url(v.second);
  return out;
}

function extensionsFromJSON(ext: ExtensionInputsJSON): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ext };
  if (ext.prf) {
    const prf: Record<string, unknown> = {};
    if (ext.prf.eval) prf.eval = prfValuesFromJSON(ext.prf.eval);
    if (ext.prf.evalByCredential) {
      // The keys stay base64url credential ids, as the browser takes them.
      prf.evalByCredential = Object.fromEntries(Object.entries(ext.prf.evalByCredential).map(([id, v]) => [id, prfValuesFromJSON(v)]));
    }
    out.prf = prf;
  }
  return out;
}

/** The browser's own parser, where it has one and it takes these options; else `null`. */
function nativeParse<J, T>(browser: PasskeyBrowser | null, name: "parseCreationOptionsFromJSON" | "parseRequestOptionsFromJSON", json: J): T | null {
  try {
    const fn = browser?.[name] as unknown as ((o: J) => T) | undefined;
    return typeof fn === "function" ? fn.call(browser, json) : null;
  } catch {
    // Its parser refused what ours may take (an older browser, an extension's stand-in).
    return null;
  }
}

/** Creation options for `navigator.credentials.create()`, from the hub's JSON. */
export function creationOptionsFromJSON(json: CreationOptionsJSON, browser: PasskeyBrowser | null = passkeyBrowser()): PublicKeyCredentialCreationOptions {
  const native = nativeParse<CreationOptionsJSON, PublicKeyCredentialCreationOptions>(browser, "parseCreationOptionsFromJSON", json);
  if (native) return native;
  const out: Record<string, unknown> = {
    ...json,
    user: { ...json.user, id: fromBase64Url(json.user.id) },
    challenge: fromBase64Url(json.challenge),
  };
  if (json.excludeCredentials) out.excludeCredentials = json.excludeCredentials.map(descriptorFromJSON);
  if (json.extensions) out.extensions = extensionsFromJSON(json.extensions);
  return out as unknown as PublicKeyCredentialCreationOptions;
}

/** Request options for `navigator.credentials.get()`, from the hub's JSON. */
export function requestOptionsFromJSON(json: RequestOptionsJSON, browser: PasskeyBrowser | null = passkeyBrowser()): PublicKeyCredentialRequestOptions {
  const native = nativeParse<RequestOptionsJSON, PublicKeyCredentialRequestOptions>(browser, "parseRequestOptionsFromJSON", json);
  if (native) return native;
  const out: Record<string, unknown> = { ...json, challenge: fromBase64Url(json.challenge) };
  if (json.allowCredentials) out.allowCredentials = json.allowCredentials.map(descriptorFromJSON);
  if (json.extensions) out.extensions = extensionsFromJSON(json.extensions);
  return out as unknown as PublicKeyCredentialRequestOptions;
}

// ------------------------------------------------------------ credentials to JSON

/** What `create()` and `get()` answer with, as far as this file reads it. */
export interface PublicKeyCredentialLike {
  id?: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    getTransports?: () => string[];
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  getClientExtensionResults?: () => unknown;
  toJSON?: () => unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * The client extension results the hub may see: `credProps.rk` and
 * `prf.enabled`, nothing else. Above all never `prf.results` (from K4 on, PRF
 * outputs derive keys).
 */
export function safeExtensionResults(raw: unknown): ExtensionResultsJSON {
  const out: ExtensionResultsJSON = {};
  if (!isObj(raw)) return out;
  if (isObj(raw.credProps) && typeof raw.credProps.rk === "boolean") out.credProps = { rk: raw.credProps.rk };
  if (isObj(raw.prf) && typeof raw.prf.enabled === "boolean") out.prf = { enabled: raw.prf.enabled };
  return out;
}

function credentialOf(value: unknown): PublicKeyCredentialLike {
  if (!isObj(value) || value.type !== "public-key" || !isObj(value.response) || !(value.rawId instanceof ArrayBuffer || ArrayBuffer.isView(value.rawId))) {
    throw new TypeError("not a public-key credential");
  }
  return value as unknown as PublicKeyCredentialLike;
}

/** The credential's own `toJSON()`, where it has a working one. */
function ownJSON(c: PublicKeyCredentialLike): Record<string, unknown> | null {
  if (typeof c.toJSON !== "function") return null;
  try {
    const j = c.toJSON();
    return isObj(j) && isObj(j.response) ? j : null;
  } catch {
    return null;
  }
}

function extensionResultsOf(c: PublicKeyCredentialLike): unknown {
  try {
    return typeof c.getClientExtensionResults === "function" ? c.getClientExtensionResults() : {};
  } catch {
    return {};
  }
}

function attachmentOf(v: unknown): { authenticatorAttachment?: string } {
  return isStr(v) && v ? { authenticatorAttachment: v } : {};
}

/** `create()`'s answer as the hub takes it (`toJSON()` where it works, else by hand; the extension whitelist either way). */
export function registrationToJSON(value: unknown): RegistrationResponseJSON {
  const c = credentialOf(value);
  const j = ownJSON(c);
  if (j) {
    const r = j.response as Record<string, unknown>;
    if (isStr(j.id) && isStr(j.rawId) && isStr(r.clientDataJSON) && isStr(r.attestationObject)) {
      const response: RegistrationResponseJSON["response"] = { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject };
      if (Array.isArray(r.transports)) response.transports = r.transports.filter(isStr);
      return { id: j.id, rawId: j.rawId, type: "public-key", response, clientExtensionResults: safeExtensionResults(j.clientExtensionResults), ...attachmentOf(j.authenticatorAttachment) };
    }
  }
  const r = c.response;
  if (!r.attestationObject) throw new TypeError("not a registration: no attestation object");
  const rawId = toBase64Url(c.rawId);
  const response: RegistrationResponseJSON["response"] = { clientDataJSON: toBase64Url(r.clientDataJSON), attestationObject: toBase64Url(r.attestationObject) };
  if (typeof r.getTransports === "function") {
    try {
      const transports = r.getTransports();
      if (Array.isArray(transports)) response.transports = transports.filter(isStr);
    } catch {
      // none said
    }
  }
  return {
    id: isStr(c.id) && c.id ? c.id : rawId,
    rawId,
    type: "public-key",
    response,
    clientExtensionResults: safeExtensionResults(extensionResultsOf(c)),
    ...attachmentOf(c.authenticatorAttachment),
  };
}

/** `get()`'s answer as the hub takes it (`toJSON()` where it works, else by hand; the extension whitelist either way). */
export function authenticationToJSON(value: unknown): AuthenticationResponseJSON {
  const c = credentialOf(value);
  const j = ownJSON(c);
  if (j) {
    const r = j.response as Record<string, unknown>;
    if (isStr(j.id) && isStr(j.rawId) && isStr(r.clientDataJSON) && isStr(r.authenticatorData) && isStr(r.signature)) {
      const response: AuthenticationResponseJSON["response"] = { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature };
      if (isStr(r.userHandle)) response.userHandle = r.userHandle;
      return { id: j.id, rawId: j.rawId, type: "public-key", response, clientExtensionResults: safeExtensionResults(j.clientExtensionResults), ...attachmentOf(j.authenticatorAttachment) };
    }
  }
  const r = c.response;
  if (!r.authenticatorData || !r.signature) throw new TypeError("not an assertion: no authenticator data or signature");
  const rawId = toBase64Url(c.rawId);
  const response: AuthenticationResponseJSON["response"] = {
    clientDataJSON: toBase64Url(r.clientDataJSON),
    authenticatorData: toBase64Url(r.authenticatorData),
    signature: toBase64Url(r.signature),
  };
  if (r.userHandle) response.userHandle = toBase64Url(r.userHandle);
  return {
    id: isStr(c.id) && c.id ? c.id : rawId,
    rawId,
    type: "public-key",
    response,
    clientExtensionResults: safeExtensionResults(extensionResultsOf(c)),
    ...attachmentOf(c.authenticatorAttachment),
  };
}

// ------------------------------------------------------------ the ceremonies

export interface PasskeyDeps {
  /** `navigator.credentials` (a fake in tests). */
  credentials: CredentialsLike;
  /** `PublicKeyCredential`'s statics (`undefined`: the page's; `null`: none, the built-in conversion and no signals). */
  browser?: PasskeyBrowser | null;
}

const browserOf = (deps: Pick<PasskeyDeps, "browser">): PasskeyBrowser | null => (deps.browser === undefined ? passkeyBrowser() : deps.browser);

/** A definite refusal from the hub (not a lost connection, not its own failure): it did not keep the passkey. */
const refusedByHub = (error: unknown) => error instanceof HubApiError && error.status >= 400 && error.status < 500;

/**
 * Sign up with a new passkey (§3.4 A): the hub's checks first (rate, human
 * check, the e-mail, the invite), then `create()`, then the account. If the
 * hub refuses the options, no passkey is ever made. If it refuses the new
 * passkey, the provider is asked to hide it (it belongs to no account). A
 * lost connection or a hub error at that last step leaves it be: the account
 * may well exist.
 */
export async function passkeySignUp(
  api: Pick<HubApi, "passkeySignupOptions" | "signUpWithPasskey">,
  deps: PasskeyDeps,
  input: { email: string; invite?: string; turnstile?: string | null; lang?: string; rpId?: string; signal?: AbortSignal },
): Promise<SignedIn> {
  const { challenge, options } = await api.passkeySignupOptions({ email: input.email, invite: input.invite, turnstile: input.turnstile, lang: input.lang });
  const browser = browserOf(deps);
  const made = await deps.credentials.create({ publicKey: creationOptionsFromJSON(options, browser), ...(input.signal ? { signal: input.signal } : {}) });
  if (!made) throw new DOMException("no passkey was made", "NotAllowedError");
  const credential = registrationToJSON(made);
  try {
    return await api.signUpWithPasskey({ challenge, email: input.email, invite: input.invite, lang: input.lang, credential });
  } catch (error) {
    if (refusedByHub(error)) await signalUnknownCredential(options.rp.id || input.rpId || "", credential.id, browser);
    throw error;
  }
}

/** A passkey's answer to a sign-in challenge. */
export interface PasskeyAnswer {
  challenge: Base64Url;
  credential: AuthenticationResponseJSON;
  /** The RP the options named (to signal an unknown credential to). */
  rpId?: string;
}

/**
 * Sign in with a passkey's answer. A passkey the hub does not know (deleted
 * from the account, replaced in its provider) is signalled to the provider so
 * it stops offering it (§3.5); the refusal still comes back.
 */
export async function finishPasskeyLogin(api: Pick<HubApi, "loginWithPasskey">, deps: Pick<PasskeyDeps, "browser">, answer: PasskeyAnswer): Promise<PasskeySignedIn> {
  try {
    const signed = await api.loginWithPasskey(answer.challenge, answer.credential);
    return { ...signed, credentialId: answer.credential.rawId };
  } catch (error) {
    if (authErrorKind(error) === "unknownPasskey" && answer.rpId) await signalUnknownCredential(answer.rpId, answer.credential.id, browserOf(deps));
    throw error;
  }
}

/**
 * A modal sign-in: fresh options, `get()` with no credential named (the
 * person picks one), then the hub. With `autofill`, its pending conditional
 * request is withdrawn first (a browser takes one request at a time) and
 * offered again if this one does not sign in.
 */
export async function passkeyLogin(
  api: Pick<HubApi, "passkeyLoginOptions" | "loginWithPasskey">,
  deps: PasskeyDeps,
  opts: { rpId?: string; signal?: AbortSignal; autofill?: PasskeyAutofill | null } = {},
): Promise<PasskeySignedIn> {
  const autofill = opts.autofill ?? null;
  const resume = autofill?.active ?? false;
  if (autofill) await autofill.stop();
  try {
    const { challenge, options } = await api.passkeyLoginOptions();
    const got = await deps.credentials.get({ publicKey: requestOptionsFromJSON(options, browserOf(deps)), ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!got) throw new DOMException("no passkey was chosen", "NotAllowedError");
    return await finishPasskeyLogin(api, deps, { challenge, credential: authenticationToJSON(got), rpId: options.rpId || opts.rpId });
  } catch (error) {
    if (resume) autofill!.start();
    throw error;
  }
}

// ------------------------------------------------------------ the account's passkeys (K2) and their PRF (§4.5)

/**
 * The PRF output a credential gave (`getClientExtensionResults().prf.results.first`),
 * copied out of the browser's buffer — `null` where it gave none (no PRF in
 * this authenticator, this browser, or over this transport: §5.2, the only
 * reliable test). Read from the credential itself, never from `toJSON()`.
 * The caller zeroes it once used.
 */
export function prfOutputOf(value: unknown): Uint8Array | null {
  if (!isObj(value)) return null;
  const results = extensionResultsOf(value as unknown as PublicKeyCredentialLike);
  if (!isObj(results) || !isObj(results.prf) || !isObj(results.prf.results)) return null;
  const first = results.prf.results.first;
  if (!(first instanceof ArrayBuffer || ArrayBuffer.isView(first))) return null;
  const bytes = ArrayBuffer.isView(first) ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength) : new Uint8Array(first);
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

/** A passkey added to the account, and — when a PRF input was given and the authenticator answered it at creation — its PRF output. */
export interface AddedPasskey {
  /** The hub's row for it (its id, label, provider). */
  passkey: AccountPasskey;
  /** Its credential id (base64url) as this browser's authenticator gave it — not the hub's echo: what a slot names is computed from this. */
  credentialId: string;
  /** `null`: no PRF result at creation (ask with {@link passkeyPrf} next, §4.5). */
  prf: Uint8Array | null;
}

/**
 * Add a passkey to the account from this full device (§3.4 B): the hub's
 * options — given `proof` it is still the person (one of the account's
 * passkeys, or its current password) — under the account's user handle,
 * its passkeys excluded, then
 * `create()`, then the hub. With `prfInput` the PRF is asked at creation too
 * (§4.5 "one gesture"), and its output comes back here only — the hub sees
 * `prf.enabled` at most. A passkey the hub refuses is signalled unknown to
 * its provider (it belongs to no account).
 */
export async function passkeyAdd(
  api: Pick<HubApi, "passkeyAddOptions" | "addPasskey">,
  deps: PasskeyDeps,
  input: { token: string; proof: Reauth; label?: string; prfInput?: Uint8Array; rpId?: string; signal?: AbortSignal },
): Promise<AddedPasskey> {
  const { challenge, options } = await api.passkeyAddOptions(input.token, input.proof);
  const asked: CreationOptionsJSON = input.prfInput
    ? { ...options, extensions: { ...options.extensions, prf: { eval: { first: toBase64Url(input.prfInput) } } } }
    : options;
  const browser = browserOf(deps);
  const made = await deps.credentials.create({ publicKey: creationOptionsFromJSON(asked, browser), ...(input.signal ? { signal: input.signal } : {}) });
  if (!made) throw new DOMException("no passkey was made", "NotAllowedError");
  const credential = registrationToJSON(made);
  const prf = input.prfInput ? prfOutputOf(made) : null;
  try {
    const passkey = await api.addPasskey(input.token, { challenge, label: input.label, credential });
    return { passkey, credentialId: credential.rawId, prf };
  } catch (error) {
    prf?.fill(0);
    if (refusedByHub(error)) await signalUnknownCredential(options.rp.id || input.rpId || "", credential.id, browser);
    throw error;
  }
}

/**
 * Ask one passkey (`credentialId`, base64url — or, with none named, the one
 * the person picks) for its PRF of `input` (§4.5 step 2): a `get()` with a
 * challenge of this page's own, sent nowhere — the PRF output is all it is
 * for. The answer: the credential that answered, and its PRF output (`null`:
 * none here). The caller zeroes the output.
 */
export async function passkeyPrf(
  deps: PasskeyDeps,
  input: { rpId?: string; credentialId?: string; prfInput?: Uint8Array; signal?: AbortSignal },
): Promise<{ credentialId: string; prf: Uint8Array | null }> {
  const options: RequestOptionsJSON = {
    challenge: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    timeout: 120_000,
    userVerification: "required",
    allowCredentials: input.credentialId ? [{ type: "public-key", id: input.credentialId }] : [],
  };
  // No RP id named: the page's own domain, which is the hub's relying party (a hub on its own origin).
  if (input.rpId) options.rpId = input.rpId;
  // No input: only which passkey the person holds is asked (its answer goes nowhere).
  if (input.prfInput) options.extensions = { prf: { eval: { first: toBase64Url(input.prfInput) } } };
  const got = await deps.credentials.get({ publicKey: requestOptionsFromJSON(options, browserOf(deps)), ...(input.signal ? { signal: input.signal } : {}) });
  if (!got) throw new DOMException("no passkey was chosen", "NotAllowedError");
  const credential = credentialOf(got);
  return { credentialId: toBase64Url(credential.rawId), prf: input.prfInput ? prfOutputOf(got) : null };
}

/**
 * Prove it is still the person with one of the account's passkeys (before
 * the password is set, changed or removed): the hub's re-authentication
 * challenge — bound to this device, naming the account's passkeys — and the
 * passkey's answer, as `PUT /v1/password` takes it.
 */
export async function passkeyReauth(
  api: Pick<HubApi, "passkeyReauthOptions">,
  deps: PasskeyDeps,
  input: { token: string; signal?: AbortSignal },
): Promise<{ challenge: string; credential: AuthenticationResponseJSON }> {
  const { challenge, options } = await api.passkeyReauthOptions(input.token);
  const got = await deps.credentials.get({ publicKey: requestOptionsFromJSON(options, browserOf(deps)), ...(input.signal ? { signal: input.signal } : {}) });
  if (!got) throw new DOMException("no passkey was chosen", "NotAllowedError");
  return { challenge, credential: authenticationToJSON(got) };
}

/** Clocks, injectable for tests. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

const pageTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Ask afresh this often: the hub's challenges live 2 minutes, so an answer always has 20 s left to reach it. */
export const AUTOFILL_REFRESH_MS = 100_000;
/** A round that ends sooner than this without an answer is a browser refusing at once… */
const QUICK_MS = 2_000;
/** …and after this many of those in a row the autofill gives up (no busy loop). */
const QUICK_LIMIT = 3;

export interface ConditionalOptions {
  /** Fresh sign-in options from the hub (`HubApi.passkeyLoginOptions`). */
  options: () => Promise<PasskeyChallenge<RequestOptionsJSON>>;
  credentials: CredentialsLike;
  browser?: PasskeyBrowser | null;
  refreshMs?: number;
  timers?: Timers;
}

/**
 * The e-mail field's passkey autofill (§3.5 step 1): `get()` with
 * `mediation: "conditional"`, withdrawn and asked again with a fresh
 * challenge before the hub's runs out (every `refreshMs`), and offered again
 * when the person closes the prompt midway. Resolves with the passkey's
 * answer and the challenge it answered; `null` once `signal` aborts. Rejects
 * when the hub's options fail, or the browser refuses at once again and again.
 */
export async function conditionalPasskeyGet(o: ConditionalOptions & { signal: AbortSignal }): Promise<PasskeyAnswer | null> {
  const { signal } = o;
  const timers = o.timers ?? pageTimers;
  const refreshMs = o.refreshMs ?? AUTOFILL_REFRESH_MS;
  const browser = browserOf(o);
  let quick = 0;
  while (!signal.aborted) {
    const { challenge, options } = await o.options();
    if (signal.aborted) return null;
    const round = new AbortController();
    const withdraw = () => round.abort(signal.reason);
    signal.addEventListener("abort", withdraw, { once: true });
    let expiring = false;
    const started = timers.now();
    const timer = timers.setTimeout(() => {
      expiring = true;
      round.abort(new DOMException("the challenge is about to expire", "AbortError"));
    }, refreshMs);
    let failure: unknown = null;
    try {
      const got = await o.credentials.get({ mediation: "conditional", publicKey: requestOptionsFromJSON(options, browser), signal: round.signal });
      if (signal.aborted) return null;
      if (got) return { challenge, credential: authenticationToJSON(got), ...(options.rpId ? { rpId: options.rpId } : {}) };
    } catch (error) {
      if (signal.aborted) return null;
      if (!expiring && !passkeyCancelled(error)) throw error;
      failure = error;
    } finally {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", withdraw);
    }
    if (expiring) {
      quick = 0;
      continue;
    }
    // Closed midway, or no answer at all: offer it again, unless the browser keeps refusing at once.
    quick = timers.now() - started < QUICK_MS ? quick + 1 : 0;
    if (quick >= QUICK_LIMIT) throw failure ?? new DOMException("the browser keeps refusing the passkey autofill", "NotAllowedError");
  }
  return null;
}

/**
 * The sign-in page's autofill, started and stopped with the page: each
 * passkey picked from it goes to `onAnswer` (`true`: signed in, it stops;
 * `false`: refused, it is offered again).
 */
export class PasskeyAutofill {
  private ctl: AbortController | null = null;
  private running: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly o: ConditionalOptions & {
      onAnswer: (answer: PasskeyAnswer) => Promise<boolean>;
      /** It stopped for good: the hub's options failed, or the browser refuses it. */
      onError?: (error: unknown) => void;
    },
  ) {}

  /** A conditional request is pending (or being prepared, or its answer being checked). */
  get active(): boolean {
    return this.running !== null;
  }

  start(): void {
    if (this.closed || this.running) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    const run = async () => {
      while (!ctl.signal.aborted) {
        const answer = await conditionalPasskeyGet({ ...this.o, signal: ctl.signal });
        if (!answer || ctl.signal.aborted) return;
        if (await this.o.onAnswer(answer)) return;
      }
    };
    this.running = run()
      .catch((error: unknown) => {
        if (!ctl.signal.aborted) this.o.onError?.(error);
      })
      .finally(() => {
        if (this.ctl !== ctl) return;
        this.ctl = null;
        this.running = null;
      });
  }

  /**
   * Withdraw the pending request and wait until the browser has let go of it
   * (at most `graceMs`: a browser that never answers the abort must not hold
   * a modal request back for ever).
   */
  async stop(graceMs = 1_000): Promise<void> {
    const running = this.running;
    this.ctl?.abort(new DOMException("the passkey autofill was withdrawn", "AbortError"));
    if (!running) return;
    const timers = this.o.timers ?? pageTimers;
    let timer: unknown;
    let late = false;
    await Promise.race([
      running,
      new Promise<void>((resolve) => {
        timer = timers.setTimeout(() => {
          late = true;
          resolve();
        }, graceMs);
      }),
    ]);
    timers.clearTimeout(timer);
    // Still not let go: leave that one to end by itself, and let a new one start.
    if (late && this.running === running) {
      this.ctl = null;
      this.running = null;
    }
  }

  /** For good (the page goes). */
  close(): void {
    this.closed = true;
    void this.stop();
  }
}
