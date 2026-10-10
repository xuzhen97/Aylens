#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// dist/client.js
var AylensBridgeError = class extends Error {
  code;
  status;
  constructor(code, message, status) {
    super(message);
    this.name = "AylensBridgeError";
    this.code = code;
    this.status = status;
  }
};
function statusToCode(status) {
  if (status === 401 || status === 403)
    return "AUTH_FAILED";
  if (status === 404)
    return "NOT_FOUND";
  if (status >= 500)
    return "GATEWAY_ERROR";
  return "INVALID_REQUEST";
}
function extractGatewayMessage(payload) {
  if (!payload || typeof payload !== "object")
    return void 0;
  const error = payload.error;
  if (typeof error === "string")
    return error;
  if (error && typeof error === "object") {
    const message = error.message;
    if (typeof message === "string")
      return message;
  }
  return void 0;
}
var AylensClient = class {
  config;
  constructor(config) {
    this.config = config;
  }
  async request(options) {
    let url;
    try {
      url = new URL(`${this.config.baseUrl}${options.path}`);
    } catch {
      throw new AylensBridgeError("INVALID_REQUEST", `\u62FC\u63A5\u51FA\u7684\u8BF7\u6C42\u5730\u5740\u975E\u6CD5\uFF1A${this.config.baseUrl}${options.path}`);
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const init = {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    };
    if (options.body !== void 0) {
      init.headers = { ...init.headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AylensBridgeError("TIMEOUT", `\u8BF7\u6C42 Aylens Gateway \u8D85\u65F6\uFF08${this.config.requestTimeoutMs}ms\uFF09\uFF1A${options.method} ${options.path}\u3002\u82E5\u547D\u4E2D\u6D4F\u89C8\u5668\u515C\u5E95\uFF0C\u8BF7\u8C03\u5927 config.env \u7684 REQUEST_TIMEOUT_MS\u3002`);
      }
      throw new AylensBridgeError("GATEWAY_UNREACHABLE", `\u65E0\u6CD5\u8FDE\u63A5 Aylens Gateway\uFF08${this.config.baseUrl}\uFF09\uFF1A${err instanceof Error ? err.message : String(err)}`);
    }
    const raw = await response.text();
    let payload;
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = void 0;
      }
    }
    if (!response.ok) {
      const detail = extractGatewayMessage(payload) ?? raw.slice(0, 300).trim();
      throw new AylensBridgeError(statusToCode(response.status), `Aylens Gateway \u8FD4\u56DE HTTP ${response.status}${detail ? `\uFF1A${detail}` : ""}`, response.status);
    }
    if (payload === void 0) {
      throw new AylensBridgeError("GATEWAY_ERROR", `Aylens Gateway \u8FD4\u56DE\u4E86\u975E JSON \u54CD\u5E94\uFF1A${raw.slice(0, 200)}`);
    }
    return payload;
  }
  get(path2, query) {
    return this.request(query ? { method: "GET", path: path2, query } : { method: "GET", path: path2 });
  }
  post(path2, body) {
    return body === void 0 ? this.request({ method: "POST", path: path2 }) : this.request({ method: "POST", path: path2, body });
  }
};

