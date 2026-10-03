import { describe, expect, test } from "bun:test";
import { faultSeam, InjectedFault } from "./host.ts";

describe("host port: the faultAt crash seam", () => {
  test("without a plan every step passes", async () => {
    const faultAt = faultSeam(undefined, () => {
      throw new Error("must not kill");
    });
    faultAt("offload.snapshot");
    faultAt("offload.release.delete");
  });

  test("a planned step throws InjectedFault there and nowhere else, and every step is reported", () => {
    const seen: string[] = [];
    const faultAt = faultSeam({ at: "offload.release", onStep: (step) => seen.push(step) }, () => {});
    faultAt("offload.snapshot");
    let error: unknown;
    try {
      faultAt("offload.release");
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(InjectedFault);
    expect((error as InjectedFault).step).toBe("offload.release");
    expect(seen).toEqual(["offload.snapshot", "offload.release"]);
  });

  test("occurrence picks the nth time a step is reached", async () => {
    const faultAt = faultSeam({ at: "hydrate.install", occurrence: 2 }, () => {});
    faultAt("hydrate.install");
    expect(() => faultAt("hydrate.install")).toThrow(InjectedFault);
    faultAt("hydrate.install");
  });

  test("the kill action calls the host's kill instead of throwing", async () => {
    let killed = 0;
    const faultAt = faultSeam({ at: "onload.swap", action: "kill" }, () => {
      killed++;
    });
    faultAt("onload.swap");
    expect(killed).toBe(1);
  });

  test("a step name that is not dotted lower-case words is a bug", async () => {
    const faultAt = faultSeam(undefined, () => {});
    expect(() => faultAt("Offload Release")).toThrow(/step/);
    expect(() => faultSeam({ at: "" }, () => {})).toThrow(/step/);
  });
});

describe("host port: faultAt is synchronous", () => {
  test("the fault is thrown at the call itself, so a saga cannot run past its step by forgetting an await", () => {
    const faultAt = faultSeam({ at: "offload.release" }, () => {});
    let ranPastTheStep = false;
    const step = (): void => {
      faultAt("offload.release");
      ranPastTheStep = true;
    };
    expect(step).toThrow(InjectedFault);
    expect(ranPastTheStep).toBe(false);
  });
});
