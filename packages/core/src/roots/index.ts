// Roots, project boundaries and project addresses (DESIGN.md "Roots", ADR-0010).

export { type ProjectMatch, type ProjectRef, type ResolveOptions, resolveProject } from "./address.ts";
export {
  DEFAULT_SCAN_DEPTH,
  type FoundProject,
  findProjects,
  PROJECT_MARKERS,
  type ProjectMarker,
  projectAt,
} from "./boundary.ts";
export {
  folderSize,
  LIKELY_ROOTS,
  type RootCandidate,
  rootCandidates,
  rootKeyFrom,
  SIZE_BUDGET_MS,
  SIZE_SKIPPED,
  type SkippedCandidate,
} from "./candidates.ts";
export { type CanonicalPath, canonicalPath, overlapByIdentity, overlapOf } from "./canonical.ts";
export {
  bindingPath,
  displayPath,
  type ListOptions,
  listRoots,
  type RootChange,
  type RootState,
  type RootView,
  type WriteRootsOptions,
  type WrittenRoots,
  writeRoots,
} from "./roots.ts";
export { boundRoot, type ScannedProject, type ScanOptions, scanRoot } from "./scan.ts";
