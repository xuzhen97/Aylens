import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DirectTransport } from "../src/transports/direct.js";
import { HttpProxyTransport } from "../src/transports/http-proxy.js";
import { Socks5Transport } from "../src/transports/socks5.js";
import type { TransportResponsePolicy } from "../src/transports/types.js";

const servers: net.Server[] = [];

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return address.port;
}

function createSocks5Proxy(): net.Server {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" = "greeting";

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methodsLength = buffer[1] ?? 0;
        const frameLength = 2 + methodsLength;
        if (buffer.length < frameLength) return;

        buffer = buffer.subarray(frameLength);
        client.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }

      if (stage !== "request" || buffer.length < 5) return;

      const addressType = buffer[3];
      let host: string;
      let offset: number;

      if (addressType === 0x01) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join(".");
        offset = 8;
      } else if (addressType === 0x03) {
        const length = buffer[4] ?? 0;
        if (buffer.length < 7 + length) return;
        host = buffer.subarray(5, 5 + length).toString("utf8");
        offset = 5 + length;
      } else {
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      if (buffer.length < offset + 2) return;
      const port = buffer.readUInt16BE(offset);
      const leftover = buffer.subarray(offset + 2);

      client.off("data", onData);

      const upstream = net.connect(port, host);
      upstream.once("connect", () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (leftover.length > 0) upstream.write(leftover);
        client.pipe(upstream);
        upstream.pipe(client);
      });

      upstream.once("error", () => {
        client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    };

    client.on("data", onData);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe("proxy transports", () => {
  it("forwards an HTTP request through an HTTP proxy", async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "x-target": "yes" });
      response.end("proxied-ok");
    });
    const targetPort = await listen(target);

    const proxy = http.createServer((request, response) => {
      if (!request.url) {
        response.writeHead(400).end();
        return;
      }

      const targetUrl = new URL(request.url);
      const upstream = http.request(
        targetUrl,
        { method: request.method, headers: request.headers },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
    });
    const proxyPort = await listen(proxy);

    const transport = new HttpProxyTransport("proxy-test", `http://127.0.0.1:${proxyPort}`);
    const result = await transport.request({
      url: `http://127.0.0.1:${targetPort}/hello`,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("proxied-ok");
    expect(result.headers.get("x-target")).toBe("yes");
  });

  it("forwards an HTTP request through a SOCKS5 proxy", async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("socks-ok");
    });
    const targetPort = await listen(target);

    const socks = createSocks5Proxy();
    const socksPort = await listen(socks);

    const transport = new Socks5Transport(
      "socks-live",
      `socks5://127.0.0.1:${socksPort}`,
    );

    const result = await transport.request({
      url: `http://127.0.0.1:${targetPort}/through-socks`,
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("socks-ok");
  });

  it("normalizes SOCKS5 connection failures as PROXY_FAILED", async () => {
    const transport = new Socks5Transport("socks-test", "socks5://127.0.0.1:1");

    await expect(
      transport.request({ url: "http://example.test/" }),
    ).rejects.toMatchObject({
      code: "PROXY_FAILED",
      retryable: true,
    });
  });
});

describe("constrained responses through transports", () => {
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

  /** 测试专用转发代理：只允许回环目标，避免成为一个通用的开放转发器。 */
  function createForwardProxy(): http.Server {
    return http.createServer((request, response) => {
      const target = request.url ? new URL(request.url) : undefined;
      if (!target || (target.hostname !== "127.0.0.1" && target.hostname !== "::1")) {
        response.writeHead(403).end();
        return;
      }

      // 只用通过白名单校验的分量构造上游请求，不把原始 URL 直接交给 http.request。
      const upstream = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 500, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
    });
  }

  it("enforces the byte limit on a direct constrained request", async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789");
    });
    const targetPort = await listen(target);

    await expect(new DirectTransport("direct-constrained").request({
      url: `http://127.0.0.1:${targetPort}/`,
      responsePolicy: constrainedPolicy({ maxBytes: 4 }),
    })).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE" });
  });

  it("applies the response policy through the HTTP proxy transport", async () => {
    const payload = "proxied constrained body";
    const target = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "gzip",
      });
      response.end(gzipSync(Buffer.from(payload)));
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(createForwardProxy());

    const transport = new HttpProxyTransport("proxy-constrained", `http://127.0.0.1:${proxyPort}`);
    const result = await transport.request({
      url: `http://127.0.0.1:${targetPort}/`,
      responsePolicy: constrainedPolicy(),
    });

    expect(result.body).toBe(payload);
  });

  it("reports a resource-limit rejection as CONTENT_UNAVAILABLE rather than PROXY_FAILED", async () => {
    const target = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("0123456789");
    });
    const targetPort = await listen(target);
    const proxyPort = await listen(createForwardProxy());

    const transport = new HttpProxyTransport("proxy-constrained", `http://127.0.0.1:${proxyPort}`);

    await expect(transport.request({
      url: `http://127.0.0.1:${targetPort}/`,
      responsePolicy: constrainedPolicy({ maxBytes: 4 }),
    })).rejects.toMatchObject({ code: "CONTENT_UNAVAILABLE", retryable: false });
  });
});
