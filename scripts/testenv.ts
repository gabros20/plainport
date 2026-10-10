// `scripts/testenv up | down | status | env | restart <service> | fault <proxy> <profile> | linux [-- <command>]`:
// the T2 test environment as code (ADR-0018, ADR-0021). Agents never build an environment by hand.
//
// - `up` brings up compose.yaml's containers (an S3 store, SFTP, rest-server, Toxiproxy), waits for every health
//   check, checks each service from the host, directly and through Toxiproxy, and writes .testenv/ (gitignored):
//   env.json (endpoints and the credentials generated for the run; T2 suites read it with loadTestEnv), the SFTP
//   keys, a sandbox known_hosts and an ssh config. It is idempotent: a second `up` reuses the credentials and keys,
//   changes nothing that runs, and clears every fault.
// - `down` removes the containers, their volumes and network, and .testenv/. Idempotent.
// - `status` prints each service's health; exit 0 only when all four are healthy.
// - `env` prints the endpoints as shell exports: `eval "$(scripts/testenv env)"`.
// - `restart <service>` restarts one container (not a recreate: what it stored survives) and waits until it is
//   healthy again. `minio` names the S3 service.
// - `fault <s3|sftp> <profile|clear>` applies one of PROFILES to a Toxiproxy proxy, replacing any other.
// - `linux` is the reproducible Linux test recipe: `bun run test:t1` (or the command after `--`) in the pinned
//   oven/bun image, with --init, on a copy of the checkout. LINUX_GAPS lists what it does not reproduce.
//
// Options: --dir <dir> (default .testenv/ in the checkout, or PLAINPORT_TESTENV_DIR), --project <name> (default
// PLAINPORT_TESTENV_PROJECT, else plainport-testenv), --port-base <port> (default 39100). After `up`, the other
// commands read the project and the ports from <dir>/env.json. The credentials are throwaway values for containers bound to 127.0.0.1; they live in
// .testenv/ (mode 0700) and in the children's environment, never in argv. Scripts may spawn directly and validate
// their own dev-only files by hand (run decisions D8 and D10).

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const checkout = resolve(import.meta.dir, "..");
const composeFile = join(checkout, "compose.yaml");

export const DEFAULT_PROJECT = "plainport-testenv";
export const DEFAULT_PORT_BASE = 39100;
const BUCKET = "plainport-t2";
const SFTP_USER = "plainport";

/** Where `scripts/testenv` keeps the environment: `.testenv/` in the checkout, or PLAINPORT_TESTENV_DIR. */
export const testenvDir = (env: Record<string, string | undefined> = process.env): string =>
  env.PLAINPORT_TESTENV_DIR ? env.PLAINPORT_TESTENV_DIR : join(checkout, ".testenv");

export const SERVICES = ["s3", "sftp", "rest", "toxiproxy"] as const;
export type Service = (typeof SERVICES)[number];

/** A compose service by name; `minio` names the S3 store, which is SeaweedFS since MinIO stopped its images. */
export const serviceName = (name: string): Service | undefined =>
  name === "minio" ? "s3" : (SERVICES as readonly string[]).includes(name) ? (name as Service) : undefined;

export const portsFor = (base: number) => ({
  s3: base,
  s3Proxied: base + 1,
  sftp: base + 22,
  sftpProxied: base + 23,
  toxiproxy: base + 74,
  rest: base + 80,
});

/** Toxiproxy's proxies, inside the compose network. compose.yaml publishes their listen ports. */
export const PROXIES = {
  s3: { listen: "0.0.0.0:8101", upstream: "s3:8333" },
  sftp: { listen: "0.0.0.0:8122", upstream: "sftp:22" },
} as const;
export type ProxyName = keyof typeof PROXIES;

export type Toxic = {
  name: string;
  type: "reset_peer" | "latency" | "slow_close";
  stream: "upstream" | "downstream";
  toxicity: number;
  attributes: Record<string, number>;
};

/**
 * The named fault profiles later tasks use (M2 Tasks 14 and 27). reset_peer acts at the first byte that reaches
 * it in its direction: it drops that chunk and closes with SO_LINGER 0, so the peer sees a TCP RST.
 * - cut: both directions reset; nothing gets through.
 * - latency: 250 ms each way.
 * - slow-close: the close reaches the client 1.5 s after the server closed.
 * - lost-ack: the request goes through whole, untouched; the first byte of the response resets the client. The
 *   store did the work, and the client cannot know. Meaningful for the S3 proxy only: on SFTP the server speaks
 *   first, so the reset fires during the SSH handshake and acts like cut.
 */
