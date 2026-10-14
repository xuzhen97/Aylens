# DeepSeek Harness 插件：aylens-dsh

`packages/dsh-plugin` 产出 DSH（DeepSeek Harness）插件包 **`aylens-dsh`**，把 Aylens Gateway 的检索能力以 **4 个原生工具**暴露给 DSH 里的模型。它与 VCPToolBox 侧的 [AylensBridge](./vcp-plugin.md) 共用同一份执行核心，见 [ADR](../adr/2026-10-14-shared-bridge-core.md)。

决策背景见 [ADR：以 DSH 原生工具插件暴露 Gateway 能力](../adr/2026-10-14-dsh-native-tool-plugin-bridge.md)。

## 四个工具

| 工具 | 对应命令 | 参数（★ = 必填） |
| --- | --- | --- |
| `aylens_search` | Search | ★`query` · `sources` · `route` · `limit` · `language` |
| `aylens_extract` | Extract | ★`urls` · ★`sources` · `content` · `limit` |
| `aylens_inspect` | GetStatus / GetOverview / ListRuntimes / ListProviders / CheckProviderAuth / GetAudit | ★`scope` · `providerId` · `requestId` · `recentAuditLimit` |
| `aylens_login` | LoginProviderAuth | ★`providerId` · ★`confirm` |

六条诊断命令合并进 `aylens_inspect` 的 `scope` 枚举（逐条成器会给系统提示词塞进六份几乎不会被调用的 schema）。`scope="provider-auth"` 需 `providerId`，`scope="audit"` 需 `requestId`——JSON Schema 表达不了条件必填，由工具主体校验并给出指路错误。

### 参数名是公开接口

模型是从系统提示词里的 JSON Schema 学填参的，所以**改参数名或必填性等于破坏性变更**。`test/dsh-plugin-contract.test.ts` 里有一张期望表逐工具锁定参数名集合与必填集合；改契约必须同时改它与测试。

### 渠道事实只写一遍

工具描述里「哪个渠道填什么、哪家批量上限多少、API 渠道自带正文因此不必再 Extract」这些**事实**住在 `packages/bridge-core/src/capabilities.ts`，两个宿主的描述都逐字引用它。改它要**同时重建两侧产物**，否则会出现「渠道实现了但某个宿主的模型不知道」。

`aylens_login` 默认关闭：它会在 Runner 上拉起**可见的 Chrome**、打断同 Profile 的进行中任务、且不等待登录完成。开启方式见下方「配置」。两道闸门（`allowAuthLogin`、`confirm` 须与 `providerId` 全等）开在共享核心里，宿主上层无法绕过。

## 安装

### 1. 前置：Gateway 与 Runner 必须在线

```bash
pnpm dev:all
```

Gateway 起着但**没有在线 Runner** 时，检索会报 `NO_RUNTIME`——这是设计如此（Gateway 不做任何抓取，没有本地回退），不是「查无结果」。用 `aylens_inspect` 的 `scope="runtimes"` / `scope="providers"` 确认执行面。

### 2. 装插件

在仓库根执行（相对路径会被锚定到调用目录）：

```powershell
dsh plugin --profile desktop add ./packages/dsh-plugin
```

也可以给绝对路径。这条命令把参数转发给 profile 目录里的 pnpm，随后宿主按**已安装状态**把 `aylens-dsh` 追加进 profile `package.json` 的 `dsh.profile.bundles`（bundle 的 patch 在包内，靠这个列表生效）。

### 3. 配置凭据

**API Key 只走环境变量。** 桌面版与 CLI 一样在启动时调用 `loadLayeredEnv`，读取顺序是：

```text
继承的进程环境  >  <cwd>/.env  >  $DSH_HOME/.env
```

因此写 `%USERPROFILE%\.dsh\.env`（即 `$DSH_HOME/.env`）即可：

```text
AYLENS_API_KEY=<config/aylens.yaml 的 auth.apiKey>
AYLENS_BASE_URL=http://127.0.0.1:3000
```

两点务必注意：

- **不要写成带 BOM 的 UTF-8**。BOM 会让首个键变成 `\ufeffAYLENS_API_KEY`，解析器认不出来。（PowerShell 5 的 `Set-Content -Encoding UTF8` 会带 BOM。）
- **不要把密钥写进 `cordis.patch.yml`**。那个文件会被 `dsh-config-manager` 重写，也会随配置同步/备份链路离开本机。

非密配置写在插件自己的 patch 行里（`packages/dsh-plugin/dsh/cordis.patch.yml`）：