// dist/config.js
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
function parseEnvFile(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#"))
      continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1)
      continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (key)
      result[key] = value;
  }
  return result;
}
var ConfigError = class extends Error {
  code = "CONFIG_ERROR";
};
function readConfigFile(dir) {
  const envPath = import_node_path.default.join(dir, "config.env");
  if (!import_node_fs.default.existsSync(envPath))
    return {};
  try {
    return parseEnvFile(import_node_fs.default.readFileSync(envPath, "utf-8"));
  } catch (err) {
    process.stderr.write(`[AylensBridge] Failed to read config.env: ${String(err)}
`);
    return {};
  }
}
function loadConfig(searchDir) {
  const dir = searchDir ?? process.cwd();
  const fileEnv = readConfigFile(dir);
  const baseUrl = (fileEnv.AYLENS_BASE_URL ?? process.env.AYLENS_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const apiKey = fileEnv.AYLENS_API_KEY ?? process.env.AYLENS_API_KEY ?? "";
  const rawTimeout = fileEnv.REQUEST_TIMEOUT_MS ?? process.env.REQUEST_TIMEOUT_MS ?? "120000";
  const parsedTimeout = Number.parseInt(rawTimeout, 10);
  const requestTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 12e4;
  if (!apiKey) {
    throw new ConfigError("\u7F3A\u5C11 AYLENS_API_KEY\uFF1A\u8BF7\u5728\u63D2\u4EF6\u76EE\u5F55\u7684 config.env \u4E2D\u914D\u7F6E\uFF0C\u6216\u8BBE\u7F6E\u540C\u540D\u73AF\u5883\u53D8\u91CF\u3002");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigError(`AYLENS_BASE_URL \u4E0D\u662F\u5408\u6CD5 URL\uFF1A${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`AYLENS_BASE_URL \u4EC5\u652F\u6301 http/https\uFF0C\u5F53\u524D\uFF1A${parsed.protocol}`);
  }
  const rawAllowAuthLogin = fileEnv.AYLENS_ALLOW_AUTH_LOGIN ?? process.env.AYLENS_ALLOW_AUTH_LOGIN ?? "false";
  const allowAuthLogin = ["1", "true", "yes", "on"].includes(rawAllowAuthLogin.trim().toLowerCase());
  return { baseUrl, apiKey, requestTimeoutMs, allowAuthLogin };
}

// dist/format.js
var MAX_DOC_BODY_CHARS = 4e3;
var MAX_TOTAL_BODY_CHARS = 28e3;
var MAX_SNIPPET_CHARS = 600;
function ok(text, messageForAI) {
  const content = [{ type: "text", text }];
  return messageForAI === void 0 ? { status: "success", result: { content }, content } : { status: "success", result: { content, messageForAI }, content, messageForAI };
}
function fail(error) {
  const code = error instanceof AylensBridgeError ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const text = `[AylensBridge:${code}] ${message}`;
  return {
    status: "error",
    error: message,
    result: { content: [{ type: "text", text }], messageForAI: text },
    content: [{ type: "text", text }],
    messageForAI: text
  };
}
function formatAge(timestamp) {
  const deltaMs = Date.now() - timestamp;
  if (!Number.isFinite(deltaMs))
    return "\u672A\u77E5";
  if (deltaMs < 0)
    return "\u521A\u521A";
  const seconds = Math.round(deltaMs / 1e3);
  if (seconds < 60)
    return `${seconds}s \u524D`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return `${minutes}m \u524D`;
  return `${Math.round(minutes / 60)}h \u524D`;
}
function truncate(text, limit) {
  if (text.length <= limit)
    return { value: text, truncated: false };
  return { value: text.slice(0, limit), truncated: true };
}
function summarize(doc) {
  const source = doc.snippet ?? doc.text;
  if (!source)
    return void 0;
  return truncate(source.replace(/\s+/g, " ").trim(), MAX_SNIPPET_CHARS).value;
}
function formatSearchResponse(response) {
  const lines = [];
  const providerEntries = Object.entries(response.meta?.providers ?? {});
  const okProviders = providerEntries.filter(([, meta]) => meta.status === "success");
  const failedProviders = providerEntries.filter(([, meta]) => meta.status === "failed");
  lines.push(`\u68C0\u7D22\u5B8C\u6210 \xB7 status=${response.status} \xB7 \u547D\u4E2D ${response.items.length} \u6761 \xB7 requestId=${response.requestId}`);
  if (providerEntries.length > 0) {
    lines.push(`Provider\uFF1A${okProviders.length}/${providerEntries.length} \u6210\u529F`, ...providerEntries.map(([id, meta]) => {
      const base = `- ${id}\uFF1A${meta.status} \xB7 ${meta.resultCount} \u6761 \xB7 ${meta.latencyMs}ms${meta.runtimeId ? ` \xB7 runtime=${meta.runtimeId}` : ""}`;
      return meta.error ? `${base} \xB7 ${meta.error.code}: ${meta.error.message}` : base;
    }));
  }
  if (failedProviders.length > 0 && response.items.length === 0) {
    lines.push("", "\u26A0\uFE0F \u5168\u90E8 Provider \u5931\u8D25\uFF0C\u4E0A\u9762\u6BCF\u884C\u7684 error \u5C31\u662F\u6839\u56E0\uFF1B\u4E0D\u8981\u628A\u5B83\u5F53\u6210\u300C\u67E5\u65E0\u7ED3\u679C\u300D\u3002");
  }
  if (response.items.length === 0 && failedProviders.length === 0) {
    lines.push("", "\uFF08\u5408\u6CD5\u7A7A\u7ED3\u679C\uFF1AProvider \u5DF2\u6267\u884C\u4F46\u6CA1\u6709\u547D\u4E2D\u3002\u82E5\u8FD9\u4E0D\u7B26\u5408\u9884\u671F\uFF0C\u68C0\u67E5 Gateway \u7684 route / sources \u914D\u7F6E\u3002\uFF09");
  }
  let bodyBudget = MAX_TOTAL_BODY_CHARS;
  response.items.forEach((doc, index) => {
    const title = doc.title?.trim() || `\uFF08\u65E0\u6807\u9898\uFF09${doc.id}`;
    lines.push("", `### ${index + 1}. ${title}`);
    lines.push(`- URL: ${doc.canonicalUrl ?? doc.url}`);
    lines.push(`- \u6765\u6E90: ${doc.platform} \xB7 provider=${doc.provenance.provider} \xB7 method=${doc.provenance.retrievalMethod}`);
    if (doc.publishedAt)
      lines.push(`- \u53D1\u5E03: ${doc.publishedAt}`);
    lines.push(`- \u6293\u53D6: ${doc.retrievedAt}`);
    if (doc.provenance.runtimeId)
      lines.push(`- runtime: ${doc.provenance.runtimeId}`);
    const snippet = summarize(doc);
    if (snippet)
      lines.push(`- \u6458\u8981: ${snippet}`);
    const body = doc.markdown ?? doc.text;
    if (body && body.trim()) {
      const budget = Math.max(0, Math.min(MAX_DOC_BODY_CHARS, bodyBudget));
      if (budget > 0) {
        const { value, truncated } = truncate(body.trim(), budget);
        bodyBudget -= value.length;
        lines.push("", truncated ? `${value}

\u2026\uFF08\u6B63\u6587\u5DF2\u622A\u65AD\uFF09` : value);
      } else {
        lines.push("", "\u2026\uFF08\u6B63\u6587\u603B\u91CF\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u5269\u4F59\u6587\u6863\u6B63\u6587\u7701\u7565\uFF09");
      }
    }
  });
  return lines.join("\n");
}

// dist/params.js
function readString(params, key) {
  const value = params[key];
  if (value === void 0 || value === null)
    return void 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : void 0;
  }
  return String(value).trim() || void 0;
}
function requireString(params, key) {
  const value = readString(params, key);
  if (!value) {
    throw new AylensBridgeError("INVALID_REQUEST", `\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570 ${key}\u3002\u8BF7\u68C0\u67E5 TOOL_REQUEST \u4E2D\u662F\u5426\u5199\u6210\u4E86 command \u5B57\u6BB5\u4E4B\u5916\u7684\u6B63\u6587\u3002`);
  }
  return value;
}
function readNumber(params, key) {
  const value = params[key];
  if (value === void 0 || value === null || value === "")
    return void 0;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new AylensBridgeError("INVALID_REQUEST", `\u53C2\u6570 ${key} \u5FC5\u987B\u662F\u6570\u5B57\uFF0C\u6536\u5230\uFF1A${String(value)}`);
  }
  return parsed;
}
function readStringArray(params, key) {
  const value = params[key];
  if (value === void 0 || value === null)
    return void 0;
  if (Array.isArray(value)) {
    const list2 = value.map((item) => String(item).trim()).filter(Boolean);
    return list2.length > 0 ? list2 : void 0;
  }
  const list = String(value).split(/[,|\n]/).map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list : void 0;
}

