import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import { imageId, imageSchema, type ImageAsset } from "../domain/images";
import { inspectImageBytes } from "../infrastructure/design-import/image";

const BYTE_LIMIT = 1_572_864;
const USER_AGENT = "FormaDesignTool/0.8.4";
export const ALLOWED_IMAGE_HOSTS = Object.freeze([
  "images.unsplash.com",
  "images.pexels.com",
  "upload.wikimedia.org",
  "live.staticflickr.com",
  "cdn.pixabay.com",
  "api.openverse.org",
  "commons.wikimedia.org",
  "api.unsplash.com",
  "api.pexels.com",
]);

type Orientation = "landscape" | "portrait" | "square";
type Mood = "dark" | "warm" | "light" | "vibrant";
export interface StockImageCandidate {
  id: string;
  title: string;
  url: string;
  tags: string[];
  mood?: Mood;
  orientation: Orientation;
  aspectRatio: number;
}
type NetworkOptions = {
  allowNetwork?: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};
type SearchOptions = NetworkOptions & {
  orientation?: Orientation;
  mood?: string;
  limit?: number;
};
type AssetEntry = { assetId: string; asset: ImageAsset };
type Localized = AssetEntry & {
  source: "network" | "cache" | "procedural-fallback";
  sourceUrl?: string;
};

function orientationOf(width: number, height: number): Orientation {
  if (width === height) return "square";
  return width > height ? "landscape" : "portrait";
}

function safeUrl(input: string, base?: URL) {
  const url = new URL(input, base);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !ALLOWED_IMAGE_HOSTS.includes(url.hostname)
  )
    throw Error("Image URL is not allowed");
  url.hash = "";
  return url;
}

