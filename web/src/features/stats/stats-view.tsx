import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { components } from "@/api/schema";
import { Content } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { QuotaReadingNote } from "@/features/accounts/quota-bits";
import { cn } from "@/lib/cn";
import { formatCompact, formatDay, formatInt, formatResetAt, formatUntil, formatUSD } from "@/lib/format";
import { useApi, useMachine } from "@/lib/machines/context";
import { mq } from "@/lib/machines/query";

type UsageStats = components["schemas"]["UsageStats"];
type DayUsage = UsageStats["daily"][number];
type ModelUsage = UsageStats["byModel"][number];
type Quota = components["schemas"]["Quota"];
type QuotaWindow = NonNullable<Quota["codex"]>["windows"][number];

const WINDOWS = [7, 30, 90] as const;

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-border bg-panel px-3 py-2">
      <div className="font-mono text-2xs tracking-wider text-faint uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-lg text-fg tabular-nums" title={hint}>
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h2 className="mb-2 font-mono text-2xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

/** Headline "what this would have cost at API rates" — the value of the subscription. */
function CostBanner({ totals, unpriced, overridePath }: { totals: UsageStats["totals"]; unpriced: string[]; overridePath: string }) {
  const { t } = useTranslation();
  return (
    <div className="rounded border border-accent/30 bg-accent/[0.06] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-2xs tracking-wider text-accent uppercase">{t("estimated cost")}</div>
          <div className="mt-0.5 font-mono text-2xl text-fg tabular-nums" title={`$${totals.costUSD.toFixed(2)}`}>
            {formatUSD(totals.costUSD)}
          </div>
        </div>
        <div className="max-w-[55%] text-right font-mono text-2xs text-faint" title={overridePath}>
          {t("at pay-as-you-go API rates · you're on a subscription")}
          {unpriced.length > 0 && (
            <div data-signal="warn" className="mt-1 text-warn-fg" title={unpriced.join("\n")}>
              {t("{{n}} models unpriced", { n: unpriced.length })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tokens per calendar day; height is scaled to the busiest day in the window. */
function DailyChart({ days }: { days: DayUsage[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...days.map((d) => d.total));
  const step = Math.max(1, Math.ceil(days.length / 6));
  return (
    <div>
      <div className="flex h-28 items-end gap-px border-b border-border">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${formatDay(d.date)} · ${formatInt(d.total)} ${t("tokens")}`}
            className="group flex h-full min-w-[2px] flex-1 items-end"
          >
            <div
              className="w-full rounded-t-[2px] bg-accent/70 transition-colors group-hover:bg-accent"
              style={{ height: `${(d.total / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-px">
        {days.map((d, i) => (
          <div key={d.date} className="min-w-[2px] flex-1 text-center font-mono text-[9px] text-faint">
            {i % step === 0 ? formatDay(d.date) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal stacked bar splitting the window's tokens by how they were charged. */
function CompositionBar({ totals }: { totals: UsageStats["totals"] }) {
  const { t } = useTranslation();
  const parts = [
    { key: "input", label: t("input"), value: totals.input, cls: "bg-accent" },
    { key: "cacheWrite", label: t("cache write"), value: totals.cacheWrite, cls: "bg-warn" },
    { key: "cacheRead", label: t("cache read"), value: totals.cacheRead, cls: "bg-accent/35" },
    { key: "output", label: t("output"), value: totals.output, cls: "bg-ok" },
  ];
  const sum = Math.max(1, totals.input + totals.output + totals.cacheRead + totals.cacheWrite);
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded bg-raised">
        {parts.map(
          (p) =>
            p.value > 0 && (
              <div
                key={p.key}
                className={p.cls}
                style={{ width: `${(p.value / sum) * 100}%` }}
                title={`${p.label}: ${formatInt(p.value)}`}
              />
            ),
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-1.5 font-mono text-2xs">
            <span className={cn("size-2 rounded-[2px]", p.cls)} />
            <span className="text-muted">{p.label}</span>
            <span className="text-fg tabular-nums" title={formatInt(p.value)}>
              {formatCompact(p.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelBars({ models }: { models: ModelUsage[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...models.map((m) => m.total));
  return (
    <div className="flex flex-col gap-1.5">
      {models.map((m) => (
        <div key={`${m.source} ${m.model}`} className="flex items-center gap-2">
          <div className="w-24 shrink-0 truncate font-mono text-2xs md:w-40" title={m.model}>
            {m.model}
          </div>
          <Badge variant={m.source === "claude" ? "claude" : "codex"}>{m.source}</Badge>
          <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded bg-raised">
            <div
              className={cn("absolute inset-y-0 left-0", m.source === "claude" ? "bg-claude/60" : "bg-codex/60")}
              style={{ width: `${(m.total / max) * 100}%` }}
            />
          </div>
          <div
            className="w-12 shrink-0 text-right font-mono text-2xs text-muted tabular-nums"
            title={`${formatInt(m.total)} tokens`}
          >
            {formatCompact(m.total)}
          </div>
          <div
            className="w-14 shrink-0 text-right font-mono text-2xs tabular-nums"
            title={m.cost === null ? t("unpriced") : `$${m.cost.toFixed(2)}`}
          >
            {m.cost === null ? <span className="text-faint">—</span> : <span data-signal="ok" className="text-ok">{formatUSD(m.cost)}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function QuotaBar({ w, source }: { w: QuotaWindow; source: "claude" | "codex" }) {
  const { t } = useTranslation();
  const used = Math.min(100, Math.max(0, w.usedPercent));
  const tone = used >= 90 ? "bg-danger" : used >= 70 ? "bg-warn" : source === "claude" ? "bg-claude" : "bg-codex";
  const resetAt = formatResetAt(w.resetsAt);
  return (
    <div>
      {/* Wraps the reset info to its own line rather than crushing the label;
          see the matching header in `QuotaWindowRow`. */}
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 font-mono text-2xs">
        <span className="min-w-0 flex-auto truncate text-muted">{w.label}</span>
        <span className="shrink-0 tabular-nums text-fg">
          {w.remainingPercent}% {t("left")}
        </span>
        {w.resetsAt && (
          <span
            className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-faint"
            title={resetAt ? new Date(w.resetsAt).toLocaleString() : undefined}
          >
            {t("resets in")} {formatUntil(w.resetsAt)}
            {resetAt && ` · ${resetAt}`}
          </span>
        )}
      </div>
      <div className="h-2 overflow-hidden rounded bg-raised">
        <div className={cn("h-full rounded", tone)} style={{ width: `${used}%` }} />
      </div>
    </div>
  );
}

/** Rolling-window usage for one CLI: Codex asks its app server, Claude via /usage. */
function QuotaWindows({ windows, source }: { windows: QuotaWindow[]; source: "claude" | "codex" }) {
  const { t } = useTranslation();
  if (windows.length === 0) return <p className="font-mono text-2xs text-faint">{t("no window data")}</p>;
  return (
    <div className="flex flex-col gap-2">
      {windows.map((w) => (
        <QuotaBar key={`${w.label} ${w.windowMinutes}`} w={w} source={source} />
      ))}
    </div>
  );
}

/** Subscription quota: rolling-window usage per CLI. */
function QuotaSection() {
  const api = useApi();
  const machine = useMachine();
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: mq(machine, "quota"),
    queryFn: async () => (await api.GET("/api/stats/quota")).data,
    staleTime: 60_000,
  });
  if (!data || (!data.claude && !data.codex)) return null;
  return (
    <Section title={t("subscription quota")}>
      <div className="grid gap-2 sm:grid-cols-2">
        {data.codex && (
          <div className="rounded border border-border bg-panel p-3">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="codex">codex</Badge>
              {data.codex.plan && <span className="font-mono text-2xs text-faint">{data.codex.plan}</span>}
            </div>
            <QuotaWindows windows={data.codex.windows} source="codex" />
            {/* The age, the source and the "you are out" flag belong beside the
                bars, not in a tooltip: a panel that showed neither is how a
                fully spent account read as having 30% of its week left. */}
            <QuotaReadingNote
              className="mt-2"
              updatedAt={data.codex.updatedAt}
              source={data.codex.source}
              blocked={data.codex.blocked}
            />
          </div>
        )}
        {data.claude && (
          <div className="rounded border border-border bg-panel p-3">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="claude">claude</Badge>
              {data.claude.plan && <span className="font-mono text-2xs text-faint">{data.claude.plan}</span>}
            </div>
            <QuotaWindows windows={data.claude.windows} source="claude" />
            <QuotaReadingNote className="mt-2" updatedAt={data.claude.updatedAt} source={data.claude.source} />
          </div>
        )}
      </div>
    </Section>
  );
}

function Dashboard({ data }: { data: UsageStats }) {
  const { t } = useTranslation();
  const { totals } = data;
  return (
    <>
      <CostBanner totals={totals} unpriced={data.pricing.unpricedModels} overridePath={data.pricing.overridePath} />

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={t("total tokens")} value={formatCompact(totals.total)} hint={formatInt(totals.total)} />
        <StatTile label={t("input")} value={formatCompact(totals.input)} hint={formatInt(totals.input)} />
        <StatTile label={t("output")} value={formatCompact(totals.output)} hint={formatInt(totals.output)} />
        <StatTile label={t("cache read")} value={formatCompact(totals.cacheRead)} hint={formatInt(totals.cacheRead)} />
        <StatTile
          label={t("cache write")}
          value={formatCompact(totals.cacheWrite)}
          hint={formatInt(totals.cacheWrite)}
        />
        <StatTile label={t("sessions")} value={formatInt(totals.sessions)} />
      </div>

      <Section title={t("tokens per day")}>
        <DailyChart days={data.daily} />
      </Section>

      <Section title={t("composition")}>
        <CompositionBar totals={totals} />
      </Section>

      {data.bySource.length > 0 && (
        <Section title={t("by source")}>
          <div className="flex flex-wrap gap-2">
            {data.bySource.map((s) => (
              <div
                key={s.source}
                className="flex items-center gap-2 rounded border border-border bg-panel px-3 py-1.5"
              >
                <Badge variant={s.source === "claude" ? "claude" : "codex"}>{s.source}</Badge>
                <span className="font-mono text-xs text-fg tabular-nums" title={formatInt(s.total)}>
                  {formatCompact(s.total)}
                </span>
                {s.cost > 0 && <span data-signal="ok" className="font-mono text-2xs text-ok tabular-nums">{formatUSD(s.cost)}</span>}
                <span className="font-mono text-2xs text-faint">
                  {s.sessions} {t("sessions")}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {data.byModel.length > 0 && (
        <Section title={t("by model")}>
          <ModelBars models={data.byModel} />
        </Section>
      )}

      <p className="mt-6 font-mono text-2xs text-faint">
        {t("since")} {data.since} · {t("updated")} {new Date(data.generatedAt).toLocaleTimeString()}
      </p>
    </>
  );
}

export function StatsView() {
  const api = useApi();
  const machine = useMachine();
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(30);
  const { data, isPending } = useQuery({
    queryKey: mq(machine, "usage", days),
    queryFn: async () => (await api.GET("/api/stats/usage", { params: { query: { days } } })).data,
    staleTime: 30_000,
  });

  return (
    <Content>
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-panel px-3">
        <span className="font-mono text-xs">{t("Usage")}</span>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <TabsList className="w-40">
            {WINDOWS.map((w) => (
              <TabsTab key={w} value={String(w)}>
                {w}d
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-4xl">
          <QuotaSection />
          <div className="mt-5 first:mt-0">
            {isPending && <Spinner />}
            {data &&
              (data.totals.total === 0 ? (
                <p className="p-6 text-center font-mono text-2xs text-faint">{t("no token usage recorded yet")}</p>
              ) : (
                <Dashboard data={data} />
              ))}
          </div>
        </div>
      </div>
    </Content>
  );
}