// dist/handlers/admin.js
function formatAudit(record) {
  const lines = [
    `\u5BA1\u8BA1 ${record.requestId} \xB7 status=${record.status}`,
    `- traceId: ${record.traceId}`,
    `- query: ${record.request.query}`
  ];
  if (record.request.sources?.length)
    lines.push(`- sources: ${record.request.sources.join(", ")}`);
  if (record.request.route)
    lines.push(`- route: ${record.request.route}`);
  if (record.request.limit !== void 0)
    lines.push(`- limit: ${record.request.limit}`);
  lines.push(`- \u5F00\u59CB: ${new Date(record.createdAt).toISOString()}\uFF08${formatAge(record.createdAt)}\uFF09`);
  if (record.completedAt !== void 0) {
    lines.push(`- \u5B8C\u6210: ${new Date(record.completedAt).toISOString()} \xB7 \u8017\u65F6 ${record.completedAt - record.createdAt}ms`);
  }
  if (record.providers.length === 0) {
    lines.push("- Provider \u4E8B\u4EF6: \uFF08\u65E0\u2014\u2014\u901A\u5E38\u610F\u5473\u7740\u5728\u6D3E\u53D1\u524D\u5C31\u5931\u8D25\u4E86\uFF09");
  } else {
    lines.push("- Provider \u4E8B\u4EF6:");
    for (const event of record.providers) {
      lines.push(`  - ${event.providerId}\uFF1A${event.status} \xB7 ${event.resultCount} \u6761 \xB7 ${event.completedAt - event.startedAt}ms${event.runtimeId ? ` \xB7 runtime=${event.runtimeId}` : ""}${event.errorCode ? ` \xB7 ${event.errorCode}` : ""}`);
    }
  }
  return lines.join("\n");
}
async function handleGetAudit(client, params) {
  const requestId = requireString(params, "requestId");
  const record = await client.get(`/v1/audit/${encodeURIComponent(requestId)}`);
  return ok(formatAudit(record));
}
async function handleGetOverview(client, params) {
  const recentAuditLimit = readNumber(params, "recentAuditLimit");
  const overview = await client.get("/v1/admin/overview");
  const { summary } = overview;
  const lines = [
    `Aylens \u603B\u89C8 \xB7 gateway=${overview.gateway.status} \xB7 \u751F\u6210\u4E8E ${formatAge(overview.generatedAt)}`,
    `- Provider: ${summary.enabledProviders}/${summary.providers} \u542F\u7528`,
    `- Runner: ${summary.onlineRuntimes}/${summary.runtimes} \u5728\u7EBF`,
    `- \u6D4F\u89C8\u5668 Profile: ${summary.browserProfiles}`,
    `- \u8FD1\u671F\u5BA1\u8BA1: ${summary.recentAudits} \u6761`
  ];
  if (overview.providers.length > 0) {
    lines.push("", "## Providers");
    for (const provider of overview.providers) {
      const auth = provider.auth ? ` \xB7 \u767B\u5F55\u6001=${provider.auth.status}${provider.auth.account ? `\uFF08${provider.auth.account.handle}\uFF09` : ""}` : provider.authControl ? " \xB7 \u767B\u5F55\u6001=\u672A\u77E5" : "";
      lines.push(`- ${provider.id} \xB7 type=${provider.type} \xB7 enabled=${provider.enabled}${auth}`);
    }
  }
  if (overview.runtimes.length > 0) {
    lines.push("", "## Runtimes");
    for (const runtime of overview.runtimes) {
      lines.push(`- ${runtime.id} \xB7 ${runtime.status}${runtime.hostname ? ` \xB7 ${runtime.hostname}` : ""}`);
    }
  }
  if (overview.browserProfiles.length > 0) {
    lines.push("", "## Browser Profiles");
    for (const profile of overview.browserProfiles) {
      lines.push(`- ${profile.id} \xB7 runtime=${profile.runtimeId} \xB7 ${profile.status}${profile.activeLeases !== void 0 && profile.maxConcurrency !== void 0 ? ` \xB7 \u79DF\u7EA6 ${profile.activeLeases}/${profile.maxConcurrency}` : ""}`);
    }
  }
  const audits = overview.audits.slice(0, recentAuditLimit !== void 0 && recentAuditLimit > 0 ? recentAuditLimit : overview.audits.length);
  if (audits.length > 0) {
    lines.push("", "## \u6700\u8FD1\u5BA1\u8BA1");
    for (const record of audits) {
      lines.push(`- ${record.requestId} \xB7 ${record.status} \xB7 ${formatAge(record.createdAt)} \xB7 query=${record.request.query.slice(0, 60)}${record.providers.some((event) => event.status === "failed") ? " \xB7 \u26A0\uFE0F \u6709 Provider \u5931\u8D25" : ""}`);
    }
    lines.push("", "\u7528 GetAudit + requestId \u67E5\u770B\u5355\u6B21\u68C0\u7D22\u7684\u5B8C\u6574 Provider \u4E8B\u4EF6\u3002");
  }
  if (summary.onlineRuntimes === 0) {
    lines.push("", "\u26A0\uFE0F \u6CA1\u6709\u5728\u7EBF Runner\uFF1A\u6B64\u65F6\u4EFB\u4F55 Search \u90FD\u4F1A\u62A5\u300C\u65E0\u53EF\u7528\u6267\u884C\u8282\u70B9\u300D\uFF08Gateway \u4E0D\u505A\u672C\u5730\u56DE\u9000\uFF09\u3002");
  }
  const needLogin = overview.providers.filter((provider) => provider.auth?.status === "auth_required").map((provider) => provider.id);
  if (needLogin.length > 0) {
    lines.push("", `\u26A0\uFE0F \u4EE5\u4E0B Provider \u9700\u8981\u4EBA\u5DE5\u767B\u5F55\uFF1A${needLogin.join(", ")}\u3002`, "\u8BF7\u5230 Aylens Admin \u7684 /admin/providers \u70B9\u300C\u767B\u5F55\u300D\uFF1B\u767B\u5F55\u6001\u53EA\u7559\u5728 Runner \u7684 persistent Profile \u91CC\u3002");
  }
  return ok(lines.join("\n"));
}

