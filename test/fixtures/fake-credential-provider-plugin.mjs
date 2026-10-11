/**
 * 复刻 API 凭据型 Provider 的 fail-closed 契约：拿不到凭据池就拒绝创建实例。
 *
 * 存在的意义是守住"Runner 真的把凭据接进了 Provider 上下文"这条装配线。
 *
 * 真实事故：`credentials` 曾经在 `src/runner/runner.ts` 组装 factory context 时漏传，
 * 而所有既有测试都**自己手搓**这个 context（把 poolForProvider 直接塞进去），
 * 于是 421 个测试全绿、实机却恒报 `PROVIDER_UNAVAILABLE: ... requires a runner credential pool`。
 *
 * 因此这个 fixture 只有走真实派发路径才有意义：它在 create() 阶段就拒绝，
 * 而 create() 正是 runner.ts 那条装配线的唯一消费者。
 */
export default {
  name: "fixture-credential-provider-plugin",
  version: "1.0.0",
  factories: [
    {
      type: "fixture-credential",
      capabilities: ["search"],
      create(id, _config, services) {
        if (!services.credentials) {
          throw new Error(`fixture-credential requires a runner credential pool: ${id}`);
        }
        return {
          id,
          async search(context, request) {
            const { poolId, pool } = services.credentials.poolForProvider(id);
            const lease = pool.acquire(poolId);
            let evidence;
            try {
              // 只回报"确实拿到了"这一事实：secret 绝不离开调用栈，
              // 更不允许进入 Gateway 可见的结果（该仓库的硬约束）。
              evidence = {
                poolId,
                credentialId: lease.credentialId,
                hadSecret: lease.secret.length > 0,
              };
            } finally {
              lease.release();
            }
            return {
              items: [
                {
                  id: "cred-doc",
                  platform: "fixture",
                  type: "webpage",
                  url: "https://example.test/cred",
                  title: request.query,
                  retrievedAt: new Date().toISOString(),
                  provenance: {
                    provider: id,
                    retrievalMethod: "fixture_credential",
                    requestId: context.requestId,
                    fetchedAt: new Date().toISOString(),
                    runtimeId: context.runtimeId,
                  },
                  extensions: evidence,
                },
              ],
            };
          },
        };
      },
    },
  ],
};