// One deadline covers the headers, every redirect, and the final streamed body.
async function download(
  url: URL,
  options: NetworkOptions,
  headers: Record<string, string> = {},
) {
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal
    ? AbortSignal.any([timeout, options.signal])
    : timeout;
  const fetchImpl = options.fetchImpl ?? fetch;
  let target = url;
  for (let hop = 0; ; hop++) {
    signal.throwIfAborted();
    const response = await fetchImpl(target.href, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(url.origin === target.origin ? headers : {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || hop === 3) throw Error("Invalid image redirect");
      target = safeUrl(location, target);
      continue;
    }
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > BYTE_LIMIT
    ) {
      void response.body?.cancel().catch(() => {});
      throw Error("Media request failed or exceeded the byte limit");
    }
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        length += value.byteLength;
        if (length > BYTE_LIMIT)
          throw Error("Media response exceeded the byte limit");
        if (value.byteLength) chunks.push(value);
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      cancel();
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
}

function photo(
  id: string,
  title: string,
  terms: string,
  mood: Mood,
  width: number,
  height: number,
  query = `fit=crop&h=${height}&w=${width}`,
) {
  return {
    id: "photo-" + id,
    title,
    tags: terms.split(" "),
    mood,
    url: `https://images.unsplash.com/photo-${id}?${query}`,
    aspectRatio: width / height,
    orientation: orientationOf(width, height),
  } satisfies StockImageCandidate;
}

export const CURATED_STOCK_CATALOG = [
  photo(
    "1495474472287-4d71bcdd2085",
    "Morning pour-over",
    "coffee cafe pour-over filter barista brewing",
    "warm",
    800,
    600,
  ),
  photo(
    "1511920170033-f8396924c348",
    "Coffee at the counter",
    "coffee cafe barista espresso",
    "warm",
    400,
    400,
  ),
  photo(
    "1447933601403-0c6688de566e",
    "Roasted beans in shadow",
    "coffee beans roast roaster texture",
    "dark",
    800,
    600,
  ),
  photo(
    "1509042239860-f550ce710b93",
    "Latte in natural light",
    "coffee latte art flat white milk espresso",
    "light",
    400,
    400,
  ),
  photo(
    "1514432324607-a09d9b4aefdd",
    "The espresso bar",
    "coffee espresso cafe roast",
    "dark",
    300,
    300,
  ),
  photo(
    "1442512595331-e89e73853f31",
    "The morning brew",
    "coffee brewing pour-over filter cafe",
    "warm",
    600,
    400,
  ),
  photo(
    "1501339847302-ac426a4a7cbb",
    "Inside the café",
    "coffee cafe interior seating cafe design",
    "warm",
    800,
    600,
  ),
  photo(
    "1497935586351-b67a49e012bf",
    "Coffee still life",
    "coffee beans cup roaster still life",
    "warm",
    800,
    533,
    "q=80&w=800",
  ),
  photo(
    "1515823064-d6e0c04616a7",
    "Matcha in white ceramic",
    "tea matcha latte cup food",
    "light",
    600,
    900,
    "q=80&w=600",
  ),
  photo(
    "1555507036-ab1f4038808a",
    "Butter and pastry layers",
    "food bakery croissant pastry bread breakfast",
    "warm",
    400,
    400,
  ),
  photo(
    "1509440159596-0249088772ff",
    "Baker’s bread",
    "food bakery sourdough loaf bread",
    "warm",
    800,
    600,
  ),
  photo(
    "1488477181946-6428a0291777",
    "Berries and cream",
    "food dessert fruit berries yogurt breakfast",
    "light",
    800,
    600,
  ),
  photo(
    "1504674900247-0877df9cc836",
    "At the dinner table",
    "food dining dinner restaurant meal",
    "warm",
    800,
    600,
  ),
  photo(
    "1547592180-85f173990554",
    "A garden lunch",
    "food salad wellness vegetable lunch",
    "vibrant",
    400,
    300,
  ),
  photo(
    "1544787219-7f47ccb76574",
    "Tea at the table",
    "food tea cup steep tea time",
    "warm",
    600,
    800,
  ),
  photo(
    "1544005313-94ddf0286df2",
    "Soft light portrait",
    "portrait avatar face woman studio",
    "warm",
    400,
    600,
  ),
  photo(
    "1500648767791-00dcc994a43e",
    "Daylight headshot",
    "portrait avatar face man editorial",
    "light",
    400,
    400,
  ),
  photo(
    "1534528741775-53994a69daeb",
    "Color study portrait",
    "portrait avatar face woman studio fashion",
    "vibrant",
    400,
    600,
  ),
  photo(
    "1506794778202-cad84cf45f1d",
    "Quiet headshot",
    "portrait avatar face man studio",
    "dark",
    400,
    600,
  ),
  photo(
    "1498050108023-c5249f4df085",
    "Developer’s workbench",
    "tech workspace laptop coding saas desk",
    "light",
    800,
    600,
  ),
  photo(
    "1496181133206-80ce9b88a853",
    "Minimal laptop",
    "tech laptop minimal hardware workspace saas",
    "light",
    1200,
    600,
  ),
  photo(
    "1517336714731-489689fd1ca8",
    "Aluminium notebook",
    "tech laptop computer hardware minimal",
    "light",
    800,
    500,
  ),
  photo(
    "1519389950473-47ba0277781c",
    "Shared workspace",
    "tech workspace office team studio saas",
    "warm",
    800,
    500,
  ),
  photo(
    "1511707171634-5f897ff02aa9",
    "Handheld screen",
    "tech phone hardware product mobile minimal",
    "dark",
    400,
    400,
  ),
  photo(
    "1486406146926-c627a92ad1ab",
    "Glass and steel",
    "architecture building facade city tower",
    "dark",
    600,
    400,
  ),
  photo(
    "1600210492486-724fe5c67fb0",
    "A sunlit living room",
    "architecture interior furniture minimalist lounge",
    "warm",
    800,
    500,
  ),
  photo(
    "1611892440504-42a792e24d32",
    "Hotel suite",
    "architecture interior minimalist hotel travel suite",
    "warm",
    800,
    600,
  ),
  photo(
    "1566073771259-6a8506099945",
    "Resort retreat",
    "architecture hotel travel pool resort",
    "light",
    800,
    600,
  ),
  photo(
    "1476514525535-07fb3b4ae5f1",
    "An alpine escape",
    "travel nature outdoor lake mountain",
    "vibrant",
    800,
    600,
  ),
  photo(
    "1441986300917-64674bd600d8",
    "The fashion shop",
    "fashion retail clothing ecommerce boutique lifestyle",
    "warm",
    800,
    600,
  ),
  photo(
    "1483985988355-763728e1935b",
    "Shopping in the city",
    "fashion lifestyle shopping retail ecommerce",
    "vibrant",
    800,
    600,
  ),
  photo(
    "1608571423902-eed4a5ad8108",
    "Skincare still life",
    "skincare product cosmetics serum beauty ecommerce",
    "warm",
    1200,
    800,
  ),
  photo(
    "1542291026-7eec264c27ff",
    "Red trainer study",
    "fashion product shoe sneaker footwear ecommerce",
    "vibrant",
    600,
    600,
  ),
  photo(
    "1523275335684-37898b6baf30",
    "Watch in soft light",
    "fashion product watch minimal accessories ecommerce",
    "light",
    800,
    500,
  ),
  photo(
    "1464822759023-fed622ff2c3b",
    "The high ridgeline",
    "nature outdoor mountain alpine hiking",
    "dark",
    800,
    600,
  ),
  photo(
    "1441974231531-c6227db76b6e",
    "Forest light",
    "nature outdoor forest woodland hiking",
    "warm",
    800,
    600,
  ),
  photo(
    "1470770841072-f978cf4d019e",
    "A still alpine lake",
    "nature outdoor lake mountain travel",
    "light",
    800,
    400,
    "fit=crop&h=400&q=80&w=800",
  ),
  photo(
    "1500534623283-312aade485b7",
    "Open landscape",
    "nature outdoor countryside landscape wellness",
    "warm",
    800,
    500,
  ),
  photo(
    "1544367567-0f2fcb009e0b",
    "Morning movement",
    "wellness yoga fitness lifestyle exercise",
    "light",
    800,
    600,
  ),
  photo(
    "1519681393784-d120267933ba",
    "Night above the mountains",
    "nature night stars outdoor alpine",
    "dark",
    800,
    500,
  ),
  photo(
    "1511379938547-c1f69419868d",
    "The recording studio",
    "music studio production sound audio",
    "dark",
    600,
    400,
  ),
  photo(
    "1516280440614-37939bbacd81",
    "On the microphone",
    "music microphone audio performance recording",
    "dark",
    400,
    400,
  ),
  photo(
    "1470225620780-dba8ba36b745",
    "Under stage lights",
    "music concert performance stage nightlife",
    "vibrant",
    800,
    600,
  ),
  photo(
    "1517841905240-472988babdf9",
    "Portrait in daylight",
    "portrait avatar face woman editorial",
    "light",
    600,
    800,
  ),
];

const aliases: Record<string, string> = {
  咖啡: "coffee",
  手冲: "pour-over",
  咖啡豆: "beans",
  豆子: "beans",
  烘焙: "roast bakery",
  拿铁: "latte",
  拉花: "latte art",
  意式: "espresso",
  烘豆: "roaster",
  咖啡馆: "cafe",
  美食: "food",
  餐饮: "dining food",
  甜品: "dessert bakery",
  面包: "bread bakery",
  茶: "tea",
  抹茶: "matcha",
  头像: "avatar",
  人物: "portrait",
  肖像: "portrait",
  建筑: "architecture",
  酒店: "hotel interior",
  室内: "interior",
  旅行: "travel",
  科技: "tech",
  办公: "workspace",
  笔记本: "laptop",
  硬件: "hardware",
  极简: "minimal",
  自然: "nature",
  户外: "outdoor",
  山脉: "mountain",
  健康: "wellness",
  瑜伽: "yoga",
  时尚: "fashion",
  护肤: "skincare product",
  电商: "ecommerce",
  产品: "product",
  生活方式: "lifestyle",
  音乐: "music",
  暗调: "dark",
  暖色: "warm",
  明亮: "light",
};
const searchModifiers = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "and",
  "with",
  "photo",
  "photos",
  "image",
  "images",
  "editorial",
  "stock",
]);
const moods = new Set(["dark", "warm", "light", "vibrant"]);

