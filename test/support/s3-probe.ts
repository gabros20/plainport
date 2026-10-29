// A test-only S3 client signed with AWS Signature Version 4 (M2 Task 17): the direct reference the rclone adapter's
// behaviour is measured against, on the T2 S3 store (SeaweedFS, D94) and later on the T3 buckets. It speaks
// path-style requests over plain fetch, each body hashed into its signature, and is never used by plainport itself:
// what a store does with `If-None-Match: *` is asked of the store here, not of rclone (ADR-0018).

import { createHash, createHmac } from "node:crypto";

export interface S3ProbeOptions {
  /** http(s)://host:port, without the bucket. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ProbeResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants it; "/" stays as it is in a path. */
const encode = (text: string, keepSlash: boolean): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) return char;
      return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");

export interface S3Probe {
  request(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    options?: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<ProbeResponse>;
  /** PUT; with `ifNoneMatch` it sends `If-None-Match: *`. */
  put(key: string, body: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<ProbeResponse>;
  get(key: string): Promise<ProbeResponse>;
  delete(key: string): Promise<ProbeResponse>;
  /** Every key under a prefix, page by page (ListObjectsV2), with the number of pages it took. */
  list(prefix: string, pageSize?: number): Promise<{ keys: string[]; pages: number }>;
}

export const s3Probe = (options: S3ProbeOptions): S3Probe => {
  const url = new URL(options.endpoint);
  const request: S3Probe["request"] = async (method, key, how = {}) => {
    const body = how.body ?? new Uint8Array();
    const path = `/${encode(options.bucket, false)}${key === "" ? "" : `/${encode(key, true)}`}`;
    const query = Object.entries(how.query ?? {})
      .map(([k, v]) => [encode(k, false), encode(v, false)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...Object.fromEntries(Object.entries(how.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      path,
      query,
      ...names.map((name) => `${name}:${String(headers[name]).trim()}`),
      "",
      names.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${day}/${options.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
    let signingKey = hmac(`AWS4${options.secretAccessKey}`, day);
    for (const part of [options.region, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
    const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
    const { host: _host, ...sent } = headers;
    const response = await fetch(`${url.origin}${path}${query === "" ? "" : `?${query}`}`, {
      method,
      headers: {
        ...sent,
        authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
      },
      ...(method === "PUT" ? { body } : {}),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  };

  return {
    request,
    put: (key, body, how = {}) =>
      request("PUT", key, { body, ...(how.ifNoneMatch ? { headers: { "If-None-Match": "*" } } : {}) }),
    get: (key) => request("GET", key),
    delete: (key) => request("DELETE", key),
    list: async (prefix, pageSize = 1000) => {
      const keys: string[] = [];
      let token: string | undefined;
      let pages = 0;
      do {
        const listed = await request("GET", "", {
          query: {
            "list-type": "2",
            prefix,
            "max-keys": String(pageSize),
            ...(token === undefined ? {} : { "continuation-token": token }),
          },
        });
        if (listed.status !== 200)
          throw new Error(
            `ListObjectsV2 ${prefix}: ${listed.status} ${new TextDecoder().decode(listed.body)}`,
          );
        pages++;
        const xml = new TextDecoder().decode(listed.body);
        for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(match[1] as string));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "")
          : undefined;
        if (token === "") throw new Error(`ListObjectsV2 ${prefix}: truncated without a continuation token`);
      } while (token !== undefined);
      return { keys, pages };
    },
  };
};

const unescapeXml = (text: string): string =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
