/**
 * A small static server for the built site in apps/site/dist/, for the browser tests and
 * tools/face/still.ts. (`astro preview` runs itself in the background when a script starts it, so
 * the script can't stop it afterwards.)
 *
 *   node tools/serve.ts 4330    serves until stopped
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "../apps/site/dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function serveSite(port: number): Promise<Server> {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    // normalize() resolves "..", and the prefix check keeps requests inside dist/.
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST)) {
      response.writeHead(403).end();
      return;
    }
    if (path.endsWith("/")) file = join(file, "index.html");
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 4330);
  await serveSite(port);
  console.log(`Serving apps/site/dist at http://localhost:${port}`);
}
