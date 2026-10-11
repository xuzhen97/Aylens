import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { GatewayContext } from "../../app/context.js";
import { ProviderNotFoundError } from "../../providers/provider-setting-service.js";
import { AdminHttpError } from "./admin-security.js";

export const providerEnabledBodySchema = z.object({
  mode: z.enum(["enabled", "disabled", "config"]),
});

/**
 * Provider 启用态写入的唯一入口。
 *
 * 鉴权由 server.ts 的 preHandler 统一处理；本路由只在 COOKIE_AUTH_ROUTES
 * 白名单登记后才会接受管理会话 Cookie。
 */
export function registerProviderEnabledRoutes(app: FastifyInstance, context: GatewayContext): void {
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/enabled",
    async (request) => {
      const { mode } = providerEnabledBodySchema.parse(request.body);
      try {
        const state = context.providerSettings.setMode(request.params.providerId, mode);
        // 控制面变更留结构化日志；本决策不建事件审计表（见 ADR 后果节）。
        request.log.info(
          { providerId: state.providerId, enabled: state.enabled, enabledMode: state.enabledMode },
          "provider enablement changed",
        );
        return state;
      } catch (error) {
        if (error instanceof ProviderNotFoundError) {
          throw new AdminHttpError(404, "PROVIDER_NOT_FOUND", error.message);
        }
        throw error;
      }
    },
  );
}
