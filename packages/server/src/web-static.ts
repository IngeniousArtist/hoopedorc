import fastifyStatic from "@fastify/static";
import { WS_PATH } from "@orc/types";
import type { FastifyInstance } from "fastify";

/**
 * Register the prebuilt web app and preserve JSON 404s for API/WebSocket
 * paths instead of letting the SPA fallback turn them into index.html.
 */
export async function registerBuiltWebApp(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? "";
    const isApiOrWs =
      url.startsWith("/api/") || url === WS_PATH || url.startsWith(`${WS_PATH}?`);
    if (isApiOrWs) return reply.code(404).send({ error: "not found" });
    return reply.type("text/html").sendFile("index.html");
  });
}
