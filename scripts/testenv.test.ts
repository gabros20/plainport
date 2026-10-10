// T0: the parts of scripts/testenv.ts that need no Docker. The T2 smoke test (testenv.t2.test.ts) runs the real thing.
import { describe, expect, test } from "bun:test";
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  envLines,
  LINUX_GAPS,
  LINUX_IMAGE,
  linuxCommand,
  PROFILES,
  PROXIES,
  parseCommand,
  portsFor,
  serviceName,
  sshConfig,
  type TestEnv,
} from "./testenv.ts";

const checkout = join(import.meta.dir, "..");

type ComposeService = {
  image: string;
  ports?: string[];
  command?: string[] | string;
  environment?: Record<string, string>;
  depends_on?: Record<string, unknown> | string[];
  healthcheck?: { test: unknown };
};
const compose = Bun.YAML.parse(readFileSync(join(checkout, "compose.yaml"), "utf8")) as {
  services: Record<string, ComposeService>;
};

const sample: TestEnv = {
  v: 1,
  project: "plainport-testenv",
  dir: "/w/.testenv",
  portBase: 39100,
  docker: { host: "unix:///var/run/docker.sock" },
  s3: {
    kind: "seaweedfs",
    endpoint: "http://127.0.0.1:39100",
    proxied: "http://127.0.0.1:39101",
    region: "us-east-1",
    bucket: "plainport-t2",
    accessKeyId: "AK",
    secretAccessKey: "SK",
  },
  sftp: {
    host: "127.0.0.1",
    port: 39122,
    proxiedPort: 39123,
    user: "plainport",
    root: "/data",
    alias: "plainport-sftp",
    proxiedAlias: "plainport-sftp-proxied",
    identityFile: "/w/.testenv/ssh/id_ed25519",
    knownHosts: "/w/.testenv/ssh/known_hosts",
    sshConfig: "/w/.testenv/ssh/config",
  },
  rest: { url: "http://127.0.0.1:39180", user: "plainport", password: "PW" },
  toxiproxy: { api: "http://127.0.0.1:39174", proxies: { s3: "s3", sftp: "sftp" } },
};

describe("testenv: compose.yaml", () => {
  test("holds the S3 store, SFTP, rest-server and Toxiproxy", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["rest", "s3", "sftp", "toxiproxy"]);
  });

  test("pins every image by digest", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect({ name, image: service.image }).toEqual({
        name,
        image: expect.stringMatching(/^[a-z0-9./-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/) as unknown as string,
      });
    }
  });

  test("binds every port to 127.0.0.1", () => {
    const ports = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThanOrEqual(6);
    for (const port of ports) expect(port).toStartWith("127.0.0.1:");
  });

  test("every service has a health check, so `up --wait` means healthy", () => {
    for (const service of Object.values(compose.services)) expect(service.healthcheck?.test).toBeDefined();
  });

  test("rest-server runs --append-only, with authentication", () => {
    const rest = compose.services.rest;
    expect(rest?.environment?.OPTIONS).toContain("--append-only");
    expect(rest?.environment?.DISABLE_AUTHENTICATION).toBeUndefined();
  });

  test("Toxiproxy sits in front of the S3 store and SFTP", () => {
    const depends = compose.services.toxiproxy?.depends_on ?? {};
    expect(Object.keys(depends).sort()).toEqual(["s3", "sftp"]);
    expect(PROXIES.s3.upstream).toBe("s3:8333");
    expect(PROXIES.sftp.upstream).toBe("sftp:22");
  });
});