export const PROFILES = {
  cut: [
    { name: "cut-upstream", type: "reset_peer", stream: "upstream", toxicity: 1, attributes: { timeout: 0 } },
    {
      name: "cut-downstream",
      type: "reset_peer",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    },
  ],
  latency: [
    {
      name: "latency-upstream",
      type: "latency",
      stream: "upstream",
      toxicity: 1,
      attributes: { latency: 250, jitter: 0 },
    },
    {
      name: "latency-downstream",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: 250, jitter: 0 },
    },
  ],
  "slow-close": [
    {
      name: "slow-close",
      type: "slow_close",
      stream: "downstream",
      toxicity: 1,
      attributes: { delay: 1500 },
    },
  ],
  "lost-ack": [
    { name: "lost-ack", type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } },
  ],
} satisfies Record<string, Toxic[]>;
export type ProfileName = keyof typeof PROFILES;

/** .testenv/env.json: what T2 suites need to reach the environment. */
export type TestEnv = {
  v: 1;
  project: string;
  dir: string;
  portBase: number;
  /**
   * The Docker endpoint and the compose binary `up` used. A test's sandbox HOME hides the docker CLI's context and
   * its ~/.docker/cli-plugins, so T2 tests hand these to their children as DOCKER_HOST and PLAINPORT_TESTENV_COMPOSE.
   */
  docker: { host?: string; compose?: string };
  /** The four containers `up` started, so the T2 gate can check they are still there and healthy. */
  containers: string[];
  s3: {
    kind: "seaweedfs";
    endpoint: string;
    /** The same store through Toxiproxy. */
    proxied: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sftp: {
    host: string;
    port: number;
    proxiedPort: number;
    user: string;
    /** The writable folder, as the chrooted SFTP user sees it. */
    root: string;
    /** Host aliases in sshConfig: direct and through Toxiproxy. */
    alias: string;
    proxiedAlias: string;
    identityFile: string;
    knownHosts: string;
    sshConfig: string;
  };
  rest: { url: string; user: string; password: string };
  toxiproxy: { api: string; proxies: Record<ProxyName, string> };
};

export const loadTestEnv = (dir = testenvDir()): TestEnv => {
  const path = join(dir, "env.json");
  if (!existsSync(path))
    throw new Error(`no T2 environment: ${path} is missing. Run \`scripts/testenv up\`.`);
  return JSON.parse(readFileSync(path, "utf8")) as TestEnv;
};

export const sshConfig = (env: TestEnv): string =>
  [
    [env.sftp.alias, env.sftp.port],
    [env.sftp.proxiedAlias, env.sftp.proxiedPort],
  ]
    .map(([alias, port]) =>
      [
        `Host ${alias}`,
        `  HostName ${env.sftp.host}`,
        `  Port ${port}`,
        `  User ${env.sftp.user}`,
        `  IdentityFile ${env.sftp.identityFile}`,
        "  IdentitiesOnly yes",
        "  IdentityAgent none",
        "  PasswordAuthentication no",
        "  KbdInteractiveAuthentication no",
        `  UserKnownHostsFile ${env.sftp.knownHosts}`,
        "  GlobalKnownHostsFile /dev/null",
        "  StrictHostKeyChecking yes",
        "  HostKeyAlgorithms ssh-ed25519",
        "  ConnectTimeout 10",
        "",
      ].join("\n"),
    )
    .join("\n");

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export const envLines = (env: TestEnv): string[] =>
  Object.entries({
    PLAINPORT_TESTENV_DIR: env.dir,
    PLAINPORT_T2_S3_ENDPOINT: env.s3.endpoint,
    PLAINPORT_T2_S3_PROXIED: env.s3.proxied,
    PLAINPORT_T2_S3_REGION: env.s3.region,
    PLAINPORT_T2_S3_BUCKET: env.s3.bucket,
    PLAINPORT_T2_S3_ACCESS_KEY_ID: env.s3.accessKeyId,
    PLAINPORT_T2_S3_SECRET_ACCESS_KEY: env.s3.secretAccessKey,
    PLAINPORT_T2_SFTP_HOST: env.sftp.host,
    PLAINPORT_T2_SFTP_PORT: String(env.sftp.port),
    PLAINPORT_T2_SFTP_PROXIED_PORT: String(env.sftp.proxiedPort),
    PLAINPORT_T2_SFTP_USER: env.sftp.user,
    PLAINPORT_T2_SFTP_ROOT: env.sftp.root,
    PLAINPORT_T2_SFTP_SSH_CONFIG: env.sftp.sshConfig,
    PLAINPORT_T2_SFTP_IDENTITY: env.sftp.identityFile,
    PLAINPORT_T2_SFTP_KNOWN_HOSTS: env.sftp.knownHosts,
    PLAINPORT_T2_REST_URL: env.rest.url,
    PLAINPORT_T2_REST_USER: env.rest.user,
    PLAINPORT_T2_REST_PASSWORD: env.rest.password,
    PLAINPORT_T2_TOXIPROXY: env.toxiproxy.api,
  }).map(([name, value]) => `export ${name}=${shellQuote(value)}`);

/** Replaces every toxic on one proxy with the profile's, or removes them all ("clear"). */
export const applyProfile = async (env: TestEnv, proxy: ProxyName, profile: ProfileName | "clear") => {
  const base = `${env.toxiproxy.api}/proxies/${env.toxiproxy.proxies[proxy]}/toxics`;
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(
        `toxiproxy ${init.method ?? "GET"} ${url}: ${response.status} ${await response.text()}`,
      );
    }
    return response;
  };
  const existing = (await (await call(base)).json()) as { name: string }[];
  for (const toxic of existing) await call(`${base}/${toxic.name}`, { method: "DELETE" });
  if (profile === "clear") return;
  for (const toxic of PROFILES[profile]) {
    await call(base, {
      method: "POST",
      body: JSON.stringify(toxic),
      headers: { "Content-Type": "application/json" },
    });
  }
};

