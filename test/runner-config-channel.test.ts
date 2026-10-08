import { describe, expect, it, vi } from "vitest";
import { RunnerConfigChannel } from "../src/runtime/runner-config-channel.js";
import { upgradeIsSecureOrLocal } from "../src/api/http/config-channel-security.js";
import type { ProxyWrite } from "../src/runtime/proxy-config-contract.js";

type FakeSocket = {
  readyState: number;
  OPEN: number;
  sent: Array<Record<string, unknown>>;
  send: (raw: string) => void;
};

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send: (raw: string) => {
      socket.sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  };
  return socket;
}

const sampleWrite: ProxyWrite = {
  operationId: "op-1",
  expectedVersion: 3,
  mutation: {
    kind: "put",
    id: "proxy-main",
    type: "http-proxy",
    address: "http://127.0.0.1:8899",
    credentials: { action: "clear" },
  },
};

function makeChannel(options: { timeoutMs?: number } = {}) {
  return new RunnerConfigChannel(options.timeoutMs ?? 10_000);
}

describe("RunnerConfigChannel", () => {
  it("sends a CONFIG_REQUEST and resolves with a CONFIG_RESULT payload", async () => {
    const channel = makeChannel();
    const socket = fakeSocket();
    channel.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: true });

    const pending = channel.request("r1", { kind: "write", write: sampleWrite });
    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0]!;
    expect(sent.type).toBe("CONFIG_REQUEST");
    expect(sent.operationId).toBe("op-1");
    expect(JSON.stringify(sent)).toContain("proxy-main");

    channel.handle({
      type: "CONFIG_RESULT",
      messageId: "m1",
      requestId: (sent.requestId as string),
      runnerId: "r1",
      result: { version: 4, proxies: [], providers: [], browserRestartRequired: [] },
      timestamp: Date.now(),
    } as never);

    const result = await pending;
    expect(result.version).toBe(4);
    channel.close();
  });

  it("rejects offline requests deterministically without sending anything", async () => {
    const channel = makeChannel();
    await expect(channel.request("missing", { kind: "read" }))
      .rejects.toMatchObject({ code: "RUNTIME_OFFLINE" });
    channel.close();
  });

  it("rejects reads with a timeout and marks writes as result-unknown", async () => {
    vi.useFakeTimers();
    try {
      const channel = makeChannel({ timeoutMs: 50 });
      const socket = fakeSocket();
      channel.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: true });

      const read = channel.request("r1", { kind: "read" });
      const write = channel.request("r1", { kind: "write", write: sampleWrite });

      vi.advanceTimersByTime(100);
      await expect(read).rejects.toMatchObject({ code: "CONFIG_TIMEOUT" });
      await expect(write).rejects.toMatchObject({ code: "CONFIG_RESULT_UNKNOWN" });
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a sent write as uncertain when the connection disappears", async () => {
    const channel = makeChannel();
    const socket = fakeSocket();
    channel.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: true });

    const pending = channel.request("r1", { kind: "write", write: sampleWrite });
    channel.detach("r1", socket as never);

    await expect(pending).rejects.toMatchObject({ code: "CONFIG_RESULT_UNKNOWN" });
    // 配置通道不发送 EXECUTE/CANCEL,不伪装成搜索任务。
    expect(socket.sent.filter((message) => message.type === "EXECUTE")).toHaveLength(0);
    expect(socket.sent.filter((message) => message.type === "CANCEL")).toHaveLength(0);
    channel.close();
  });

  it("ignores replies that do not match requestId and runnerId", async () => {
    const channel = makeChannel();
    const socket = fakeSocket();
    channel.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: true });

    const pending = channel.request("r1", { kind: "read" });
    const sent = socket.sent[0]!;

    channel.handle({
      type: "CONFIG_RESULT",
      messageId: "m-wrong",
      requestId: "other-request",
      runnerId: "r1",
      result: { version: 9, proxies: [], providers: [], browserRestartRequired: [] },
      timestamp: Date.now(),
    } as never);
    channel.handle({
      type: "CONFIG_RESULT",
      messageId: "m-wrong-runner",
      requestId: sent.requestId,
      runnerId: "other-runner",
      result: { version: 9, proxies: [], providers: [], browserRestartRequired: [] },
      timestamp: Date.now(),
    } as never);

    // 正确回执仍然能完成请求。
    channel.handle({
      type: "CONFIG_RESULT",
      messageId: "m-right",
      requestId: sent.requestId,
      runnerId: "r1",
      result: { version: 5, proxies: [], providers: [], browserRestartRequired: [] },
      timestamp: Date.now(),
    } as never);
    expect((await pending).version).toBe(5);
    channel.close();
  });

  it("rejects requests to runners that do not advertise proxyConfig support", async () => {
    const channel = makeChannel();
    const socket = fakeSocket();
    channel.attach("r1", socket as never, { secureOrLocal: true, supportsProxyConfig: false });

    await expect(channel.request("r1", { kind: "read" }))
      .rejects.toMatchObject({ code: "CONFIG_UNSUPPORTED" });
    expect(socket.sent).toHaveLength(0);
    channel.close();
  });

  it("clears pending requests when a session is replaced", async () => {
    const channel = makeChannel();
    const socketA = fakeSocket();
    const socketB = fakeSocket();
    channel.attach("r1", socketA as never, { secureOrLocal: true, supportsProxyConfig: true });

    const pending = channel.request("r1", { kind: "write", write: sampleWrite });
    channel.attach("r1", socketB as never, { secureOrLocal: true, supportsProxyConfig: true });

    await expect(pending).rejects.toMatchObject({ code: "CONFIG_RESULT_UNKNOWN" });
    channel.close();
  });
});

describe("upgradeIsSecureOrLocal", () => {
  const trustProxy = ["127.0.0.1"];

  it("accepts a loopback ws upgrade as local", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "127.0.0.1",
      headers: { host: "127.0.0.1:3000" },
    }, trustProxy)).toBe(true);
  });

  it("rejects a remote ws upgrade even with a forged forwarded header", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "203.0.113.10",
      headers: { host: "example.com", "x-forwarded-proto": "https" },
    }, trustProxy)).toBe(false);
  });

  it("accepts an https upgrade through an explicitly trusted proxy", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "127.0.0.1",
      headers: { host: "example.com", "x-forwarded-proto": "https" },
    }, trustProxy)).toBe(true);
  });

  it("rejects an untrusted proxy chain", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "203.0.113.10",
      headers: { host: "example.com", "x-forwarded-proto": "https" },
    }, trustProxy)).toBe(false);
  });

  it("does not treat a remote peer with a localhost Host header as local", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "198.51.100.7",
      headers: { host: "localhost:3000" },
    }, trustProxy)).toBe(false);
  });

  it("accepts wss directly from the client", () => {
    expect(upgradeIsSecureOrLocal({
      socketRemoteAddress: "203.0.113.10",
      headers: { host: "example.com" },
      isTls: true,
    }, trustProxy)).toBe(true);
  });
});
