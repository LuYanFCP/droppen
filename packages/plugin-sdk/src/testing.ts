/**
 * `createTestHost()` — an in-memory {@link PluginHost} for plugin unit tests.
 *
 * Storage keeps the same compare-and-set rules a real host enforces (a write
 * names the revision it is based on; a batch is all or nothing; conflicts
 * carry the current document), so a plugin's conflict handling can be tested
 * without a server. Every side effect a plugin may cause through the host —
 * a saved file, a print, a copied text, a question, a navigation — is recorded
 * for the test to inspect.
 */
import { createElement, Fragment, type ReactNode } from "react";
import {
  isDocName,
  localize,
  PluginStorageError,
  SDK_VERSION,
  type Doc,
  type DocMeta,
  type DocWrite,
  type Locale,
  type PluginHost,
  type StorageError,
} from "./index";

export interface TestHostOptions {
  pluginId?: string;
  language?: Locale;
  /** Documents the store starts with: name to value (revision 1), or a full `Doc`. */
  docs?: Record<string, unknown>;
  /** How `ui.confirm` answers: a constant, or a function of the message. Defaults to `true`. */
  confirm?: boolean | ((message: string) => boolean);
  capabilities?: Partial<PluginHost["capabilities"]>;
  /** The plugin's strings, as its contributions would register them. */
  strings?: Record<string, string>;
  /** A per-document size limit in bytes of JSON, as a host enforces. Default 4 MiB. */
  docLimit?: number;
  /** The clock `updatedAt` is read from. */
  now?: () => Date;
}