// The Linux recipe (HANDOFF "Tests and flake watch"): the oven/bun image of .bun-version, pinned by digest.
export const LINUX_IMAGE =
  "oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";

/** What the Linux recipe does not reproduce, compared with GitHub's ubuntu-24.04 runner. */
export const LINUX_GAPS = [
  "Debian bookworm's git 2.39 has no fsmonitor daemon on Linux (Ubuntu 24.04's 2.43 has), so the fsmonitor check of" +
    " packages/core/src/scan/git.test.ts fails here and not in CI.",
  "No Node.js, npm, pnpm or Yarn: the real offline-install tests skip, as they do outside CI, and the npm eval" +
    " (evals/agent-smoke/hydrate.test.ts) fails.",
  "The copy is a fresh one-commit git repository: no history, no tags, no remote.",
  "linux/arm64 on Apple silicon, where CI is linux/amd64.",
  "Debian (the oven/bun base) rather than Ubuntu 24.04, as the unprivileged user bun rather than the runner user.",
];

export const linuxCommand = (options: { checkout: string; run: string }): string[] => {
  const script = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq >/dev/null",
    "apt-get install -y -qq --no-install-recommends git zsh bzip2 unzip procps ca-certificates openssh-client >/dev/null",
    // A copy, so the container's node_modules and .tools never land in the checkout.
    "mkdir /work",
    "tar -C /src --exclude=./node_modules --exclude='./packages/*/node_modules' --exclude=./.tools --exclude=./dist" +
      " --exclude=./.testenv --exclude=./.git -cf - . | tar -C /work -xf -",
    "chown -R bun:bun /work",
    "cd /work",
    // Some tests (scripts/install) need the checkout to be a git repository.
    "runuser -u bun -- sh -c 'git init -q && git add -A && git -c user.name=testenv -c user.email=testenv@invalid" +
      " commit -q -m testenv'",
    "runuser -u bun -- bun install --frozen-lockfile",
    "runuser -u bun -- bun scripts/fetch-tools.ts",
    `runuser -u bun -- bash -c ${shellQuote(options.run)}`,
  ].join("\n");
  return [
    "docker",
    "run",
    "--rm",
    "--init",
    "-v",
    `${options.checkout}:/src:ro`,
    LINUX_IMAGE,
    "bash",
    "-c",
    script,
  ];
};

export type Command =
  | { command: "up" | "down" | "status" | "env" }
  | { command: "restart"; service: Service }
  | { command: "fault"; proxy: ProxyName; profile: ProfileName | "clear" }
  | { command: "linux"; run: string };
export type Options = { dir?: string; project?: string; portBase?: number };

