// node scripts/preview.mjs -> http://localhost:4174 : runs every registry player inside the real sandbox bridge.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".md": "text/plain" };
const ALLOWED = ["harness", "players", "spec"];

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") url = "/harness/preview.html";
  const f = path.resolve(root, "." + url);
  const top = path.relative(root, f).split(path.sep)[0];
  const ok = (ALLOWED.includes(top) || path.relative(root, f) === "players-registry.json") && f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile();
  if (!ok) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", TYPES[path.extname(f)] || "application/octet-stream");
  res.setHeader("access-control-allow-origin", "*");
  res.end(fs.readFileSync(f));
}).listen(4174, "127.0.0.1", () => console.log("Preview: http://localhost:4174"));
