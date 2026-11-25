import { Inflate } from "fflate";
import { checkDesignFileSize } from "./types";

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(bytes: Uint8Array) {
  let checksum = -1;
  for (const value of bytes)
    checksum = crcTable[(checksum ^ value) & 255] ^ (checksum >>> 8);
  return (checksum ^ -1) >>> 0;
}
interface Entry {
  start: number;
  compressed: number;
  size: number;
  method: number;
  crc: number;
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
export function openDesignArchive(bytes: Uint8Array) {
  checkDesignFileSize(bytes.length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true);
  const u32 = (p: number) => view.getUint32(p, true);
  let end = bytes.length - 22;
  const lower = Math.max(0, end - 65535);
  while (
    end >= lower &&
    !(u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length)
  )
    end--;
  if (end < lower) throw Error("找不到完整的 ZIP 文件目录");
  const count = u16(end + 10);
  let cursor = u32(end + 16),
    total = 0;
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    count > 50000 ||
    cursor + u32(end + 12) !== end
  )
    throw Error("不支持此归档目录或条目数");
  const directoryStart = cursor;
  const entries = new Map<string, Entry>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50)
      throw Error("ZIP 条目目录不完整");
    const method = u16(cursor + 10),
      flags = u16(cursor + 8),
      size = u32(cursor + 24),
      compressed = u32(cursor + 20);
    const nameEnd = cursor + 46 + u16(cursor + 28),
      next = nameEnd + u16(cursor + 30) + u16(cursor + 32);
    if (next > end) throw Error("ZIP 条目超出目录边界");
    const name = utf8.decode(bytes.subarray(cursor + 46, nameEnd));
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").some((p) => p === ".." || p === ".") ||
      entries.has(name)
    )
      throw Error("ZIP 条目路径无效或重复");
    total += size;
    if (size > 192 * 1024 * 1024 || total > 512 * 1024 * 1024)
      throw Error("文件解压后超过支持的内存预算");
    if ((method !== 0 && method !== 8) || flags & 1)
      throw Error("不支持此 ZIP 压缩或加密方式");
    const local = u32(cursor + 42);
    if (
      local + 30 > directoryStart ||
      u32(local) !== 0x04034b50 ||
      u16(local + 8) !== method ||
      u16(local + 6) !== flags
    )
      throw Error("ZIP 本地条目头无效");
    const localNameEnd = local + 30 + u16(local + 26),
      start = localNameEnd + u16(local + 28);
    if (
      start + compressed > directoryStart ||
      utf8.decode(bytes.subarray(local + 30, localNameEnd)) !== name
    )
      throw Error("ZIP 内容范围与目录不符");
    entries.set(name, {
      start,
      compressed,
      size,
      method,
      crc: u32(cursor + 16),
    });
    cursor = next;
  }
  if (cursor !== end) throw Error("ZIP 条目计数不符");
  return {
    names: [...entries.keys()],
    has: (name: string) => entries.has(name),
    read(name: string): Uint8Array {
      const entry = entries.get(name);
      if (!entry) throw Error("归档中缺少 " + name);
      const source = bytes.subarray(
        entry.start,
        entry.start + entry.compressed,
      );
      let result: Uint8Array;
      if (entry.method === 0) result = source;
      else {
        result = new Uint8Array(entry.size);
        let written = 0;
        const decoder = new Inflate((chunk) => {
          if (written + chunk.length > entry.size)
            throw Error("解压内容超过声明长度");
          result.set(chunk, written);
          written += chunk.length;
        });
        for (let at = 0; at < source.length; at += 8192)
          decoder.push(
            source.subarray(at, at + 8192),
            at + 8192 >= source.length,
          );
        if (written !== entry.size) throw Error("解压长度不符");
      }
      if (result.length !== entry.size || crc32(result) !== entry.crc)
        throw Error("ZIP 内容校验失败：" + name);
      return result;
    },
  };
}
