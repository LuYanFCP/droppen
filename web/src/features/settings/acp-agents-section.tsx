/**
 * Settings › General › ACP agents: the agents this device runs sessions on.
 *
 * Any program that speaks the Agent Client Protocol over stdio can be one;
 * each is an id, a name, the command line that starts it in ACP mode, and the
 * variables it needs. A known agent can be added from the server's built-in
 * descriptions (`GET /api/acp/agents`'s `presets`), which fill in its name,
 * executable and arguments; they stay editable, and nothing is saved until
 * the person saves. Nothing is picked for them: no agent is a default.
 *
 * One block per agent, and one form open at a time. Every session records the
 * agent it ran on: editing an agent changes how its sessions are reopened,
 * and removing one leaves its sessions listed and readable, not continued.
 *
 * The variables are what an API key looks like, so they are never read back —
 * the server says which names are set, and a block typed here replaces them all.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, errorText } from "@/api/errors";
import { GlyphIcon } from "@/components/glyph";
import { SelectField } from "@/components/ui/select";
import { acpAgentsKey, splitArgs, useAcpAgents, type AcpAgentInfo } from "@/features/sessions/acp-agent";
import { ACP_GLYPH, acpAgentGlyph } from "@/features/sessions/acp-agent-icons";
import { applyPreset, CUSTOM_PRESET, newAgentId, type AcpAgentDraft, type AcpAgentPreset } from "@/features/sessions/acp-agent-presets";
import {
  SECTION_TITLE,
  SETTINGS_ACTION,
  SETTINGS_ACTION_DANGER,
  SETTINGS_ACTION_PRIMARY,
  SETTINGS_COLUMN,
  SETTINGS_FIELD,
} from "@/features/settings/layout";
import { cn } from "@/lib/cn";
import { useApi, useMachine } from "@/lib/machines/context";
import { mq } from "@/lib/machines/query";
import { requestConfirm } from "@/plugins/confirm";

/** The form open for a new agent, rather than for one of the configured. */
const ADDING = "";

/** The body of `PUT /api/acp/agents/{id}`. */
type AgentPatch = { name?: string; command?: string; args?: string[]; env?: string };

const ROW =
  "flex flex-col items-start gap-2 @min-[36rem]/settings:flex-row @min-[36rem]/settings:items-center @min-[36rem]/settings:justify-between @min-[36rem]/settings:gap-4";

