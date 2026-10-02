# ADR-0013 — Secrets envelope, key custody and no lent tokens (2026-10-01)

**Context.** `.env` files, keys and agent transcripts must travel with a project, but production secrets
should not reach every device a project's code reaches, and restic's repository key opens everything.

**Decision.**
- restic is the only encryption for project data; no outer `tar + age` layer.
- Files matching `secrets.patterns`, and agent transcripts, go into one age-encrypted envelope beside the
  snapshot, sealed to every owner device plus a recovery identity. Workers get it only after
  `plainport secrets grant <project> --to <device>`; otherwise finding `secrets.withheld`.
- Device age identities live in the Secure Enclave on Macs (`age-plugin-se`), in a root-only file on Linux.
  Recovery material (repository passwords, the recovery identity, the prune key) lives in 1Password as
  `op://` references.
- Catalog events on bucket and VPS stores are sealed with XChaCha20-Poly1305.
- plainport never lends git tokens; each device brings its own credentials (deploy key or bot account on
  workers).
- Secrets stay references everywhere: config, logs and agent configs never hold a value.

**Why.** Code and secrets have different audiences. Re-encrypting the whole package would break deduplication
and add nothing over restic's client-side encryption.

**Consequences.** `age` and `age-plugin-se` become bundled binaries from M3. The secrets-envelope suite onloads as
owner, worker and revoked device and asserts which files exist. Logs redact environment values and URLs with
credentials.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Security and encryption; Decisions (1Password, worker secrets withheld, no lent tokens, age envelope).