/** What a test can look at and control besides the host itself. */
export interface TestHost extends PluginHost {
  /** The store's current documents, by name. */
  readonly docs: Map<string, Doc<unknown>>;
  /** Every `files.save`, in order. */
  readonly saved: { name: string; data: Blob }[];
  /** Every `print`, in order. */
  readonly printed: { title: string; html: string }[];
  /** Every `clipboard.writeText`, in order. */
  readonly copied: string[];
  /** Every `ui.confirm` message, in order. */
  readonly confirms: string[];
  /** Every `navigation.navigate` path, in order. */
  readonly navigations: string[];
  /** Every successful write, in order (one entry per document). */
  readonly writes: Doc<unknown>[];
  /** What the next `files.open` returns. */
  nextOpen: File | null;
  /** Make the next storage call fail with this error (once). */
  failNext(error: StorageError): void;
  /** Change a document as another tab or device would, and notify watchers. */
  writeElsewhere<T>(name: string, value: T): Doc<T>;
}

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export function createTestHost(options: TestHostOptions = {}): TestHost {
  const now = options.now ?? (() => new Date());
  const docLimit = options.docLimit ?? 4 * 1024 * 1024;
  const docs = new Map<string, Doc<unknown>>();
  for (const [name, value] of Object.entries(options.docs ?? {})) {
    const doc =
      value && typeof value === "object" && "revision" in value && "value" in value && "name" in value
        ? (clone(value) as Doc<unknown>)
        : { name, revision: 1, updatedAt: now().toISOString(), value: clone(value) };
    docs.set(name, doc);
  }
  const watchers = new Map<string, Set<(revision: number | null) => void>>();
  const notify = (name: string, revision: number) => {
    for (const fn of watchers.get(name) ?? []) fn(revision);
  };
  let pending: StorageError | null = null;
  const takeFailure = () => {
    if (!pending) return;
    const error = pending;
    pending = null;
    throw new PluginStorageError(error);
  };
  const language = options.language ?? "zh-CN";
  const strings = options.strings ?? {};

  const checkWrite = (write: DocWrite) => {
    if (!isDocName(write.name)) throw new PluginStorageError({ code: "failed", message: `invalid document name ${JSON.stringify(write.name)}` });
    const size = new TextEncoder().encode(JSON.stringify(write.value)).length;
    if (size > docLimit) throw new PluginStorageError({ code: "too_large", message: `${write.name} is ${size} bytes`, limit: docLimit });
    const current = docs.get(write.name) ?? null;
    if ((current?.revision ?? null) !== write.expectedRevision) {
      throw new PluginStorageError({
        code: "conflict",
        message: `${write.name} is at revision ${current?.revision ?? "none"}, not ${write.expectedRevision ?? "none"}`,
        doc: write.name,
        current: clone(current),
      });
    }
  };
  const commit = (write: DocWrite): Doc<unknown> => {
    const doc = {
      name: write.name,
      revision: (write.expectedRevision ?? 0) + 1,
      updatedAt: now().toISOString(),
      value: clone(write.value),
    };
    docs.set(write.name, doc);
    host.writes.push(clone(doc));
    return clone(doc);
  };

  const host: TestHost = {
    sdkVersion: SDK_VERSION,
    pluginId: options.pluginId ?? "test",
    docs,
    saved: [],
    printed: [],
    copied: [],
    confirms: [],
    navigations: [],
    writes: [],
    nextOpen: null,
    failNext(error) {
      pending = error;
    },
    writeElsewhere<T>(name: string, value: T) {
      const current = docs.get(name);
      const doc = { name, revision: (current?.revision ?? 0) + 1, updatedAt: now().toISOString(), value: clone(value) };
      docs.set(name, doc);
      notify(name, doc.revision);
      return clone(doc) as Doc<T>;
    },
    storage: {
      async get<T>(name: string) {
        takeFailure();
        return clone((docs.get(name) as Doc<T> | undefined) ?? null);
      },
      async list(prefix: string): Promise<DocMeta[]> {
        takeFailure();
        return [...docs.values()]
          .filter((doc) => doc.name.startsWith(prefix))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(({ name, revision, updatedAt }) => ({ name, revision, updatedAt }));
      },
      async put<T>(name: string, value: T, expectedRevision: number | null) {
        takeFailure();
        const write = { name, value, expectedRevision };
        checkWrite(write);
        const doc = commit(write);
        notify(name, doc.revision);
        return doc as Doc<T>;
      },
      async batch(writes: DocWrite[]) {
        takeFailure();
        const names = new Set<string>();
        for (const write of writes) {
          if (names.has(write.name)) throw new PluginStorageError({ code: "failed", message: `${write.name} appears twice in one batch` });
          names.add(write.name);
          checkWrite(write);
        }
        const out = writes.map(commit);
        for (const doc of out) notify(doc.name, doc.revision);
        return out;
      },
      watch(name, onChange) {
        if (!watchers.has(name)) watchers.set(name, new Set());
        watchers.get(name)!.add(onChange);
        return () => watchers.get(name)?.delete(onChange);
      },
    },
    ui: {
      Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement(Fragment, null, children) : null),
      DialogContent: ({ title, className, children }: { title: string; className?: string; children: ReactNode }) =>
        createElement("div", { role: "dialog", "aria-label": title, className }, createElement("h2", null, title), children),
      Spinner: ({ className }: { className?: string }) => createElement("span", { role: "status", className }, "…"),
      async confirm(message) {
        host.confirms.push(message);
        const answer = options.confirm ?? true;
        return typeof answer === "function" ? answer(message) : answer;
      },
    },
    i18n: {
      language: () => language,
      t(key, vars) {
        const text = strings[key] ?? key;
        return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ""));
      },
      text: (value) => localize(value, language),
    },
    navigation: {
      navigate(path = "") {
        host.navigations.push(path);
      },
      useLeaveGuard() {},
    },
    capabilities: { print: true, clipboard: true, ...options.capabilities },
    files: {
      async save(data, suggestedName) {
        host.saved.push({ name: suggestedName, data });
      },
      async open() {
        const file = host.nextOpen;
        host.nextOpen = null;
        return file;
      },
    },
    clipboard: {
      async writeText(text) {
        host.copied.push(text);
      },
    },
    async print(document) {
      host.printed.push(document);
    },
  };
  return host;
}
