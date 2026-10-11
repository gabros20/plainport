// Whether everything the current schema allows, a consumer holding the released schema also accepts: the direction that
// matters for what plainport prints (machine-contract §7). A property added, an enum value added to an open set or a
// bound loosened in a printed object is not caught here (additive keys are fine, D16); what is caught is anything
// that makes a valid new output invalid under the old schema: a removed or newly optional key, a changed type, a value
// outside an old enum or const, a looser bound or pattern.
//
// The keywords understood are those plainport's generator emits (UNDERSTOOD below). Annotations (ANNOTATIONS) are
// ignored. Any other keyword the released schema has must be deep-equal in the current one, which errs toward
// reporting a difference.

type Schema = Record<string, unknown> | boolean;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Values a schema admits when it is an enum or a const; undefined when it is neither. */
const valuesOf = (schema: Record<string, unknown>): unknown[] | undefined => {
  if (Array.isArray(schema.enum)) return schema.enum;
  if ("const" in schema) return [schema.const];
  return undefined;
};

const UNDERSTOOD = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "anyOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  "format",
  "additionalProperties",
  "propertyNames",
]);
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "examples", "default", "deprecated"]);

const TYPE_OK: Record<string, string[]> = { integer: ["integer", "number"], number: ["number"] };

const typeOk = (neu: unknown, old: unknown): boolean => {
  const news = Array.isArray(neu) ? neu : [neu];
  const olds = Array.isArray(old) ? old : [old];
  return news.every((n) => olds.some((o) => o === n || (TYPE_OK[n as string] ?? []).includes(o as string)));
};

/** The problems that make `neu` admit something `old` does not; empty when `neu` is assignable to `old`. */
export const notAssignable = (neu: Schema, old: Schema, path = "$"): string[] => {
  if (old === true || (isObject(old) && Object.keys(old).filter((k) => k !== "$schema").length === 0))
    return [];
  if (typeof neu === "boolean" || typeof old === "boolean")
    return same(neu, old)
      ? []
      : [`${path}: ${JSON.stringify(neu)} where ${JSON.stringify(old)} was published`];
  if (Array.isArray(neu.anyOf)) {
    return neu.anyOf.flatMap((branch, i) => notAssignable(branch as Schema, old, `${path}|${i}`));
  }
  if (Array.isArray(old.anyOf)) {
    const tried = old.anyOf.map((branch) => notAssignable(neu, branch as Schema, path));
    return tried.some((p) => p.length === 0)
      ? []
      : [
          `${path}: matches none of the ${old.anyOf.length} published alternatives (${tried.map((p) => p[0]).join("; ")})`,
        ];
  }
  const problems: string[] = [];
  const oldValues = valuesOf(old);
  if (oldValues !== undefined) {
    const newValues = valuesOf(neu);
    if (newValues === undefined) problems.push(`${path}: no longer closed to ${JSON.stringify(oldValues)}`);
    else
      for (const value of newValues)
        if (!oldValues.some((o) => same(o, value)))
          problems.push(
            `${path}: value ${JSON.stringify(value)} is not in the published ${JSON.stringify(oldValues)}`,
          );
  }
  if (old.type !== undefined) {
    if (neu.type === undefined) problems.push(`${path}: lost its type ${JSON.stringify(old.type)}`);
    else if (!typeOk(neu.type, old.type))
      problems.push(
        `${path}: type ${JSON.stringify(neu.type)} where ${JSON.stringify(old.type)} was published`,
      );
  }
  for (const [bound, tighter] of [
    ["minimum", (n: number, o: number) => n >= o],
    ["minLength", (n: number, o: number) => n >= o],
    ["maximum", (n: number, o: number) => n <= o],
    ["maxLength", (n: number, o: number) => n <= o],
    ["minItems", (n: number, o: number) => n >= o],
    ["maxItems", (n: number, o: number) => n <= o],
  ] as const) {
    const o = old[bound];
    if (typeof o !== "number") continue;
    const n = neu[bound];
    if (typeof n !== "number" || !tighter(n, o))
      problems.push(`${path}: ${bound} ${String(n)} where ${o} was published`);
  }
  if (typeof old.pattern === "string" && neu.pattern !== old.pattern)
    problems.push(`${path}: pattern ${String(neu.pattern)} where ${old.pattern} was published`);
  if (typeof old.format === "string" && neu.format !== old.format)
    problems.push(`${path}: format ${String(neu.format)} where ${old.format} was published`);
  // A closed object stays closed; a value schema of the open part stays assignable.
  if (old.additionalProperties === false) {
    if (neu.additionalProperties !== false) problems.push(`${path}: was closed to other keys, is open now`);
    else if (isObject(neu.properties))
      for (const key of Object.keys(neu.properties))
        if (!isObject(old.properties) || !(key in old.properties))
          problems.push(`${path}.${key}: a new key on an object that was closed to other keys`);
  } else if (isObject(old.additionalProperties)) {
    if (!isObject(neu.additionalProperties))
      problems.push(`${path}: the values of other keys are no longer described`);
    else problems.push(...notAssignable(neu.additionalProperties, old.additionalProperties, `${path}{}`));
  }
  if (isObject(old.propertyNames)) {
    if (!isObject(neu.propertyNames)) problems.push(`${path}: key names are no longer constrained`);
    else problems.push(...notAssignable(neu.propertyNames, old.propertyNames, `${path}<key>`));
  }
  for (const [keyword, value] of Object.entries(old))
    if (!UNDERSTOOD.has(keyword) && !ANNOTATIONS.has(keyword) && !same(neu[keyword], value))
      problems.push(
        `${path}: ${keyword} changed from ${JSON.stringify(value)} to ${JSON.stringify(neu[keyword])}`,
      );
  if (isObject(old.properties)) {
    const props = isObject(neu.properties) ? neu.properties : {};
    const required = list(neu.required);
    for (const [key, oldProp] of Object.entries(old.properties)) {
      const newProp = props[key];
      if (newProp === undefined) {
        problems.push(`${path}.${key}: removed`);
        continue;
      }
      problems.push(...notAssignable(newProp as Schema, oldProp as Schema, `${path}.${key}`));
    }
    for (const key of list(old.required))
      if (!required.includes(key)) problems.push(`${path}.${String(key)}: was required, is optional now`);
  }
  if (old.items !== undefined) {
    if (neu.items === undefined) problems.push(`${path}[]: items no longer described`);
    else problems.push(...notAssignable(neu.items as Schema, old.items as Schema, `${path}[]`));
  }
  return problems;
};
