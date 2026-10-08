import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { AdminHttpError } from "./admin-security.js";
import { proxyWriteSchema } from "../../runtime/proxy-config-contract.js";
import { ProxyConfigError } from "../../runner/proxy-config-service.js";
import { RetrievalError } from "../../core/errors.js";

/** 配置操作的目标只允许代理 ID 或 Provider ID,禁止地址或 mutation JSON 进入操作表。 */
function operationTarget(mutation: z.infer<typeof proxyWriteSchema>["mutation"]): string {
  if (mutation.kind === "bind") return mutation.providerId;
  return mutation.id;
}

export function registerRunnerProxyRoutes(
  app: FastifyInstance,
  context: GatewayContext,
): void {
  app.get<{ Params: { runnerId: string } }>(
    "/v1/admin/runners/:runnerId/proxy-config",
    async (request) => {
      const { runnerId } = request.params;
      try {
        return await context.configChannel.request(runnerId, { kind: "read" });
      } catch (error) {
        throw toAdminError(error);
      }
    },
  );

  app.post<{ Params: { runnerId: string } }>(
    "/v1/admin/runners/:runnerId/proxy-config",
    async (request) => {
      const { runnerId } = request.params;

      // 严格 schema 校验:无效输入返回固定消息,不回显请求内容。
      const parsed = proxyWriteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AdminHttpError(400, "INVALID_REQUEST", "Proxy config mutation is invalid");
      }
      const write = parsed.data;

      // 先记录安全操作意图;失败不发出写入。
      try {
        context.configOperations.record({
          operationId: write.operationId,
          runnerId,
          target: operationTarget(write.mutation),
          kind: write.mutation.kind,
          createdAt: Date.now(),
          status: "pending",
        });
      } catch {
        // 操作审计不可写时拒绝发出写入,避免产生无审计的秘密操作。
        throw new AdminHttpError(503, "CONFIG_RESULT_UNKNOWN", "Config operation audit is unavailable");
      }

      try {
        const result = await context.configChannel.request(runnerId, { kind: "write", write });
        try {
          context.configOperations.record({
            operationId: write.operationId,
            runnerId,
            target: operationTarget(write.mutation),
            kind: write.mutation.kind,
            createdAt: Date.now(),
            status: "succeeded",
          });
        } catch {
          // 完成审计写入失败:结果无法确认,不能诱导重发已成功的写入。
          throw new AdminHttpError(503, "CONFIG_RESULT_UNKNOWN", "Config write result could not be confirmed");
        }
        return result;
      } catch (error) {
        // 明确失败(版本冲突/无效/被引用等)记录 failed;待确认保持 pending。
        if (error instanceof RetrievalError && error.code !== "CONFIG_RESULT_UNKNOWN") {
          try {
            context.configOperations.record({
              operationId: write.operationId,
              runnerId,
              target: operationTarget(write.mutation),
              kind: write.mutation.kind,
              createdAt: Date.now(),
              status: "failed",
            });
          } catch { /* 审计故障已在下方暴露 */ }
        }
        throw toAdminError(error);
      }
    },
  );
}

function toAdminError(error: unknown): AdminHttpError {
  if (error instanceof AdminHttpError) return error;

  if (error instanceof ProxyConfigError) {
    if (error.code === "CONFIG_VERSION_CONFLICT" || error.code === "CONFIG_IN_USE") {
      return new AdminHttpError(409, error.code, error.message);
    }
    return new AdminHttpError(400, error.code, error.message);
  }

  if (error instanceof RetrievalError) {
    if (error.code === "CONFIG_VERSION_CONFLICT" || error.code === "CONFIG_IN_USE") {
      return new AdminHttpError(409, error.code, error.message);
    }
    if (error.code === "RUNTIME_OFFLINE") {
      return new AdminHttpError(503, error.code, error.message);
    }
    if (error.code === "CONFIG_UNSUPPORTED") {
      return new AdminHttpError(503, error.code, error.message);
    }
    if (error.code === "CONFIG_RESULT_UNKNOWN") {
      return new AdminHttpError(503, error.code, error.message);
    }
    if (error.code === "CONFIG_TIMEOUT") {
      return new AdminHttpError(503, error.code, error.message);
    }
    return new AdminHttpError(503, error.code, error.message);
  }

  // 原始 Error 不进入响应或日志展开。
  return new AdminHttpError(503, "INTERNAL_ERROR", "Proxy config request failed");
}