describe("testenv: fault profiles", () => {
  test("are cut, latency, slow-close and lost-ack", () => {
    expect(Object.keys(PROFILES).sort()).toEqual(["cut", "latency", "lost-ack", "slow-close"]);
  });

  test("cut resets the connection both ways at the first byte", () => {
    expect(PROFILES.cut.map((toxic) => [toxic.type, toxic.stream, toxic.attributes])).toEqual([
      ["reset_peer", "upstream", { timeout: 0 }],
      ["reset_peer", "downstream", { timeout: 0 }],
    ]);
  });

  test("lost-ack forwards the request whole and resets at the first byte of the response", () => {
    // reset_peer drops the chunk that triggers it and closes with SO_LINGER 0 (a TCP RST). On the downstream
    // stream only, so nothing in the upstream direction is touched: the server gets the whole request.
    expect(PROFILES["lost-ack"].map((toxic) => [toxic.type, toxic.stream, toxic.attributes])).toEqual([
      ["reset_peer", "downstream", { timeout: 0 }],
    ]);
  });

  test("latency delays both ways, and slow-close delays the close", () => {
    expect(PROFILES.latency.map((toxic) => [toxic.type, toxic.stream])).toEqual([
      ["latency", "upstream"],
      ["latency", "downstream"],
    ]);
    expect(PROFILES["slow-close"].map((toxic) => [toxic.type, toxic.stream])).toEqual([
      ["slow_close", "downstream"],
    ]);
  });

  test("every toxic has a unique name and acts on every connection", () => {
    const names = Object.values(PROFILES).flatMap((toxics) => toxics.map((toxic) => toxic.name));
    expect(new Set(names).size).toBe(names.length);
    for (const toxic of Object.values(PROFILES).flat()) expect(toxic.toxicity).toBe(1);
  });
});

describe("testenv: ports, ssh and env", () => {
  test("ports derive from one base, so a second environment can run beside the first", () => {
    expect(portsFor(39100)).toEqual({
      s3: 39100,
      s3Proxied: 39101,
      sftp: 39122,
      sftpProxied: 39123,
      toxiproxy: 39174,
      rest: 39180,
    });
    expect(portsFor(39300).s3).toBe(39300);
  });

  test("the ssh config is a sandbox: its own key, its own known_hosts, no agent, strict host keys", () => {
    const config = sshConfig(sample);
    for (const alias of ["plainport-sftp", "plainport-sftp-proxied"])
      expect(config).toContain(`Host ${alias}\n`);
    expect(config).toContain("Port 39122\n");
    expect(config).toContain("Port 39123\n");
    expect(config).toContain("IdentityFile /w/.testenv/ssh/id_ed25519\n");
    expect(config).toContain("IdentitiesOnly yes\n");
    expect(config).toContain("IdentityAgent none\n");
    expect(config).toContain("UserKnownHostsFile /w/.testenv/ssh/known_hosts\n");
    expect(config).toContain("GlobalKnownHostsFile /dev/null\n");
    expect(config).toContain("StrictHostKeyChecking yes\n");
    expect(config).toContain("PasswordAuthentication no\n");
  });

  test("`env` prints shell exports for every endpoint", () => {
    const lines = envLines(sample);
    expect(lines).toContain("export PLAINPORT_T2_S3_ENDPOINT='http://127.0.0.1:39100'");
    expect(lines).toContain("export PLAINPORT_T2_S3_PROXIED='http://127.0.0.1:39101'");
    expect(lines).toContain("export PLAINPORT_T2_SFTP_SSH_CONFIG='/w/.testenv/ssh/config'");
    expect(lines).toContain("export PLAINPORT_T2_TOXIPROXY='http://127.0.0.1:39174'");
    expect(lines).toContain("export PLAINPORT_TESTENV_DIR='/w/.testenv'");
  });

  test("minio names the S3 service, so `restart minio` keeps working", () => {
    expect(serviceName("minio")).toBe("s3");
    expect(serviceName("s3")).toBe("s3");
    expect(serviceName("sftp")).toBe("sftp");
    expect(serviceName("nope")).toBeUndefined();
  });
});

