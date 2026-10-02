// Every registered command, in help order. Later milestones add entries here; nothing else lists commands.

import type { Registry } from "../registry.ts";
import { help } from "./help.ts";
import { version } from "./version.ts";

export const REGISTRY: Registry = [help, version];
