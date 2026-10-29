// The `ssh` that T2 tests hand to rclone (`--sftp-ssh`) and to anything else that runs ssh from PATH (M2 Task 17;
// DESIGN.md "Machines → SSH policy", "Testing": an `ssh` shim). It is the system's OpenSSH, as installed, always with
// the sandbox's config (-F: never ~/.ssh/config, whose HOME a test does not own), BatchMode=yes so nothing ever
// prompts, and StrictHostKeyChecking=yes so only the pinned host key is accepted.
//
// With `trace`, the shim also copies what passes over the SFTP channel each way into two files, so a test can read
// the SFTP requests the client sent (sftpRequests): that is how Task 17 measures whether rclone ever asks the server
// to fsync (R2-6). The copy goes through tee, so the bytes rclone and the server see are unchanged.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The system's OpenSSH, by absolute path: never a shell function or another ssh earlier on PATH. */
export const SYSTEM_SSH = "/usr/bin/ssh";

export interface SshShim {
  /** The executable shim (`<dir>/ssh`). */
  path: string;
  /** Its folder, to put first on a child's PATH. */
  dir: string;
  /** rclone's `ssh` option for a host alias of the config: rclone appends `-s sftp` itself. */
  rcloneSsh(alias: string): string;
  /** With `trace`: the files the client's and the server's bytes are copied to, one pair per connection. */
  traces?: { dir: string };
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** rclone's SpaceSepList quoting: an argument with a space or a quote is double-quoted. */
const rcloneQuote = (value: string): string =>
  /[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"] as const;

/** Writes the shim into `dir` (created if needed) for the sandbox ssh config at `config`. */
export const makeSshShim = (dir: string, config: string, options: { trace?: boolean } = {}): SshShim => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ssh");
  const ssh = [SYSTEM_SSH, "-F", config, ...OPTIONS].map(shellQuote).join(" ");
  let traces: SshShim["traces"];
  let body: string;
  if (options.trace) {
    const traceDir = join(dir, "traces");
    mkdirSync(traceDir, { recursive: true });
    traces = { dir: traceDir };
    // One pair of files per connection, named by the shim's pid. pipefail is not POSIX: the exit status is ssh's,
    // read from a file the pipeline's middle writes.
    body = [
      "#!/bin/sh",
      `t=${shellQuote(traceDir)}/$$`,
      `tee "$t.up" | { ${ssh} "$@"; echo $? > "$t.status"; } | tee "$t.down"`,
      'status=$(cat "$t.status" 2>/dev/null || echo 255)',
      'exit "$status"',
      "",
    ].join("\n");
  } else {
    body = ["#!/bin/sh", `exec ${ssh} "$@"`, ""].join("\n");
  }
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return {
    path,
    dir,
    rcloneSsh: (alias) => [path, alias].map(rcloneQuote).join(" "),
    ...(traces === undefined ? {} : { traces }),
  };
};

/** An SFTP packet's type and, for SSH_FXP_EXTENDED (200), its request name. */
export interface SftpPacket {
  type: number;
  extended?: string;
}

/** SFTP packet types (draft-ietf-secsh-filexfer-02, the version OpenSSH speaks). */
export const SFTP = { INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, WRITE: 6, RENAME: 18, EXTENDED: 200 } as const;

/** The packets of one direction of an SFTP channel: uint32 length, then the type byte and the payload. */
export const sftpPackets = (bytes: Uint8Array): SftpPacket[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: SftpPacket[] = [];
  for (let at = 0; at + 5 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = bytes[at + 4] as number;
    if (at + 4 + length > bytes.length) break; // cut short: the connection ended mid-packet
    const packet: SftpPacket = { type };
    if (type === SFTP.EXTENDED && length >= 13) {
      // type, uint32 request id, then string extended-request (uint32 length + bytes)
      const nameLength = view.getUint32(at + 9);
      packet.extended = new TextDecoder().decode(bytes.subarray(at + 13, at + 13 + nameLength));
    }
    packets.push(packet);
    at += 4 + length;
  }
  return packets;
};

/** The extensions a server's SSH_FXP_VERSION names: uint32 version, then (name, data) string pairs. */
export const sftpServerExtensions = (down: Uint8Array): string[] => {
  const view = new DataView(down.buffer, down.byteOffset, down.byteLength);
  if (down.length < 9 || down[4] !== SFTP.VERSION) return [];
  const end = 4 + view.getUint32(0);
  const names: string[] = [];
  const decoder = new TextDecoder();
  for (let at = 9; at + 4 <= end; ) {
    const nameLength = view.getUint32(at);
    const name = decoder.decode(down.subarray(at + 4, at + 4 + nameLength));
    at += 4 + nameLength;
    if (at + 4 > end) break;
    at += 4 + view.getUint32(at);
    names.push(name);
  }
  return names;
};
