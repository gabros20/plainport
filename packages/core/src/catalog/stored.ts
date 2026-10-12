// Where a snapshot is stored (Q11, location by containment): until M3's replication, a snapshot event has exactly one
// `stored` entry, and that entry describes the store whose catalog holds the event. A reader takes the location from
// the store it read the event from and never interprets the key, so neither its shape nor this device's alias for the
// store matters: two devices calling one store `archive` and `nas`, one device with two names for it, and an M1 alias
// shaped like a ULID all resolve to the store that was read. An event with zero or several entries is skipped as
// unsupported (catalog.event-skipped, stored-multiple; log.ts), which makes the fold uncertain (D86).
//
// Writers keep the rule: one entry, keyed by the store's id on a format-2 store and by this device's alias on a
// format-1 store, since v0.1.1 looks up `stored[<its alias>]`. appendEvent refuses any other count.

/** The reason a snapshot event with zero or several `stored` entries is skipped (catalog.event-skipped). */
export const STORED_MULTIPLE = "stored-multiple";

/** The key of the one `stored` entry a writer gives an event it appends to this store (Q11). */
export const storedKey = (store: { name: string; id: string }, format: 1 | 2): string =>
  format === 2 ? store.id : store.name;

/** The event's location on the store it was read from: the restic id of its one entry, undefined unless exactly one. */
export const storedHere = (stored: Readonly<Record<string, string>>): string | undefined => {
  const ids = Object.values(stored);
  return ids.length === 1 ? ids[0] : undefined;
};
