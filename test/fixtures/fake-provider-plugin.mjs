export default {
  name: "fixture-provider-plugin",
  version: "1.0.0",
  factories: [
    {
      type: "fixture-remote",
      // 插件加载器要求显式声明能力;fixture 只实现 search。
      capabilities: ["search"],
      authControl: true,
      create(id, _config, services) {
        return {
          id,
          async checkAuth() {
            const state = {
              status: "authenticated",
              account: { handle: "@fixture", displayName: "Fixture User" },
              checkedAt: Date.now(),
            };
            services.reportAuthState?.(state);
            return state;
          },
          async openLogin() {
            const state = {
              status: "auth_required",
              checkedAt: Date.now(),
            };
            services.reportAuthState?.(state);
            return state;
          },
          async search(context, request) {
            return {
              items: [
                {
                  id: "fixture-doc",
                  platform: "fixture",
                  type: "webpage",
                  url: "https://example.test/result",
                  title: request.query,
                  retrievedAt: new Date().toISOString(),
                  provenance: {
                    provider: id,
                    retrievalMethod: "fixture_plugin",
                    requestId: context.requestId,
                    fetchedAt: new Date().toISOString(),
                    runtimeId: context.runtimeId,
                  },
                  extensions: {
                    transportCount: services.transports.list().length,
                    jobId: context.jobId,
                  },
                },
              ],
            };
          },
        };
      },
    },
  ],
};
