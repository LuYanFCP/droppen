import { useTranslation } from "react-i18next";
import {
  ENV_MAX_VARS,
  type EnvBlockIssue,
  type EnvBlockWarning,
} from "@/features/accounts/env-block";
import type { AccountProvider } from "@/features/accounts/use-accounts";
import { cn } from "@/lib/cn";

/**
 * The one box an env account is entered in, shared by the add form and the
 * re-authorization dialog so both spell the rules the same way.
 *
 * A block rather than a field per variable: what people have in hand is a few
 * lines out of a shell profile or a vendor's setup page, and asking them to
 * split it into a key, a URL and a model name was the thing this replaced.
 */

/** What each CLI does with the block, said once beside the box. */
const HELP: Record<AccountProvider, string> = {
  claude:
    "The whole block is injected into the claude process this account starts. Common: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL.",
  codex:
    "OPENAI_API_KEY becomes the api key of the model provider Droppen defines for codex, and OPENAI_BASE_URL its base url; everything else is injected as-is.",
};

const PLACEHOLDER: Record<AccountProvider, string> = {
  claude: "ANTHROPIC_AUTH_TOKEN=sk-…\nANTHROPIC_BASE_URL=https://…",
  codex: "OPENAI_API_KEY=sk-…\nOPENAI_BASE_URL=https://api.openai.com/v1",
};

/** The first problem with the block, named with the line it is on. */
function IssueText({ issue }: { issue: EnvBlockIssue }) {
  const { t } = useTranslation();
  const text = (() => {
    switch (issue.code) {
      case "empty":
        return t("add at least one KEY=VALUE line");
      case "too_large":
        return t("this block is too large (8 KiB max)");
      case "too_many":
        return t("at most {{max}} variables", { max: ENV_MAX_VARS });
      case "syntax":
        return t("line {{line}} is not KEY=VALUE", { line: issue.line });
      case "denied":
        return t("{{key}} cannot be set here", { key: issue.key });
      case "duplicate":
        return t("{{key}} is set twice, on line {{line}}", { key: issue.key, line: issue.line });
      case "bad_url":
        return t("{{key}} must be an http:// or https:// url", { key: issue.key });
      case "codex_key_missing":
        return t("codex needs OPENAI_API_KEY");
    }
  })();
  return <span data-signal="failed" className="font-mono text-2xs text-danger">{text}</span>;
}

/**
 * Something the block would be stored with and then fail on. Amber rather than
 * red, and beside the box rather than in place of the save button: it is a
 * guess about intent, and the one person it would be wrong for is the one who
 * really does host their endpoint under a second `/v1`.
 */
function WarningText({ warning }: { warning: EnvBlockWarning }) {
  const { t } = useTranslation();
  const text = (() => {
    switch (warning.code) {
      case "base_url_v1":
        return t(
          "ANTHROPIC_BASE_URL usually should not end in /v1 — claude appends /v1/messages itself, so this one would call /v1/v1/messages",
        );
    }
  })();
  return <span data-signal="warn" className="font-mono text-2xs text-warn-fg">{text}</span>;
}

export function EnvBlockField({
  provider,
  value,
  onChange,
  issue,
  warning = null,
  hint,
  autoFocus = false,
}: {
  provider: AccountProvider;
  value: string;
  onChange: (value: string) => void;
  /** The parse result for `value`; shown once there is anything to judge. */
  issue: EnvBlockIssue | null;
  /** A block that parses but looks wrong; said in amber, and never blocking. */
  warning?: EnvBlockWarning | null;
  /** An extra line above the help, for the re-auth dialog's warning. */
  hint?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  // An untouched box is not a mistake: the "add at least one line" complaint
  // waits until the user has typed something to complain about.
  const shown = value.trim() === "" ? null : issue;

  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs text-faint">{t("environment variables (one KEY=VALUE per line)")}</span>
      <textarea
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        rows={6}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PLACEHOLDER[provider]}
        className={cn(
          "w-full resize-y rounded border border-border bg-raised px-2 py-1.5 font-mono text-2xs text-fg",
          "placeholder:text-faint focus:border-accent/60 focus:outline-none",
          shown && "border-danger/60",
        )}
      />
      {hint && <span className="text-2xs text-faint">{hint}</span>}
      <span className="text-2xs text-faint">{t(HELP[provider])}</span>
      {shown && <IssueText issue={shown} />}
      {warning && <WarningText warning={warning} />}
    </label>
  );
}
