# Aylens

Aylens is a Node.js/TypeScript retrieval gateway foundation for AI agents.

The project currently implements the **retrieval architecture and distributed execution runtime only**. No real search channel such as Brave, X, Zhihu, Xiaohongshu, or Google is connected yet.

## Implemented foundation

- Fastify Gateway with API-key authentication
- Unified search request/response contracts
- Provider definition + ProviderFactory registry
- Capability-based Runtime Registry
- Local Runtime and remote Aylens Runner
- Outbound WebSocket Runner protocol
- Per-Runner credentials
- Dynamic Runner Provider Plugin loading
- Runtime-local Transport Registry
- Direct / HTTP Proxy / SOCKS5 transports
- Browser Profile Manager and Profile Lease
- Playwright-based Google Chrome Profile Host
- Persistent Chrome profile launch
- CDP attach mode for externally launched Chrome
- Browser profile -> Runtime-local proxy binding
- In-memory audit trail
- MCP tool adapter definitions
- Config validation and environment interpolation
- Unit and Gateway/Runner integration tests

The important boundary is:

```text
Gateway
  -> Provider definition
  -> Execution Dispatcher
  -> Local Runtime OR Remote Runner
  -> Provider Plugin
  -> Runtime-local Transport / BrowserHost
  -> Internet
```

Proxy credentials, Chrome profile directories, cookies, local storage, and other login state remain local to the Runtime that owns them.

## Install and validate

```bash
npm install
npm run typecheck
npm test
npm run build
```

Run the Gateway:

```bash
npm run dev
```

Run a Runner:

```bash
npm run dev:runner
```

Default configuration files:

```text
config/aylens.yaml
config/runner.yaml
```

## Gateway API

```text
GET  /health
GET  /ready
POST /v1/search
GET  /v1/providers
GET  /v1/runtimes
GET  /v1/audit/:requestId
GET  /v1/browser-profiles
```

Authenticated `/v1/*` HTTP endpoints use:

```text
Authorization: Bearer <AYLENS_API_KEY>
```

With the default configuration there are no providers, so:

```bash
curl -X POST http://127.0.0.1:3000/v1/search \
  -H 'Authorization: Bearer dev-key' \
  -H 'Content-Type: application/json' \
  -d '{"query":"hello"}'
```

returns a successful empty result. This is intentional.

---

## Runner Provider Plugins

A Runner no longer contains hard-coded channels. It loads explicitly configured local ESM modules at startup.

Runner config:

```yaml
plugins:
  baseDir: "."
  modules:
    - "./plugins/my-provider/index.mjs"
    - "@my-company/aylens-provider-example"
```

A plugin exports a plugin descriptor:

```js
export default {
  name: "example-plugin",
  version: "1.0.0",

  factories: [
    {
      type: "example-browser-provider",

      create(id, config, services) {
        return {
          id,

          async search(context, request) {
            // services.transports
            // services.browser
            // config.options
            // config.browser?.profile

            return {
              items: [],
            };
          },
        };
      },
    },
  ],
};
```

The Runner validates plugin metadata and registers each `ProviderFactory`.

Only provider types that were **actually loaded successfully** are reported to the Gateway:

```text
Runner REGISTER
  capabilities.providerTypes
```

Therefore a Gateway runtime selector can safely request:

```yaml
providers:
  example:
    type: example-browser-provider

    runtime:
      selector:
        os: windows
        providerType: example-browser-provider
        browser: chrome
        profile: account-main
```

If a configured plugin cannot be imported or exports an invalid descriptor, Runner startup fails before it registers with the Gateway.

Plugins are trusted local code. Configuring a module gives that module access to the Runner process and its Runtime-local services.

---

## Runtime-local transports

Each Gateway/Runner has its own Transport Registry.

### Direct

```yaml
transports:
  direct:
    type: direct
```

### HTTP/HTTPS proxy

```yaml
transports:
  proxy-us:
    type: http-proxy
    url: "${PROXY_US_URL}"
```

Supported proxy URL schemes:

```text
http://
https://
```

Credentials can stay inside the Runtime-local environment variable:

```text
PROXY_US_URL=http://username:password@proxy-host:8080
```

### SOCKS5

```yaml
transports:
  proxy-cn:
    type: socks5
    url: "${PROXY_CN_URL}"
```