export function AcpAgentsSection() {
  const { t } = useTranslation();
  const { data } = useAcpAgents();
  // The agent whose form is open, `ADDING` for a new one, `null` for none.
  const [open, setOpen] = useState<string | null>(null);
  const agents = data?.agents ?? [];
  const presets = data?.presets ?? [];
  return (
    <section className="border-b border-border p-3">
      <h2 data-label="" className={SECTION_TITLE}>
        {t("acp agents")}
      </h2>
      <div className={cn(SETTINGS_COLUMN, "flex flex-col gap-3")}>
        <span className="text-xs text-muted">
          {t("Any agent that speaks the Agent Client Protocol (ACP) over stdio can run sessions here, each with its own command line and variables. A session always runs on the agent it was started with.")}
        </span>
        {agents.map((agent) =>
          open === agent.id ? (
            <AgentForm key={agent.id} agent={agent} presets={presets} taken={agents} onDone={() => setOpen(null)} />
          ) : (
            <AgentRow key={agent.id} agent={agent} busy={open !== null} onEdit={() => setOpen(agent.id)} />
          ),
        )}
        {data && agents.length === 0 && open === null && (
          <span className="text-xs text-faint">{t("No ACP agent is set up on this device yet.")}</span>
        )}
        {open === ADDING ? (
          <AgentForm presets={presets} taken={agents} onDone={() => setOpen(null)} />
        ) : (
          <div>
            <button type="button" disabled={open !== null || !data} onClick={() => setOpen(ADDING)} className={SETTINGS_ACTION}>
              {t("add agent")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** One configured agent: its mark, name and command line, and what can be done to it. */
function AgentRow({ agent, busy, onEdit }: { agent: AcpAgentInfo; busy: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const machine = useMachine();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: async () => {
      const res = await api.DELETE("/api/acp/agents/{id}", { params: { path: { id: agent.id } } });
      if (!res.data) throw new ApiError(res.error);
      return res.data;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: acpAgentsKey(machine) });
      void queryClient.invalidateQueries({ queryKey: mq(machine, "models", "acp", agent.id) });
    },
  });
  const askRemove = async () => {
    const yes = await requestConfirm(
      t("Remove {{name}}? Its sessions stay in the list and can be read, but cannot be continued until an agent is added again as “{{id}}”.", {
        name: agent.name,
        id: agent.id,
      }),
      { danger: true, confirmLabel: t("remove") },
    );
    if (yes) remove.mutate();
  };
  const commandLine = [agent.command, ...agent.args].join(" ");
  return (
    <div className={ROW} data-acp-agent-row={agent.id}>
      <div className="flex min-w-0 items-start gap-2">
        <GlyphIcon glyph={acpAgentGlyph(agent.id)} className="mt-0.5 size-3.5 text-muted" />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 text-xs">
            <span>{agent.name}</span>
            <span className="font-mono text-2xs text-faint">{agent.id}</span>
          </div>
          <div className="font-mono text-2xs break-all text-muted">{commandLine}</div>
          {agent.envNames.length > 0 && (
            <div className="font-mono text-2xs break-all text-faint">{t("variables: {{names}}", { names: agent.envNames.join(", ") })}</div>
          )}
          {remove.error && (
            <div data-signal="failed" className="text-2xs break-words text-danger">
              {errorText(remove.error)}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" disabled={busy || remove.isPending} onClick={onEdit} className={SETTINGS_ACTION}>
          {t("edit")}
        </button>
        <button type="button" disabled={busy || remove.isPending} onClick={() => void askRemove()} className={SETTINGS_ACTION_DANGER}>
          {t("remove")}
        </button>
      </div>
    </div>
  );
}

/**
 * The form for one agent: a configured one (`agent`), or a new one, which
 * starts from a preset or from nothing. A new agent's id is its preset's, or
 * its name as a slug; an agent's id never changes.
 */
function AgentForm({
  agent,
  presets,
  taken,
  onDone,
}: {
  agent?: AcpAgentInfo;
  presets: readonly AcpAgentPreset[];
  taken: readonly AcpAgentInfo[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const machine = useMachine();
  const queryClient = useQueryClient();
  const [preset, setPreset] = useState(CUSTOM_PRESET);
  const [draft, setDraft] = useState<AcpAgentDraft>({ name: null, command: null, args: null });
  const [env, setEnv] = useState<string | null>(null);
  const name = draft.name ?? agent?.name ?? "";
  const command = draft.command ?? agent?.command ?? "";
  const args = draft.args ?? agent?.args.join(" ") ?? "";
  const ids = new Set(taken.map((other) => other.id));
  const id = agent?.id ?? newAgentId(name, ids, preset);
  const described = agent ?? presets.find((candidate) => candidate.id === preset);
  const names = agent?.envNames ?? [];

  const save = useMutation({
    mutationFn: async (patch: AgentPatch) => {
      const res = await api.PUT("/api/acp/agents/{id}", { params: { path: { id } }, body: patch });
      if (!res.data) throw new ApiError(res.error);
      return res.data;
    },
    onSuccess: (saved, patch) => {
      void queryClient.invalidateQueries({ queryKey: acpAgentsKey(machine) });
      // Another executable or environment may offer other models.
      void queryClient.invalidateQueries({ queryKey: mq(machine, "models", "acp", saved.id) });
      // Clearing the variables leaves the form open on the rest.
      if (patch.env === "" && Object.keys(patch).length === 1) setEnv(null);
      else onDone();
    },
  });

  const dirty = agent === undefined || draft.name !== null || draft.command !== null || draft.args !== null || env !== null;
  const field = cn(SETTINGS_FIELD, "font-mono");
  const submit = () =>
    save.mutate(
      agent === undefined
        ? { name, command, args: splitArgs(args), ...(env !== null ? { env } : {}) }
        : {
            ...(draft.name !== null ? { name } : {}),
            ...(draft.command !== null ? { command } : {}),
            ...(draft.args !== null ? { args: splitArgs(args) } : {}),
            ...(env !== null ? { env } : {}),
          },
    );

  return (
    <div data-acp-agent-form={agent?.id ?? "new"} className="flex flex-col gap-2 border border-border p-3">
      <div className="flex items-center gap-2 text-xs">
        <GlyphIcon glyph={agent || preset !== CUSTOM_PRESET ? acpAgentGlyph(id) : ACP_GLYPH} className="size-3.5 text-muted" />
        <span className="font-medium">{agent ? agent.name : name.trim() || t("new agent")}</span>
        <span className="font-mono text-2xs text-faint">{id}</span>
      </div>
      {agent === undefined && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t("preset")}</span>
          <SelectField
            aria-label={t("preset")}
            value={preset}
            onValueChange={(next) => {
              setDraft(applyPreset(draft, next, presets));
              setPreset(next);
            }}
            options={[
              { value: CUSTOM_PRESET, label: t("custom (no preset)"), glyph: ACP_GLYPH },
              // One already added is added again as a custom one, under another id.
              ...presets.map((p) => ({ value: p.id, label: p.name, glyph: acpAgentGlyph(p.id), disabled: ids.has(p.id) })),
            ]}
          />
        </div>
      )}
      {described && (described.note || described.homepage) && (
        <span data-preset-hint="" className="text-xs text-muted">
          {described.note}
          {described.note && described.homepage && " · "}
          {described.homepage && (
            <a href={described.homepage} target="_blank" rel="noreferrer" className="underline hover:text-fg">
              {t("learn more")}
            </a>
          )}
        </span>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t("name")}</span>
        <input
          value={name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t("ACP agent")}
          autoComplete="off"
          spellCheck={false}
          className={SETTINGS_FIELD}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t("executable")}</span>
        <input
          value={command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder="/path/to/agent"
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t("arguments (separated by spaces)")}</span>
        <input
          value={args}
          onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          placeholder="acp"
          autoComplete="off"
          spellCheck={false}
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">
          {t("environment (one KEY=VALUE per line)")}
          {names.length > 0 && <> {t("· saved: {{names}} (a new block replaces them all)", { names: names.join(", ") })}</>}
        </span>
        <textarea
          rows={4}
          value={env ?? ""}
          onChange={(e) => setEnv(e.target.value)}
          placeholder={names.length > 0 ? "••••••••" : "KEY=…"}
          autoComplete="off"
          spellCheck={false}
          className={cn(field, "h-auto resize-y py-1.5 max-md:h-auto")}
        />
      </label>
      {save.error && (
        <span data-signal="failed" className="text-xs text-danger">
          {errorText(save.error)}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!dirty || !command.trim() || save.isPending}
          onClick={submit}
          data-variant="primary"
          className={SETTINGS_ACTION_PRIMARY}
        >
          {agent ? t("save") : t("add agent")}
        </button>
        <button type="button" disabled={save.isPending} onClick={onDone} className={SETTINGS_ACTION}>
          {t("cancel")}
        </button>
        {names.length > 0 && (
          <button type="button" disabled={save.isPending} onClick={() => save.mutate({ env: "" })} className={SETTINGS_ACTION}>
            {t("clear variables")}
          </button>
        )}
      </div>
    </div>
  );
}
