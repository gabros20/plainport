// The matrix against DESIGN.md and the test sources (T0), and the guard that fails the M2 gate while a todo remains.

import { describe, expect, test } from "bun:test";
import { compatSources, INVENTORY, matrixRows, readDesign, remainingTodos, testsIn } from "./matrix.ts";

describe("compat matrix: DESIGN.md's Formats and compatibility", () => {
  const rows = matrixRows(readDesign());
  const sources = compatSources();
  const tests = testsIn(sources);

  test("has a row for every format in the inventory, and no row outside it", () => {
    const ids = rows.map((r) => r.id);
    expect(INVENTORY.filter((i) => !ids.includes(i))).toEqual([]);
    expect(ids.filter((i) => !(INVENTORY as readonly string[]).includes(i))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every row says what v0.1.1 does, what a rollback leaves, what stops a v0.1.1 writer, and how an M1 store is adopted", () => {
    for (const row of rows) {
      expect(row.cells.length, `${row.id}: columns`).toBe(6);
      for (const cell of row.cells) expect(cell.length, `${row.id}: an empty cell`).toBeGreaterThan(0);
    }
  });

  test("every row has a test titled with its id, and every titled id is a row", () => {
    const tagged = new Set(tests.flatMap((t) => t.ids));
    expect(rows.map((r) => r.id).filter((id) => !tagged.has(id))).toEqual([]);
    expect([...tagged].filter((id) => !rows.some((r) => r.id === id))).toEqual([]);
  });

  test("the todo column names the owning task exactly when a test.todo stands for the row", () => {
    const todoIds = new Set(tests.filter((t) => t.todo).flatMap((t) => t.ids));
    for (const row of rows) {
      const says = /^todo: Task \d+/.test(row.cells[5] as string);
      expect(says, `${row.id}: the Test column and the test.todo entries disagree`).toBe(todoIds.has(row.id));
    }
  });
});

describe("compat matrix: the todo guard", () => {
  test("lists the todos of a source", () => {
    const source = 'test.todo("[a.b] later");\ntest("[a.b] now", () => {});\ntest.todo("[c] more");';
    expect(remainingTodos([source])).toEqual(["[a.b] later", "[c] more"]);
  });

  test("sees it.todo, single-quoted and template titles", () => {
    const source =
      "it.todo('[a] one', () => {});\ntest.todo(`[b] two`, () => {});\ntest.skipIf(true)(\"[c] three\", () => {});";
    expect(remainingTodos([source])).toEqual(["[a] one", "[b] two"]);
    expect(testsIn([source]).map((t) => t.ids)).toEqual([["a"], ["b"], ["c"]]);
  });

  test("[guard] fails the M2 gate while a todo remains (PLAINPORT_COMPAT_GATE=1)", () => {
    const todos = remainingTodos();
    if (process.env.PLAINPORT_COMPAT_GATE === "1")
      expect(todos, "compat todos remain: the owning tasks must turn them on").toEqual([]);
    else expect(Array.isArray(todos)).toBe(true);
  });
});