```yaml
config:
  baseUrl: http://127.0.0.1:3000
  requestTimeoutMs: 120000
  allowAuthLogin: false     # 想让 aylens_login 可用时改成 true
```

优先级是 `config` 段 → 环境变量 → 内置默认值。缺 API Key 时**不会在激活期抛错**——那会让整个插件层失效、4 个工具集体消失，比单次调用失败难诊断得多；错误留给每次工具调用，并给出可操作的指引。

### 4. 重启宿主

`.env` 在**启动时**加载，所以改完凭据（或装/卸插件）需要完全退出并重启 DeepSeek Harness 桌面版。重启后新会话里应能看到 4 个 `aylens_*` 工具。

### 更新

因为安装用的是 `link:`，改完源码重建即可，无需重装：

```bash
pnpm build:dsh-plugin
```

宿主进程不会热替换已加载的模块，**重建后仍需重启才会生效**。

### 卸载与回滚

```powershell
dsh plugin --profile desktop remove aylens-dsh          # 装回时也会自动从 bundles 列表移除
Remove-Item "$env:USERPROFILE\.dsh\.env"                # 撤销凭据（若该文件原本不存在）
```

## 开发与验收

```bash
pnpm test:bridge-core        # 共享核心：client / operations / render / capabilities
pnpm test:dsh-plugin         # 插件：配置解析与 4 个工具的行为
pnpm build:dsh-plugin        # 打包出 dsh/index.mjs（@deepseek-ai/* 保持 external）
pnpm smoke:dsh-plugin        # 临时 profile 里真装一次并确认进了层栈
pnpm test                    # 根套件，含 test/dsh-plugin-contract.test.ts 与 VCP 侧契约测试
```

真实检索冒烟（需要 Gateway 与 Runner 在线，且带上 API Key）：

```powershell
$env:AYLENS_SMOKE="1"; $env:AYLENS_API_KEY="dev-key"; pnpm smoke:dsh-plugin
```

**顺序纪律：先 build 再 test。** `test/dsh-plugin-contract.test.ts` 与 `test/vcp-plugin-contract.test.ts` 都刻意只读**已构建产物**——漏了重建，测试会和产物一起停在旧状态，绿得毫无意义。

冒烟脚本自建临时 `DSH_HOME`，**不会碰 `~/.dsh/profiles/desktop`**。

## 故障排查

| 症状 | 原因与处置 |
| --- | --- |
| 4 个工具根本没出现 | 按序查三件事：① `dsh/index.mjs` 是否构建过（`pnpm build:dsh-plugin`）；② `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有没有 `aylens-dsh`；③ 宿主日志里有没有 `@deepseek-ai/dsh-tools` 解析错误。**先别怀疑业务代码。** |
| 工具出现但报 `CONFIG_ERROR` | `$DSH_HOME/.env` 没被读到，或**改完没重启宿主**。注意运行中的进程是在启动那一刻读的 `.env`。 |
| 报 `NO_RUNTIME` | 没有在线 Runner。`aylens_inspect` `{scope:"runtimes"}` 看执行面；这**不是**查无结果。 |
| 报 `GATEWAY_UNREACHABLE` / `TIMEOUT` | Gateway 没起、`baseUrl` 不对，或命中浏览器兜底需要调大 `requestTimeoutMs`。 |
| 检索总是空结果 | 先 `aylens_inspect` `{scope:"providers"}` 看该 Provider 的 `enabled` 与**真实可用操作**（能力来自 Runner 心跳上报，旧 Runner 会显示「未上报」而不是谎报支持）。注意 API 渠道默认可能是停止状态。 |
| `aylens_extract` 报来源不支持 | 只有 `tavily` / `exa` / `anysearch` 提供 extract；`url-fetch` 与 `x-search` 没有。 |
| `aylens_login` 被拒 | 默认关闭。把 patch 行的 `allowAuthLogin` 改成 `true`；`confirm` 必须与 `providerId` 完全相同。 |
| 改了描述但模型还按旧的填参 | 描述与参数契约都来自**已构建产物**。重建两侧并重启宿主。 |

## 与内置检索的关系

DSH 自带 `web_search` / `web_fetch`。`aylens_search` 的描述里写明了它覆盖内置检索覆盖不到的场景——需要登录态的站点检索（如 X）、已知 URL 的浏览器兜底抓取、Tavily / Exa / AnySearch 多源汇集与 API Key 池调度。纯公开网页的普通查资料用内置的更省。

这段说明是刻意写进工具描述的：不写，模型默认会用内置检索，本插件等于形同虚设——与 VCP 侧「渠道实现了但描述没点名，模型不知道它存在」是同一种失败形状。
