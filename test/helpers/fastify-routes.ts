/**
 * 解析 Fastify `printRoutes({ commonPrefix: false })` 的树形输出。
 *
 * 存在的理由：这个仓库反复出现「必须手工同步的硬编码白名单」
 * （ADMIN_PAGES、capabilitiesSchema、COOKIE_AUTH_ROUTES），
 * 漏一处的信号永远是运行时故障。有了路由枚举，就能写覆盖守卫把它变成测试失败。
 */
export interface RegisteredRoute {
  method: string;
  url: string;
}

const METHOD_LIST = /^(.*?)\s*\(([A-Z, ]+)\)$/;

export function collectRegisteredRoutes(tree: string): RegisteredRoute[] {
  const stack: Array<{ depth: number; path: string }> = [];
  const routes: RegisteredRoute[] = [];

  for (const line of tree.split("\n")) {
    if (!line.trim()) continue;

    // 缩进由每 4 字符一组的树枝/空白构成；去掉它们后剩下的才是本行内容。
    const branch = /^((?:[│ ]   )*)(?:├── |└── )?(.*)$/.exec(line);
    if (!branch) continue;
    const depth = (branch[1] ?? "").length / 4;
    const content = (branch[2] ?? "").trim();
    if (!content) continue;

    const parsed = METHOD_LIST.exec(content);
    const segment = (parsed?.[1] ?? content).trim();

    // 弹出比当前深度更深的节点，父路径即为栈顶。
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
    const parentPath = stack.length > 0 ? (stack[stack.length - 1] as { path: string }).path : "";
    const path = joinPath(parentPath, segment);
    stack.push({ depth, path });

    if (!parsed) continue;
    for (const method of (parsed[2] ?? "").split(",").map((value) => value.trim())) {
      // Fastify 会自动补 HEAD，枚举时忽略，否则每个 GET 都会多出一条。
      if (method !== "GET" && method !== "POST") continue;
      routes.push({ method, url: path });
    }
  }

  return routes;
}

function joinPath(parent: string, segment: string): string {
  if (!parent) return segment;
  if (!segment) return parent;
  if (segment.startsWith("/")) return `${parent}${segment}`;
  return parent.endsWith("/") ? `${parent}${segment}` : `${parent}/${segment}`;
}
