// Merging config layers (DESIGN.md "Merging and writing"): tables merge key by key at every depth, arrays and
// scalars replace, and a key that is absent or undefined in a higher layer leaves the lower value in place.

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Sets an own property, so a `__proto__` key from a file stays data instead of changing a prototype. */
const define = (table: Table, key: string, value: unknown): void => {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
};

/** A copy sharing no tables or arrays with the original. */
const copy = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copy);
  if (!isTable(value)) return value;
  const out: Table = {};
  for (const [key, child] of Object.entries(value)) if (child !== undefined) define(out, key, copy(child));
  return out;
};

const mergeInto = (base: Table, layer: Table): void => {
  for (const [key, value] of Object.entries(layer)) {
    if (value === undefined) continue;
    const current = Object.hasOwn(base, key) ? base[key] : undefined;
    if (isTable(current) && isTable(value)) mergeInto(current, value);
    else define(base, key, copy(value));
  }
};

/** Merges layers from lowest to highest precedence into a new table; the layers are not changed. */
export const mergeLayers = (layers: readonly unknown[]): Table => {
  const out: Table = {};
  for (const layer of layers) if (isTable(layer)) mergeInto(out, layer);
  return out;
};
