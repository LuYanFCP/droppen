import { useQuery } from "@tanstack/react-query";
import { useApi, useMachine } from "@/lib/machines/context";
import { mq } from "@/lib/machines/query";
import type { MachineKey } from "@/lib/machines/key";

/** Where this machine's ACP agent settings are cached. */
export const acpSettingsKey = (machine: MachineKey) => mq(machine, "acp-settings");

/** How this machine starts its ACP agent: its name, command line and variable names. */
export function useAcpSettings() {
  const api = useApi();
  const machine = useMachine();
  return useQuery({
    queryKey: acpSettingsKey(machine),
    queryFn: async () => (await api.GET("/api/acp/settings")).data,
  });
}

/** Arguments as typed into one field: separated by whitespace, no quoting. */
export function splitArgs(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}
