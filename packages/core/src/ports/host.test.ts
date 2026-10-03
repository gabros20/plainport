import { describe, expect, test } from "bun:test";
import { faultSeam, InjectedFault } from "./host.ts";

describe("host port: the faultAt crash seam", () => {
  test("without a plan every step passes", async () => {
    const faultAt = faultSeam(undefined, () => {
      throw new Error("must not kill");
    });
    await faultAt("offload.snapshot");
    await faultAt("offload.release.delete");
  });

  test("a planned step throws InjectedFault there and nowhere else, and every step is reported", async () => {
    const seen: string[] = [];
    const faultAt = faultSeam({ at: "offload.release", onStep: (step) => seen.push(step) }, () => {});
    await faultAt("offload.snapshot");
    const error = await faultAt("offload.release").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InjectedFault);
    expect((error as InjectedFault).step).toBe("offload.release");
    expect(seen).toEqual(["offload.snapshot", "offload.release"]);
  });

  test("occurrence picks the nth time a step is reached", async () => {
    const faultAt = faultSeam({ at: "hydrate.install", occurrence: 2 }, () => {});
    await faultAt("hydrate.install");
    await expect(faultAt("hydrate.install")).rejects.toBeInstanceOf(InjectedFault);
    await faultAt("hydrate.install");
  });

  test("the kill action calls the host's kill instead of throwing", async () => {
    let killed = 0;
    const faultAt = faultSeam({ at: "onload.swap", action: "kill" }, () => {
      killed++;
    });
    await faultAt("onload.swap");
    expect(killed).toBe(1);
  });

  test("a step name that is not dotted lower-case words is a bug", async () => {
    const faultAt = faultSeam(undefined, () => {});
    await expect(faultAt("Offload Release")).rejects.toThrow(/step/);
    expect(() => faultSeam({ at: "" }, () => {})).toThrow(/step/);
  });
});