// dist/handlers/providers.js
function formatAuth(providerId, runtimeId, auth) {
  const lines = [`Provider ${providerId} \xB7 runtime=${runtimeId} \xB7 \u767B\u5F55\u6001=${auth.status}`];
  if (auth.account) {
    lines.push(`- \u8D26\u53F7: ${auth.account.handle}${auth.account.displayName ? `\uFF08${auth.account.displayName}\uFF09` : ""}`);
  }
  if (auth.checkedAt) {
    lines.push(`- \u68C0\u67E5\u65F6\u95F4: ${new Date(auth.checkedAt).toISOString()}\uFF08${formatAge(auth.checkedAt)}\uFF09`);
  }
  if (auth.status === "auth_required") {
    lines.push("", "\u26A0\uFE0F \u9700\u8981\u4EBA\u5DE5\u767B\u5F55\uFF1A\u8BF7\u5728 Aylens Admin\uFF08/admin/providers\uFF09\u70B9\u300C\u767B\u5F55\u300D\uFF0C\u5728\u5F39\u51FA\u7684 Chrome \u91CC\u5B8C\u6210\u767B\u5F55\u4E0E 2FA\u3002", "\u51ED\u636E\u53EA\u7559\u5728 Runner \u7684 persistent Profile \u4E2D\uFF0CGateway \u4E0D\u63A5\u89E6 Cookie\u3002");
  }
  return lines.join("\n");
}
async function handleCheckProviderAuth(client, params) {
  const providerId = requireString(params, "providerId");
  const response = await client.post(`/v1/providers/${encodeURIComponent(providerId)}/auth/check`);
  return ok(formatAuth(providerId, response.runtimeId, response.auth));
}
async function handleLoginProviderAuth(client, params) {
  const providerId = requireString(params, "providerId");
  const confirm = readString(params, "confirm");
  if (!client.config.allowAuthLogin) {
    throw new AylensBridgeError("AUTH_LOGIN_DISABLED", "LoginProviderAuth \u9ED8\u8BA4\u5173\u95ED\uFF1A\u5B83\u4F1A\u5728 Runner \u4E0A\u62C9\u8D77\u4E00\u4E2A\u53EF\u89C1 Chrome \u5E76\u53EF\u80FD\u6253\u65AD\u540C Profile \u7684\u8FDB\u884C\u4E2D\u4EFB\u52A1\u3002\u786E\u8BA4\u8981\u542F\u7528\u65F6\uFF0C\u8BF7\u5728\u63D2\u4EF6\u76EE\u5F55 config.env \u4E2D\u8BBE\u7F6E AYLENS_ALLOW_AUTH_LOGIN=true \u5E76\u91CD\u65B0\u52A0\u8F7D\u63D2\u4EF6\u3002");
  }
  if (confirm !== providerId) {
    throw new AylensBridgeError("AUTH_LOGIN_DISABLED", `\u4E8C\u6B21\u786E\u8BA4\u672A\u901A\u8FC7\uFF1A\u8BF7\u628A confirm \u53C2\u6570\u5199\u6210\u4E0E providerId \u5B8C\u5168\u76F8\u540C\u7684\u503C\uFF08\u5F53\u524D providerId=${providerId}\uFF09\u3002`);
  }
  const response = await client.post(`/v1/providers/${encodeURIComponent(providerId)}/auth/login`);
  return ok([
    `\u5DF2\u5728 Runner\uFF08runtime=${response.runtimeId}\uFF09\u4E0A\u542F\u52A8\u767B\u5F55\u6D41\u7A0B\u3002`,
    formatAuth(providerId, response.runtimeId, response.auth),
    "",
    "\u767B\u5F55\u7A97\u53E3\u7531 Runner \u4FA7\u7684 Chrome \u627F\u8F7D\uFF0C\u8BF7\u5728\u76EE\u6807\u673A\u5668\u4E0A\u5B8C\u6210\u64CD\u4F5C\uFF1B\u672C\u547D\u4EE4\u4E0D\u4F1A\u7B49\u5F85\u767B\u5F55\u5B8C\u6210\u3002"
  ].join("\n"));
}