const USAGE =
  "usage: scripts/testenv up | down | status | env | restart <service> | fault <s3|sftp> <profile|clear> | " +
  "linux [-- <command>]  [--dir <dir>] [--project <name>] [--port-base <port>]\n" +
  "environment: PLAINPORT_TESTENV_DIR (default --dir), PLAINPORT_TESTENV_PROJECT (default --project)";

export const parseCommand = (
  argv: string[],
): ({ ok: true } & Command & Options) | { ok: false; message: string } => {
  const fail = (message: string) => ({ ok: false as const, message: `${message}\n${USAGE}` });
  const split = argv.indexOf("--");
  const args = split === -1 ? argv : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  const words: string[] = [];
  const options: Options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--dir" || arg === "--project" || arg === "--port-base") {
      const value = args[++i];
      if (value === undefined) return fail(`${arg} needs a value`);
      if (arg === "--dir") options.dir = resolve(value);
      else if (arg === "--project") {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(value))
          return fail(`--project ${value}: lowercase letters, digits, - and _`);
        options.project = value;
      } else {
        const base = Number(value);
        if (!Number.isInteger(base) || base < 1024 || base > 65_000)
          return fail("--port-base must be 1024 to 65000");
        options.portBase = base;
      }
    } else if (arg.startsWith("--")) return fail(`unknown option ${arg}`);
    else words.push(arg);
  }
  const [command, ...operands] = words;
  switch (command) {
    case "up":
    case "down":
    case "status":
    case "env":
      if (operands.length > 0) return fail(`${command} takes no arguments`);
      return { ok: true, command, ...options };
    case "restart": {
      const service = serviceName(operands[0] ?? "");
      if (operands.length !== 1 || service === undefined) {
        return fail(`restart needs one service: ${SERVICES.join(", ")} (or minio)`);
      }
      return { ok: true, command, service, ...options };
    }
    case "fault": {
      const [proxy, profile] = operands;
      if (operands.length !== 2 || !Object.hasOwn(PROXIES, proxy ?? "")) {
        return fail(`fault needs a proxy (${Object.keys(PROXIES).join(", ")}) and a profile`);
      }
      if (profile !== "clear" && !Object.hasOwn(PROFILES, profile ?? "")) {
        return fail(`unknown profile ${profile}: use ${Object.keys(PROFILES).join(", ")} or clear`);
      }
      return {
        ok: true,
        command,
        proxy: proxy as ProxyName,
        profile: profile as ProfileName | "clear",
        ...options,
      };
    }
    case "linux":
      if (operands.length > 0) return fail("linux takes its command after --");
      return { ok: true, command, run: rest.length > 0 ? rest.join(" ") : "bun run test:t1", ...options };
    case undefined:
      return fail("no command");
    default:
      return fail(`unknown command ${command}`);
  }
};

// --- Running it -------------------------------------------------------------------------------------------------

type Ran = { exitCode: number; stdout: string; stderr: string };

