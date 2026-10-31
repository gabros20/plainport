// What each backend guarantees through this adapter (DESIGN.md "Remote stores: consistency and publication", Q8),
// as M2 Task 17 measured it on T2 with rclone 1.75.1: the S3 store (SeaweedFS 4.48, D94) and SFTP on OpenSSH through
// the system's ssh. semantics.t2.test.ts measures each property again and checks it against these, so a profile here
// never claims what the measurement no longer shows. A device records what it measured of its own store in that
// store's sidecar (Q4); these are the reference the measurement is compared with, never a substitute for it.
//
// Two properties cannot be shown by a probe, and are stated on the safe side:
// - cancellation: a put whose call failed may still have reached the server (the request was sent, the answer lost),
//   so both are `may-land-late`, asserted by plainport.
// - durability needs a power cut. SeaweedFS keeps an acknowledged write across a restart (measured), but its volume
//   writes fsync only on request (`fsync=true`, off by default), so it is `acked-unsynced`. rclone's SFTP backend
//   never sends fsync@openssh.com although OpenSSH offers it (measured from the SFTP stream), so SFTP is too. Both
//   reach release only through Q21's post-grace proof (R2-6).

import type { StoreSemantics } from "@plainport/core";
import lock from "../../../tools.lock.json" with { type: "json" };

/** The rclone version this plainport bundles, which the profiles below were measured with. */
export const PINNED_RCLONE = lock.tools.rclone.version;

/** The S3 store on T2: SeaweedFS 4.48 behind rclone's S3 backend. */
export const SEAWEEDFS_PROFILE: StoreSemantics = Object.freeze<StoreSemantics>({
  readAfterWrite: { value: true, evidence: "measured" },
  listAfterWrite: { value: true, evidence: "measured" },
  // 2,500 keys over three ListObjectsV2 pages, every one listed.
  listComplete: { value: true, evidence: "measured" },
  publication: { value: "atomic-put", evidence: "measured" },
  // If-None-Match: * through --header-upload: of racing writers exactly one creates the key, the others get 412.
  conditionalCreate: { value: true, evidence: "measured" },
  durability: { value: "acked-unsynced", evidence: "measured" },
  cancellation: { value: "may-land-late", evidence: "asserted" },
});

/** SFTP on OpenSSH (sftp-server's posix-rename@openssh.com), reached through the system's ssh. */
export const SFTP_OPENSSH_PROFILE: StoreSemantics = Object.freeze<StoreSemantics>({
  readAfterWrite: { value: true, evidence: "measured" },
  listAfterWrite: { value: true, evidence: "measured" },
  listComplete: { value: true, evidence: "measured" },
  // The move onto the key is one posix-rename@openssh.com: it replaces a key that is there, whole.
  publication: { value: "temp-then-rename", evidence: "measured" },
  // A rename replaces; this adapter has no create-only route on SFTP.
  conditionalCreate: { value: false, evidence: "asserted" },
  durability: { value: "acked-unsynced", evidence: "measured" },
  cancellation: { value: "may-land-late", evidence: "asserted" },
});

/**
 * AWS S3, by its documentation: strong read-after-write and list consistency
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel), an object shown only once
 * whole, and a success returned only once the object is stored redundantly across devices and Availability Zones
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html). Conditional create through this
 * adapter is measured on the real bucket (Task 28), so it stays unknown here.
 */
export const AWS_S3_DOCUMENTED: StoreSemantics = Object.freeze<StoreSemantics>({
  readAfterWrite: { value: true, evidence: "documented" },
  listAfterWrite: { value: true, evidence: "documented" },
  listComplete: { value: true, evidence: "documented" },
  publication: { value: "atomic-put", evidence: "documented" },
  conditionalCreate: "unknown",
  durability: { value: "durable", evidence: "documented" },
  cancellation: { value: "may-land-late", evidence: "asserted" },
});