function termsOf(text: string) {
  const normalized = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/pour[\s-]?over/g, "pourover")
    .replace(/e-commerce/g, "ecommerce");
  return normalized.match(/[a-z0-9]+/g) ?? [];
}

const resultList = z.object({ results: z.array(z.unknown()) });
const photoList = z.object({ photos: z.array(z.unknown()) });
const dimensions = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
const unsplashPhoto = dimensions.extend({
  id: z.string(),
  alt_description: z.string().nullish(),
  description: z.string().nullish(),
  urls: z.object({ regular: z.string() }),
  tags: z.array(z.object({ title: z.string() })).optional(),
});
const pexelsPhoto = dimensions.extend({
  id: z.number(),
  alt: z.string().nullish(),
  src: z.object({ large: z.string() }),
});
const openversePhoto = dimensions.extend({
  id: z.string(),
  title: z.string().nullish(),
  url: z.string(),
  thumbnail: z.string().nullish(),
  tags: z.array(z.object({ name: z.string() })).nullish(),
});

type Provider = "unsplash" | "pexels" | "openverse";

function providerPhoto(
  provider: Provider,
  row: unknown,
  query: string,
): StockImageCandidate | undefined {
  function candidate(
    id: string | number,
    title: string | null | undefined,
    urls: (string | null | undefined)[],
    size: { width: number; height: number },
    tags: string[] = [],
  ) {
    for (const raw of urls) {
      if (!raw) continue;
      try {
        const url = safeUrl(raw);
        return {
          id: provider + "-" + id,
          title: title || query,
          url: url.href,
          tags,
          orientation: orientationOf(size.width, size.height),
          aspectRatio: size.width / size.height,
        };
      } catch {
        /* Try an allowed rendition if the original host is outside the catalog. */
      }
    }
  }
  if (provider === "unsplash") {
    const { data } = unsplashPhoto.safeParse(row);
    if (data)
      return candidate(
        data.id,
        data.alt_description || data.description,
        [data.urls.regular],
        data,
        data.tags?.map((t) => t.title),
      );
  } else if (provider === "pexels") {
    const { data } = pexelsPhoto.safeParse(row);
    if (data) return candidate(data.id, data.alt, [data.src.large], data);
  } else {
    const { data } = openversePhoto.safeParse(row);
    if (data)
      return candidate(
        data.id,
        data.title,
        [data.url, data.thumbnail],
        data,
        data.tags?.map((t) => t.name),
      );
  }
}

