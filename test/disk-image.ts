// Disk images for tests (macOS, hdiutil): the exFAT blob-fs suite and the crash matrix's case-sensitive volume.
// hdiutil create, attach and detach go through diskarbitrationd, which is slow and can refuse ("Resource busy",
// "Resource temporarily unavailable") while another image is attaching or detaching, in this test process or in
// another one running on the same machine. So every call here holds one lock shared by all of them (a folder in the
// OS temp dir, taken over from a dead holder), retries the known transient errors a few times, and says which step
// failed and after how long. Callers give their hooks a timeout long enough for a loaded machine.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "plainport-hdiutil.lock");
const LOCK_WAIT_MS = 120_000;
const TRANSIENT = /Resource busy|Resource temporarily unavailable|resource is busy|timed out/i;
const ATTEMPTS = 4;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Runs `work` while holding the machine-wide hdiutil lock; a lock whose holder is gone is taken over. */
export const withImageLock = async <T>(work: () => T | Promise<T>, lock = LOCK): Promise<T> => {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {}
      // No pid yet means a holder is between its mkdir and its write: wait. A dead pid: take the lock over.
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`hdiutil lock ${lock} still held by pid ${holder} after ${LOCK_WAIT_MS / 1000} s`);
      await Bun.sleep(50);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

/** One hdiutil call under the lock, retried on a transient refusal; a failure names the call and how long it took. */
export const hdiutil = async (...args: string[]): Promise<void> => {
  const started = Date.now();
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const run = await withImageLock(() =>
      Bun.spawnSync(["hdiutil", ...args], {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    if (run.exitCode === 0) return;
    last = `${run.stderr.toString().trim()} (exit ${run.exitCode})`;
    if (!TRANSIENT.test(last)) break;
    await Bun.sleep(500 * attempt);
  }
  throw new Error(
    `hdiutil ${args.join(" ")} failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${last}`,
  );
};

export interface DiskImage {
  /** Where the volume is mounted. */
  mount: string;
  /** Detaches the volume (forced) and deletes the image file. */
  remove(): Promise<void>;
}

/**
 * Creates an image of `size` with file system `fs` in `dir` and mounts it at `<dir>/mnt`, hidden from the Finder.
 * `sparse` grows the image file as it is written instead of allocating it whole.
 */
export const attachImage = async (
  dir: string,
  options: { size: string; fs: string; volname: string; sparse?: boolean },
): Promise<DiskImage> => {
  const image = join(dir, options.sparse ? "volume.sparseimage" : "volume.dmg");
  const mount = join(dir, "mnt");
  mkdirSync(mount, { recursive: true });
  await hdiutil(
    "create",
    "-quiet",
    "-size",
    options.size,
    "-fs",
    options.fs,
    "-volname",
    options.volname,
    ...(options.sparse ? ["-type", "SPARSE"] : []),
    image,
  );
  await hdiutil("attach", "-quiet", "-nobrowse", "-noverify", "-mountpoint", mount, image);
  return {
    mount,
    remove: async () => {
      try {
        await hdiutil("detach", "-quiet", "-force", mount);
      } finally {
        rmSync(image, { force: true });
      }
    },
  };
};
