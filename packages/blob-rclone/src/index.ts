// @plainport/blob-rclone — The BlobStore port over the pinned rclone CLI (S3 buckets and SFTP).

export const packageName = "@plainport/blob-rclone";
export {
  classifyExit,
  RCLONE_REMOTE,
  type RcloneBlobStore,
  type RcloneBlobStoreOptions,
  type RcloneRemote,
  rcloneBlobStore,
  TEMP_PREFIX,
} from "./rclone-store.ts";
