import { useParams } from "@tanstack/react-router";
import { SessionDetailInner } from "@/features/sessions/session-detail";

/** CLI instant chats are normal claude/codex sessions rendered in chat clothing. */
/** The home's `/chat/claude/$id` or another machine's: the same page. */
export function ClaudeChatView() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <SessionDetailInner source="claude" id={id} chat />;
}

export function CodexChatView() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <SessionDetailInner source="codex" id={id} chat />;
}
