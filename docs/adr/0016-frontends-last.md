# ADR-0016 — Frontends last: TUI, then a SwiftUI app over `serve --stdio` (2026-10-01)

**Context.** A TUI and a desktop app are wanted, but building them early would freeze a plan and event
contract that is still moving.

**Decision.** The core exposes `plan()` and `run()`, and every frontend renders the same `Plan` and event stream.
The CLI calls the core in-process. `plainport serve --stdio` (JSON-RPC 2.0 as NDJSON) serves agents and peers
from M4. The TUI (Ink by default) and the SwiftUI desktop app, which runs the binary as a sidecar, come at M6.
`.plainport` stubs open on double-click from M6.

**Why.** By M6 the contract has carried four milestones of real use. Zod schemas exported as JSON Schema give the
Swift app typed models without a second source of truth.

**Consequences.** No frontend-only behaviour: anything a frontend shows must exist in the core's plan or events.

**Status.** Accepted (owner, 2026-10-01).

**Design.** Architecture; Core API (remote control); Build plan M6; Decisions (desktop app: SwiftUI).
