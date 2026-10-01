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

function pm2App(name, script, cwdExpression = "__dirname") {
  return `    {\n      name: ${JSON.stringify(name)},\n      namespace: "aylens",\n      script: ${JSON.stringify(script)},\n      cwd: ${cwdExpression},\n      interpreter: "node",\n      exec_mode: "fork",\n      instances: 1,\n      autorestart: true,\n      watch: false,\n      restart_delay: 2000,\n      max_restarts: 20,\n      kill_timeout: 5000,\n      env: { NODE_ENV: "production" },\n    }`;
}

async function writePm2Files(dir, apps, { combined = false } = {}) {
  const prelude = combined ? 'const path = require("node:path");\n\n' : "";
  const ecosystem = `${prelude}module.exports = {\n  apps: [\n${apps.join(",\n")}\n  ],\n};\n`;
  await writeFile(join(dir, "ecosystem.config.cjs"), ecosystem);

  const powershell = `$ErrorActionPreference = "Stop"\n$Root = Split-Path -Parent $MyInvocation.MyCommand.Path\nSet-Location $Root\nif (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {\n  throw "PM2 未安装。请先执行: npm install -g pm2"\n}\npm2 startOrRestart .\\ecosystem.config.cjs --update-env\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\npm2 save\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\npm2 status\n`;
  await writeFile(join(dir, "pm2-start.ps1"), powershell);

  const cmd = `@echo off\nsetlocal\ncd /d "%~dp0"\nwhere pm2 >nul 2>nul\nif errorlevel 1 (\n  echo PM2 is not installed. Run: npm install -g pm2\n  exit /b 1\n)\ncall pm2 startOrRestart ecosystem.config.cjs --update-env\nif errorlevel 1 exit /b %errorlevel%\ncall pm2 save\nif errorlevel 1 exit /b %errorlevel%\ncall pm2 status\n`;
  await writeFile(join(dir, "pm2-start.cmd"), cmd);

  const shell = `#!/usr/bin/env sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nif ! command -v pm2 >/dev/null 2>&1; then\n  echo "PM2 is not installed. Run: npm install -g pm2" >&2\n  exit 1\nfi\npm2 startOrRestart ./ecosystem.config.cjs --update-env\npm2 save\npm2 status\n`;
  const shellPath = join(dir, "pm2-start.sh");
  await writeFile(shellPath, shell);
  await chmod(shellPath, 0o755).catch(() => undefined);
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
    scripts: {
      start: "node ./aylens-gateway.mjs",
      "pm2:start": "pm2 startOrRestart ./ecosystem.config.cjs --update-env && pm2 save",
      "pm2:stop": "pm2 stop aylens-gateway && pm2 save",
      "pm2:restart": "pm2 restart aylens-gateway --update-env && pm2 save",
      "pm2:logs": "pm2 logs aylens-gateway",
    },
    dependencies: pickDependencies(["fastify", "ws", "yaml", "zod"]),
  });
  await writePm2Files(dir, [pm2App("aylens-gateway", "./aylens-gateway.mjs")]);
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
    scripts: {
      start: "node ./aylens-runner.mjs",
      "pm2:start": "pm2 startOrRestart ./ecosystem.config.cjs --update-env && pm2 save",
      "pm2:stop": "pm2 stop aylens-runner && pm2 save",
      "pm2:restart": "pm2 restart aylens-runner --update-env && pm2 save",
      "pm2:logs": "pm2 logs aylens-runner",
    },
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
  await writePm2Files(dir, [pm2App("aylens-runner", "./aylens-runner.mjs")]);
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

async function buildXSearchProvider() {
  const result = await build({
    entryPoints: [join(root, "src/providers/x-search/index.ts")],
    outfile: "index.mjs",
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
  });
  const bundle = result.outputFiles.find((file) => file.path.endsWith("index.mjs"));
  if (!bundle) throw new Error("x-search Provider bundle was not produced");

  const manifest = {
    formatVersion: 1,
    name: "aylens-x-search",
    version: "1.0.0",
    apiVersion: "1",
    entry: "index.mjs",
    providerTypes: ["x-search"],
  };
  const archive = zipSync({
    "provider.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    "index.mjs": bundle.contents,
  }, { level: 9 });

  const providersDir = join(releaseDir, "providers");
  await mkdir(providersDir, { recursive: true });
  await writeFile(join(providersDir, "x-search.aylens-provider"), archive);
}

async function buildCombinedPm2() {
  await writePm2Files(releaseDir, [
    pm2App("aylens-gateway", "./aylens-gateway.mjs", 'path.join(__dirname, "gateway")'),
    pm2App("aylens-runner", "./aylens-runner.mjs", 'path.join(__dirname, "runner")'),
  ], { combined: true });
}

