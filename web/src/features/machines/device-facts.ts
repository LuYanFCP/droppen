/*
 * What a device that runs AI says of itself, as people read it: its system
 * and its agent's version (its info, `MachineInfo.os` / `agentVersion`). Shown
 * on its row in 「我的设备」 and in its details.
 */

/** A system as people call it, from the name the agent reports (Node's `process.platform`). */
export function osLabel(platform: string | null | undefined): string | null {
  if (!platform) return null;
  switch (platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    default:
      return platform;
  }
}

/** The agent's version as it reads: `v0.2.112`, without the build's commit (kept for the tooltip). */
export function versionLabel(version: string | null | undefined): string | null {
  if (!version) return null;
  const bare = version.split("+")[0]!.trim();
  return bare ? `v${bare.replace(/^v/, "")}` : null;
}
