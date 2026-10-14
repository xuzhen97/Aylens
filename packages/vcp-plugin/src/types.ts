/**
 * VCPToolBox synchronous stdio 协议结构。
 *
 * 契约来源：VCPToolBox/Plugin.js
 * - stdin 收到一个 JSON 字符串（ToolCallParser 序列化后的字段扁平对象）；
 * - 同步插件在进程 exit 时用 `JSON.parse(stdout.trim())` 解析**整个** stdout，
 *   因此 stdout 只允许出现这一个 JSON，任何日志必须走 stderr；
 * - `status` 只认 "success" / "error"。
 *
 * 这三个类型是 VCP **专属**的协议载体，不进共享核心。
 */

export interface VcpRequest {
  command: string;
  params?: Record<string, unknown>;
  maid?: string;
  [key: string]: unknown;
}

export type VcpContentItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface VcpResponse {
  status: "success" | "error";
  result?: {
    content: VcpContentItem[];
    messageForAI?: string;
  };
  content?: VcpContentItem[];
  messageForAI?: string;
  error?: string;
}

/**
 * 配置形状现由共享核心定义（两个宿主的配置语义必须一致）。
 * 这里保留 `PluginConfig` 这个名字，免得改动调用点。
 */
export type { BridgeConfig as PluginConfig } from "../../bridge-core/src/client.js";
