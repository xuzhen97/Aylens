import type { BrowserContext } from "playwright-core";

export interface BrowserSession {
  profileId: string;
  context: BrowserContext;
}

export interface BrowserHost {
  withProfile<T>(
    profileId: string,
    jobId: string,
    callback: (session: BrowserSession) => Promise<T>,
    /** 可选取消信号：任务被放弃或超时时，不得再进入 callback，且必须释放 Profile 租约。 */
    options?: { signal?: AbortSignal | undefined },
  ): Promise<T>;

  /**
   * 在交互式 Profile 中打开真实浏览器页面。支持时应避免先建立自动化连接，
   * 让密码、2FA、OAuth 等人工登录流程直接发生在普通浏览器窗口中。
   */
  openInteractive?(
    profileId: string,
    jobId: string,
    url: string,
  ): Promise<void>;

  close(): Promise<void>;
}
