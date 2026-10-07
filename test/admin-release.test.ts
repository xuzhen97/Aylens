import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("admin release", () => {
  it("includes Admin assets and runtime plugins in the Gateway-only build", async () => {
    await execFileAsync(process.execPath, ["scripts/build-release.mjs", "gateway"], { cwd: root, timeout: 120_000 });
    const html = await readFile(join(root, "release/gateway/admin/index.html"), "utf8");
    expect(html).toContain("/admin/assets/");
    const packageJson = JSON.parse(await readFile(join(root, "release/gateway/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies).toHaveProperty("@fastify/cookie");
    expect(packageJson.dependencies).toHaveProperty("@fastify/static");
    const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(assetPath).toBeDefined();
    expect(await readFile(join(root, "release/gateway", assetPath!.replace(/^\/admin\//, "admin/")))).toBeTruthy();
  }, 180_000);

  it("runs the Gateway bundle from a copied release with production dependencies", async () => {
    const temp = await mkdtemp(join(tmpdir(), "aylens-release-smoke-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await cp(join(root, "release/gateway"), join(temp, "gateway"), { recursive: true });
      const gatewayDir = join(temp, "gateway");
      const configPath = join(temp, "config.yaml");
      const port = 38_000 + Math.floor(Math.random() * 10_000);
      await writeFile(configPath, `version: 1\nserver:\n  host: 127.0.0.1\n  port: ${port}\nauth:\n  apiKey: release-test-key\n`);
      const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      await execFileAsync(packageManager, ["install", "--prod", "--ignore-scripts"], {
        cwd: gatewayDir, timeout: 120_000, shell: process.platform === "win32",
      });
      child = spawn(process.execPath, [join(gatewayDir, "aylens-gateway.mjs")], {
        cwd: gatewayDir,
        env: { ...process.env, AYLENS_CONFIG: configPath },
        stdio: "pipe",
      });
      let childOutput = "";
      child.stdout?.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
      const base = `http://127.0.0.1:${port}`;
      let health = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          const response = await fetch(`${base}/health`);
          health = response.ok;
          if (health) break;
        } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
      }
      expect(health, childOutput).toBe(true);
      expect((await fetch(`${base}/admin/profiles`)).status).toBe(200);
      const html = await (await fetch(`${base}/admin`)).text();
      const asset = html.match(/src="([^"]+\.js)"/)?.[1];
      expect(asset).toBeTruthy();
      expect((await fetch(new URL(asset!, base))).status).toBe(200);
    } finally {
      if (child && child.exitCode === null) {
        child.kill();
        await new Promise((resolvePromise) => child!.once("exit", resolvePromise));
      }
      await rm(temp, { recursive: true, force: true });
    }
  }, 300_000);
});
