# 配置说明

## 配置入口

Gateway：

```text
config/aylens.yaml
```

Runner:

```text
config/runner.yaml
```

## 数据库(Runner 代理配置 / Gateway 审计)

Gateway 与 Runner 各自使用独立本地 SQLite(Node 24 `node:sqlite`),路径通过环境变量配置:

```text
AYLENS_GATEWAY_DB   # 默认 ./.data/gateway.sqlite
AYLENS_RUNNER_DB    # 默认 ./.data/runners/<runner-id>.sqlite
```

- Runner 首次启动会从 YAML 一次性导入代理(transports)与 Provider 传输绑定;此后这些字段以数据库为唯一来源,YAML 不再覆盖。修改代理请在 Admin → 代理配置 页面操作。
- 未迁移字段(Provider options、Browser Profile、插件、启动连接配置)继续由 YAML 提供。
- Gateway SQLite 保存脱敏请求审计与配置操作记录,默认保留 30 天;重启后遗留的运行中请求标记为 interrupted。
- 数据库无法打开或迁移失败时 Runner/Gateway 会明确报错退出,不静默回退 YAML。
- Runner 数据库包含代理凭据。SQLite 不提供静态加密,数据库目录与备份必须按敏感文件保护(建议将 `AYLENS_RUNNER_DB` 指向受 ACL 保护的稳定数据目录,而不是 release 目录——release 重建会删除该目录)。

生产建议:

```text
AYLENS_GATEWAY_DB=/stable-data/gateway.sqlite
AYLENS_RUNNER_DB=/stable-data/runner.sqlite
```

Admin 代理配置页仅允许修改在线 Runner;携带凭据的远程配置操作要求 HTTPS + WSS(loopback 开发连接例外)。HTTP 代理修改后新任务立即生效;浏览器 Profile 引用的代理修改后需重启对应 Chrome 才能生效。

默认配置(`config/aylens.yaml` / `config/runner.yaml`)已接入 url-fetch,
开箱即用——HTTP 阶段默认走 `proxy-main`，不启动浏览器也能使用代理。
可通过环境变量覆盖配置文件位置：

```text
AYLENS_CONFIG
AYLENS_RUNNER_CONFIG
```

配置支持环境变量插值：

```text
${VAR}
${VAR:-fallback}
```

```yaml
server:
  host: 0.0.0.0
  port: 3000
  publicOrigin: "https://aylens.example.com"
  trustProxy:
    - "127.0.0.1"
    - "10.20.0.0/16"

auth:
  apiKey: "${AYLENS_API_KEY:-dev-key}"
  runnerTokens:
    dev-runner: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"

providers:
  url-fetch:
    type: url-fetch

routes:
  default:
    providers:
      - url-fetch
```

Gateway Admin 登录使用当前 `auth.apiKey`，不需要新增管理 Key。线上应配置 HTTPS 对外 Origin；若 TLS 在受控反向代理终止，精确配置 `publicOrigin` 和可信代理地址/CIDR。默认 `trustProxy: []`，不要设置宽泛网段或通配信任。非 loopback 明文 HTTP 不允许建立管理会话。Provider 的 `transport`、`browser` 与 `options` 只存在于 Runner Provider Deployment。

`server` 与 `runtimeRegistry` 都有默认值。Provider 的 `runtime` placement 也可以省略；此时 Gateway 会按 Provider ID 与 Type，从实际部署该 Provider 的在线 Runner 中选择。

## Runner 最小结构

```yaml
runner:
  id: dev-runner
  gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect"
  token: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"
plugins:
  modules:
    - "builtin:url-fetch"
    - "builtin:x-search"
    # 外部扩展推荐：- "./providers/example.aylens-provider"

browser:
  # 浏览器类 Provider 未显式指定 profile 时统一使用这里。
  defaultProfile: browser-main

providers:
  url-fetch:
    type: url-fetch
    transport:
      primary: proxy-main
      fallback: [direct]
    options:
      controlledProxyEgress: true
      httpTimeoutMs: 25000
  x:
    type: x-search

browserProfiles:
  browser-main:
    mode: cdp
    userDataDir: "./.profiles/browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    interactive: true
```

Runner 不再要求手工填写 `capabilities`。Provider Type 来自实际加载成功的 Plugin，Provider ID 来自本机 Deployment，Browser/Profile 能力来自实际 Browser Profile。Direct Transport、Plugin `baseDir`、心跳和并发数都有默认值。

`browser.defaultProfile` 是 Runner 级共享浏览器工作区。Runner 会把它作为 `services.defaultBrowserProfile` 注入 ProviderFactory；`x-search` 始终使用该默认值，`url-fetch` 只在进入浏览器兜底阶段时才会用到它——它的 HTTP 阶段与浏览器完全无关。两者在未配置 `provider.browser.profile` 时都回退到该默认值。其他 Browser Provider 也应采用 `config.browser?.profile ?? services.defaultBrowserProfile` 的逻辑。需要隔离账号时，再在单个 Provider 上显式指定 `browser.profile` 覆盖默认值。

