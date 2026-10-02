// The app version (ADR-0020). Imported as text, so `bun build --compile` bakes VERSION into the binary.
import raw from "../../../VERSION" with { type: "text" };

export const VERSION = raw.trim();