async function buildReleaseReadme() {
  const readme = `# Aylens Release\n\n本目录是 Aylens 的正式构建产物，可复制到其他已安装 Node.js 24+ 的机器运行，不需要源码仓库。\n\n## 目录\n\n\`\`\`text\nrelease/\n├── ecosystem.config.cjs       # 同机启动 Gateway + Runner\n├── pm2-start.ps1              # Windows PowerShell 一键启动\n├── pm2-start.cmd              # Windows cmd 一键启动\n├── pm2-start.sh               # Linux/macOS 一键启动\n├── gateway/\n│   ├── aylens-gateway.mjs\n│   ├── ecosystem.config.cjs\n│   ├── pm2-start.*\n│   ├── package.json\n│   └── config/aylens.yaml\n├── runner/\n│   ├── aylens-runner.mjs\n│   ├── ecosystem.config.cjs\n│   ├── pm2-start.*\n│   ├── package.json\n│   └── config/runner.yaml\n└── providers/\n    ├── generic-browser.aylens-provider\n    └── x-search.aylens-provider\n\`\`\`\n\n## 安装运行依赖\n\nGateway 和 Runner 分开部署时，在对应目录执行：\n\n\`\`\`bash\nnpm install --omit=dev\n\`\`\`\n\n如果整个 \`release/\` 在同一台机器运行，则分别在 \`gateway/\` 和 \`runner/\` 执行一次。\n\n## PM2 一键启动\n\n先安装 PM2：\n\n\`\`\`bash\nnpm install -g pm2\n\`\`\`\n\nWindows PowerShell：\n\n\`\`\`powershell\n.\\pm2-start.ps1\n\`\`\`\n\nWindows cmd：\n\n\`\`\`bat\npm2-start.cmd\n\`\`\`\n\nLinux / macOS：\n\n\`\`\`bash\n./pm2-start.sh\n\`\`\`\n\n在 \`release/\` 根目录执行会同时管理 \`aylens-gateway\` 和 \`aylens-runner\`；只复制 \`gateway/\` 或 \`runner/\` 到独立机器时，在该目录执行同名脚本即可。脚本使用 \`pm2 startOrRestart\`，所以首次部署会启动，后续覆盖新版本后再次执行会重启到新代码；随后自动执行 \`pm2 save\` 保存当前进程列表。\n\n常用命令：\n\n\`\`\`bash\npm2 status\npm2 logs aylens-gateway\npm2 logs aylens-runner\npm2 restart aylens-gateway --update-env\npm2 restart aylens-runner --update-env\npm2 stop aylens-gateway\npm2 stop aylens-runner\n\`\`\`\n\nLinux 服务器如需操作系统重启后自动恢复 PM2 进程，还需要按 PM2 提示执行一次 \`pm2 startup\`；一键脚本已经执行 \`pm2 save\`。\n\n## Gateway\n\n复制 \`gateway/\` 到服务器后，非 PM2 模式也可以直接执行：\n\n\`\`\`bash\nnpm start\n\`\`\`\n\n默认读取 \`./config/aylens.yaml\`。也可以通过 \`AYLENS_CONFIG\` 指定其他配置文件。Gateway 是控制面，不执行 Provider，不需要 Chrome 或 Browser Profile。\n\n## Runner\n\n复制 \`runner/\` 到执行机器后，非 PM2 模式也可以直接执行：\n\n\`\`\`bash\nnpm start\n\`\`\`\n\n默认读取 \`./config/runner.yaml\`。也可以通过 \`AYLENS_RUNNER_CONFIG\` 指定其他配置文件。Runner 负责 Provider、HTTP/Proxy、BrowserHost、Chrome Profile 和登录态。\n\n如 Provider 需要真实浏览器，请在 Runner 所在机器安装 Google Chrome，并按 \`runner/config/runner.yaml\` 配置 Browser Profile。\n\n## Provider\n\n\`.aylens-provider\` 是 Aylens 的单文件 Provider 分发格式。可以通过 GitHub Release、内网文件服务器或直接复制进行分发，不要求发布 npm。\n\n例如把 Provider 文件复制到 Runner：\n\n\`\`\`text\nrunner/\n├── aylens-runner.mjs\n├── package.json\n├── config/runner.yaml\n└── providers/\n    └── my-provider.aylens-provider\n\`\`\`\n\n然后在 \`runner/config/runner.yaml\` 中加载：\n\n\`\`\`yaml\nplugins:\n  baseDir: "."\n  modules:\n    - "./providers/my-provider.aylens-provider"\n\`\`\`\n\n内置 Provider 仍可使用 \`builtin:<implementation>\`。Runner 会校验 Provider 包中的 manifest，并把 bundle 解到本机 \`~/.aylens/provider-cache/\` 内容寻址缓存后加载。可以通过 \`AYLENS_HOME\` 修改 Aylens 本地数据目录。\n\n## 最小部署关系\n\n\`\`\`text\nGateway\n   │ WebSocket\n   ▼\nRunner\n   │\n   ├── builtin Provider\n   └── *.aylens-provider\n\`\`\`\n\n同一个 Gateway 可以连接多个 Runner；多个 Runner 也可以部署同一个 Provider ID/Type，由 Gateway 按在线状态和容量选择执行节点。\n`;

  await writeFile(join(releaseDir, "README.md"), readme);
}

async function verifyRelease() {
  const required = [
    "gateway/aylens-gateway.mjs",
    "gateway/package.json",
    "gateway/config/aylens.yaml",
    "gateway/ecosystem.config.cjs",
    "gateway/pm2-start.ps1",
    "gateway/pm2-start.cmd",
    "gateway/pm2-start.sh",
    "runner/aylens-runner.mjs",
    "runner/package.json",
    "runner/config/runner.yaml",
    "runner/ecosystem.config.cjs",
    "runner/pm2-start.ps1",
    "runner/pm2-start.cmd",
    "runner/pm2-start.sh",
    "providers/generic-browser.aylens-provider",
    "providers/x-search.aylens-provider",
    "ecosystem.config.cjs",
    "pm2-start.ps1",
    "pm2-start.cmd",
    "pm2-start.sh",
    "README.md",
  ];
  for (const relative of required) {
    await readFile(join(releaseDir, relative));
  }
}

if (target === "all") await rm(releaseDir, { recursive: true, force: true });
if (target === "all" || target === "gateway") await buildGateway();
if (target === "all" || target === "runner") await buildRunner();
if (target === "all" || target === "providers") {
  await buildGenericBrowserProvider();
  await buildXSearchProvider();
}
if (target === "all") await buildCombinedPm2();
if (target === "all") await buildReleaseReadme();
if (target === "all") {
  await verifyRelease();
  console.log("Release built: Gateway bundle, Runner bundle, and .aylens-provider package.");
}
