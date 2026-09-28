import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { appConfigSchema } from "../src/config/schema.js";
import { createGatewayContext } from "../src/app/context.js";
import { buildHttpServer } from "../src/api/http/server.js";
import { runnerConfigSchema } from "../src/runner/config.js";
import { createRunnerRuntime } from "../src/runner/runtime.js";
import { AylensRunner } from "../src/runner/runner.js";

async function listenHttp(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine HTTP server port");
  }

  return address.port;
}

async function closeHttp(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const profileDir = await mkdtemp(join(tmpdir(), "aylens-generic-browser-"));
const contentServer = http.createServer((request, response) => {
  if (request.url === "/login") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "aylens_session=authenticated; Path=/; HttpOnly; SameSite=Lax",
    });
    response.end(
      "<!doctype html><html><head><title>Login Bootstrap</title></head>" +
      "<body><main><h1>Session established</h1></main></body></html>",
    );
    return;
  }

  if (request.url === "/account") {
    const authenticated = request.headers.cookie?.includes(
      "aylens_session=authenticated",
    ) ?? false;

    if (!authenticated) {
      response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><html><head><title>Unauthorized</title></head>" +
        "<body><main><h1>Not signed in</h1></main></body></html>",
      );
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><head><title>Aylens Authenticated Smoke</title></head>" +
      "<body><main><h1>Generic Browser Authenticated</h1>" +
      "<p>The persistent Chrome profile reused the session cookie.</p>" +
      "</main></body></html>",
    );
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

let app: FastifyInstance | undefined;
let runner: AylensRunner | undefined;

try {
  const contentPort = await listenHttp(contentServer);

  const gatewayConfig = appConfigSchema.parse({
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 3000,
      runnerPath: "/v1/runners/connect",
    },
    auth: {
      apiKey: "smoke-api",
      runnerTokens: {
        "smoke-windows-runner": "smoke-runner-token",
      },
    },
    runtimeRegistry: {
      heartbeatTimeoutMs: 1000,
      offlineAfterMs: 5000,
      jobTimeoutMs: 30_000,
    },
    providers: {
      "generic-browser": {
        type: "generic-browser",
        enabled: true,
        runtime: {
          selector: {
            os: "windows",
            providerType: "generic-browser",
            browser: "chrome",
            profile: "smoke-profile",
          },
        },
        browser: {
          profile: "smoke-profile",
        },
        options: {
          waitUntil: "domcontentloaded",
          timeoutMs: 15_000,
          extractionTimeoutMs: 5000,
          maxTextChars: 10_000,
          snippetChars: 500,
          textSelector: "body",
          keepPageOpen: false,
        },
      },
    },
    routes: {
      default: {
        providers: ["generic-browser"],
      },
    },
  });

  const gateway = createGatewayContext(gatewayConfig);
  app = buildHttpServer(gateway);
  const gatewayAddress = await app.listen({ host: "127.0.0.1", port: 0 });

  const websocketUrl = new URL(gatewayAddress);
  websocketUrl.protocol = "ws:";
  websocketUrl.pathname = gatewayConfig.server.runnerPath;

  const runnerConfig = runnerConfigSchema.parse({
    runner: {
      id: "smoke-windows-runner",
      gatewayUrl: websocketUrl.toString(),
      token: "smoke-runner-token",
      heartbeatMs: 100,
      maxJobs: 1,
      labels: {
        purpose: "generic-browser-smoke",
      },
    },
    plugins: {
      baseDir: process.cwd(),
      modules: ["builtin:generic-browser"],
    },
    capabilities: {
      browsers: ["chrome"],
      http: true,
      browserAutomation: true,
    },
    transports: {
      direct: { type: "direct" },
    },
    browserProfiles: {
      "smoke-profile": {
        browser: "chrome",
        mode: "launch",
        persistent: true,
        userDataDir: profileDir,
        maxConcurrency: 1,
        interactive: false,
        headless: true,
        channel: "chrome",
        args: [],
      },
    },
  });

  const runtime = await createRunnerRuntime(runnerConfig);
  runner = new AylensRunner(runnerConfig, runtime);
  await runner.connect();

  const loginResponse = await gateway.search.search({
    query: "http://127.0.0.1:" + contentPort + "/login",
  });

  if (
    loginResponse.status !== "completed" ||
    !loginResponse.items[0]?.text?.includes("Session established")
  ) {
    throw new Error(
      "Unable to establish browser session: " + JSON.stringify(loginResponse),
    );
  }

  const accountResponse = await gateway.search.search({
    query: "http://127.0.0.1:" + contentPort + "/account",
  });

  const item = accountResponse.items[0];

  if (
    accountResponse.status !== "completed" ||
    !item ||
    item.title !== "Aylens Authenticated Smoke" ||
    !item.text?.includes("Generic Browser Authenticated") ||
    !item.text.includes("reused the session cookie") ||
    item.provenance.runtimeId !== "smoke-windows-runner" ||
    item.extensions?.httpStatus !== 200
  ) {
    throw new Error(
      "Persistent browser session was not reused: " +
      JSON.stringify(accountResponse),
    );
  }

  console.log(JSON.stringify({
    status: "ok",
    sessionReused: true,
    runtimeId: item.provenance.runtimeId,
    provider: item.provenance.provider,
    title: item.title,
    url: item.url,
    text: item.text,
    profileDir,
  }, null, 2));
} finally {
  if (runner) await runner.close();
  if (app) await app.close();
  await closeHttp(contentServer);
  await rm(profileDir, { recursive: true, force: true });
}