// dist/handlers/extract.js
var MAX_LIMIT = 100;
var MAX_BODY_CHARS = 4e3;
function clip(value) {
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF09` : value;
}
async function handleExtract(client, params) {
  const urls = readStringArray(params, "urls");
  const sources = readStringArray(params, "sources");
  const limit = readNumber(params, "limit");
  const format = readString(params, "format");
  if (!urls) {
    throw new AylensBridgeError("INVALID_REQUEST", "\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570 urls\uFF1A\u8BF7\u7ED9\u51FA\u8981\u63D0\u53D6\u7684 HTTP(S) \u5730\u5740\u5217\u8868\u3002");
  }
  if (!sources) {
    throw new AylensBridgeError("INVALID_REQUEST", "\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570 sources\uFF1A\u63D0\u53D6\u5FC5\u987B\u663E\u5F0F\u6307\u5B9A\u6765\u6E90\uFF0C\u4E0D\u4F1A\u9ED8\u8BA4\u8C03\u7528\u6240\u6709\u670D\u52A1\u3002");
  }
  if (limit !== void 0 && (limit <= 0 || limit > MAX_LIMIT)) {
    throw new AylensBridgeError("INVALID_REQUEST", `limit \u5FC5\u987B\u5728 1..${MAX_LIMIT} \u4E4B\u95F4\uFF0C\u6536\u5230\uFF1A${limit}`);
  }
  if (format !== void 0 && format !== "markdown" && format !== "text") {
    throw new AylensBridgeError("INVALID_REQUEST", `format \u53EA\u80FD\u662F markdown \u6216 text\uFF0C\u6536\u5230\uFF1A${format}`);
  }
  const body = { urls, sources };
  if (limit !== void 0)
    body.limit = limit;
  if (format !== void 0)
    body.content = { format };
  const response = await client.post("/v1/extract", body);
  const succeeded = response.items.filter((item) => item.status === "success");
  const failed = response.items.filter((item) => item.status === "failed");
  const lines = [
    `\u63D0\u53D6\u72B6\u6001\uFF1A${response.status}\uFF08\u6210\u529F ${succeeded.length} / \u5931\u8D25 ${failed.length}\uFF09`,
    ""
  ];
  for (const item of succeeded) {
    const bodyText = clip(item.document?.markdown ?? item.document?.text ?? "");
    lines.push(`## ${item.document?.title ?? item.url}`);
    lines.push(`URL: ${item.url}`);
    lines.push("");
    lines.push(bodyText || "\uFF08\u65E0\u6B63\u6587\uFF09");
    lines.push("");
  }
  if (failed.length > 0) {
    lines.push("### \u5931\u8D25");
    for (const item of failed) {
      lines.push(`- ${item.url} \u2192 ${item.error?.code ?? "CONTENT_UNAVAILABLE"}`);
    }
  }
  if (succeeded.length === 0) {
    const details = Object.entries(response.meta?.providers ?? {}).map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"}`).join("; ");
    throw new AylensBridgeError("NO_RUNTIME", `Aylens \u63D0\u53D6\u6CA1\u6709\u62FF\u5230\u4EFB\u4F55\u6B63\u6587\uFF08status=${response.status}\uFF09${details ? `\uFF1A${details}` : ""}`);
  }
  return ok(lines.join("\n"), `Aylens \u63D0\u53D6\u5B8C\u6210\uFF1A\u6210\u529F ${succeeded.length} \u6761\uFF0C\u5931\u8D25 ${failed.length} \u6761\uFF08status=${response.status}\uFF09\u3002`);
}

// dist/handlers/search.js
var MAX_LIMIT2 = 100;
async function handleSearch(client, params) {
  const query = requireString(params, "query");
  const route = readString(params, "route");
  const sources = readStringArray(params, "sources");
  const language = readString(params, "language");
  const limit = readNumber(params, "limit");
  if (limit !== void 0 && (limit <= 0 || limit > MAX_LIMIT2)) {
    throw new AylensBridgeError("INVALID_REQUEST", `limit \u5FC5\u987B\u5728 1..${MAX_LIMIT2} \u4E4B\u95F4\uFF0C\u6536\u5230\uFF1A${limit}`);
  }
  const body = { query };
  if (route !== void 0)
    body.route = route;
  if (sources !== void 0)
    body.sources = sources;
  if (language !== void 0)
    body.language = language;
  if (limit !== void 0)
    body.limit = limit;
  const response = await client.post("/v1/search", body);
  if (response.status === "failed" && response.items.length === 0) {
    const details = Object.entries(response.meta?.providers ?? {}).map(([id, meta]) => `${id}: ${meta.error?.code ?? "FAILED"} ${meta.error?.message ?? ""}`.trim()).join("; ");
    throw new AylensBridgeError("NO_RUNTIME", `Aylens \u68C0\u7D22\u6574\u4F53\u5931\u8D25\uFF08requestId=${response.requestId}\uFF09${details ? `\uFF1A${details}` : ""}`);
  }
  const text = formatSearchResponse(response);
  const messageForAI = response.items.length > 0 ? `Aylens \u68C0\u7D22\u547D\u4E2D ${response.items.length} \u6761\uFF08status=${response.status}\uFF09\u3002\u6B63\u6587\u89C1\u4E0B\u65B9\u3002` : `Aylens \u68C0\u7D22\u65E0\u547D\u4E2D\uFF08status=${response.status}\uFF09\u3002`;
  return ok(text, messageForAI);
}