默认 Profile 使用 managed CDP：Runner 不再通过 Playwright `launchPersistentContext()` 创建浏览器，而是直接启动系统安装的 Google Chrome 进程，再通过 `connectOverCDP()` attach。人工登录发生在普通 Chrome 窗口中；平时检索仍由 Provider 自动操作任务页面。

## Runtime 选择

Provider 定义与执行机器是两个概念。默认情况下无需配置 `runtime`，Gateway 会要求目标 Runner 实际部署同一个 Provider ID，并匹配 Provider Type。只有需要固定机器或增加 placement 约束时，才配置 `runtime.nodeId` 或 `runtime.selector`。注意 Runner 的 `browser.defaultProfile` 不会自动成为 Gateway 调度条件；多 Runner 场景若依赖特定 Profile，应显式配置 `runtime.selector.profile`。

示例：

```yaml
providers:
  url-fetch:
    type: url-fetch
    enabled: true

    runtime:
      selector:
        os: windows
        providerType: url-fetch
        browser: chrome
        profile: browser-main

```

这里表达的是：

- Provider instance：url-fetch
- Provider type：url-fetch
- Runtime OS：Windows
- Runtime 已加载对应 Provider Plugin
- Runtime 已部署 url-fetch 这个 Provider ID
- Runtime 提供 Chrome
- Runtime 拥有 browser-main Profile

Provider 的执行配置属于 Runner。使用共享默认 Profile 时可以不重复声明 `browser.profile`：

```yaml
browser:
  defaultProfile: browser-main

providers:
  url-fetch:
    type: url-fetch
    options:
      timeoutMs: 30000
```

只有需要覆盖默认工作区时，才在该 Provider 下显式配置 `browser.profile`。

Gateway 不需要知道远程机器上的 Chrome 路径、Provider Options、Cookie 或代理配置。

## Transport（Runner 配置）

Direct：

```yaml
transports:
  direct:
    type: direct
```

HTTP/HTTPS Proxy：

```yaml
transports:
  proxy-us:
    type: http-proxy
    url: "${PROXY_US_URL}"
```

支持：

```text
http://
https://
```

SOCKS5：

```yaml
transports:
  proxy-cn:
    type: socks5
    url: "${PROXY_CN_URL}"
```

支持：

```text
socks5://
socks5h://
```

代理凭据保存在 Runner 本地 SQLite(见上文数据库一节);通过 Admin → 代理配置 页面在线修改,支持保留、替换或清除凭据。凭据不通过 Gateway 持久化或下发。

## Browser Profile（Runner 配置）

默认：普通 Chrome + managed CDP：

```yaml
browserProfiles:
  browser-main:
    browser: chrome
    mode: cdp
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    interactive: true
    maxConcurrency: 1
    args: []
```

`autoStart: true` 时，Runner 会先检查 `cdpEndpoint`。如果已有 Chrome 在监听就直接复用；否则从系统安装位置寻找 Google Chrome，以普通 OS 进程启动并带上独立 `userDataDir` 和 remote-debugging 参数。也可以通过 `CHROME_PATH` 或 `executablePath` 显式指定 Chrome。

只连接已有 Chrome：

```yaml
browserProfiles:
  chrome-external:
    browser: chrome
    mode: cdp
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: false
    maxConcurrency: 1
    interactive: true
```

旧的 Playwright launch 模式仍保留，适合无需人工站点登录的隔离抓取：

```yaml
browserProfiles:
  automation-only:
    browser: chrome
    mode: launch
    userDataDir: "D:\\Aylens\\profiles\\automation-only"
    headless: true
```

Browser Profile 可以指定 Runner-local Transport：

```yaml
browserProfiles:
  account-main:
    browser: chrome
    mode: cdp
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    transport: proxy-cn
```

`mode: launch` 时，BrowserHost 会把 Runtime-local Transport 映射为 Playwright 的浏览器代理配置；`mode: cdp + autoStart: true` 时，Runner 会把同一个 Transport 映射成普通 Chrome 的 `--proxy-server=...` 启动参数。

注意：CDP 模式的代理是在 **Chrome 进程启动时**确定的。修改 `transport` 后，如果 `cdpEndpoint` 上已经有旧 Chrome 在运行，Runner 会复用旧进程，新的代理参数不会动态生效。此时必须先彻底关闭该 `browser-main` Chrome，再重新触发登录/检查/搜索，让 Runner 用新配置重新启动。

不要让多台机器同时写同一个 Chrome User Data 目录。

## 敏感信息边界

以下内容应保持 Runtime-local：

- Runner Token
- Proxy URL 中的凭据
- Chrome userDataDir
- Chrome Cookie / Local Storage
- CDP 本地访问细节
- Provider 私密凭据

Gateway 侧优先保存逻辑名称和选择条件，而不是本地秘密。
