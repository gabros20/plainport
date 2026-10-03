// Every registered command, in help order. Later milestones add entries here; nothing else lists commands.

import type { Registry } from "../registry.ts";
import { help } from "./help.ts";
import { init } from "./init.ts";
import { offload } from "./offload.ts";
import { dehydrate, hydrate, onload } from "./onload.ts";
import { gc, recover, restore } from "./recover.ts";
import { rootAdd, rootBind, rootList, rootScan } from "./root.ts";
import { ls, status } from "./status.ts";
import { version } from "./version.ts";

export const REGISTRY: Registry = [
  help,
  init,
  ls,
  status,
  offload,
  onload,
  hydrate,
  dehydrate,
  restore,
  recover,
  gc,
  rootAdd,
  rootBind,
  rootList,
  rootScan,
  version,
];
