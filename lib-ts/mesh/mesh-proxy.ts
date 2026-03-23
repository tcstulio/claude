// Mesh API proxy — forwards mesh routes to localhost:3001
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const MESH_PORT = parseInt(process.env.MESH_PORT ?? "3001", 10);
const MESH_HOST = "127.0.0.1";

const MESH_PREFIXES = [
  "/api/ledger",
  "/api/economy",
  "/api/network/peers/public",
  "/api/network/trust",
  "/api/network/rank",
  "/api/network/crawl",
  "/api/network/query",
  "/api/network/relay",
  "/api/network/federation",
  "/api/infra",
  "/api/capabilities",
  "/api/knowledge",
  "/api/canary",
  "/api/org",
  "/api/local-tools",
  "/api/local-mcp",
  "/api/build-info",
  "/api/mesh",
];

export function isMeshRoute(path: string): boolean {
  return MESH_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?"));
}

export function proxyToMesh(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  const proxyReq = httpRequest(
    {
      hostname: MESH_HOST,
      port: MESH_PORT,
      path: url.pathname + url.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${MESH_HOST}:${MESH_PORT}`,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Mesh service unavailable (port " + MESH_PORT + ")" }));
  });

  req.pipe(proxyReq);
}