async function searchProvider(
  provider: Provider,
  query: string,
  count: number,
  options: SearchOptions,
  key?: string,
) {
  const endpoints = {
    unsplash: "https://api.unsplash.com/search/photos",
    pexels: "https://api.pexels.com/v1/search",
    openverse: "https://api.openverse.org/v1/images/",
  };
  const url = safeUrl(endpoints[provider]);
  url.searchParams.set(provider === "openverse" ? "q" : "query", query);
  url.searchParams.set(
    provider === "openverse" ? "page_size" : "per_page",
    String(count),
  );
  if (provider === "openverse") url.searchParams.set("license", "cc0,pdm");
  else if (options.orientation) {
    const square = provider === "unsplash" ? "squarish" : "square";
    url.searchParams.set(
      "orientation",
      options.orientation === "square" ? square : options.orientation,
    );
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key)
    headers.Authorization = provider === "unsplash" ? "Client-ID " + key : key;
  const body: unknown = JSON.parse(
    (await download(url, options, headers)).toString("utf8"),
  );
  const rows =
    provider === "pexels"
      ? photoList.parse(body).photos
      : resultList.parse(body).results;
  return rows
    .map((row) => providerPhoto(provider, row, query))
    .filter((row) => row !== undefined);
}

export async function searchStockImages(
  query: string,
  options: SearchOptions = {},
): Promise<StockImageCandidate[]> {
  const limit = Math.max(0, Math.min(80, Math.floor(options.limit ?? 6)));
  if (!limit) return [];
  const aliasTerms = Object.entries(aliases)
    .filter(([word]) => query.includes(word))
    .map(([, english]) => english);
  const words = new Set(termsOf([query, ...aliasTerms].join(" ")));
  const topics = [...words].filter(
    (word) => !searchModifiers.has(word) && !moods.has(word),
  );
  const mood = options.mood?.toLowerCase();
  const ranked = CURATED_STOCK_CATALOG.filter(
    (p) => !options.orientation || options.orientation === p.orientation,
  )
    .map((photo) => {
      const tags = new Set(termsOf([...photo.tags, photo.title].join(" ")));
      const matches = topics.filter((w) => tags.has(w)).length;
      return {
        photo,
        matches,
        score:
          matches * 4 +
          Number(photo.mood === mood) * 2 +
          Number(words.has(photo.mood)),
      };
    })
    .filter(
      (row) =>
        !query.trim() ||
        row.matches ||
        (!topics.length && words.has(row.photo.mood)),
    )
    .sort((a, b) => b.score - a.score);
  const curated = ranked.slice(0, limit).map((row) => row.photo);
  if (
    !query.trim() ||
    options.allowNetwork === false ||
    options.signal?.aborted
  )
    return curated;
  const minimumMatches = Math.min(topics.length, 2);
  const results: StockImageCandidate[] = ranked
    .filter((row) => row.matches >= minimumMatches)
    .slice(0, limit)
    .map((row) => row.photo);
  if (results.length === limit) return results;
  const seen = new Set(results.map((r) => r.url));
  const providers: [Provider, string | undefined][] = [
    ["unsplash", process.env.UNSPLASH_ACCESS_KEY],
    ["pexels", process.env.PEXELS_API_KEY],
    ["openverse", undefined],
  ];
  for (const [provider, key] of providers) {
    if (!key && provider !== "openverse") continue;
    try {
      const remote = await searchProvider(
        provider,
        aliasTerms.length ? [...words].join(" ") : query,
        Math.min(30, limit - results.length),
        options,
        key,
      );
      for (const photo of remote) {
        if (
          seen.has(photo.url) ||
          (options.orientation && photo.orientation !== options.orientation)
        )
          continue;
        seen.add(photo.url);
        results.push(photo);
        if (results.length === limit) return results;
      }
    } catch {
      /* A failed provider must not discard existing matches. */
    }
    if (options.signal?.aborted) break;
  }
  return [...results, ...curated.filter((photo) => !seen.has(photo.url))].slice(
    0,
    limit,
  );
}

