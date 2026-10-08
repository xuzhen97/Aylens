/**
 * VCPToolBox synchronous stdio 协议结构。
 *
 * 契约来源：VCPToolBox/Plugin.js
 * - stdin 收到一个 JSON 字符串（ToolCallParser 序列化后的字段扁平对象）；
 * - 同步插件在进程 exit 时用 `JSON.parse(stdout.trim())` 解析**整个** stdout，
 *   因此 stdout 只允许出现这一个 JSON，任何日志必须走 stderr；
 * - `status` 只认 "success" / "error"。
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

export interface PluginConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs: number;
  /** 是否允许 LoginProviderAuth。默认 false：该命令会在 Runner 上拉起可见 Chrome。 */
  allowAuthLogin: boolean;
}
