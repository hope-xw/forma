import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ComponentLibrary } from "../domain/library-schema";
const PUBLISH_ADDR_KEY = "forma.library-publish-url";
export function PublishLibrary({ library }: { library: ComponentLibrary }) {
  const [address, setAddress] = useState(() => {
      try {
        return localStorage.getItem(PUBLISH_ADDR_KEY) ?? "";
      } catch {
        return "";
      }
    }),
    [token, setToken] = useState(""),
    [url, setUrl] = useState(""),
    [notice, setNotice] = useState(""),
    [copied, setCopied] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function publish() {
    setBusy(true);
    setError("");
    setNotice("");
    setUrl("");
    try {
      const trimmed = address.trim();
      if (trimmed) {
        try {
          localStorage.setItem(PUBLISH_ADDR_KEY, trimmed);
        } catch {
          /* ignore storage quota errors */
        }
      }
      const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(
        location.hostname,
      );
      const endpointBase =
        trimmed ||
        (window.formaDesktop
          ? await window.formaDesktop.localLibraryAddress()
          : localHost
            ? location.origin
            : "");
      if (!endpointBase) throw Error("填写团队的组件库发布服务地址");
      const base = new URL(endpointBase);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password
      )
        throw Error("请输入 HTTP 或 HTTPS 服务地址");
      if (
        token &&
        base.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )
        throw Error("发布凭证需要 HTTPS 或本机服务");
      const endpoint = new URL(
        base.pathname.replace(/\/$/, "") +
          "/libraries/" +
          encodeURIComponent(library.id),
        base,
      ).href;
      const signal = AbortSignal.timeout(20000);
      const head = await fetch(endpoint, {
        method: "GET",
        credentials: "omit",
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!head.ok && head.status !== 404)
        throw Error("读取远端版本失败 · " + head.status);
      const tag = head.headers.get("etag");
      if (head.ok) {
        const previous = await head.json();
        if (previous.id !== library.id) throw Error("地址属于其他组件库");
        if (JSON.stringify(previous) === JSON.stringify(library)) {
          setUrl(endpoint);
          setNotice("远端已是相同快照 r" + library.revision);
          return;
        }
        if (previous.revision >= library.revision)
          throw Error("远端已有相同或更高修订，发布已停止");
        if (!tag) throw Error("发布服务未返回版本标识 ETag");
      }
      const response = await fetch(endpoint, {
        method: "PUT",
        signal,
        redirect: "error",
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(head.ok ? { "If-Match": tag! } : { "If-None-Match": "*" }),
        },
        body: JSON.stringify(library),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error ?? "发布失败 · " + response.status);
      }
      setUrl(endpoint);
      setNotice("已发布修订 r" + library.revision);
    } catch (err) {
      setError(
        err instanceof TypeError
          ? "无法连接发布服务，请检查服务地址和允许的编辑器来源"
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusy(false);
    }
  }
  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore clipboard deny */
    }
  }
  return (
    <details className="advanced-properties publish-library">
      <summary>发布组件库</summary>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void publish();
        }}
      >
        <label>
          发布服务
          <input
            aria-label="组件库发布服务"
            type="url"
            placeholder="本机服务或团队 HTTPS 地址"
            value={address}
            onChange={(ev) => setAddress(ev.target.value)}
          />
        </label>
        <label>
          发布凭证
          <input
            aria-label="组件库发布凭证"
            type="password"
            placeholder="可选"
            autoComplete="off"
            value={token}
            onChange={(ev) => setToken(ev.target.value)}
          />
        </label>
        <button className="primary wide" disabled={busy}>
          {busy ? "发布中…" : "发布修订 r" + library.revision}
        </button>
      </form>
      {notice && (
        <small style={{ color: "var(--figma-green)", display: "block" }}>
          {notice}
        </small>
      )}
      {!!url && (
        <label>
          {["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
            ? "本机订阅地址"
            : "团队订阅地址"}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              aria-label="可分享的订阅地址"
              readOnly
              value={url}
              style={{ flex: 1, minWidth: 0 }}
              onFocus={(ev) => ev.currentTarget.select()}
            />
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="复制订阅地址"
              data-tip={copied ? "已复制" : "复制订阅地址"}
              onClick={() => void copyUrl()}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </label>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
