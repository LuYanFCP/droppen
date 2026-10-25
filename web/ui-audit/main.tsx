/*
 * `scripts/ui-audit` renders this: the real primitives and the real
 * settings-row composition, with no API, router or machine context. It is a
 * fixture, not a product page; keep it in step with `features/settings/` and
 * `components/ui/` when either changes.
 *
 * `web/src/index.css` excludes this directory from Tailwind's scan
 * (`@source not`), so nothing here can change the production stylesheet. That
 * also means every class below must already occur in `web/src`; use the same
 * strings the real page uses.
 */
import "@/index.css";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");

// The same string as `features/settings/settings-view.tsx`.
const preferenceRow =
  "flex max-w-xl flex-col items-start gap-2 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-4";

function Row({ id, label, hint, children }: { id: string; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div data-audit-row={id} className={preferenceRow}>
      <div data-audit-label>
        <div className="text-xs">{label}</div>
        <div className="text-2xs text-faint">{hint}</div>
      </div>
      <div data-audit-control className="max-w-full shrink-0">
        {children}
      </div>
    </div>
  );
}

const models = [
  { value: "claude", label: "Claude" },
  { value: "claude-opus", label: "Claude Opus 5.5" },
  { value: "claude-sonnet", label: "Claude Sonnet 5.5" },
  { value: "claude-haiku", label: "Claude Haiku 5.5" },
  { value: "codex", label: "Codex" },
  { value: "deepseek", label: "DeepSeek v4.1 Flash" },
];
const efforts = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

function App() {
  return (
    <div className="@container/settings mx-auto max-w-3xl p-4">
      <header className="mb-3 flex h-8 items-center border-b border-border px-4 text-[13px] font-semibold">Settings</header>
      <section className="border-b border-border p-3">
        <h2
          data-label=""
          className="label-caps -mx-3 -mt-3 mb-3 flex h-9 items-center border-b border-border px-3 text-2xs text-fg"
        >
          Preferences
        </h2>
        <Row id="grouping" label="Session list grouping" hint="Group sessions by project directory">
          <Tabs value="flat" onValueChange={() => undefined}>
            <TabsList className="w-40">
              <TabsTab value="flat">Flat</TabsTab>
              <TabsTab value="directory">Directory</TabsTab>
            </TabsList>
          </Tabs>
        </Row>
        <div className="mt-3" />
        <Row id="language" label="Language" hint="Auto follows the browser language">
          <Tabs value="en" onValueChange={() => undefined}>
            <TabsList className="w-72 max-w-full">
              <TabsTab value="auto">Auto</TabsTab>
              <TabsTab value="en">EN</TabsTab>
              <TabsTab value="zh-CN">简体</TabsTab>
              <TabsTab value="zh-TW">繁體</TabsTab>
              <TabsTab value="ja">日本語</TabsTab>
            </TabsList>
          </Tabs>
        </Row>
        <div className="mt-3" />
        <Row id="model" label="Model" hint="Which model the agent uses">
          <SelectField value="claude-opus" options={models} onValueChange={() => undefined} />
        </Row>
        <div className="mt-3" />
        <Row id="effort" label="Effort" hint="How long the agent may think">
          <SelectField value="high" options={efforts} onValueChange={() => undefined} />
        </Row>
        <div className="mt-3" />
        <Row id="empty" label="Account" hint="No account is connected yet">
          <SelectField value="" options={[]} onValueChange={() => undefined} />
        </Row>
        <div className="mt-3" />
        <Row id="name" label="Display name" hint="Shown to the other devices">
          <Input defaultValue="kilerd's Mac mini" />
        </Row>
        <div className="mt-3" />
        <Row id="actions" label="Connection" hint="Check the link to the hub">
          <div className="flex gap-1.5">
            <Button variant="secondary">Test</Button>
            <Button variant="primary">Save</Button>
          </div>
        </Row>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
