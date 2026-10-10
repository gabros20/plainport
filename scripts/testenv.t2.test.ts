// T2 smoke test for scripts/testenv: `scripts/testenv up && bun run test:t2 -t testenv && scripts/testenv down`.
// It brings up a second environment of its own (its own compose project, ports and folder), so it can take that one
// down and check nothing is left, without disturbing the shared environment the other T2 suites use. The shared
// environment is read only for the Docker endpoint: the home tripwire gives tests a sandbox HOME, where the docker
// CLI would find no context.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeT2 } from "../test/tiers.ts";
import {
  applyProfile,
  loadTestEnv,
  PROFILES,
  type TestEnv,
  dockerEnv as testenvDockerEnv,
} from "./testenv.ts";

const TIMEOUT = 240_000;
const script = join(import.meta.dir, "testenv.ts");

describeT2("testenv: the T2 environment", () => {
  let scratch: string;
  let dir: string;
  let env: TestEnv;
  let dockerEnv: Record<string, string>;
  const project = `plainport-testenv-smoke-${process.pid}`;

  const testenv = (...args: string[]) => {
    const child = Bun.spawnSync(
      ["bun", script, ...args, "--dir", dir, "--project", project, "--port-base", "39300"],
      { env: { ...process.env, ...dockerEnv }, stdout: "pipe", stderr: "pipe" },
    );
    return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };
  const docker = (...args: string[]) =>
    Bun.spawnSync(["docker", ...args], {
      env: { ...process.env, ...dockerEnv },
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();

  const s3 = (endpoint: string) =>
    new Bun.S3Client({
      endpoint,
      bucket: env.s3.bucket,
      region: env.s3.region,
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    });
  /** The error code of a request that failed at the connection, or the HTTP status of one that got an answer. */
  const outcome = async (request: Promise<Response>): Promise<string | number> => {
    try {
      return (await request).status;
    } catch (error) {
      return String((error as { code?: string }).code ?? (error as Error).message);
    }
  };
  const sftp = (alias: string, commands: string) => {
    const batch = join(scratch, "batch");
    writeFileSync(batch, `${commands}\n`);
    const child = Bun.spawnSync(["sftp", "-F", env.sftp.sshConfig, "-b", batch, alias], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: scratch,
    });
    return { exitCode: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
  };

  beforeAll(() => {
    const shared = loadTestEnv();
    dockerEnv = testenvDockerEnv(shared);
    scratch = mkdtempSync(join(tmpdir(), "plainport-testenv-smoke-"));
    dir = join(scratch, "testenv");
  });
  afterAll(() => {
    // Whatever happened above, leave no container, volume or network behind.
    testenv("down");
    rmSync(scratch, { recursive: true, force: true });
  });

  test(
    "up is health-checked and idempotent, and writes endpoints, run credentials and a sandbox ssh setup",
    () => {
      const first = testenv("up");
      expect(first).toMatchObject({ exitCode: 0 });
      env = loadTestEnv(dir);
      expect(env.project).toBe(project);
      expect(env.containers).toHaveLength(4);
      expect(env.s3.endpoint).toBe("http://127.0.0.1:39300");
      expect(env.s3.accessKeyId).toMatch(/^[A-Z0-9]{20}$/);
      for (const file of ["env.json", "ssh/config", "ssh/known_hosts", "ssh/id_ed25519", "rest.htpasswd"]) {
        expect(existsSync(join(dir, file))).toBe(true);
      }
      expect(readFileSync(join(dir, "ssh/known_hosts"), "utf8")).toContain("[127.0.0.1]:39322 ssh-ed25519 ");

      const before = readFileSync(join(dir, "env.json"), "utf8");
      const second = testenv("up");
      expect(second.exitCode).toBe(0);
      expect(readFileSync(join(dir, "env.json"), "utf8")).toBe(before);

      const status = testenv("status");
      expect(status.exitCode).toBe(0);
      for (const service of ["s3", "sftp", "rest", "toxiproxy"])
        expect(status.stdout).toMatch(new RegExp(`${service}\\s+healthy`));
      expect(testenv("env").stdout).toContain("export PLAINPORT_T2_S3_ENDPOINT='http://127.0.0.1:39300'");
    },
    TIMEOUT,
  );

  test(
    "every service answers, directly and through Toxiproxy, and refuses the unauthenticated",
    async () => {
      for (const endpoint of [env.s3.endpoint, env.s3.proxied]) {
        await s3(endpoint).write(`reach/${endpoint.split(":").at(-1)}`, "hello");
        expect(
          await s3(env.s3.endpoint)
            .file(`reach/${endpoint.split(":").at(-1)}`)
            .text(),
        ).toBe("hello");
      }
      expect(await outcome(fetch(`${env.s3.endpoint}/${env.s3.bucket}/reach/39300`))).toBe(403);

      writeFileSync(join(scratch, "upload.txt"), "over sftp\n");
      for (const alias of [env.sftp.alias, env.sftp.proxiedAlias]) {
        const ran = sftp(alias, `put upload.txt ${env.sftp.root}/${alias}.txt\nls ${env.sftp.root}`);
        expect(ran.output).toContain(`${alias}.txt`);
        expect(ran.exitCode).toBe(0);
      }
      // Key only: the same user with password authentication and no key is refused.
      const password = Bun.spawnSync(
        [
          "sftp",
          "-F",
          env.sftp.sshConfig,
          "-o",
          "PubkeyAuthentication=no",
          "-o",
          "PasswordAuthentication=yes",
          "-o",
          "BatchMode=yes",
          "-b",
          "/dev/null",
          env.sftp.alias,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(password.exitCode).not.toBe(0);
      expect(password.stderr.toString()).toContain("Permission denied");

      // rest-server: authentication required, and append-only: a write succeeds, a delete is refused.
      const auth = { Authorization: `Basic ${btoa(`${env.rest.user}:${env.rest.password}`)}` };
      expect(await outcome(fetch(`${env.rest.url}/smoke/config`))).toBe(401);
      expect(
        await outcome(fetch(`${env.rest.url}/smoke/?create=true`, { method: "POST", headers: auth })),
      ).toBe(200);
      const blob = new TextEncoder().encode("append only");
      const id = new Bun.CryptoHasher("sha256").update(blob).digest("hex");
      expect(
        await outcome(
          fetch(`${env.rest.url}/smoke/data/${id}`, { method: "POST", headers: auth, body: blob }),
        ),
      ).toBe(200);
      expect(
        await outcome(fetch(`${env.rest.url}/smoke/data/${id}`, { method: "DELETE", headers: auth })),
      ).toBe(403);

      expect(await outcome(fetch(`${env.toxiproxy.api}/version`))).toBe(200);
    },
    TIMEOUT,
  );

  test(
    "cut resets S3 and SFTP connections both ways, and clearing it restores them",
    async () => {
      await applyProfile(env, "s3", "cut");
      await applyProfile(env, "sftp", "cut");
      expect(await outcome(fetch(`${env.s3.proxied}/`))).toBe("ECONNRESET");
      expect(sftp(env.sftp.proxiedAlias, `ls ${env.sftp.root}`).exitCode).not.toBe(0);
      // The direct endpoints are untouched.
      expect(await outcome(fetch(`${env.s3.endpoint}/`))).toBe(403);

      await applyProfile(env, "s3", "clear");
      await applyProfile(env, "sftp", "clear");
      expect(await outcome(fetch(`${env.s3.proxied}/`))).toBe(403);
      expect(sftp(env.sftp.proxiedAlias, `ls ${env.sftp.root}`).exitCode).toBe(0);
    },
    TIMEOUT,
  );

  test(
    "latency slows every request by its delay both ways",
    async () => {
      const delay = PROFILES.latency.reduce((sum, toxic) => sum + Number(toxic.attributes.latency), 0);
      await applyProfile(env, "s3", "latency");
      const started = performance.now();
      expect(await outcome(fetch(`${env.s3.proxied}/`, { headers: { Connection: "close" } }))).toBe(403);
      expect(performance.now() - started).toBeGreaterThanOrEqual(delay);
      await applyProfile(env, "s3", "clear");
    },
    TIMEOUT,
  );

  test(
    "slow-close holds the connection open after the server closed it",
    async () => {
      const delay = Number(PROFILES["slow-close"][0]?.attributes.delay);
      await applyProfile(env, "s3", "slow-close");
      const port = Number(new URL(env.s3.proxied).port);
      const { lastData, closed } = await new Promise<{ lastData: number; closed: number }>(
        (resolve, reject) => {
          let lastData = 0;
          const socket = connect(port, "127.0.0.1", () =>
            socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
          );
          socket.on("data", () => {
            lastData = performance.now();
          });
          socket.on("error", reject);
          socket.on("close", () => resolve({ lastData, closed: performance.now() }));
        },
      );
      expect(lastData).toBeGreaterThan(0);
      expect(closed - lastData).toBeGreaterThanOrEqual(delay - 50);
      await applyProfile(env, "s3", "clear");
    },
    TIMEOUT,
  );

  test(
    "lost-ack: the request reaches the store whole while the client sees a reset",
    async () => {
      await applyProfile(env, "s3", "lost-ack");
      const body = "written, but the client never hears it\n".repeat(100);
      const url = s3(env.s3.proxied).presign("lost-ack/object", { method: "PUT", expiresIn: 300 });
      expect(await outcome(fetch(url, { method: "PUT", body }))).toBe("ECONNRESET");
      await applyProfile(env, "s3", "clear");
      expect(await s3(env.s3.endpoint).file("lost-ack/object").text()).toBe(body);
    },
    TIMEOUT,
  );

  test(
    "restart restarts one service and what it stored survives (`minio` names the S3 service)",
    async () => {
      await s3(env.s3.endpoint).write("durable/object", "still here");
      const before = docker(
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--filter",
        "label=com.docker.compose.service=s3",
      );
      const restarted = testenv("restart", "minio");
      expect(restarted.stderr).toBe("");
      expect(restarted.exitCode).toBe(0);
      expect(
        docker(
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          "label=com.docker.compose.service=s3",
        ),
      ).toBe(before);
      expect(await s3(env.s3.endpoint).file("durable/object").text()).toBe("still here");
      expect(await s3(env.s3.proxied).file("durable/object").text()).toBe("still here");

      expect(testenv("restart", "toxiproxy").exitCode).toBe(0);
      expect(await s3(env.s3.proxied).file("durable/object").text()).toBe("still here");
    },
    TIMEOUT,
  );

  test(
    "down is idempotent and leaves no container, volume, network or .testenv folder behind",
    () => {
      const label = `label=com.docker.compose.project=${project}`;
      // The images' anonymous volumes carry no compose label, so they are named before `down`.
      const containers = docker("ps", "-aq", "--filter", label).split("\n").filter(Boolean);
      expect(containers).toHaveLength(4);
      const volumes = docker(
        "inspect",
        "-f",
        "{{range .Mounts}}{{if .Name}}{{.Name}} {{end}}{{end}}",
        ...containers,
      )
        .split(/\s+/)
        .filter(Boolean);
      expect(volumes.length).toBeGreaterThan(0);

      // A file testenv did not write makes down refuse before it stops anything, so no env.json is left
      // describing containers that are gone.
      writeFileSync(join(dir, ".DS_Store"), "");
      const refused = testenv("down");
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(".DS_Store");
      expect(docker("ps", "-q", "--filter", label).split("\n").filter(Boolean)).toHaveLength(4);
      expect(existsSync(join(dir, "env.json"))).toBe(true);
      expect(testenv("status").exitCode).toBe(0);
      unlinkSync(join(dir, ".DS_Store"));

      expect(testenv("down").exitCode).toBe(0);
      expect(testenv("down").exitCode).toBe(0);
      for (const volume of volumes)
        expect(docker("volume", "ls", "-q", "--filter", `name=^${volume}$`)).toBe("");
      expect(docker("ps", "-aq", "--filter", label)).toBe("");
      expect(docker("volume", "ls", "-q", "--filter", label)).toBe("");
      expect(docker("network", "ls", "-q", "--filter", label)).toBe("");
      expect(existsSync(dir)).toBe(false);
      expect(testenv("status").exitCode).not.toBe(0);
    },
    TIMEOUT,
  );
});
