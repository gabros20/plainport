// Where a store is, as config resolves it (never a secret), and the facts a measurement of it holds for (Q4): the
// endpoint, how this device reaches it, and the restic and rclone versions this build carries. `store list` shows the
// location, `store test` records its measurement under the facts, and a change to any of them drops the measurement.

import type { Store } from "../config/schema.ts";
import { expandHome } from "../paths.ts";
import type { StoreFacts } from "../stores-state.ts";

/** The pinned tools' versions this build runs with (tools.lock.json), which a measurement's facts name. */
export interface ToolVersions {
  restic: string;
  rclone: string;
}

/** Where the store is: a local folder (absolute), `sftp:<host>:<path>`, `s3:<endpoint>/<bucket>[/<path>]`, a peer's. */
export const storeLocation = (store: Store, home: string): string => {
  switch (store.kind) {
    case "local":
      return expandHome(store.path, home, home);
    case "sftp":
      return `sftp:${store.host}:${store.path}`;
    case "s3":
      return `s3:${store.endpoint.replace(/\/+$/, "")}/${store.bucket}${store.path === undefined ? "" : `/${store.path}`}`;
    case "peer":
      return `peer:${store.device}:${store.path}`;
  }
};

/** What a measurement of the store holds for; rclone only for a store reached through rclone (sftp, s3). */
export const storeFacts = (store: Store, home: string, tools: ToolVersions): StoreFacts => ({
  endpoint: storeLocation(store, home),
  access: store.kind,
  restic: tools.restic,
  ...(store.kind === "sftp" || store.kind === "s3" ? { rclone: tools.rclone } : {}),
});
