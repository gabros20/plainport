// Every registered command, in help order. Later milestones add entries here; nothing else lists commands.

import type { Registry } from "../registry.ts";
import { help } from "./help.ts";
import { init } from "./init.ts";
import { offload } from "./offload.ts";
import { rootAdd, rootBind, rootList, rootScan } from "./root.ts";
import { version } from "./version.ts";

export const REGISTRY: Registry = [help, init, offload, rootAdd, rootBind, rootList, rootScan, version];