const spawn = (
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  stdin?: string,
): Ran => {
  const child = Bun.spawnSync(argv, {
    // Bun passes the resolved path as argv[0]; a multi-call binary (OrbStack's docker-compose) needs its own name.
    argv0: basename(argv[0] ?? ""),
    env,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
};

class TestenvError extends Error {}
const refuse = (message: string): never => {
  throw new TestenvError(message);
};

const sleep = (ms: number) => Bun.sleep(ms);
const until = async <T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  for (;;) {
    try {
      const value = await attempt();
      if (value !== undefined) return value;
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() > deadline)
      return refuse(`${what} did not answer within ${timeoutMs / 1000} s${last ? `: ${last}` : ""}`);
    await sleep(500);
  }
};

const files = (dir: string) => ({
  env: join(dir, "env.json"),
  credentials: join(dir, "credentials.json"),
  htpasswd: join(dir, "rest.htpasswd"),
  ssh: join(dir, "ssh"),
  identity: join(dir, "ssh", "id_ed25519"),
  hostKey: join(dir, "ssh", "host_ed25519"),
  knownHosts: join(dir, "ssh", "known_hosts"),
  sshConfig: join(dir, "ssh", "config"),
});
/** Everything `up` may write, so `down` deletes exactly that and refuses a folder holding anything else. */
const OWN_FILES = ["env.json", "credentials.json", "rest.htpasswd", "ssh"];
const OWN_SSH_FILES = [
  "id_ed25519",
  "id_ed25519.pub",
  "host_ed25519",
  "host_ed25519.pub",
  "known_hosts",
  "config",
];

type Credentials = {
  project: string;
  portBase: number;
  s3: { accessKeyId: string; secretAccessKey: string };
  rest: { password: string };
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const randomId = (length: number) => Array.from(randomBytes(length), (byte) => alphabet[byte % 36]).join("");

const writePrivate = (path: string, content: string) => {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
};

const dockerHost = (): string | undefined => {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const ran = spawn(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  return ran.exitCode === 0 && ran.stdout.trim() ? ran.stdout.trim() : undefined;
};

/**
 * The docker compose plugin's binary, which also runs standalone. A symlink in ~/.docker/cli-plugins is followed
 * one step only: OrbStack's points at docker-compose, itself a link to a multi-call binary that dispatches on its name.
 */
const composeBinary = (): string | undefined => {
  if (process.env.PLAINPORT_TESTENV_COMPOSE) return process.env.PLAINPORT_TESTENV_COMPOSE;
  const ran = spawn([
    "docker",
    "info",
    "--format",
    '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}',
  ]);
  const path = ran.stdout.trim();
  if (ran.exitCode !== 0 || !path) return undefined;
  return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : path;
};

/**
 * Why the environment in `dir` cannot serve T2 suites, or undefined when its containers are all running and healthy.
 * One `docker inspect` of the containers `up` recorded: cheap enough for describeT2 to run once per process.
 */
export const environmentProblem = (dir: string): string | undefined => {
  let env: TestEnv;
  try {
    env = loadTestEnv(dir);
  } catch (error) {
    return (error as Error).message;
  }
  if (!Array.isArray(env.containers) || env.containers.length !== SERVICES.length) {
    return `${join(dir, "env.json")} names no containers`;
  }
  let ran: Ran;
  try {
    ran = spawn(["docker", "inspect", "--format", "{{.State.Health.Status}}", ...env.containers], {
      ...process.env,
      ...dockerEnv(env),
    });
  } catch (error) {
    return `docker could not run: ${(error as Error).message}`;
  }
  if (ran.exitCode !== 0) return "its containers are gone";
  const states = ran.stdout.split("\n").filter((line) => line.trim());
  if (states.length !== env.containers.length || states.some((state) => state.trim() !== "healthy")) {
    return `its containers are not all healthy (${states.join(", ") || "no state"})`;
  }
  return undefined;
};

/** docker-related variables for T2 tests' children: see TestEnv.docker. */
export const dockerEnv = (env: TestEnv): Record<string, string> => ({
  ...(env.docker.host === undefined ? {} : { DOCKER_HOST: env.docker.host }),
  ...(env.docker.compose === undefined ? {} : { PLAINPORT_TESTENV_COMPOSE: env.docker.compose }),
});

/** The environment a `docker compose` call needs to interpolate compose.yaml. */
const composeEnv = (
  dir: string,
  credentials: Credentials | undefined,
): Record<string, string | undefined> => {
  const f = files(dir);
  const ports = portsFor(credentials?.portBase ?? DEFAULT_PORT_BASE);
  // `down`, `ps` and `restart` must interpolate compose.yaml too; without credentials any value will do.
  const placeholder = "unused";
  return {
    ...process.env,
    PLAINPORT_T2_S3_BUCKET: BUCKET,
    PLAINPORT_T2_S3_ACCESS_KEY_ID: credentials?.s3.accessKeyId ?? placeholder,
    PLAINPORT_T2_S3_SECRET_ACCESS_KEY: credentials?.s3.secretAccessKey ?? placeholder,
    PLAINPORT_T2_SSH_DIR: f.ssh,
    PLAINPORT_T2_REST_HTPASSWD: f.htpasswd,
    PLAINPORT_T2_PORT_S3: String(ports.s3),
    PLAINPORT_T2_PORT_S3_PROXIED: String(ports.s3Proxied),
    PLAINPORT_T2_PORT_SFTP: String(ports.sftp),
    PLAINPORT_T2_PORT_SFTP_PROXIED: String(ports.sftpProxied),
    PLAINPORT_T2_PORT_TOXIPROXY: String(ports.toxiproxy),
    PLAINPORT_T2_PORT_REST: String(ports.rest),
  };
};

const compose = (project: string, dir: string, credentials: Credentials | undefined, args: string[]): Ran => {
  const binary = process.env.PLAINPORT_TESTENV_COMPOSE
    ? [process.env.PLAINPORT_TESTENV_COMPOSE]
    : ["docker", "compose"];
  return spawn(
    // --env-file /dev/null: never read a stray .env in the checkout.
    [...binary, "--project-name", project, "--file", composeFile, "--env-file", "/dev/null", ...args],
    composeEnv(dir, credentials),
  );
};

const readCredentials = (dir: string): Credentials | undefined => {
  const path = files(dir).credentials;
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Credentials) : undefined;
};

/** The credentials and keys of the run: the ones already in `dir`, or new ones. */
const prepare = async (dir: string, options: Options): Promise<Credentials> => {
  const f = files(dir);
  const existing = readCredentials(dir);
  if (existing !== undefined) {
    const project = options.project ?? existing.project;
    const portBase = options.portBase ?? existing.portBase;
    if (project !== existing.project || portBase !== existing.portBase) {
      refuse(
        `${dir} already holds project ${existing.project} on port base ${existing.portBase}. ` +
          `Run \`scripts/testenv down --dir ${dir}\` first, or use another --dir.`,
      );
    }
    const missing = ["id_ed25519", "id_ed25519.pub", "host_ed25519", "host_ed25519.pub"]
      .map((name) => join("ssh", name))
      .concat(["rest.htpasswd"])
      .filter((name) => !existsSync(join(dir, name)));
    if (missing.length > 0) {
      refuse(
        `${dir} is incomplete: ${missing.join(", ")} missing beside credentials.json. ` +
          `Run \`scripts/testenv down --dir ${dir}\`, then up again.`,
      );
    }
    return existing;
  }
  mkdirSync(f.ssh, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [key, comment] of [
    [f.identity, "plainport-testenv-client"],
    [f.hostKey, "plainport-testenv-host"],
  ] as const) {
    if (existsSync(key)) unlinkSync(key);
    if (existsSync(`${key}.pub`)) unlinkSync(`${key}.pub`);
    const ran = spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", key]);
    if (ran.exitCode !== 0) refuse(`ssh-keygen failed: ${ran.stderr.trim()}`);
  }
  const credentials: Credentials = {
    project: options.project ?? process.env.PLAINPORT_TESTENV_PROJECT ?? DEFAULT_PROJECT,
    portBase: options.portBase ?? DEFAULT_PORT_BASE,
    s3: { accessKeyId: randomId(20), secretAccessKey: randomBytes(30).toString("base64url") },
    rest: { password: randomBytes(24).toString("hex") },
  };
  writePrivate(
    f.htpasswd,
    `${SFTP_USER}:${await Bun.password.hash(credentials.rest.password, { algorithm: "bcrypt", cost: 6 })}\n`,
  );
  // Written last: its presence means the keys and the htpasswd beside it are complete.
  writePrivate(f.credentials, `${JSON.stringify(credentials, null, 2)}\n`);
  return credentials;
};

const describe = (dir: string, credentials: Credentials, docker: TestEnv["docker"]): TestEnv => {
  const f = files(dir);
  const ports = portsFor(credentials.portBase);
  return {
    v: 1,
    project: credentials.project,
    dir,
    portBase: credentials.portBase,
    docker,
    containers: [],
    s3: {
      kind: "seaweedfs",
      endpoint: `http://127.0.0.1:${ports.s3}`,
      proxied: `http://127.0.0.1:${ports.s3Proxied}`,
      region: "us-east-1",
      bucket: BUCKET,
      accessKeyId: credentials.s3.accessKeyId,
      secretAccessKey: credentials.s3.secretAccessKey,
    },
    sftp: {
      host: "127.0.0.1",
      port: ports.sftp,
      proxiedPort: ports.sftpProxied,
      user: SFTP_USER,
      root: "/data",
      alias: "plainport-sftp",
      proxiedAlias: "plainport-sftp-proxied",
      identityFile: f.identity,
      knownHosts: f.knownHosts,
      sshConfig: f.sshConfig,
    },
    rest: { url: `http://127.0.0.1:${ports.rest}`, user: SFTP_USER, password: credentials.rest.password },
    toxiproxy: { api: `http://127.0.0.1:${ports.toxiproxy}`, proxies: { s3: "s3", sftp: "sftp" } },
  };
};

const writeSsh = (env: TestEnv) => {
  const f = files(env.dir);
  const hostKey = readFileSync(`${f.hostKey}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  writePrivate(
    f.knownHosts,
    `[${env.sftp.host}]:${env.sftp.port} ${hostKey}\n[${env.sftp.host}]:${env.sftp.proxiedPort} ${hostKey}\n`,
  );
  writePrivate(f.sshConfig, sshConfig(env));
};

const populateProxies = async (env: TestEnv) => {
  const body = Object.entries(PROXIES).map(([name, proxy]) => ({ name, ...proxy, enabled: true }));
  await until("Toxiproxy", 60_000, async () => {
    const response = await fetch(`${env.toxiproxy.api}/populate`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`populate: ${response.status} ${await response.text()}`);
    return true;
  });
  // A clean slate: every proxy enabled, no toxic left from an earlier run.
  const reset = await fetch(`${env.toxiproxy.api}/reset`, { method: "POST" });
  if (!reset.ok) refuse(`toxiproxy reset: ${reset.status}`);
};

const s3Client = (env: TestEnv, endpoint: string) =>
  new Bun.S3Client({
    endpoint,
    bucket: env.s3.bucket,
    region: env.s3.region,
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
  });

/** Each service, checked from the host as the suites will reach it. */
const probe = async (env: TestEnv, services: readonly Service[]) => {
  for (const service of services) {
    if (service === "s3") {
      for (const endpoint of [env.s3.endpoint, env.s3.proxied]) {
        await until(`the S3 store at ${endpoint}`, 90_000, async () => {
          await s3Client(env, endpoint).list({ maxKeys: 1 });
          return true;
        });
      }
    } else if (service === "sftp") {
      for (const alias of [env.sftp.alias, env.sftp.proxiedAlias]) {
        await until(`SFTP (${alias})`, 90_000, async () => {
          const ran = spawn(
            ["sftp", "-F", env.sftp.sshConfig, "-b", "-", alias],
            process.env,
            `ls ${env.sftp.root}\n`,
          );
          if (ran.exitCode !== 0) throw new Error(ran.stderr.trim());
          return true;
        });
      }
    } else if (service === "rest") {
      await until("rest-server", 60_000, async () => {
        const auth = `Basic ${btoa(`${env.rest.user}:${env.rest.password}`)}`;
        const response = await fetch(`${env.rest.url}/`, { headers: { Authorization: auth } });
        if (response.status === 401) refuse("rest-server refused the run's credentials");
        return true;
      });
    } else {
      await until("Toxiproxy", 60_000, async () =>
        (await fetch(`${env.toxiproxy.api}/version`)).ok ? true : undefined,
      );
    }
  }
};

type PsRow = { Service: string; State: string; Health: string };
const ps = (project: string, dir: string): PsRow[] => {
  const ran = compose(project, dir, readCredentials(dir), ["ps", "--all", "--format", "json"]);
  if (ran.exitCode !== 0) refuse(`docker compose ps failed: ${ran.stderr.trim()}`);
  return ran.stdout
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => JSON.parse(line) as PsRow | PsRow[]);
};

const waitHealthy = async (project: string, dir: string, service: Service) =>
  until(`${service}'s health check`, 120_000, async () =>
    ps(project, dir).some((row) => row.Service === service && row.Health === "healthy") ? true : undefined,
  );

const up = async (dir: string, options: Options) => {
  const credentials = await prepare(dir, options);
  const host = dockerHost();
  const binary = composeBinary();
  const env = describe(dir, credentials, {
    ...(host === undefined ? {} : { host }),
    ...(binary === undefined ? {} : { compose: binary }),
  });
  writeSsh(env);
  const started = compose(credentials.project, dir, credentials, [
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "180",
    "--remove-orphans",
  ]);
  if (started.exitCode !== 0) {
    refuse(
      `docker compose up failed:\n${started.stderr.trim()}\nRun \`scripts/testenv down\` and try again.`,
    );
  }
  await populateProxies(env);
  await probe(env, SERVICES);
  const ids = compose(credentials.project, dir, credentials, ["ps", "--quiet"]);
  env.containers = ids.stdout.split("\n").filter((line) => line.trim());
  if (ids.exitCode !== 0 || env.containers.length !== SERVICES.length) {
    refuse(
      `docker compose ps found ${env.containers.length} containers, not ${SERVICES.length}: ${ids.stderr.trim()}`,
    );
  }
  // Written last: describeT2 suites take its presence to mean the environment is up.
  writePrivate(files(dir).env, `${JSON.stringify(env, null, 2)}\n`);
  console.log(
    `testenv: ${credentials.project} is up and healthy; endpoints and credentials in ${files(dir).env}`,
  );
};

const down = (dir: string, options: Options) => {
  const credentials = readCredentials(dir);
  const project =
    credentials?.project ?? options.project ?? process.env.PLAINPORT_TESTENV_PROJECT ?? DEFAULT_PROJECT;
  const f = files(dir);
  // Refuse before stopping anything: a refusal after `compose down` would leave an env.json that describes
  // containers that are gone.
  if (existsSync(dir)) {
    const strangers = [
      ...readdirSync(dir).filter((name) => !OWN_FILES.includes(name)),
      ...(existsSync(f.ssh) ? readdirSync(f.ssh).filter((name) => !OWN_SSH_FILES.includes(name)) : []),
    ];
    if (strangers.length > 0) {
      refuse(
        `${dir} holds files testenv did not write (${strangers.join(", ")}); remove them, then run down again. ` +
          "Nothing was stopped.",
      );
    }
    // env.json first, so no suite takes the environment for up while it goes down.
    if (existsSync(f.env)) unlinkSync(f.env);
  }
  const ran = compose(project, dir, credentials, ["down", "--volumes", "--remove-orphans", "--timeout", "5"]);
  if (ran.exitCode !== 0) refuse(`docker compose down failed: ${ran.stderr.trim()}`);
  if (existsSync(dir)) {
    for (const name of OWN_FILES.filter((name) => name !== "ssh")) {
      if (existsSync(join(dir, name))) unlinkSync(join(dir, name));
    }
    if (existsSync(f.ssh)) {
      for (const name of readdirSync(f.ssh)) unlinkSync(join(f.ssh, name));
      rmdirSync(f.ssh);
    }
    rmdirSync(dir);
  }
  console.log(`testenv: ${project} is down; no container, volume or network of it is left`);
};

const status = (dir: string, options: Options): number => {
  const project =
    readCredentials(dir)?.project ??
    options.project ??
    process.env.PLAINPORT_TESTENV_PROJECT ??
    DEFAULT_PROJECT;
  const rows = ps(project, dir);
  let healthy = 0;
  for (const service of SERVICES) {
    const row = rows.find((candidate) => candidate.Service === service);
    const state = row === undefined ? "absent" : row.Health || row.State;
    if (state === "healthy") healthy++;
    console.log(`${service.padEnd(10)} ${state}`);
  }
  return healthy === SERVICES.length && existsSync(files(dir).env) ? 0 : 1;
};

const restart = async (dir: string, service: Service) => {
  const env = loadTestEnv(dir);
  const credentials = readCredentials(dir);
  const ran = compose(env.project, dir, credentials, ["restart", "--timeout", "10", service]);
  if (ran.exitCode !== 0) refuse(`docker compose restart ${service} failed: ${ran.stderr.trim()}`);
  await waitHealthy(env.project, dir, service);
  // Toxiproxy keeps its proxies in memory only.
  if (service === "toxiproxy") await populateProxies(env);
  await probe(env, service === "toxiproxy" ? ["toxiproxy", "s3", "sftp"] : [service]);
  console.log(`testenv: ${service} restarted and healthy`);
};

const main = async (argv: string[]): Promise<number> => {
  const parsed = parseCommand(argv);
  if (!parsed.ok) {
    console.error(`testenv: ${parsed.message}`);
    return 2;
  }
  const dir = parsed.dir ?? testenvDir();
  switch (parsed.command) {
    case "up":
      await up(dir, parsed);
      return 0;
    case "down":
      down(dir, parsed);
      return 0;
    case "status":
      return status(dir, parsed);
    case "env":
      for (const line of envLines(loadTestEnv(dir))) console.log(line);
      return 0;
    case "restart":
      await restart(dir, parsed.service);
      return 0;
    case "fault":
      await applyProfile(loadTestEnv(dir), parsed.proxy, parsed.profile);
      console.log(`testenv: ${parsed.proxy}: ${parsed.profile}`);
      return 0;
    case "linux": {
      console.log(
        `testenv linux: ${LINUX_IMAGE}, --init; known gaps:\n${LINUX_GAPS.map((gap) => `- ${gap}`).join("\n")}`,
      );
      const child = Bun.spawnSync(linuxCommand({ checkout, run: parsed.run }), {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exitCode ?? 1;
    }
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    if (!(error instanceof TestenvError)) throw error;
    console.error(`testenv: ${error.message}`);
    process.exitCode = 1;
  }
}
