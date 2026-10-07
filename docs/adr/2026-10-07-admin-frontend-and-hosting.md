# 独立 Admin 前端工程与 Gateway 同源托管

- Status: Accepted
- Date: 2026-10-07

## Context

Aylens Admin 原先由 Gateway 中的 TypeScript 字符串模板生成 HTML、CSS 与浏览器脚本。随着页面和交互增加，这种方式不利于组件复用、前端类型检查及交互测试。后台需要独立的前端工程边界，但当前没有独立管理服务或独立部署的需求。

## Decision

在同一仓库的 `apps/admin/` 中维护独立 Admin 前端工程，采用 React、Vite、TypeScript 和 React Router。UI 使用 shadcn/ui 与 Tailwind CSS，图标使用 lucide-react；按需引入组件源码，以自定义 Hooks 和必要的 Context 管理状态，不默认引入大型后台框架或全局状态库。

开发时前端独立启动，通过开发代理访问 Gateway。生产构建产物随 Gateway 发布，置于 `release/gateway/admin/`，由 Gateway 在 `/admin` 同源托管，不新增前端运行服务，不开放宽松跨源凭据访问。

基础 UI 组件与业务逻辑分离；优先通过主题 Token 和组件组合定制界面，避免深度修改基础组件。Admin 不导入 Gateway 运行时代码或服务端配置。

## Consequences

- 前端获得独立开发、构建、类型检查和组件测试能力，页面不再依赖服务端字符串拼接。
- 生产部署仍是单个 Gateway 服务，避免增加独立域名、跨域认证及额外服务运维成本；前端生产发布与 Gateway 发布耦合。
- Gateway-only 和完整发布构建必须包含前端产物；Runner/Provider 的独立构建不依赖前端。复制 Gateway 发布目录到源码仓库之外必须仍能提供后台。
- Gateway 托管负责 Admin 子路由回退、静态缓存、安全响应头及路径穿越防护；API 与缺失静态资源不得错误回退为 SPA HTML。缺失前端产物不得阻断业务 API。
- shadcn/ui 生成的组件源码由项目负责维护，依赖升级不会自动更新这些组件。保留可访问性与标准组件行为，减少定制维护负担。
- Tailwind 样式构建为外置 CSS。所选交互组件必须在生产 CSP 下验证；运行时样式需求不能成为静默放宽 CSP 的理由，必要调整需另行审核。脚本和网络来源保持同源限制。
- 工程拆分不是权限隔离；认证与接口授权由 Gateway 独立负责。

## Alternatives considered

- **保留 Gateway 字符串模板**：无需新增前端构建，但页面与脚本维护、组件复用和交互测试成本持续增长，不满足本次维护目标。
- **独立部署前端**：允许单独发布，但需要额外部署与代理/跨域安排；当前不需要这一运维边界。
- **拆出独立管理后端服务**：能建立更独立的管理服务边界，但增加接口和服务运维成本，超出当前需求。
- **Ant Design 或 MUI 等完整 UI 库**：后台组件成熟，但用户选择 shadcn/ui 的简洁视觉与组件源码可控性，并接受相应维护责任。