// dist/handlers/system.js
async function handleGetStatus(client) {
  const health = await client.get("/health");
  const ready = await client.get("/ready");
  const lines = [
    `Aylens Gateway\uFF1Ahealth=${health.status} \xB7 ready=${ready.status} \xB7 \u5728\u7EBF Runner=${ready.runtimes}`
  ];
  if (ready.runtimes === 0) {
    lines.push("", "\u26A0\uFE0F \u6CA1\u6709\u4EFB\u4F55\u5728\u7EBF Runner\uFF1A\u6B64\u65F6 /v1/search \u4F1A\u62A5\u300C\u65E0\u53EF\u7528\u6267\u884C\u8282\u70B9\u300D\uFF0C\u8FD9\u662F\u8BBE\u8BA1\u5982\u6B64\uFF08Gateway \u4E0D\u505A\u4EFB\u4F55\u6293\u53D6\uFF0C\u6CA1\u6709\u672C\u5730\u56DE\u9000\uFF09\u3002");
  }
  return ok(lines.join("\n"));
}
async function handleListRuntimes(client) {
  const { runtimes } = await client.get("/v1/runtimes");
  if (runtimes.length === 0) {
    return ok("\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55 Runner \u6CE8\u518C\u5230\u8BE5 Gateway\u3002");
  }
  const lines = [`\u5171 ${runtimes.length} \u4E2A Runner\uFF1A`];
  for (const runtime of runtimes) {
    lines.push("", `### ${runtime.id}`, `- \u4E3B\u673A: ${runtime.hostname} \xB7 os=${runtime.os} \xB7 \u7248\u672C=${runtime.version} \xB7 \u534F\u8BAE=${runtime.protocolVersion}`, `- \u72B6\u6001: ${runtime.status} \xB7 \u6700\u540E\u5FC3\u8DF3: ${formatAge(runtime.lastSeenAt)}`, `- \u5BB9\u91CF: ${runtime.capacity.activeJobs}/${runtime.capacity.maxJobs}`, `- Provider \u7C7B\u578B: ${runtime.capabilities.providerTypes.join(", ") || "\uFF08\u65E0\uFF09"}`, `- Provider \u5B9E\u4F8B: ${runtime.capabilities.providerIds.join(", ") || "\uFF08\u65E0\uFF09"}`, `- \u6D4F\u89C8\u5668: ${runtime.capabilities.browsers.join(", ") || "\uFF08\u65E0\uFF09"} \xB7 \u81EA\u52A8\u5316=${runtime.capabilities.browserAutomation} \xB7 HTTP=${runtime.capabilities.http}`, `- Profile: ${runtime.capabilities.profiles.join(", ") || "\uFF08\u65E0\uFF09"} \xB7 \u4EE3\u7406\u914D\u7F6E\u901A\u9053=${runtime.capabilities.proxyConfig === true}`);
    const labels = Object.entries(runtime.labels);
    if (labels.length > 0) {
      lines.push(`- \u6807\u7B7E: ${labels.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  }
  return ok(lines.join("\n"));
}
async function handleListProviders(client) {
  const { providers } = await client.get("/v1/providers");
  if (providers.length === 0) {
    return ok("\u8BE5 Gateway \u672A\u914D\u7F6E\u4EFB\u4F55 Provider\u3002");
  }
  const lines = [`\u5171 ${providers.length} \u4E2A Provider\uFF1A`];
  for (const provider of providers) {
    lines.push(`- ${provider.id} \xB7 type=${provider.type} \xB7 enabled=${provider.enabled} \xB7 runtime=${JSON.stringify(provider.runtime)}`);
  }
  lines.push("", "\u8C03\u7528 Search \u65F6\u53EF\u7528 sources \u663E\u5F0F\u6307\u5B9A\u4E0A\u8FF0 id\uFF08\u5982 sources=A,B\uFF09\uFF0C\u6216\u6539\u7528 route \u8DEF\u7531\u540D\u3002");
  return ok(lines.join("\n"));
}

// dist/commands.js
var COMMANDS = [
  {
    name: "Search",
    description: "\u529F\u80FD: \u901A\u8FC7 Aylens Gateway \u6267\u884C\u7EDF\u4E00\u4E92\u8054\u7F51\u68C0\u7D22\uFF08url-fetch / x-search \u7B49 Provider\uFF09\uFF0C\u8FD4\u56DE\u6807\u9898\u3001URL\u3001\u6765\u6E90\u4E0E\u6B63\u6587 Markdown\u3002\n`command` \u56FA\u5B9A\u4E3A `Search`\uFF0C\u4E0D\u5F97\u586B\u5199 URL\u3001\u8DEF\u5F84\u6216\u81EA\u7136\u8BED\u8A00\u3002\n`query` \u662F\u68C0\u7D22\u5185\u5BB9\u672C\u4F53\uFF1A\u6293\u53D6\u6307\u5B9A\u7F51\u9875\u65F6\u76F4\u63A5\u5199\u8BE5 URL\uFF1BX \u68C0\u7D22\u65F6\u5199 X \u68C0\u7D22\u5F0F\u3002\n`sources` \u53EF\u663E\u5F0F\u6307\u5B9A Provider \u5B9E\u4F8B\uFF08\u9017\u53F7\u5206\u9694\uFF09\uFF0C`route` \u53EF\u6307\u5B9A Gateway \u8DEF\u7531\u540D\uFF0C\u4E8C\u8005\u90FD\u4E0D\u586B\u5219\u8D70\u9ED8\u8BA4\u8DEF\u7531\u3002\n`limit` \u4E3A\u671F\u671B\u6761\u6570\uFF081-100\uFF09\uFF0C`language` \u4E3A\u8BED\u8A00\u504F\u597D\u3002",
    exampleParams: [
      { key: "query", value: "https://example.com" },
      { key: "sources", value: "url-fetch" },
      { key: "limit", value: "5" }
    ],
    run: handleSearch
  },
  {
    name: "Extract",
    description: "\u529F\u80FD: \u5BF9\u663E\u5F0F URL \u5217\u8868\u63D0\u53D6\u6B63\u6587\uFF08\u4E0E Search \u662F\u4E24\u4E2A\u72EC\u7ACB\u80FD\u529B\uFF09\uFF0C\u8FD4\u56DE Markdown \u6216\u7EAF\u6587\u672C\u3001\u9010\u6761\u6210\u529F/\u5931\u8D25\u72B6\u6001\u3002\n`command` \u56FA\u5B9A\u4E3A `Extract`\uFF0C\u4E0D\u5F97\u586B\u5199 URL\u3001\u8DEF\u5F84\u6216\u81EA\u7136\u8BED\u8A00\u3002\n`urls` \u662F\u8981\u63D0\u53D6\u7684 HTTP(S) \u5730\u5740\u5217\u8868\uFF08\u9017\u53F7\u6216\u6362\u884C\u5206\u9694\uFF09\u3002\n`sources` \u5FC5\u586B\uFF0C\u6307\u5B9A\u63D0\u53D6\u6765\u6E90\uFF08\u5982 `tavily`\uFF09\uFF1B\u4E0D\u4F1A\u9ED8\u8BA4\u8C03\u7528\u6240\u6709\u63D0\u53D6\u670D\u52A1\uFF0C\u4E5F\u4E0D\u590D\u7528 Search \u7684\u9ED8\u8BA4\u8DEF\u7531\u3002\n`limit` \u4E3A\u671F\u671B\u8FD4\u56DE\u6761\u6570\uFF081-100\uFF09\uFF0C`content` \u63A7\u5236\u6B63\u6587\u683C\u5F0F\uFF08markdown \u6216 text\uFF09\u3002",
    exampleParams: [
      { key: "urls", value: "https://example.com/article" },
      { key: "sources", value: "tavily" },
      { key: "content", value: "markdown" }
    ],
    run: handleExtract
  },
  {
    name: "GetStatus",
    description: "\u529F\u80FD: \u67E5\u770B Aylens Gateway \u5065\u5EB7\u72B6\u6001\u4E0E\u5728\u7EBF Runner \u6570\u91CF\uFF0C\u7528\u4E8E\u5224\u65AD\u68C0\u7D22\u662F\u5426\u5177\u5907\u6267\u884C\u8282\u70B9\u3002\n`command` \u56FA\u5B9A\u4E3A `GetStatus`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\u3002",
    exampleParams: [],
    run: (client) => handleGetStatus(client)
  },
  {
    name: "GetOverview",
    description: "\u529F\u80FD: \u83B7\u53D6 Gateway \u603B\u89C8\uFF1AProvider \u6E05\u5355\u4E0E\u767B\u5F55\u6001\u3001Runner\u3001\u6D4F\u89C8\u5668 Profile\u3001\u6700\u8FD1\u5BA1\u8BA1\u3002\u6392\u67E5\u300C\u68C0\u7D22\u4E0D\u597D\u7528\u300D\u5148\u770B\u8FD9\u91CC\u3002\n`command` \u56FA\u5B9A\u4E3A `GetOverview`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\u3002\n`recentAuditLimit` \u53EF\u9650\u5236\u5217\u51FA\u7684\u8FD1\u671F\u5BA1\u8BA1\u6761\u6570\u3002",
    exampleParams: [{ key: "recentAuditLimit", value: "5" }],
    run: handleGetOverview
  },
  {
    name: "ListRuntimes",
    description: "\u529F\u80FD: \u5217\u51FA\u5DF2\u8FDE\u63A5 Runner \u8282\u70B9\u7684\u72B6\u6001\u3001\u5BB9\u91CF\u3001Provider \u80FD\u529B\u3001\u6D4F\u89C8\u5668\u4E0E Profile\u3002\n`command` \u56FA\u5B9A\u4E3A `ListRuntimes`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\u3002",
    exampleParams: [],
    run: (client) => handleListRuntimes(client)
  },
  {
    name: "ListProviders",
    description: "\u529F\u80FD: \u5217\u51FA Gateway \u5DF2\u914D\u7F6E\u7684 Provider \u5B9E\u4F8B\uFF08id / type / enabled / runtime\uFF09\uFF0C\u7528\u4E8E\u786E\u5B9A Search \u7684 sources \u53D6\u503C\u3002\n`command` \u56FA\u5B9A\u4E3A `ListProviders`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\u3002",
    exampleParams: [],
    run: (client) => handleListProviders(client)
  },
  {
    name: "CheckProviderAuth",
    description: "\u529F\u80FD: \u68C0\u67E5\u6307\u5B9A Provider \u7684\u4EBA\u5DE5\u767B\u5F55\u6001\uFF08\u65E0\u526F\u4F5C\u7528\uFF09\u3002\u8FD4\u56DE authenticated / auth_required / unknown \u4E0E\u5F53\u524D\u8D26\u53F7\u3002\n`command` \u56FA\u5B9A\u4E3A `CheckProviderAuth`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\uFF1B`providerId` \u7528 ListProviders \u8FD4\u56DE\u7684 id\u3002",
    exampleParams: [{ key: "providerId", value: "x" }],
    run: handleCheckProviderAuth
  },
  {
    name: "LoginProviderAuth",
    description: "\u529F\u80FD: \u5728 Runner \u4E0A\u62C9\u8D77\u4E00\u4E2A\u53EF\u89C1 Chrome \u5E76\u6253\u5F00\u8BE5 Provider \u7684\u767B\u5F55\u9875\uFF08**\u5F3A\u526F\u4F5C\u7528**\uFF0C\u4F1A\u6253\u65AD\u540C Profile \u7684\u8FDB\u884C\u4E2D\u4EFB\u52A1\uFF0C\u4E14\u4E0D\u7B49\u5F85\u767B\u5F55\u5B8C\u6210\uFF09\u3002\n\u9ED8\u8BA4\u5173\u95ED\uFF0C\u9700\u5728\u63D2\u4EF6 config.env \u8BBE AYLENS_ALLOW_AUTH_LOGIN=true \u624D\u53EF\u7528\u3002\n`command` \u56FA\u5B9A\u4E3A `LoginProviderAuth`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\uFF1B`providerId` \u4E3A\u76EE\u6807 Provider\uFF0C`confirm` \u5FC5\u987B\u4E0E `providerId` \u5B8C\u5168\u76F8\u540C\u4F5C\u4E3A\u4E8C\u6B21\u786E\u8BA4\u3002",
    exampleParams: [
      { key: "providerId", value: "x" },
      { key: "confirm", value: "x" }
    ],
    run: handleLoginProviderAuth
  },
  {
    name: "GetAudit",
    description: "\u529F\u80FD: \u6309 requestId \u67E5\u770B\u5355\u6B21\u68C0\u7D22\u7684\u5BA1\u8BA1\u660E\u7EC6\uFF08\u72B6\u6001\u3001\u8017\u65F6\u3001\u6BCF\u4E2A Provider \u7684\u6210\u8D25\u4E0E\u9519\u8BEF\u7801\uFF09\u3002\n`command` \u56FA\u5B9A\u4E3A `GetAudit`\uFF0C\u4E0D\u5F97\u586B\u5199\u5176\u4ED6\u5185\u5BB9\uFF1B`requestId` \u6765\u81EA Search \u8FD4\u56DE\u7684 requestId \u6216 GetOverview \u7684\u8FD1\u671F\u5BA1\u8BA1\u5217\u8868\u3002",
    exampleParams: [{ key: "requestId", value: "req-xxxxxxxx" }],
    run: handleGetAudit
  }
];
var VCP_COMMANDS = COMMANDS.map((command) => command.name);

// dist/dispatcher.js
function normalizeParams(request) {
  const { command: _command, params: nested, maid: _maid, ...flat } = request;
  return { ...flat, ...nested ?? {} };
}
async function dispatchCommand(client, request) {
  const command = typeof request.command === "string" ? request.command.trim() : "";
  if (!command) {
    throw new AylensBridgeError("INVALID_REQUEST", `\u7F3A\u5C11 command \u5B57\u6BB5\u3002\u53EF\u7528\u547D\u4EE4\uFF1A${COMMANDS.map((item) => item.name).join(", ")}`);
  }
  const definition = COMMANDS.find((item) => item.name === command);
  if (!definition) {
    throw new AylensBridgeError("INVALID_REQUEST", `\u672A\u77E5\u547D\u4EE4 "${command}"\u3002\u53EF\u7528\u547D\u4EE4\uFF1A${COMMANDS.map((item) => item.name).join(", ")}`);
  }
  return definition.run(client, normalizeParams(request));
}

// dist/index.js
function writeResponse(response) {
  const content = response.content ?? response.result?.content ?? [];
  const payload = {
    status: response.status,
    result: { content },
    content
  };
  if (response.messageForAI !== void 0)
    payload.messageForAI = response.messageForAI;
  if (response.error !== void 0)
    payload.error = response.error;
  process.stdout.write(JSON.stringify(payload));
}
async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
async function main() {
  const raw = await readStdin();
  if (!raw.trim())
    throw new Error("stdin \u672A\u6536\u5230\u4EFB\u4F55\u8F93\u5165");
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error(`stdin \u4E0D\u662F\u5408\u6CD5 JSON\uFF1A${raw.slice(0, 200)}`);
  }
  const config = loadConfig();
  const client = new AylensClient(config);
  writeResponse(await dispatchCommand(client, request));
}
main().then(() => {
  process.exitCode = 0;
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[AylensBridge] ${message}
`);
  writeResponse(fail(error));
  process.exitCode = 0;
});
