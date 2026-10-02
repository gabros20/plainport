// The environment for a test's child process whose plainport paths must land in `home`. The XDG variables are set
// explicitly, because the test runner's own (the home tripwire's sandbox) would otherwise outrank HOME.

import { join } from "node:path";

export const childEnv = (
  home: string,
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  ...extra,
});
