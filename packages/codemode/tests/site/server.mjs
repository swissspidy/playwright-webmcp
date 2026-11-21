import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 4175);

createServer(async (req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
  } catch {
    // A malformed escape such as "/%" must not take the server down.
    res.writeHead(400);
    res.end("bad request");
    return;
  }
  if (path.endsWith("/")) path += "index.html";
  if (!path.endsWith(".html") && !path.endsWith(".js")) path += ".html";
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, () => console.log(`codemode test site on http://localhost:${port}`));