describe("testenv: command line", () => {
  test("parses every subcommand and refuses an unknown one", () => {
    expect(parseCommand(["up"])).toMatchObject({ ok: true, command: "up" });
    expect(parseCommand(["down"])).toMatchObject({ ok: true, command: "down" });
    expect(parseCommand(["status"])).toMatchObject({ ok: true, command: "status" });
    expect(parseCommand(["env"])).toMatchObject({ ok: true, command: "env" });
    expect(parseCommand(["restart", "minio"])).toMatchObject({ ok: true, command: "restart", service: "s3" });
    expect(parseCommand(["fault", "s3", "lost-ack"])).toMatchObject({
      ok: true,
      command: "fault",
      proxy: "s3",
      profile: "lost-ack",
    });
    expect(parseCommand(["fault", "sftp", "clear"])).toMatchObject({ ok: true, profile: "clear" });
    expect(parseCommand(["linux"])).toMatchObject({ ok: true, command: "linux", run: "bun run test:t1" });
    expect(parseCommand(["linux", "--", "bun", "test", "x"])).toMatchObject({ run: "bun test x" });
    expect(parseCommand(["up", "--dir", "/d", "--project", "p", "--port-base", "39300"])).toMatchObject({
      ok: true,
      dir: "/d",
      project: "p",
      portBase: 39300,
    });
    expect(parseCommand([])).toMatchObject({ ok: false });
    expect(parseCommand(["bogus"])).toMatchObject({ ok: false });
    expect(parseCommand(["restart"])).toMatchObject({ ok: false });
    expect(parseCommand(["restart", "redis"])).toMatchObject({ ok: false });
    expect(parseCommand(["fault", "rest", "cut"])).toMatchObject({ ok: false });
    expect(parseCommand(["fault", "s3", "melt"])).toMatchObject({ ok: false });
    expect(parseCommand(["up", "--port-base", "80"])).toMatchObject({ ok: false });
  });

  test("the scripts/testenv wrapper is executable and runs testenv.ts", () => {
    const wrapper = join(checkout, "scripts", "testenv");
    accessSync(wrapper, constants.X_OK);
    expect(readFileSync(wrapper, "utf8")).toContain('exec bun "$here/testenv.ts" "$@"');
  });
});

describe("testenv: the Linux recipe", () => {
  test("runs the pinned oven/bun that matches .bun-version, with --init, on a read-only copy of the checkout", () => {
    const bun = readFileSync(join(checkout, ".bun-version"), "utf8").trim();
    expect(LINUX_IMAGE).toMatch(new RegExp(`^oven/bun:${bun.replaceAll(".", "\\.")}@sha256:[0-9a-f]{64}$`));
    const argv = linuxCommand({ checkout: "/c", run: "bun run test:t1" });
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    expect(argv).toContain("--init");
    expect(argv).toContain("/c:/src:ro");
    expect(argv).toContain(LINUX_IMAGE);
    const script = argv.at(-1) ?? "";
    expect(script).toContain("bun install --frozen-lockfile");
    expect(script).toContain("bun scripts/fetch-tools.ts");
    expect(script).toContain("bun run test:t1");
    // Tests run as the image's unprivileged user: as root, permission tests can't fail the way they should.
    expect(script).toContain("runuser -u bun");
  });

  test("names its known gaps", () => {
    expect(LINUX_GAPS.join("\n")).toContain("fsmonitor");
  });
});

describe("testenv: repository wiring", () => {
  test(".testenv/ is gitignored", () => {
    expect(readFileSync(join(checkout, ".gitignore"), "utf8").split("\n")).toContain(".testenv/");
  });

  test("test:t2 and test:t3 set PLAINPORT_TEST_TIER to 2 and 3", () => {
    const pkg = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:t2"]).toBe("bun run check:bun && PLAINPORT_TEST_TIER=2 bun test");
    expect(pkg.scripts["test:t3"]).toBe("bun run check:bun && PLAINPORT_TEST_TIER=3 bun test");
  });
});
