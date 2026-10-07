import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";

import { RetrievalError } from "../src/core/errors.js";
import { parseTargetUrl } from "../src/providers/url-fetch/url-policy.js";
import { connectionOptions, isPublicAddress, pinnedLookup, resolvePublicTarget } from "../src/transports/network-policy.js";

const mockedLookup = vi.mocked(lookup);

afterEach(() => {
  vi.clearAllMocks();
});

function expectSyncCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(RetrievalError);
  expect(caught).toMatchObject({ code });
}

describe("parseTargetUrl", () => {
  it("rejects non-http schemes, embedded credentials and malformed input", () => {
    for (const input of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "http://user:secret@example.com/",
      "not a url",
      "",
      "://missing-scheme",
    ]) {
      expectSyncCode(() => parseTargetUrl(input), "URL_FORBIDDEN");
    }
  });

  it("accepts plain http and https targets", () => {
    expect(parseTargetUrl("https://example.com/docs?q=1").hostname).toBe("example.com");
    expect(parseTargetUrl("http://example.com/").protocol).toBe("http:");
  });
});

describe("isPublicAddress", () => {
  const blocked = [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.9.9",
    "192.0.2.10",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2002:0a00:1::",
    "not-an-ip",
    "",
  ];

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::",
  ];

  it.each(blocked)("treats %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(allowed)("treats %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("resolvePublicTarget", () => {
  it("rejects literal private targets without any DNS lookup", async () => {
    await expect(resolvePublicTarget(new URL("http://127.0.0.1/"))).rejects.toMatchObject({
      code: "URL_FORBIDDEN",
    });
    await expect(resolvePublicTarget(new URL("http://[::1]/"))).rejects.toMatchObject({
      code: "URL_FORBIDDEN",
    });
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any resolved address is not public", async () => {
    mockedLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ] as never);

    await expect(resolvePublicTarget(new URL("http://mixed.test/"))).rejects.toMatchObject({
      code: "URL_FORBIDDEN",
    });
  });

  it("returns the validated address and family for a public hostname", async () => {
    mockedLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);

    await expect(resolvePublicTarget(new URL("https://public.test/"))).resolves.toEqual({
      address: "93.184.216.34",
      family: 4,
    });
  });

  it("reports resolution failure as a retryable network error", async () => {
    mockedLookup.mockRejectedValue(new Error("ENOTFOUND"));

    await expect(resolvePublicTarget(new URL("http://missing.test/"))).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });
  });
});

describe("pinnedLookup", () => {
  it("returns the validated address for both lookup callback forms", () => {
    const lookupFn = pinnedLookup({ address: "93.184.216.34", family: 4 }) as unknown as (
      hostname: string,
      options: unknown,
      callback: (...args: unknown[]) => void,
    ) => void;

    const single = vi.fn();
    lookupFn("public.test", {}, single);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);

    const all = vi.fn();
    lookupFn("public.test", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("disables address-family racing so only the validated address is dialled", () => {
    expect(connectionOptions({ address: "93.184.216.34", family: 4 })).toMatchObject({
      autoSelectFamily: false,
    });
    expect(connectionOptions(undefined)).toEqual({});
  });
});
