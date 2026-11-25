import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { crc32, inflateSync } from "node:zlib";
import {
  ALLOWED_IMAGE_HOSTS,
  CURATED_STOCK_CATALOG,
  MediaAssetRegistry,
  createProceduralBackdropAsset,
  localizeImageUrl,
  resolveMediaAssetsForHtml,
  searchStockImages,
} from "../src/agent/media-assets";
import { imageSchema } from "../src/domain/images";

const origin = "https://images.unsplash.com";
const limit = 1_572_864;
const callsForbidden: typeof fetch = async () => {
  assert.fail("unexpected fetch");
};
const idOf = (bytes: Buffer) =>
  "img-" + createHash("sha256").update(bytes).digest("hex");
const bytesOf = (data: string) => Buffer.from(data.split(",")[1], "base64");

// Real 13×7 PNG, progressive JPEG, lossy/lossless WebP and GIF files encoded with Pillow.
const fixtures = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAA0AAAAHCAIAAABcElBNAAAAFUlEQVR4nGP0MFRkIAIwEaNoGKkDALAjAKhevskuAAAAAElFTkSuQmCC",
  jpeg: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAHAA0DASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUAQEAAAAAAAAAAAAAAAAAAAAD/9oADAMBAAIQAxAAAAGaAt//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAEFAj//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAY/Aj//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/IT//2gAMAwEAAgADAAAAEAv/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAQ/9oACAEBAAE/ED//2Q==",
  webp: "UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoNAAcAAUAmJYwCdAFAAAD++HyzBskU3I8jnelRgAA=",
  lossless: "UklGRh4AAABXRUJQVlA4TBEAAAAvDIABAAfQmCI1pP+BiOh/AAA=",
  gif: "R0lGODdhDQAHAIEAAEgxIQAAAAAAAAAAACwAAAAADQAHAAAIEQABCBxIsKDBgwgTKlzIsGFAADs=",
};
const png = Buffer.from(fixtures.png, "base64");
const pngResponse = () => new Response(png);

test("the exact HTTPS allowlist rejects non-public targets before fetch", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return pngResponse();
  };
  for (const host of ALLOWED_IMAGE_HOSTS) {
    assert.equal(
      (
        await localizeImageUrl("https://" + host + "/stock", {
          fetchImpl,
          strict: true,
        })
      ).source,
      "network",
    );
  }
  const previous = calls;
  for (const host of [
    "localhost",
    "127.0.0.1",
    "[::1]",
    "0.0.0.0",
    "10.0.0.8",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "8.8.8.8",
    "2130706433",
    "[2001:db8::1]",
    "images.unsplash.com.example.org",
    "images.unsplash.com@localhost",
    "foo.images.unsplash.com",
    "images.unsplash.com:8080",
  ]) {
    await assert.rejects(
      localizeImageUrl("https://" + host + "/photo", {
        fetchImpl,
        strict: true,
      }),
    );
  }
  for (const url of [
    "file:///etc/hosts",
    "http://images.unsplash.com/x",
    "data:image/png;base64,AAAA",
    "//images.unsplash.com/x",
  ]) {
    await assert.rejects(localizeImageUrl(url, { fetchImpl, strict: true }));
  }
  assert.equal(calls, previous);
});

test("manual redirects revalidate the next location, and stop after three hops", async () => {
  const calls: string[] = [];
  const run = (locations: string[]) =>
    localizeImageUrl(origin + "/a", {
      strict: true,
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.signal);
        return locations.length
          ? new Response(null, {
              status: 302,
              headers: { Location: locations.shift()! },
            })
          : pngResponse();
      },
    });
  await assert.rejects(run(["/b", "http://169.254.169.254/latest/"]));
  assert.deepEqual(calls, [origin + "/a", origin + "/b"]);
  calls.length = 0;
  assert.equal(
    (await run(["/b", "https://images.pexels.com/c", "/d"])).source,
    "network",
  );
  assert.equal(calls.length, 4);
  calls.length = 0;
  await assert.rejects(run(["/b", "/c", "/d", "/e"]), /redirect/i);
  assert.equal(calls.length, 4);
});