function bitmap(bytes: Buffer, name: string): AssetEntry {
  const info = inspectImageBytes(bytes);
  if (
    info.mime === "png" &&
    (bytes.length < 33 || bytes.readUInt32BE(8) !== 13)
  )
    throw Error("Invalid PNG header");
  if (info.mime === "webp") {
    const size = bytes.readUInt32LE(4) + 8;
    const chunkSize = bytes.readUInt32LE(16);
    const chunk = bytes.toString("latin1", 12, 16);
    if (
      size > bytes.length ||
      20 + chunkSize > size ||
      (chunk === "VP8X" && chunkSize !== 10) ||
      (chunk === "VP8L" &&
        (chunkSize < 5 || bytes[20] !== 0x2f || bytes[24] >>> 5)) ||
      (chunk === "VP8 " &&
        (chunkSize < 10 || bytes.readUIntBE(23, 3) !== 0x9d012a))
    )
      throw Error("Invalid WebP header");
  }
  return {
    assetId: "img-" + createHash("sha256").update(bytes).digest("hex"),
    asset: imageSchema.parse({
      name: name.trim().slice(0, 255) || "Image",
      width: info.width,
      height: info.height,
      data: "data:image/" + info.mime + ";base64," + bytes.toString("base64"),
    }),
  };
}

export class MediaAssetRegistry {
  private readonly assets = new Map<string, ImageAsset>();
  register(entry: AssetEntry): string;
  register(assetId: string, asset: ImageAsset): string;
  register(entry: AssetEntry | string, image?: ImageAsset) {
    const id = imageId.parse(typeof entry === "string" ? entry : entry.assetId);
    if (!this.assets.has(id))
      this.assets.set(
        id,
        imageSchema.parse(typeof entry === "string" ? image : entry.asset),
      );
    return id;
  }
  get(assetId: string) {
    return this.assets.get(assetId);
  }
  toRecord(): Record<string, ImageAsset> {
    return Object.fromEntries(this.assets);
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let crc = i;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4))
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  chunk.writeUInt32BE(~crc >>> 0, chunk.length - 4);
  return chunk;
}

const palettes = [
  ["#241a22", "#a35d46", "#ffe1ab"],
  ["#102d34", "#6c8e78", "#f2e1ba"],
  ["#151b33", "#62658a", "#efbcb2"],
  ["#251d2a", "#ab7761", "#f4dfcb"],
];
function extent(value: number | undefined, defaultValue: number) {
  return Number.isFinite(value)
    ? Math.min(32768, Math.max(1, Math.round(value!)))
    : defaultValue;
}

