// Host checks that find nothing: no process uses the folder, no file is a placeholder, docker is not running. For
// tests of what comes after preflight (the scan, the plan); preflight's own tests fake each check instead.

import { ok } from "@plainport/contract";
import type { HostChecks } from "../ports/checks.ts";

export const quietChecks: HostChecks = {
  processesUsing: async () => ok([]),
  dataless: async () => ok({ placeholders: [], unsearchable: [] }),
  dockerMounts: async () => ok({ available: false, reason: "docker is not installed" }),
};
