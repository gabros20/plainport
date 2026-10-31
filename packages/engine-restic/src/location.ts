// Where restic finds a store's repository (DESIGN.md "Storage → Store kinds", "Layout on every store"; Q7). One store
// definition gives both layers, so the restic location here and the rclone remote the opener builds name the same
// prefix: the store's root, then the repository's place under it (`repo` for an M1 store, `repos/<attempt>` for one
// bootstrap set up), which the store's published store.json says.
//
//   local   <root>/<repo>                                        a path
//   sftp    sftp:<host>:<path>/<repo>                            through the system's ssh, from the child's PATH, with
//                                                                BatchMode=yes and strict host keys (SSH policy)
//   s3      s3:<endpoint>/<bucket>[/<path>]/<repo>               -o s3.region=<region> when config sets one
//
// The S3 key pair reaches restic only as AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the child's environment (the
// engine's secretEnv), never in argv; AWS_SESSION_TOKEN is never given (Q7: no temporary credentials in M2). Nothing
// here is a secret: the location and the extended options may be shown in messages.

import { join } from "node:path";

/** The ssh options every SFTP run uses, restic's and rclone's alike: nothing ever prompts, and only known hosts. */
export const SSH_POLICY = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"] as const;

/** The ssh command line that reaches an SFTP store's host: `ssh` from the child's PATH, with SSH_POLICY. */
export const sshCommand = (host: string): string => ["ssh", ...SSH_POLICY, host].join(" ");

export type StoreLocation =
  /** A folder, absolute. */
  | { kind: "local"; root: string }
  /** An ssh host (an alias of the ssh config, or a name) and the store's folder on it. */
  | { kind: "sftp"; host: string; path: string }
  /** An S3 endpoint URL, a bucket and an optional prefix inside it. */
  | { kind: "s3"; endpoint: string; bucket: string; path?: string; region?: string };

export interface ResticTarget {
  /** restic's --repo. */
  repository: string;
  /** restic's -o key=value options. */
  extended: string[];
}

/** The store's root as restic names it, without a repository under it. */
export const storeRootUrl = (location: StoreLocation): string => {
  switch (location.kind) {
    case "local":
      return location.root;
    case "sftp":
      return `sftp:${location.host}:${location.path.replace(/\/+$/, "") || "/"}`;
    case "s3":
      return `s3:${location.endpoint.replace(/\/+$/, "")}/${location.bucket}${location.path === undefined ? "" : `/${location.path}`}`;
  }
};

/** The restic location of the repository at `repo` (relative to the store's root) and the options it needs. */
export const resticTarget = (location: StoreLocation, repo: string): ResticTarget => {
  switch (location.kind) {
    case "local":
      return { repository: join(location.root, repo), extended: [] };
    case "sftp": {
      const root = storeRootUrl(location);
      return {
        repository: `${root}${root.endsWith("/") ? "" : "/"}${repo}`,
        extended: [`sftp.command=${sshCommand(location.host)} -s sftp`],
      };
    }
    case "s3":
      return {
        repository: `${storeRootUrl(location)}/${repo}`,
        extended: location.region === undefined ? [] : [`s3.region=${location.region}`],
      };
  }
};

/** The S3 key pair as restic reads it from its environment. */
export const s3Environment = (credentials: {
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> => ({
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
});