test("binary headers determine MIME, exact dimensions, and the SHA-256 Forma ID", async () => {
  for (const [format, encoded] of Object.entries(fixtures)) {
    const bytes = Buffer.from(encoded, "base64");
    const result = await localizeImageUrl(origin + "/misleading.svg", {
      strict: true,
      fetchImpl: async () =>
        new Response(bytes, { headers: { "Content-Type": "text/html" } }),
    });
    assert.equal(result.assetId, idOf(bytes));
    assert.equal(result.asset.width, 13);
    assert.equal(result.asset.height, 7);
    assert.equal(
      result.asset.data,
      "data:image/" +
        (format === "lossless" ? "webp" : format) +
        ";base64," +
        encoded,
    );
    assert.ok(imageSchema.safeParse(result.asset).success);
  }
  const extended = Buffer.from(fixtures.webp, "base64");
  const vp8x = Buffer.alloc(18);
  vp8x.write("VP8X");
  vp8x.writeUInt32LE(10, 4);
  vp8x.writeUIntLE(12, 12, 3);
  vp8x.writeUIntLE(6, 15, 3);
  const webp = Buffer.concat([
    extended.subarray(0, 12),
    vp8x,
    extended.subarray(12),
  ]);
  webp.writeUInt32LE(webp.length - 8, 4);
  const { asset } = await localizeImageUrl(origin + "/extended", {
    strict: true,
    fetchImpl: async () => new Response(webp),
  });
  assert.deepEqual([asset.width, asset.height], [13, 7]);
});

test("MIME spoofing, invalid dimensions and truncated headers are rejected", async () => {
  const zeroWidth = Buffer.from(png);
  zeroWidth.writeUInt32BE(0, 16);
  const malformedWebp = Buffer.from(fixtures.webp, "base64");
  malformedWebp[23] = 0;
  for (const bytes of [
    Buffer.from("<svg/>"),
    png.subarray(0, 23),
    zeroWidth,
    malformedWebp,
    Buffer.from([255, 216, 255, 224, 255, 255]),
  ]) {
    await assert.rejects(
      localizeImageUrl(origin + "/invalid", {
        strict: true,
        fetchImpl: async () =>
          new Response(bytes, { headers: { "Content-Type": "image/png" } }),
      }),
    );
  }
});

test("declared and chunked overflow cancel the body and never cache a partial image", async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png);
        controller.enqueue(new Uint8Array(limit - png.length));
        controller.enqueue(Uint8Array.of(0));
      },
      cancel() {
        cancelled = true;
      },
    });
    let attempts = 0;
    const fetchImpl: typeof fetch = async () =>
      ++attempts === 1
        ? new Response(body, {
            headers: declared ? { "content-length": String(limit + 1) } : {},
          })
        : pngResponse();
    await assert.rejects(
      localizeImageUrl(origin + "/size", { fetchImpl, strict: true }),
      /limit/,
    );
    assert.ok(cancelled);
    assert.equal(
      (await localizeImageUrl(origin + "/size", { fetchImpl, strict: true }))
        .source,
      "network",
    );
  }
  const bytes = Buffer.alloc(limit);
  png.copy(bytes);
  assert.equal(
    (
      await localizeImageUrl(origin + "/exact", {
        strict: true,
        fetchImpl: async () => new Response(bytes),
      })
    ).assetId,
    idOf(bytes),
  );
});

test("offline, failed, and aborted downloads return deterministic usable backdrops", async () => {
  const url = origin + "/offline";
  const controller = new AbortController();
  let cancelled = false;
  const delayed: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(png.subarray(0, 8));
          queueMicrotask(() => controller.abort());
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const options = { name: "Pour over", fallbackPrompt: "coffee bar" };
  const aborted = await localizeImageUrl(url, {
    ...options,
    signal: controller.signal,
    fetchImpl: delayed,
  });
  assert.ok(cancelled);
  for (const result of [
    aborted,
    await localizeImageUrl(url, {
      ...options,
      allowNetwork: false,
      fetchImpl: callsForbidden,
    }),
    await localizeImageUrl(url, {
      ...options,
      fetchImpl: async () => {
        throw Error("offline");
      },
    }),
  ]) {
    assert.equal(result.source, "procedural-fallback");
    assert.equal(
      result.assetId,
      createProceduralBackdropAsset(options.fallbackPrompt).assetId,
    );
    assert.equal(result.asset.name, options.name);
  }
});

