// @plainport/eco-node — The Node ecosystem plugin: lockfiles, regenerable folders and hydration.

export const packageName = "@plainport/eco-node";
export {
  choosePackageManager,
  LOCKFILES,
  MANAGER_NAMES,
  type PackageManager,
  type PackageManagerChoice,
  type PackageManagerInput,
} from "./detect.ts";
export { nodePlugin } from "./plugin.ts";
export { type OutputFolder, scriptWriting } from "./scripts.ts";