Supported schemes:

```text
socks5://
socks5h://
```

Providers receive the Runtime-local `TransportRegistry` through their factory context:

```js
create(id, config, services) {
  const transport = services.transports.get(
    config.transport?.primary ?? "direct"
  );

  // transport.request(...)
}
```

The Gateway does not need the remote Runner's actual proxy URL or credentials.

---

## Browser Runtime / Chrome Profile Host

Browser automation is a separate Runtime service; it is not implemented as an HTTP Transport.

A Provider Plugin receives:

```text
services.browser
```

and can acquire a configured profile:

```js
await services.browser.withProfile(
  config.browser.profile,
  context.jobId,
  async ({ context: browserContext }) => {
    const page = await browserContext.newPage();

    // Provider-specific browser automation happens here.

    return result;
  }
);
```

The BrowserHost:

1. acquires a Profile Lease;
2. lazily opens or attaches to Chrome;
3. reuses the browser context for later jobs;
4. passes the context to the Provider;
5. releases the lease after the operation;
6. closes Aylens-owned persistent contexts when the Runtime shuts down.

### Persistent Google Chrome profile

Example Runner config:

```yaml
browserProfiles:
  xhs-main:
    browser: chrome
    mode: launch

    # Use a dedicated Aylens automation profile directory.
    userDataDir: "D:\\Aylens\\profiles\\xhs-main"

    channel: chrome
    headless: false
    interactive: true

    maxConcurrency: 1
    args: []

    transport: proxy-cn
```

On first use, Aylens launches installed Google Chrome through `playwright-core` using the configured persistent user-data directory.

For login-required platforms, use a dedicated Aylens profile directory and complete login interactively in that Chrome profile. The same Runtime can then reuse its cookies/local storage without sending them to the Gateway.

Do not point multiple machines at the same writable Chrome User Data directory.

### CDP attach

A Runner can also attach to an externally started Chrome:

```yaml
browserProfiles:
  chrome-external:
    browser: chrome
    mode: cdp
    userDataDir: "D:\\Aylens\\profiles\\external"
    cdpEndpoint: "http://127.0.0.1:9222"

    maxConcurrency: 1
    interactive: true
    headless: false
    channel: chrome
    args: []
```

In CDP mode Aylens treats the external Chrome process as externally owned and does not terminate it during BrowserHost shutdown.

### Browser proxy

A launched persistent profile can reference a Runner-local Transport:

```yaml
transports:
  proxy-cn:
    type: socks5
    url: "${PROXY_CN_URL}"

browserProfiles:
  account-main:
    browser: chrome
    mode: launch
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    channel: chrome
    headless: false
    interactive: true
    maxConcurrency: 1
    args: []
    transport: proxy-cn
```

The BrowserHost translates that local Transport config into Playwright's browser proxy configuration.

---

## Runner example

```yaml
runner:
  id: windows-home-01
  gatewayUrl: "wss://aylens.example.com/v1/runners/connect"
  token: "${AYLENS_RUNNER_TOKEN}"
  heartbeatMs: 10000
  maxJobs: 2

  labels:
    role: social-browser

plugins:
  baseDir: "."
  modules:
    - "./plugins/example-browser/index.mjs"

capabilities:
  browsers:
    - chrome

  http: true
  browserAutomation: true

transports:
  direct:
    type: direct

  proxy-cn:
    type: socks5
    url: "${PROXY_CN_URL}"

browserProfiles:
  account-main:
    browser: chrome
    mode: launch
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    channel: chrome
    headless: false
    interactive: true
    maxConcurrency: 1
    args: []
    transport: proxy-cn
```

Provider capabilities are derived from loaded plugins rather than manually declared in YAML.

---

## Generic browser verification provider

The repository now includes a deliberately small Runner plugin at **plugins/generic-browser/index.mjs**. It is not a search engine: it treats the search query as a URL and exercises the complete browser path.

~~~text
POST /v1/search
  -> SearchService
  -> ExecutionDispatcher
  -> Windows Runner
  -> generic-browser Provider Plugin
  -> BrowserHost.withProfile(...)
  -> persistent Google Chrome profile
  -> page.goto(...)
  -> title + body.innerText()
  -> SearchDocument
  -> JOB_RESULT
  -> Gateway response
~~~