test("the offline PNG decodes into deterministic, varied pixels with valid checksums", () => {
  const options = {
    width: 173,
    height: 89,
    palette: ["#123", "#847", "#eeb"] as [string, string, string],
  };
  const first = createProceduralBackdropAsset("art direction", options);
  const bytes = bytesOf(first.asset.data);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(first.assetId, idOf(bytes));
  assert.equal(
    first.assetId,
    createProceduralBackdropAsset("art direction", {
      ...options,
      name: "New title",
    }).assetId,
  );
  assert.notEqual(
    first.assetId,
    createProceduralBackdropAsset("different prompt", options).assetId,
  );
  const chunks = new Map<string, Buffer>();
  for (let p = 8; p < bytes.length;) {
    const len = bytes.readUInt32BE(p),
      end = p + 8 + len;
    assert.equal(crc32(bytes.subarray(p + 4, end)), bytes.readUInt32BE(end));
    chunks.set(
      bytes.toString("ascii", p + 4, p + 8),
      bytes.subarray(p + 8, end),
    );
    p = end + 4;
  }
  assert.deepEqual([...chunks.keys()], ["IHDR", "PLTE", "IDAT", "IEND"]);
  assert.deepEqual(
    [chunks.get("IHDR")!.readUInt32BE(), chunks.get("IHDR")!.readUInt32BE(4)],
    [173, 89],
  );
  assert.equal(chunks.get("IHDR")![9], 3);
  assert.equal(chunks.get("PLTE")!.length, 768);
  assert.equal(chunks.get("PLTE")!.subarray(0, 3).toString("hex"), "112233");
  const raw = inflateSync(chunks.get("IDAT")!);
  assert.equal(raw.length, 174 * 89);
  assert.ok(new Set(raw).size > 100);
  for (let y = 0; y < 89; y++) assert.equal(raw[174 * y], 0);
});

test("successful bytes are cached within a session and registry exports deduplicated assets", async () => {
  const registry = new MediaAssetRegistry();
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls++;
    return pngResponse();
  };
  const url = origin + "/session";
  const first = await localizeImageUrl(url, {
    registry,
    fetchImpl,
    name: "First",
  });
  const second = await localizeImageUrl(url + "#fragment", {
    registry,
    fetchImpl,
    allowNetwork: false,
    name: "Second",
  });
  assert.equal(second.source, "cache");
  assert.equal(second.assetId, first.assetId);
  assert.equal(second.asset.name, "Second");
  assert.equal(calls, 1);
  assert.equal(registry.register(first.assetId, first.asset), first.assetId);
  assert.deepEqual(registry.get(first.assetId), first.asset);
  assert.deepEqual(registry.toRecord(), { [first.assetId]: first.asset });
  assert.equal(
    (
      await localizeImageUrl(url, {
        registry: new MediaAssetRegistry(),
        fetchImpl,
      })
    ).source,
    "network",
  );
  assert.equal(calls, 2);
});

