export default {
  name: "fixture-provider-plugin",
  version: "1.0.0",
  factories: [
    {
      type: "fixture-remote",
      create(id, _config, services) {
        return {
          id,
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