Only http:// and https:// targets are accepted. URLs containing embedded credentials are rejected.

### Provider options

~~~yaml
providers:
  generic-browser:
    type: generic-browser

    runtime:
      selector:
        os: windows
        providerType: generic-browser
        browser: chrome
        profile: generic-login

    browser:
      profile: generic-login

    options:
      waitUntil: domcontentloaded
      timeoutMs: 30000
      extractionTimeoutMs: 10000
      postLoadDelayMs: 0
      maxTextChars: 50000
      snippetChars: 500
      textSelector: body
      keepPageOpen: false
~~~

The result is normalized into the same SearchDocument shape used by every other provider, with platform=web, type=webpage, the final URL, title, cleaned text, snippet, HTTP status metadata, and browser provenance.

### Windows: verify persistent login state end to end

Ready-to-use example configs are included:

~~~text
config/examples/generic-browser.gateway.yaml
config/examples/generic-browser.runner.yaml
~~~

The Runner example uses a dedicated profile directory:

~~~text
D:\Aylens\profiles\generic-login
~~~

Do not point this at your normal day-to-day Chrome profile.

Open PowerShell window 1 and start the Gateway:

~~~powershell
$env:AYLENS_CONFIG="./config/examples/generic-browser.gateway.yaml"
$env:AYLENS_API_KEY="dev-key"
$env:AYLENS_RUNNER_TOKEN="dev-runner-token"
npm run dev
~~~

Open PowerShell window 2 on the Windows browser machine and start the Runner:

~~~powershell
$env:AYLENS_RUNNER_CONFIG="./config/examples/generic-browser.runner.yaml"
$env:AYLENS_RUNNER_TOKEN="dev-runner-token"
npm run dev:runner
~~~

Confirm that the Runner is registered:

~~~powershell
curl.exe http://127.0.0.1:3000/v1/runtimes `
  -H "Authorization: Bearer dev-key"
~~~

The Runtime should advertise the generic-browser provider type, Chrome, and the generic-login profile.

For a public-page smoke test:

~~~powershell
curl.exe -X POST http://127.0.0.1:3000/v1/search `
  -H "Authorization: Bearer dev-key" `
  -H "Content-Type: application/json" `
  -d '{"query":"https://example.com","sources":["generic-browser"]}'
~~~

A real-Chrome automated smoke test is also available:

~~~bash
npm run smoke:generic-browser
~~~

On Windows with Google Chrome installed, this starts a temporary persistent Chrome profile, sends one request that establishes a session cookie, immediately sends a second request to a protected page, and verifies that the same BrowserContext reused the cookie through the full Gateway -> Runner -> Plugin -> Chrome -> Gateway path. The temporary profile is removed afterward.

For a login-required site, the example Gateway config intentionally sets keepPageOpen=true. Use this sequence:

1. Send a request whose query is the site's login page.
2. A visible Google Chrome window opens using the generic-login persistent profile.
3. The request may return the current login-page text, but the Chrome tab stays open.
4. Complete login manually in that Chrome window.
5. Send a second request for an authenticated page on the same site.
6. The second request uses the same persistent BrowserContext, so cookies and local storage are reused.
7. Verify that the returned text contains authenticated-only content.
8. After login is established, set keepPageOpen=false so later reads do not accumulate tabs.

The login session stays on the Windows Runtime. Cookies, local storage, the Chrome user-data directory, and Runtime-local proxy credentials are not sent to the Gateway.

For client-rendered pages, increase postLoadDelayMs. To extract a narrower region, set textSelector to a selector such as main.

The generic provider is intentionally small. Platform-specific browser providers should reuse the same BrowserHost/Profile mechanism while implementing their own navigation, authentication checks, pagination, and structured extraction.

---

## Adding a real provider later

A provider integration should normally require only:

1. implement `SearchProvider`;
2. expose it through a `ProviderFactory`;
3. package that factory as a Runner plugin or register it in the Gateway local runtime;
4. use injected Runtime-local Transport and/or BrowserHost;
5. add its Provider definition to Gateway YAML;
6. add it to a route or request it explicitly.

It should **not** require modifying:

```text
SearchService
ExecutionDispatcher
RuntimeRegistry
Runner protocol
Gateway REST API
```

unless the integration introduces a genuinely new capability.

See `ARCHITECTURE.md` for the full architecture design.
