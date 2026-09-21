# Aylens 文档

根目录 README 只保留项目入口、快速启动、常用命令和文档导航。实现细节、运行手册和验收步骤放在本目录。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [getting-started.md](./getting-started.md) | 安装、最小启动、generic-browser 快速验证 |
| [configuration.md](./configuration.md) | Gateway / Runner 配置、环境变量、Runtime selector、Transport、Browser Profile |
| [runtime.md](./runtime.md) | Gateway / Runner 分布式执行、Transport、BrowserHost、Profile Lease |
| [providers.md](./providers.md) | ProviderFactory、Runner Plugin、generic-browser、如何添加新 Provider |
| [api.md](./api.md) | 当前 REST API、鉴权、MCP adapter 状态 |
| [admin-ui.md](./admin-ui.md) | 后台页面、主题、API Key、安全边界 |
| [operations.md](./operations.md) | Gateway / Windows Runner 启动、人工登录态验收、故障定位 |
| [testing.md](./testing.md) | 测试矩阵、typecheck/build、集成测试、真实 Chrome smoke test |

完整架构设计继续保留在根目录：

- [../ARCHITECTURE.md](../ARCHITECTURE.md)

## 推荐阅读顺序

第一次运行：

1. [getting-started.md](./getting-started.md)
2. [configuration.md](./configuration.md)
3. [operations.md](./operations.md)

准备开发 Provider：

1. [runtime.md](./runtime.md)
2. [providers.md](./providers.md)
3. [../ARCHITECTURE.md](../ARCHITECTURE.md)

排查问题：

1. [operations.md](./operations.md)
2. [testing.md](./testing.md)
3. /admin 后台