test("the catalog has distinct photographic sources and searches English and Chinese offline", async () => {
  assert.ok(CURATED_STOCK_CATALOG.length >= 40);
  assert.equal(
    new Set(CURATED_STOCK_CATALOG.map((s) => s.url)).size,
    CURATED_STOCK_CATALOG.length,
  );
  assert.equal(
    new Set(CURATED_STOCK_CATALOG.map((s) => s.id)).size,
    CURATED_STOCK_CATALOG.length,
  );
  assert.ok(
    CURATED_STOCK_CATALOG.filter((s) => s.tags.includes("coffee")).length >= 8,
  );
  for (const item of CURATED_STOCK_CATALOG) {
    assert.ok(ALLOWED_IMAGE_HOSTS.includes(new URL(item.url).hostname));
    assert.ok(item.tags.length && item.title && item.mood);
    assert.equal(
      item.orientation,
      item.aspectRatio > 1
        ? "landscape"
        : item.aspectRatio < 1
          ? "portrait"
          : "square",
    );
  }
  for (const [query, tag] of [
    ["手冲咖啡", "pour-over"],
    ["coffee beans", "beans"],
    ["咖啡豆", "beans"],
    ["烘焙", "roast"],
    ["甜品", "bakery"],
    ["人物头像", "portrait"],
    ["建筑酒店", "hotel"],
    ["科技办公", "workspace"],
    ["自然户外", "outdoor"],
    ["护肤", "skincare"],
    ["抹茶", "matcha"],
    ["studio portrait", "portrait"],
    ["laptop", "laptop"],
    ["music", "music"],
  ]) {
    const [first] = await searchStockImages(query, {
      allowNetwork: false,
      fetchImpl: callsForbidden,
      limit: 1,
    });
    assert.ok(first?.tags.includes(tag), query + " → " + first?.title);
  }
  const [portrait] = await searchStockImages("portrait", {
    orientation: "portrait",
    mood: "dark",
    limit: 1,
    fetchImpl: callsForbidden,
  });
  assert.equal(portrait.mood, "dark");
  assert.equal(portrait.orientation, "portrait");
  assert.deepEqual(
    await searchStockImages("no-such-domain", { allowNetwork: false }),
    [],
  );
});

