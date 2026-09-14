import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

// Last request headers seen per host and path (localhost and 127.0.0.1 both serve this site), so
// tests can check which requests carried a header. GET /__requests returns them.
const lastHeaders = {};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/__requests") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastHeaders));
    return;
  }
  (lastHeaders[req.headers.host ?? ""] ??= {})[url.pathname] = req.headers;
  // Redirects, for checking that audit headers follow same-origin hops and stay off cross-origin ones.
  if (url.pathname === "/__redirect-home") {
    res.writeHead(302, { location: "/" });
    res.end();
    return;
  }
  if (url.pathname === "/__redirect-partner") {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/partner.html` });
    res.end();
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`demo site on http://localhost:${port}`));
