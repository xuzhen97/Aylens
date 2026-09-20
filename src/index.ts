import { createGatewayContext } from "./app/context.js";
import { buildHttpServer } from "./api/http/server.js";
import { loadConfig } from "./config/loader.js";

const config = await loadConfig();
const context = createGatewayContext(config);
const app = buildHttpServer(context);

await app.listen({ host: config.server.host, port: config.server.port });
