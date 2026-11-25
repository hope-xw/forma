import { parseLibrary } from "../domain/library-schema";

export type Subscription = { id: string; url: string; name: string };
const key = (doc: string) => "forma-library-links:" + doc;

export function subscriptions(doc: string): Subscription[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key(doc)) ?? "[]");
    return Array.isArray(data)
      ? data.filter(
          (s) =>
            s &&
            typeof s.id === "string" &&
            typeof s.url === "string" &&
            typeof s.name === "string",
        )
      : [];
  } catch {
    return [];
  }
}
export function saveSubscription(doc: string, id: string, link?: Subscription) {
  const next = subscriptions(doc).filter((s) => s.id !== id);
  if (link) next.push(link);
  localStorage.setItem(key(doc), JSON.stringify(next));
  return next;
}
export async function fetchLibrary(address: string, signal: AbortSignal) {
  const url = new URL(address);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("请输入 HTTP 或 HTTPS 组件库地址");
  const response = await fetch(url, {
    credentials: "omit",
    cache: "no-cache",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok || !response.body)
    throw Error("组件库服务器返回 " + response.status);
  const limit = 32 * 1024 * 1024;
  const reader = response.body.getReader();
  let length = 0;
  const decoder = new TextDecoder(),
    chunks: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw Error("组件库超过 32 MB");
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return parseLibrary(JSON.parse(chunks.join("")));
}