function setProviderKeys(t: TestContext, unsplash?: string, pexels?: string) {
  for (const [key, value] of [
    ["UNSPLASH_ACCESS_KEY", unsplash],
    ["PEXELS_API_KEY", pexels],
  ] as const) {
    const previous = process.env[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test("Openverse fills remaining places, validates hosts and leaves curated results first", async (t) => {
  setProviderKeys(t);
  const calls: string[] = [];
  const rows = [
    "https://bad.example/x",
    "https://upload.wikimedia.org/x",
    "https://upload.wikimedia.org/x",
  ].map((url, i) => ({
    id: String(i),
    url,
    width: 400,
    height: 250,
    title: "Coffee bean detail",
    tags: [{ name: "coffee" }],
  }));
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(
      new Headers(init?.headers).get("user-agent"),
      "FormaDesignTool/0.8.4",
    );
    assert.equal(init?.redirect, "manual");
    assert.ok(init.signal);
    return Response.json({ results: [null, ...rows] });
  };
  const curated = await searchStockImages("coffee", {
    limit: 20,
    allowNetwork: false,
  });
  assert.deepEqual(
    await searchStockImages("coffee", { limit: 2, fetchImpl }),
    curated.slice(0, 2),
  );
  assert.equal(calls.length, 0);
  const result = await searchStockImages("coffee", { limit: 20, fetchImpl });
  assert.deepEqual(result.slice(0, -1), curated);
  assert.equal(result.at(-1)?.url, rows[1].url);
  const url = new URL(calls[0]);
  assert.equal(url.hostname, "api.openverse.org");
  assert.equal(url.searchParams.get("q"), "coffee");
  assert.equal(calls.length, 1);
});

test("keyed search uses the correct API and keeps credentials on the issuing origin", async (t) => {
  setProviderKeys(t, "test-unsplash", "test-pexels");
  const calls: [string, string | null][] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push([url.hostname, new Headers(init?.headers).get("authorization")]);
    if (url.hostname === "api.unsplash.com")
      return new Response(null, {
        status: 302,
        headers: { location: "https://images.pexels.com/catalog" },
      });
    if (url.hostname === "images.pexels.com")
      return Response.json({
        results: [
          {
            id: "u",
            alt_description: "Observatory",
            width: 400,
            height: 600,
            urls: { regular: origin + "/star" },
          },
        ],
      });
    return Response.json({
      photos: [
        {
          id: 9,
          width: 400,
          height: 600,
          alt: "Telescope",
          src: { large: "https://images.pexels.com/star" },
        },
      ],
    });
  };
  const result = await searchStockImages("observatory", {
    limit: 2,
    orientation: "portrait",
    fetchImpl,
  });
  assert.deepEqual(
    result.map((r) => r.id),
    ["unsplash-u", "pexels-9"],
  );
  assert.deepEqual(calls, [
    ["api.unsplash.com", "Client-ID test-unsplash"],
    ["images.pexels.com", null],
    ["api.pexels.com", "test-pexels"],
  ]);
});

test("HTML localizes stock queries, img sources and CSS layers without changing unrelated content", async () => {
  const remote = origin + "/ui?a=1&b=2";
  const calls: string[] = [];
  const input = `<!doctype html><html><head><style>.hero{background-image:linear-gradient(red,transparent), url('${remote}')} .caption:before{content:"url(not-an-image)"}</style></head><body>
    <picture><source srcset="https://bad.example/source"><IMG alt='A > B' SRC="${remote.replace("&", "&amp;")}" srcset="https://bad.example/large 2x" data-forma-asset-id="spoof"></picture>
    <img data-stock-query='咖啡豆'><section style='background-image:url("https://bad.example/backdrop")'></section>
    <img src="http://169.254.169.254/x"><img src="//bad.example/scheme-relative">
    <p>Literal https://example.com/story</p><!-- <img src="https://comment.test"> --></body></html>`;
  const result = await resolveMediaAssetsForHtml(input, {
    fetchImpl: async (url) => {
      calls.push(String(url));
      return pngResponse();
    },
  });
  assert.equal(result.resolvedCount, 6);
  assert.equal(result.fallbackCount, 3);
  assert.equal(calls.length, 2);
  assert.ok(calls.includes(remote));
  assert.ok(calls.every((u) => new URL(u).hostname === "images.unsplash.com"));
  assert.doesNotMatch(
    result.html,
    /bad\.example|169\.254|\bsrcset=|data-stock-query|spoof/,
  );
  assert.match(
    result.html,
    /linear-gradient\(red,transparent\), url\(data:image\/png;base64,/,
  );
  assert.match(result.html, /background-image:url\(data:image\/png;base64,/);
  assert.match(result.html, /content:"url\(not-an-image\)"/);
  assert.ok(result.html.includes("Literal https://example.com/story"));
  assert.ok(result.html.includes('<!-- <img src="https://comment.test"> -->'));
  const tags = Array.from(
    result.html.matchAll(/data-forma-asset-id="(img-[a-f0-9]{64})"/g),
    (m) => m[1],
  );
  assert.equal(tags.length, 4);
  assert.equal(tags[0], idOf(png));
  for (const id of tags)
    assert.equal(id, idOf(bytesOf(result.images[id].data)));
  const replay = await resolveMediaAssetsForHtml(result.html, {
    fetchImpl: callsForbidden,
    allowNetwork: false,
  });
  assert.deepEqual(
    new Set(Object.keys(replay.images)),
    new Set(Object.keys(result.images)),
  );
  assert.equal(replay.fallbackCount, 0);
});

test("placement budget strips remaining media including srcset and leaves no external image URL", async () => {
  const html =
    '<img src="https://bad.example/a"><img src="' +
    origin +
    '/b"><style>.c{background-image:url(https://bad.example/c)}</style><source srcset="//bad.example/d">';
  for (const maxImages of [0, 1]) {
    let calls = 0;
    const result = await resolveMediaAssetsForHtml(html, {
      maxImages,
      fetchImpl: async () => {
        calls++;
        return pngResponse();
      },
    });
    assert.equal(result.resolvedCount, maxImages);
    assert.equal(result.fallbackCount, maxImages);
    assert.equal(calls, 0);
    assert.equal(Object.keys(result.images).length, maxImages);
    assert.doesNotMatch(result.html, /https?:\/\/|srcset=/);
    assert.match(result.html, /background-image:none/);
  }
  let calls = 0;
  const result = await resolveMediaAssetsForHtml(
    Array.from(
      { length: 14 },
      (_, i) => '<img src="' + origin + "/" + i + '">',
    ).join(""),
    {
      fetchImpl: async () => {
        calls++;
        return pngResponse();
      },
    },
  );
  assert.equal(calls, 12);
  assert.equal(result.resolvedCount, 12);
  assert.equal(Object.keys(result.images).length, 1);
});

test("all redirect hops and the response stream share a single 10-second deadline", async (t) => {
  const deadline = new AbortController();
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeouts.push(ms);
    return deadline.signal;
  });
  const signals: (AbortSignal | null | undefined)[] = [];
  let cancelled = false;
  const result = await localizeImageUrl(origin + "/deadline", {
    fetchImpl: async (_url, options) => {
      signals.push(options?.signal);
      if (signals.length === 1)
        return new Response(null, {
          status: 307,
          headers: { location: "/slow" },
        });
      return new Response(
        new ReadableStream({
          pull() {
            deadline.abort(new Error("deadline"));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  assert.deepEqual(timeouts, [10_000]);
  assert.deepEqual(signals, [deadline.signal, deadline.signal]);
  assert.equal(cancelled, true);
  assert.equal(result.source, "procedural-fallback");
});

test("escaped CSS image functions, responsive strings and a srcset-only image are localized", async () => {
  const css = String.raw`.hero{background-image:-webkit-image-set("https://unlisted.example/a" 1x type("image/png"),u\72 l('https://images.unsplash.com/b') 2x)} .label::before{content:"url(unchanged)"}.mask{clip-path:url(#mask)}`;
  const calls: string[] = [];
  const result = await resolveMediaAssetsForHtml(
    "<style>" +
      css +
      '</style><img srcset="https://unlisted.example/c 1x, //elsewhere.example/d 2x">',
    {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return pngResponse();
      },
    },
  );
  assert.deepEqual(calls, [origin + "/b"]);
  assert.equal(result.resolvedCount, 3);
  assert.equal(result.fallbackCount, 2);
  assert.doesNotMatch(result.html, /unlisted|elsewhere|srcset/);
  assert.match(result.html, /image-set\(url\(data:image\/png;base64,/);
  assert.ok(result.html.includes('type("image/png")'));
  assert.ok(result.html.includes('content:"url(unchanged)"'));
  assert.ok(result.html.includes("url(#mask)"));
  assert.match(result.html, /data-forma-asset-id="img-[a-f0-9]{64}"/);
});

test("parallel downloads retain document order even when the second image completes first", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const html =
    '<img src="' + origin + '/first"><img src="' + origin + '/second">';
  const task = resolveMediaAssetsForHtml(html, {
    fetchImpl: async (u) => {
      calls.push(String(u));
      if (String(u).endsWith("/first")) await gate;
      return String(u).endsWith("/first")
        ? pngResponse()
        : new Response(Buffer.from(fixtures.jpeg, "base64"));
    },
  });
  try {
    assert.deepEqual(calls, [origin + "/first", origin + "/second"]);
  } finally {
    release();
  }
  const result = await task;
  assert.deepEqual(
    Array.from(
      result.html.matchAll(/data-forma-asset-id="([^"]+)"/g),
      (a) => a[1],
    ),
    [idOf(png), idOf(Buffer.from(fixtures.jpeg, "base64"))],
  );
});

test("weak keyword overlap leaves room for topic-specific search results", async (t) => {
  setProviderKeys(t);
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    queries.push(new URL(String(input)).searchParams.get("q")!);
    return Response.json({
      results: [
        {
          id: "coffee-press",
          title: "Coffee in a French press",
          url: origin + "/press",
          width: 800,
          height: 600,
        },
      ],
    });
  };
  const result = await searchStockImages("coffee french press", {
    limit: 2,
    fetchImpl,
  });
  assert.deepEqual(queries, ["coffee french press"]);
  assert.equal(result[0].id, "openverse-coffee-press");
  assert.ok(result[1].tags.includes("coffee"));
  assert.deepEqual(
    await searchStockImages("a dark photo of an observatory", {
      allowNetwork: false,
    }),
    [],
  );
});
