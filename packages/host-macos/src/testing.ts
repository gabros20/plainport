// The guarded host for tests: it refuses the real home, taken from the account database (os.userInfo), which no
// HOME or tripwire changes, plus any real home the tripwire names; and it makes this checkout read-only (run
// decision D7). Only tests import it.

import { userInfo } from "node:os";
import { resolve } from "node:path";
import type { GuardPolicy } from "./guard.ts";
import { createMacosHost, type MacosHost, type MacosHostOptions } from "./host.ts";

const checkout = resolve(import.meta.dir, "../../..");

export const testGuard = (): GuardPolicy => {
  const homes = new Set([resolve(userInfo().homedir)]);
  const named = process.env.PLAINPORT_TRIPWIRE_REAL_HOME;
  if (named) homes.add(resolve(named));
  return { refuse: [...homes], readOnly: [checkout] };
};

export const testHost = (options: Omit<MacosHostOptions, "guard"> = {}): MacosHost =>
  createMacosHost({ ...options, guard: testGuard() });
