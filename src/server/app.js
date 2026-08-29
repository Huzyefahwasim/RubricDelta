import { createServer } from "node:http";
import { responseHeaders, SECURITY_HEADERS } from "./headers.js";
import { createRouter, requestPathIsSafe, RequestError, serveStaticFile } from "./router.js";

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { ...responseHeaders("application/json; charset=utf-8"), ...extraHeaders });
  response.end(JSON.stringify(value));
}

export function createRubricDeltaApplication({ host, port, publicRoot, artifactRoot, dataService }) {
  let address = null;
  const route = createRouter({ artifactRoot, dataService });
  const httpServer = createServer(async (request, response) => {
    try {
      if (!requestPathIsSafe(request.url)) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
        return;
      }
      const url = new URL(request.url, "http://localhost");
      if (await route(request, response, url.pathname)) return;
      if (request.method === "GET" && await serveStaticFile({ publicRoot, requestUrl: request.url, response })) return;
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(response, error.status, error.body, error.status === 413 ? { Connection: "close" } : {});
        return;
      }
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
    }
  });

  httpServer.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.writableEnded) {
      socket.destroy();
      return;
    }
    const body = JSON.stringify({ error: { code: "BAD_REQUEST", message: "Invalid HTTP request" } });
    const headers = {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      Connection: "close",
    };
    const lines = ["HTTP/1.1 400 Bad Request", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", body];
    socket.end(lines.join("\r\n"));
  });

  return {
    async start() {
      if (address) return;
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const bound = httpServer.address();
      address = `http://${bound.address.includes(":") ? `[${bound.address}]` : bound.address}:${bound.port}`;
    },
    async stop() {
      if (!address) return;
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      address = null;
    },
    address() {
      return address;
    },
  };
}
