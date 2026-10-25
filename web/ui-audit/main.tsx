/*
 * `scripts/ui-audit` renders this: the real primitives and the real
 * settings-row composition, with no API, router or machine context. It is a
 * fixture, not a product page; keep it in step with `features/settings/` and
 * `components/ui/` when either changes.
 *
 * `web/src/index.css` excludes this directory from Tailwind's scan
 * (`@source not`), so nothing here can change the production stylesheet. That
 * also means every class below must already occur in `web/src`; the layout
 * strings are imported from the settings skeleton for exactly that reason.
 */
import "@/index.css";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { PREFERENCE_ROW, ROW_HINT, ROW_LABEL, SECTION_TITLE } from "@/features/settings/layout";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");

function Row({ id, label, hint, children }: { id: string; label: string; hint: string; children: React.ReactNode }) {
  return (
    <div data-audit-row={id} className={`${PREFERENCE_ROW} mt-3`}>
      <div>
        <div className={ROW_LABEL}>{label}</div>
        <div className={ROW_HINT}>{hint}</div>
      </div>
      <div data-audit-control className="w-full">
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
        <h2 data-label="" className={SECTION_TITLE}>
          Preferences
        </h2>
        <Row id="grouping" label="Session list grouping" hint="Group sessions by project directory">
          <Tabs value="flat" onValueChange={() => undefined}>
            <TabsList className="w-full">
              <TabsTab value="flat">Flat</TabsTab>
              <TabsTab value="directory">Directory</TabsTab>
            </TabsList>
          </Tabs>
        </Row>
        <Row id="language" label="Language" hint="Auto follows the browser language">
          <SelectField
            value="en"
            options={[
              { value: "auto", label: "Auto" },
              { value: "en", label: "EN" },
              { value: "zh-CN", label: "简体" },
              { value: "zh-TW", label: "繁體" },
              { value: "ja", label: "日本語" },
            ]}
            onValueChange={() => undefined}
          />
        </Row>
        <Row id="model" label="Model" hint="Which model the agent uses">
          <SelectField value="claude-opus" options={models} onValueChange={() => undefined} />
        </Row>
        <Row id="effort" label="Effort" hint="How long the agent may think">
          <SelectField value="high" options={efforts} onValueChange={() => undefined} />
        </Row>
        <Row id="empty" label="Account" hint="No account is connected yet">
          <SelectField value="" options={[]} onValueChange={() => undefined} />
        </Row>
        <Row id="name" label="Display name" hint="Shown to the other devices">
          <Input defaultValue="kilerd's Mac mini" />
        </Row>
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
