import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GatewayContext } from "../../app/context.js";
import { AdminHttpError } from "./admin-security.js";
import { RetrievalError } from "../../core/errors.js";
import { ProxyConfigError } from "../../runner/proxy-config-service.js";
import { CredentialConfigError } from "../../runner/credentials/service.js";
import {
  credentialOperationTarget,
  credentialWriteSchema,
} from "../../runtime/credential-config-contract.js";

/**
 * Runner API 凭据的管理端点。
 *
 * 与代理配置同一套安全语义：管理会话/Bearer 认证、在线写入、版本冲突 409、
 * 断线回执超时视为“结果待确认”。Gateway 只短暂转发 secret，不持久化、
 * 不回显、不写日志或审计。
 */
export function registerRunnerCredentialRoutes(
  app: FastifyInstance,
  context: GatewayContext,
): void {
  app.get<{ Params: { runnerId: string } }>(
    "/v1/admin/runners/:runnerId/credentials",
    async (request) => {
      const { runnerId } = request.params;
      try {
        return await context.configChannel.request(runnerId, { resource: "credentials", kind: "read" });
      } catch (error) {
        throw toAdminError(error);
      }
    },
  );

  app.post<{ Params: { runnerId: string } }>(
    "/v1/admin/runners/:runnerId/credentials",
    async (request) => {
      const { runnerId } = request.params;

      // 严格 schema 校验：无效输入返回固定消息，不回显请求内容（可能含 secret）。
      const parsed = credentialWriteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AdminHttpError(400, "INVALID_REQUEST", "Credential config mutation is invalid");
      }
      const write = parsed.data;

      // 先记录安全操作意图；失败不发出写入。target 只有 ID，绝不含 secret。
      try {
        context.configOperations.record({
          operationId: write.operationId,
          runnerId,
          target: credentialOperationTarget(write.mutation),
          kind: write.mutation.kind,
          createdAt: Date.now(),
          status: "pending",
        });
      } catch {
        throw new AdminHttpError(503, "CONFIG_RESULT_UNKNOWN", "Config operation audit is unavailable");
      }

      try {
        const result = await context.configChannel.request(runnerId, {
          resource: "credentials",
          kind: "write",
          write,
        });
        try {
          context.configOperations.record({
            operationId: write.operationId,
            runnerId,
            target: credentialOperationTarget(write.mutation),
            kind: write.mutation.kind,
            createdAt: Date.now(),
            status: "succeeded",
          });
        } catch {
          // 完成审计写入失败：结果无法确认，不能诱导重发已成功的写入。
          throw new AdminHttpError(503, "CONFIG_RESULT_UNKNOWN", "Config write result could not be confirmed");
        }
        return result;
      } catch (error) {
        // 明确失败记录 failed；待确认保持 pending，让界面去重新读取核对。
        if (error instanceof RetrievalError && error.code !== "CONFIG_RESULT_UNKNOWN") {
          try {
            context.configOperations.record({
              operationId: write.operationId,
              runnerId,
              target: credentialOperationTarget(write.mutation),
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

  if (error instanceof CredentialConfigError || error instanceof ProxyConfigError) {
    if (error.code === "CONFIG_VERSION_CONFLICT" || error.code === "CONFIG_IN_USE") {
      return new AdminHttpError(409, error.code, error.message);
    }
    return new AdminHttpError(400, error.code, error.message);
  }

  if (error instanceof RetrievalError) {
    if (error.code === "CONFIG_VERSION_CONFLICT" || error.code === "CONFIG_IN_USE") {
      return new AdminHttpError(409, error.code, error.message);
    }
    if (
      error.code === "RUNTIME_OFFLINE"
      || error.code === "CONFIG_UNSUPPORTED"
      || error.code === "CONFIG_RESULT_UNKNOWN"
      || error.code === "CONFIG_TIMEOUT"
    ) {
      return new AdminHttpError(503, error.code, error.message);
    }
    return new AdminHttpError(503, error.code, error.message);
  }

  // 原始 Error 不进入响应或日志展开：其中可能含 secret 或上游原文。
  return new AdminHttpError(503, "INTERNAL_ERROR", "Credential config request failed");
}
