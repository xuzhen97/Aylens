import http from "node:http";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { DirectTransport } from "../src/transports/direct.js";
import type { TransportResponse, TransportResponsePolicy } from "../src/transports/types.js";

const servers: http.Server[] = [];

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => {
      // 停顿读取类测试会留下半开连接，必须强制断开，否则 close 会一直等待。
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  ));
});

function constrainedPolicy(overrides: Partial<TransportResponsePolicy> = {}): TransportResponsePolicy {
  return {
    maxBytes: 1_000_000,
    maxDecodedBytes: 1_000_000,
    decode: "web",
    redirect: "manual",
    network: "controlled-egress",
    ...overrides,
  };
}

function fetchWithPolicy(
  port: number,
  responsePolicy: TransportResponsePolicy,
  signal?: AbortSignal,
): Promise<TransportResponse> {
  return new DirectTransport("direct-test").request({
    url: `http://127.0.0.1:${port}/`,
    responsePolicy,
    signal,
  });
}

describe("constrained response reading", () => {
  it("rejects a response that exceeds the raw byte limit", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789");
    });

    await expect(fetchWithPolicy(port, constrainedPolicy({ maxBytes: 4 }))).rejects.toMatchObject({
      code: "CONTENT_UNAVAILABLE",
      retryable: false,
    });
  });

  it("decodes gzip, zlib deflate, raw deflate and brotli bodies", async () => {
    const payload = "压缩与明文 mixed content 123 ".repeat(20);
    const cases: Array<[string, Buffer]> = [
      ["gzip", gzipSync(Buffer.from(payload))],
      ["deflate", deflateSync(Buffer.from(payload))],
      ["deflate", deflateRawSync(Buffer.from(payload))],
      ["br", brotliCompressSync(Buffer.from(payload))],
    ];

    for (const [encoding, encoded] of cases) {
      const port = await listen((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-encoding": encoding,
        });
        response.end(encoded);
      });

      const result = await fetchWithPolicy(port, constrainedPolicy());
      expect(result.body, `content-encoding: ${encoding}`).toBe(payload);
    }
  });

  it("rejects a decompressed body that exceeds the decoded limit", async () => {
    const compressed = gzipSync(Buffer.from("a".repeat(50_000)));
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      response.end(compressed);
    });

    await expect(fetchWithPolicy(port, constrainedPolicy({ maxDecodedBytes: 1_000 }))).rejects
      .toMatchObject({ code: "CONTENT_UNAVAILABLE" });
  });

  it("fails clearly when the compressed body is corrupt", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      response.end(Buffer.from("not actually gzip"));
    });

    await expect(fetchWithPolicy(port, constrainedPolicy())).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });

  it("decodes a GBK body declared by the HTTP charset", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=gbk" });
      response.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    });

    const result = await fetchWithPolicy(port, constrainedPolicy());
    expect(result.body).toBe("中文");
    expect(result.decodeWarning).toBeUndefined();
    expect(result.bodyBytes?.byteLength).toBe(4);
  });

  it("decodes a GBK body declared only by the HTML meta charset", async () => {
    const html = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>', "latin1"),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from("</body></html>", "latin1"),
    ]);
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html);
    });

    const result = await fetchWithPolicy(port, constrainedPolicy());
    expect(result.body).toContain("中文");
  });

  it("strips a UTF-8 BOM", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]));
    });

    const result = await fetchWithPolicy(port, constrainedPolicy());
    expect(result.body).toBe("hello");
  });

  it("fails clearly on an unsupported charset label", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=x-unknown-enc" });
      response.end("hello");
    });

    await expect(fetchWithPolicy(port, constrainedPolicy())).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });

  it("records a decode warning instead of silently mangling invalid bytes", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(Buffer.from([0x61, 0xff, 0x62]));
    });

    const result = await fetchWithPolicy(port, constrainedPolicy());
    expect(result.body).toContain("\uFFFD");
    expect(result.decodeWarning).toContain("utf-8");
  });

  it("fails clearly on an unsupported content-encoding", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
      response.end("hello");
    });

    await expect(fetchWithPolicy(port, constrainedPolicy())).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });

  it("aborts a stalled read with TIMEOUT", async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
    });

    const controller = new AbortController();
    const pending = fetchWithPolicy(port, constrainedPolicy(), controller.signal);
    setTimeout(() => controller.abort(), 30).unref();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("does not follow redirects on the constrained path", async () => {
    let followed = 0;
    const targetPort = await listen((_request, response) => {
      followed += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("landed");
    });
    const port = await listen((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
      response.end();
    });

    const result = await fetchWithPolicy(port, constrainedPolicy());
    expect(result.status).toBe(302);
    expect(result.finalUrl).toBe(`http://127.0.0.1:${port}/`);
    expect(result.body).toBe("");
    expect(followed).toBe(0);
  });
});
