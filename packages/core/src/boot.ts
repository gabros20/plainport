// Whether something recorded earlier is from this host's current boot (Q5 i). A boot session is an id the kernel
// makes at every boot (macOS `kern.bootsessionuuid`, Linux `/proc/sys/kernel/random/boot_id`), so no clock step can
// move it. When both the record and this host have one, it alone decides. Otherwise M1's rules do, which read the
// boot time as the clock minus uptime and so move with every step of the clock: a recorded boot time within
// SAME_BOOT_MS of this one (the trash claim, D64), or a start no earlier than this boot (the lock, D63).

import { assertSystemError, type ProcessInfo } from "./io.ts";
import type { HostPorts } from "./ports/host.ts";

/** Boot times computed at different moments differ by the clock's drift against uptime; a reboot moves it far more. */
export const SAME_BOOT_MS = 120_000;

/** What a record says about the boot it was written in; epoch milliseconds. */
export interface BootMark {
  /** The host's boot time as the writer computed it. */
  bootedAt?: number;
  /** When the writer started, for a record that holds no boot time. */
  startedAt?: number;
  /** The boot session the writer ran in. */
  session?: string;
}

/** Whether `mark` is from this boot; `session` is this host's boot session now, undefined when it cannot be read. */
export const fromThisBoot = (
  proc: Pick<ProcessInfo, "bootedAtMs">,
  mark: BootMark,
  session: string | undefined,
): boolean => {
  if (mark.session !== undefined && session !== undefined) return mark.session === session;
  const booted = proc.bootedAtMs();
  if (mark.bootedAt !== undefined) return Math.abs(mark.bootedAt - booted) <= SAME_BOOT_MS;
  return mark.startedAt !== undefined && mark.startedAt >= booted;
};

const SESSION = /^[0-9A-Fa-f-]{16,64}$/;

/**
 * This host's boot session, for HostPorts.bootSession: undefined on a platform without one, or when it cannot be
 * read, so callers fall back to M1's rules. macOS has no file for it, so `sysctl` runs through the one runner.
 */
export const readBootSession = async (
  host: Pick<HostPorts, "run" | "fs">,
  platform: string,
): Promise<string | undefined> => {
  let text: string;
  if (platform === "darwin") {
    const ran = await host.run({
      command: "/usr/sbin/sysctl",
      args: ["-n", "kern.bootsessionuuid"],
      cwd: "/",
      env: {},
      idleTimeoutMs: 5_000,
      timeoutMs: 5_000,
      outputLimitBytes: 4_096,
    });
    if (!ran.ok || ran.value.exitCode !== 0) return undefined;
    text = ran.value.stdout.text;
  } else if (platform === "linux") {
    try {
      text = await host.fs.readText("/proc/sys/kernel/random/boot_id");
    } catch (error) {
      assertSystemError(error);
      return undefined;
    }
  } else return undefined;
  const session = text.trim();
  return SESSION.test(session) ? session : undefined;
};
