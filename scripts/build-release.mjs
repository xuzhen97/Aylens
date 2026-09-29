import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { strToU8, zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(root, "release");
const target = process.argv[2] ?? "all";
const validTargets = new Set(["all", "gateway", "runner", "providers"]);
if (!validTargets.has(target)) throw new Error(`Unknown build target: ${target}`);

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dependencies = rootPackage.dependencies ?? {};

function pickDependencies(names) {
  return Object.fromEntries(names.map((name) => [name, dependencies[name]]).filter(([, version]) => version));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function bundleApp(entry, outfile) {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "none",
  });
  await chmod(outfile, 0o755).catch(() => undefined);
}

async function buildGateway() {
  const dir = join(releaseDir, "gateway");
  await rm(dir, { recursive: true, force: true });
  await bundleApp("src/index.ts", join(dir, "aylens-gateway.mjs"));
  await mkdir(join(dir, "config"), { recursive: true });
  await copyFile(join(root, "config/aylens.yaml"), join(dir, "config/aylens.yaml"));
  await writeJson(join(dir, "package.json"), {
    name: "@aylens/gateway",
    version: rootPackage.version,
    private: true,
    type: "module",
    engines: rootPackage.engines,
    scripts: { start: "node ./aylens-gateway.mjs" },
    dependencies: pickDependencies(["fastify", "ws", "yaml", "zod"]),
  });
}

async function buildRunner() {
  const dir = join(releaseDir, "runner");
  await rm(dir, { recursive: true, force: true });
  await bundleApp("src/runner/index.ts", join(dir, "aylens-runner.mjs"));
  await mkdir(join(dir, "config"), { recursive: true });
  await copyFile(join(root, "config/runner.yaml"), join(dir, "config/runner.yaml"));
  await writeJson(join(dir, "package.json"), {
    name: "@aylens/runner",
    version: rootPackage.version,
    private: true,
    type: "module",
    engines: rootPackage.engines,
    scripts: { start: "node ./aylens-runner.mjs" },
    dependencies: pickDependencies([
      "fflate",
      "http-proxy-agent",
      "https-proxy-agent",
      "playwright-core",
      "socks-proxy-agent",
      "ws",
      "yaml",
      "zod",
    ]),
  });
}

async function buildGenericBrowserProvider() {
  const result = await build({
    entryPoints: [join(root, "src/providers/generic-browser/index.ts")],
    outfile: "index.mjs",
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
  });
  const bundle = result.outputFiles.find((file) => file.path.endsWith("index.mjs"));
  if (!bundle) throw new Error("generic-browser Provider bundle was not produced");

  const manifest = {
    formatVersion: 1,
    name: "aylens-generic-browser",
    version: "1.0.0",
    apiVersion: "1",
    entry: "index.mjs",
    providerTypes: ["generic-browser"],
  };
  const archive = zipSync({
    "provider.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    "index.mjs": bundle.contents,
  }, { level: 9 });

  const providersDir = join(releaseDir, "providers");
  await mkdir(providersDir, { recursive: true });
  await writeFile(join(providersDir, "generic-browser.aylens-provider"), archive);
}

async function buildReleaseReadme() {
  const readme = `# Aylens Release\n\n本目录是 Aylens 的正式构建产物，可复制到其他已安装 Node.js 24+ 的机器运行，不需要源码仓库。\n\n## 目录\n\n\`\`\`text\nrelease/\n├── gateway/\n│   ├── aylens-gateway.mjs\n│   ├── package.json\n│   └── config/aylens.yaml\n├── runner/\n│   ├── aylens-runner.mjs\n│   ├── package.json\n│   └── config/runner.yaml\n└── providers/\n    └── generic-browser.aylens-provider\n\`\`\`\n\n## Gateway\n\n复制 \`gateway/\` 到服务器，进入目录后安装生产依赖并启动：\n\n\`\`\`bash\nnpm install --omit=dev\nnpm start\n\`\`\`\n\n默认读取 \`./config/aylens.yaml\`。也可以通过 \`AYLENS_CONFIG\` 指定其他配置文件。Gateway 是控制面，不执行 Provider，不需要 Chrome 或 Browser Profile。\n\n## Runner\n\n复制 \`runner/\` 到执行机器，进入目录后安装生产依赖并启动：\n\n\`\`\`bash\nnpm install --omit=dev\nnpm start\n\`\`\`\n\n默认读取 \`./config/runner.yaml\`。也可以通过 \`AYLENS_RUNNER_CONFIG\` 指定其他配置文件。Runner 负责 Provider、HTTP/Proxy、BrowserHost、Chrome Profile 和登录态。\n\n如 Provider 需要真实浏览器，请在 Runner 所在机器安装 Google Chrome，并按 \`runner/config/runner.yaml\` 配置 Browser Profile。\n\n## Provider\n\n\`.aylens-provider\` 是 Aylens 的单文件 Provider 分发格式。可以通过 GitHub Release、内网文件服务器或直接复制进行分发，不要求发布 npm。\n\n例如把 Provider 文件复制到 Runner：\n\n\`\`\`text\nrunner/\n├── aylens-runner.mjs\n├── package.json\n├── config/runner.yaml\n└── providers/\n    └── my-provider.aylens-provider\n\`\`\`\n\n然后在 \`runner/config/runner.yaml\` 中加载：\n\n\`\`\`yaml\nplugins:\n  baseDir: "."\n  modules:\n    - "./providers/my-provider.aylens-provider"\n\`\`\`\n\n内置 Provider 仍可使用 \`builtin:<implementation>\`，例如：\n\n\`\`\`yaml\nplugins:\n  modules:\n    - "builtin:generic-browser"\n\`\`\`\n\nRunner 会校验 Provider 包中的 manifest，并把 bundle 解到本机 \`~/.aylens/provider-cache/\` 内容寻址缓存后加载。可以通过 \`AYLENS_HOME\` 修改 Aylens 本地数据目录。\n\n## 最小部署关系\n\n\`\`\`text\nGateway\n   │ WebSocket\n   ▼\nRunner\n   │\n   ├── builtin Provider\n   └── *.aylens-provider\n\`\`\`\n\n同一个 Gateway 可以连接多个 Runner；多个 Runner 也可以部署同一个 Provider ID/Type，由 Gateway 按在线状态和容量选择执行节点。\n`;

  await writeFile(join(releaseDir, "README.md"), readme);
}

async function verifyRelease() {
  const required = [
    "gateway/aylens-gateway.mjs",
    "gateway/package.json",
    "gateway/config/aylens.yaml",
    "runner/aylens-runner.mjs",
    "runner/package.json",
    "runner/config/runner.yaml",
    "providers/generic-browser.aylens-provider",
    "README.md",
  ];
  for (const relative of required) {
    await readFile(join(releaseDir, relative));
  }
}

if (target === "all") await rm(releaseDir, { recursive: true, force: true });
if (target === "all" || target === "gateway") await buildGateway();
if (target === "all" || target === "runner") await buildRunner();
if (target === "all" || target === "providers") await buildGenericBrowserProvider();
if (target === "all") await buildReleaseReadme();
if (target === "all") {
  await verifyRelease();
  console.log("Release built: Gateway bundle, Runner bundle, and .aylens-provider package.");
}