export function createProceduralBackdropAsset(
  prompt: string,
  options: {
    width?: number;
    height?: number;
    palette?: [string, string, string];
    name?: string;
  } = {},
): AssetEntry {
  const seed = createHash("sha256").update(prompt).digest();
  let width = extent(options.width, 480),
    height = extent(options.height, 320);
  // Indexed pixels leave room for grain at the requested aspect ratio under the download limit.
  const scale = Math.min(1, Math.sqrt(1_500_000 / ((width + 1) * height)));
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  const defaults = palettes[seed[0] % palettes.length];
  const stops = defaults.map((fallback, i) => {
    let color = options.palette?.[i] ?? fallback;
    if (/^#[a-f\d]{3}$/i.test(color))
      color = "#" + [...color.slice(1)].map((c) => c + c).join("");
    if (!/^#[a-f\d]{6}$/i.test(color)) color = fallback;
    return [1, 3, 5].map((p) => parseInt(color.slice(p, p + 2), 16));
  });
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    const first = i < 144 ? 0 : 1;
    const t = first === 0 ? i / 144 : (i - 144) / 111;
    for (let channel = 0; channel < 3; channel++)
      palette[i * 3 + channel] = Math.round(
        stops[first][channel] * (1 - t) + stops[first + 1][channel] * t,
      );
  }
  const pixels = Buffer.alloc((width + 1) * height);
  const lightX = 0.18 + seed[1] / 400,
    lightY = 0.12 + seed[2] / 600;
  let noise = seed.readUInt32LE(4) || 1;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const glow = Math.exp(-3.8 * (u - lightX) ** 2 - 2.5 * (v - lightY) ** 2);
      const vignette = (u - 0.5) ** 2 + (v - 0.5) ** 2;
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      const grain = ((noise >>> 24) / 255 - 0.5) * 5.5;
      pixels[y * (width + 1) + 1 + x] = Math.max(
        0,
        Math.min(
          255,
          Math.round(
            49 + 152 * glow + 44 * (1 - v) + 15 * u - 82 * vignette + grain,
          ),
        ),
      );
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 3; // 8-bit indexed RGB, non-interlaced, filter None on every row.
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("PLTE", palette),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return bitmap(png, options.name || prompt || "Editorial backdrop");
}

type LocalizeOptions = NetworkOptions & {
  name?: string;
  fallbackPrompt?: string;
  strict?: boolean;
  registry?: MediaAssetRegistry;
};
// Explicit registries isolate sessions. Standalone calls share only successful public bytes from the same transport.
const downloadCaches = new WeakMap<
  MediaAssetRegistry | typeof fetch,
  Map<string, AssetEntry>
>();

export async function localizeImageUrl(
  input: string,
  options: LocalizeOptions = {},
): Promise<Localized> {
  let result: Localized;
  try {
    const url = safeUrl(input);
    const owner = options.registry ?? options.fetchImpl ?? fetch;
    const cache = downloadCaches.get(owner) ?? new Map<string, AssetEntry>();
    downloadCaches.set(owner, cache);
    let entry = cache.get(url.href);
    const source = entry ? "cache" : "network";
    if (!entry) {
      if (options.allowNetwork === false)
        throw Error("Image downloads are disabled");
      entry = bitmap(
        await download(url, options),
        url.pathname.split("/").pop() || "Stock photo",
      );
      // Limit retained data URIs even when the caller keeps a session open indefinitely.
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(url.href, entry);
    }
    result = {
      assetId: entry.assetId,
      asset: {
        ...entry.asset,
        name: options.name?.trim().slice(0, 255) || entry.asset.name,
      },
      source,
      sourceUrl: url.href,
    };
  } catch (error) {
    if (options.strict) throw error;
    result = {
      ...createProceduralBackdropAsset(
        options.fallbackPrompt || options.name || input,
        {
          name: options.name || options.fallbackPrompt || "Editorial backdrop",
        },
      ),
      source: "procedural-fallback",
    };
  }
  options.registry?.register(result);
  return result;
}

function decodeAttribute(raw: string) {
  const entities: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    colon: ":",
    sol: "/",
  };
  return raw.replace(
    /&(amp|quot|apos|lt|gt|colon|sol);|&#(x[\da-f]+|\d+);?/gi,
    (match, name: string | undefined, numeric: string | undefined) => {
      if (name) return entities[name.toLowerCase()];
      if (!numeric) return match;
      const value =
        numeric[0].toLowerCase() === "x"
          ? parseInt(numeric.slice(1), 16)
          : Number(numeric);
      return value > 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : "\uFFFD";
    },
  );
}
function unescapeCss(text: string) {
  return text.replace(
    /\\(?:([\da-f]{1,6})[\t\n\r\f ]?|\r\n|[\n\r\f]|([\s\S]))/gi,
    (_, hex: string | undefined, char: string | undefined) => {
      if (!hex) return char ?? "";
      const code = parseInt(hex, 16);
      return code && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
    },
  );
}
function attribute(name: string, value: string) {
  return (
    name +
    '="' +
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;") +
    '"'
  );
}

