/**
 * VCP 侧的客户端出口。
 *
 * 真正的实现已迁到 `packages/bridge-core`（两个宿主共用）。这里只做再导出，
 * 让本包内既有的 `../client.js` 引用路径与调用形态保持不变。
 */
export {
	AylensBridgeError,
	AylensClient,
	type AylensErrorCode,
	type BridgeConfig,
} from "../../bridge-core/src/client.js";
