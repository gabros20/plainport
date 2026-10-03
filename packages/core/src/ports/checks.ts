// The host's preflight checks (DESIGN.md "Offload process" step 2, "Edge cases → macOS and the environment"): what
// only the platform can answer. Which processes use the folder, which files are placeholders whose data is not on
// this disk, and which containers bind-mount it. @plainport/host-macos answers them with lsof, find -flags and the
// docker CLI. Core turns the answers into findings, so the rules stay platform-neutral and testable with fakes.
//
// A check that cannot give a whole answer fails rather than answering in part: preflight reports its failure as a
// blocker, since an unchecked folder is not known to be safe to delete.

import type { Result } from "@plainport/contract";

export interface CheckContext {
  /** The environment children are given (PATH, HOME, DOCKER_HOST, …); nothing else is inherited. */
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

/** A process, other than plainport itself, that uses the folder. */
export interface ProcessUse {
  pid: number;
  ppid: number;
  /** Its command name, as the system reports it (possibly cut short). */
  command: string;
  /** One of plainport's own ancestors: the shell or agent that started it. */
  ancestor: boolean;
  /** Its working directory is the folder or inside it. */
  cwd: boolean;
  /** Paths inside the folder it holds open (files, mapped libraries, its executable), at most 50. */
  files: string[];
  /** How many it holds open in all. */
  fileCount: number;
}

export type DockerMounts =
  | {
      available: true;
      /** Bind mounts of running containers whose source is the folder or inside it. */
      mounts: { container: string; name: string; source: string }[];
    }
  /** Docker is not installed, or its daemon is not running: nothing can mount the folder, so nothing to check. */
  | { available: false; reason: string };

export interface HostChecks {
  /** Processes with files open or their working directory inside the folder. */
  processesUsing(dir: string, ctx: CheckContext): Promise<Result<ProcessUse[]>>;
  /** Placeholder (dataless) files and folders inside the folder, relative to it; their data is not on this disk. */
  dataless(dir: string, ctx: CheckContext): Promise<Result<string[]>>;
  /** Running containers that bind-mount the folder. */
  dockerMounts(dir: string, ctx: CheckContext): Promise<Result<DockerMounts>>;
}
