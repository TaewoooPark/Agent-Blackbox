import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

export type DashboardServerOptions = {
  distDir: string;
  port?: number;
  daemonUrl: string;
};

export type RunningDashboardServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

// Serve the pre-built dashboard as static files, injecting the daemon URL at
// runtime so a single `up` command works on any port without rebuilding.
export async function startDashboardServer(options: DashboardServerOptions): Promise<RunningDashboardServer> {
  const indexPath = join(options.distDir, "index.html");
  let indexHtml: string;
  try {
    indexHtml = await readFile(indexPath, "utf8");
  } catch {
    throw new Error(`Dashboard build not found at ${options.distDir}. Run "npm run build" first.`);
  }
  const injected = indexHtml.replace(
    "</head>",
    `  <script>window.AGENT_BLACKBOX_DAEMON_URL=${JSON.stringify(options.daemonUrl)};</script>\n  </head>`
  );

  const server = createServer((request, response) => {
    const rawPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    if (rawPath === "/" || rawPath === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(injected);
      return;
    }
    const safePath = normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(options.distDir, safePath);
    if (!filePath.startsWith(options.distDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    void stat(filePath)
      .then((stats) => {
        if (!stats.isFile()) {
          throw new Error("not a file");
        }
        response.writeHead(200, { "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
        createReadStream(filePath).pipe(response);
      })
      .catch(() => {
        // SPA fallback so client routes resolve to the app shell.
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(injected);
      });
  });

  const port = options.port ?? 5173;
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
