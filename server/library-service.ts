import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseLibrary } from "../src/domain/library-schema";

type Options = { directory: string; origins: string[]; writeToken?: string };
const digest = (text: string) => createHash("sha256").update(text).digest();
async function readBody(req: IncomingMessage) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw Error("组件库超过 32 MB");
    parts.push(chunk);
  }
  return parseLibrary(JSON.parse(Buffer.concat(parts).toString("utf8")));
}
/** The revision check and atomic rename occur in one synchronous section after request parsing. */
export function libraryRequest(options: Options) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !options.origins.includes(origin)) {
        send(403, { error: "此编辑器来源未启用" });
        return;
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Expose-Headers", "ETag");
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, If-Match, If-None-Match",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET, HEAD, PUT, OPTIONS",
        );
        res.writeHead(204);
        res.end();
        return;
      }
      const match = /^\/libraries\/([^/?#]+)$/.exec(req.url ?? "");
      if (!match) {
        send(404, { error: "组件库地址不存在" });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const filename = path.join(
        options.directory,
        digest(id).toString("hex") + ".json",
      );
      const method = req.method;
      if (!["GET", "HEAD", "PUT"].includes(method ?? "")) {
        send(405, { error: "不支持此方法" });
        return;
      }
      if (method === "PUT") {
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          send(415, { error: "需要 JSON 组件库" });
          return;
        }
        if (
          options.writeToken &&
          !timingSafeEqual(
            digest(req.headers.authorization ?? ""),
            digest("Bearer " + options.writeToken),
          )
        ) {
          send(403, { error: "发布凭证无效" });
          return;
        }
        if (!options.writeToken && !origin) {
          send(403, { error: "本地发布需要已启用的编辑器来源" });
          return;
        }
      }
      const incoming = method === "PUT" ? await readBody(req) : undefined;
      let current: string | undefined;
      try {
        current = readFileSync(filename, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const etag = current
        ? '"' + digest(current).toString("hex") + '"'
        : undefined;
      if (!incoming) {
        if (!current) {
          send(404, { error: "组件库尚未发布" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-cache",
          ETag: etag!,
        });
        res.end(method === "HEAD" ? undefined : current);
        return;
      }
      if (incoming.id !== id) {
        send(409, { error: "发布地址与组件库 ID 不一致" });
        return;
      }
      if (
        current
          ? req.headers["if-match"] !== etag
          : req.headers["if-none-match"] !== "*"
      ) {
        send(412, { error: "远端版本已经改变，请重新比较" });
        return;
      }
      if (current && incoming.revision <= JSON.parse(current).revision) {
        send(409, { error: "请先修改主组件以生成新修订" });
        return;
      }
      const bytes = JSON.stringify(incoming);
      mkdirSync(options.directory, { recursive: true });
      const tmp = filename + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(tmp, bytes, { mode: 0o600, flag: "wx" });
        renameSync(tmp, filename);
      } finally {
        rmSync(tmp, { force: true });
      }
      res.setHeader("ETag", '"' + digest(bytes).toString("hex") + '"');
      send(current ? 200 : 201, { id, revision: incoming.revision });
    } catch (err) {
      send(400, {
        error: err instanceof Error ? err.message : "组件库请求失败",
      });
    }
  };
}
export function libraryServer(options: Options) {
  return createServer(libraryRequest(options));
}
export function localLibraryDirectory() {
  const base =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? homedir())
        : (process.env.XDG_DATA_HOME ??
          path.join(homedir(), ".local", "share"));
  return path.join(base, "Forma", "published-libraries");
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const host = process.env.FORMA_LIBRARY_HOST ?? "127.0.0.1",
    port = Number(process.env.FORMA_LIBRARY_PORT ?? 5181);
  const writeToken = process.env.FORMA_LIBRARY_WRITE_TOKEN;
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !writeToken)
    throw Error("对外发布需要设置 FORMA_LIBRARY_WRITE_TOKEN");
  const origins = (
    process.env.FORMA_LIBRARY_ORIGINS ??
    "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173,forma://app"
  ).split(",");
  libraryServer({
    directory: process.env.FORMA_LIBRARY_DIRECTORY ?? localLibraryDirectory(),
    writeToken,
    origins,
  }).listen(port, host, () =>
    console.log("Forma 组件库服务 http://" + host + ":" + port),
  );
}