// Start all selected requests in document order and assemble the replacements in that same order.
async function replaceMatches(
  input: string,
  pattern: RegExp,
  rewrite: (match: RegExpMatchArray) => Promise<string> | string,
) {
  const parts: (string | Promise<string>)[] = [];
  let offset = 0;
  for (const match of input.matchAll(pattern)) {
    parts.push(input.slice(offset, match.index), rewrite(match));
    offset = match.index! + match[0].length;
  }
  parts.push(input.slice(offset));
  return (await Promise.all(parts)).join("");
}

function embeddedBitmap(data: string, name: string) {
  const comma = data.indexOf(",");
  if (
    comma <= 0 ||
    comma > 32 ||
    data.length - comma - 1 > 4 * Math.ceil(BYTE_LIMIT / 3) ||
    !/^data:image\/(?:png|jpeg|webp|gif);base64$/i.test(data.slice(0, comma))
  )
    throw Error("Unsupported embedded image");
  const bytes = Buffer.from(data.slice(comma + 1), "base64");
  return bitmap(bytes, name);
}

type HtmlOptions = NetworkOptions & {
  maxImages?: number;
  registry?: MediaAssetRegistry;
};

export async function resolveMediaAssetsForHtml(
  input: string,
  options: HtmlOptions = {},
) {
  const registry = new MediaAssetRegistry();
  const pending = new Map<string, Promise<Localized>>();
  const maximum = Number.isFinite(options.maxImages)
    ? Math.max(0, Math.floor(options.maxImages!))
    : 12;
  let resolvedCount = 0,
    fallbackCount = 0;

  async function locate(
    url: string,
    query: string,
    name: string,
  ): Promise<Localized> {
    if (query)
      url =
        (await searchStockImages(query, { ...options, limit: 1 }))[0]?.url ??
        url;
    if (/^data:/i.test(url)) {
      try {
        return {
          ...embeddedBitmap(url, name || "Embedded image"),
          source: "cache",
        };
      } catch {
        /* Invalid embedded media gets the same offline treatment. */
      }
    }
    return localizeImageUrl(url, {
      ...options,
      registry: options.registry ?? registry,
      name: name || query,
      fallbackPrompt: query || name || url || "Editorial backdrop",
    });
  }

  // resolvedCount counts image placements, including procedural replacements. Excess placements are stripped.
  function placement(url: string, query = "", name = "") {
    if (resolvedCount >= maximum) return;
    resolvedCount++;
    const key = JSON.stringify([query, query ? "" : url]);
    let job = pending.get(key);
    if (!job) {
      job = locate(url, query, name);
      pending.set(key, job);
    }
    return job.then((result) => {
      registry.register(result);
      if (options.registry && !options.registry.get(result.assetId))
        options.registry.register(result);
      if (result.source === "procedural-fallback") fallbackCount++;
      return result;
    });
  }

  function rewriteCss(css: string) {
    // Track function nesting: strings in image-set() are sources, while strings in
    // type() or content are prose. CSS escapes may appear in function names and URLs.
    const tokens =
      /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|((?:[-\w]|\\(?:[\da-f]{1,6}\s?|[\s\S]))+)(\()?|[()]/gi;
    const argument =
      /\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|((?:\\[\s\S]|[^()'"\\])*))\s*\)/y;
    const stack: string[] = [];
    const pieces: (string | Promise<string>)[] = [];
    let offset = 0;
    for (let token = tokens.exec(css); token; token = tokens.exec(css)) {
      let raw: string;
      if (token[1]) {
        if (!token[2]) continue;
        const fn = unescapeCss(token[1]).toLowerCase();
        argument.lastIndex = tokens.lastIndex;
        const arg = fn === "url" || fn === "src" ? argument.exec(css) : null;
        if (!arg) {
          stack.push(fn);
          continue;
        }
        raw = arg[1] ?? arg[2] ?? arg[3];
        tokens.lastIndex = argument.lastIndex;
      } else if (token[0] === "(") {
        stack.push("");
        continue;
      } else if (token[0] === ")") {
        stack.pop();
        continue;
      } else if (
        /^["']/.test(token[0]) &&
        ["image-set", "-webkit-image-set", "image"].includes(stack.at(-1) ?? "")
      ) {
        raw = token[0].slice(1, -1);
      } else continue;

      const url = unescapeCss(raw.trim());
      if (url.startsWith("#") || /^data:(?!image\/)/i.test(url)) continue;
      const job = placement(url);
      pieces.push(
        css.slice(offset, token.index),
        job ? job.then(({ asset }) => "url(" + asset.data + ")") : "none",
      );
      offset = tokens.lastIndex;
    }
    pieces.push(css.slice(offset));
    return Promise.all(pieces).then((parts) => parts.join(""));
  }

  async function tag(name: string, raw: string, markup: string) {
    const lower = name.toLowerCase();
    const attrs = new Map<string, { raw: string; value: string }>();
    for (const m of raw.matchAll(
      /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      const key = m[1].toLowerCase();
      if (!attrs.has(key))
        attrs.set(key, {
          raw: m[0],
          value: decodeAttribute(m[2] ?? m[3] ?? m[4] ?? ""),
        });
    }
    const get = (key: string) => attrs.get(key)?.value ?? "";
    if (
      lower === "link" &&
      (/^(?:image)$/i.test(get("as")) ||
        attrs.has("imagesrcset") ||
        /\bicon\b/i.test(get("rel")))
    )
      return "";
    const style = attrs.get("style");
    const css = style ? rewriteCss(style.value) : undefined;
    let changed = !!css;
    const remove = (key: string) => {
      if (attrs.delete(key)) changed = true;
    };
    const put = (key: string, value: string) => {
      attrs.set(key, { raw: attribute(key, value), value });
      changed = true;
    };
    const image = lower === "img";
    const firstSrcsetUrl = image
      ? get("srcset").trim().split(/\s+/)[0]?.replace(/,+$/, "")
      : "";
    if (image || lower === "source") remove("srcset");
    const svg = lower === "image" || lower === "feimage";
    let mediaKey = "background";
    if (image || (lower === "input" && get("type").toLowerCase() === "image"))
      mediaKey = "src";
    else if (svg) mediaKey = attrs.has("href") ? "href" : "xlink:href";
    else if (lower === "video") mediaKey = "poster";
    const src = get(mediaKey).trim() || firstSrcsetUrl;
    const query = image ? get("data-stock-query").trim() : "";
    if (image) {
      remove("data-stock-query");
      remove("data-forma-asset-id");
    }
    if (svg && mediaKey === "href") remove("xlink:href");
    if ((src || query) && !(svg && src?.startsWith("#"))) {
      remove(mediaKey);
      const result = await placement(src, query, get("alt"));
      if (result) {
        put(mediaKey, result.asset.data);
        if (image) put("data-forma-asset-id", result.assetId);
      }
    }
    if (css) put("style", await css);
    if (!changed) return markup;
    const serialized = [...attrs.values()].map((a) => " " + a.raw).join("");
    return (
      "<" + name + serialized + (raw.trimEnd().endsWith("/") ? " />" : ">")
    );
  }

  // Consume quoted attributes and raw-text elements as units so angle brackets inside them are preserved.
  const tags =
    /<!--[\s\S]*?(?:-->|$)|<(style|script|textarea|title)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(<\/\1\s*>|$)|<([a-z][\w:-]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const html = await replaceMatches(input, tags, async (m) => {
    if (m[1]) {
      const opening = "<" + m[1] + m[2] + ">";
      const start = tag(m[1], m[2], opening);
      const content = m[1].toLowerCase() === "style" ? rewriteCss(m[3]) : m[3];
      return (await start) + (await content) + m[4];
    }
    return m[5] ? tag(m[5], m[6], m[0]) : m[0];
  });
  // Browser-enforced backstop for other image syntaxes (e.g. escaped CSS image-set).
  // Place it before any resource, retaining standards mode for full srcdoc documents.
  const policy =
    '<meta http-equiv="Content-Security-Policy" content="img-src data:">';
  const output = html.replace(
    /^(\s*(?:<!doctype\s+html[^>]*>\s*)?(?:<html(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>\s*)?(?:<head(?=[\s>])(?:[^>"']|"[^"]*"|'[^']*')*>\s*)?)/i,
    (prefix: string) =>
      html.startsWith(policy, prefix.length) ? prefix : prefix + policy,
  );
  return {
    html: output,
    images: registry.toRecord(),
    resolvedCount,
    fallbackCount,
  };
}
