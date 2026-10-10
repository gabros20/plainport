# ADR-0006 — restic for project data, rclone for catalog metadata, both pinned (2026-09-30)

**Context.** An offload must move 30,000 to 300,000 small files with deduplication, encryption and an atomic
snapshot, and the repository must stay readable if plainport is abandoned. Beside it, plainport keeps a few
kilobytes of catalog events that every machine must read.

**Decision.** restic is the only engine for project data, behind the `Engine` port. rclone carries catalog
events to buckets and SFTP, behind the `BlobStore` port; `node:fs` serves local disks and peer RPC serves
devices running plainport. plainport bundles pinned restic (0.17.1 or later, for the exit codes it maps; raised to 0.18.0 or later by run
decision D93 on 2026-10-10, for the JSON output of `check` and `restore`) and
rclone binaries, so every device runs the tested versions. OpenDAL is the fallback if conditional writes ever
become required.

**Why.** restic gives content-defined deduplication, authenticated encryption, `restic check`, JSON-lines
output and stable exit codes, and a stock `restic` can still read every repository. A generic file SDK would
rebuild restic badly. rclone needs no native module (ADR-0004) and runs under the same process runner. The
metadata layer needs only put, get and prefix listing, because events are immutable ULID-named files.

**Consequences.** M1 needs a pinned restic binary for development and tests (it is not installed on the
owner's laptop as of 2026-10-02); M2 adds rclone. Recorded restic JSON-lines fixtures are kept per supported
restic version. A REST-server store can't hold metadata, so peer stores are preferred.

**Status.** Accepted (owner, 2026-09-30).

**Design.** Storage: engine and metadata; Plugin interfaces (`Engine`, `BlobStore`).
