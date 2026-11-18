/**
 * Minimal PMTiles v3 writer (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
 * Used by the package build to cut a city out of a Protomaps build without external binaries.
 * Verified by reading the output back with the official `pmtiles` JS library (pmtilesWriter.test.ts).
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { zxyToTileId } from 'pmtiles';

export type TileInput = { z: number; x: number; y: number; data: Uint8Array };

export type WriterOptions = {
  /** Compression of tile data as stored (2 = gzip, 1 = none). Tiles must already be in this form. */
  tileCompression: 1 | 2;
  /** 1 = MVT */
  tileType: number;
  minZoom: number;
  maxZoom: number;
  bounds: [minLon: number, minLat: number, maxLon: number, maxLat: number];
  center: [lon: number, lat: number, zoom: number];
  metadata: Record<string, unknown>;
  /** Max root directory size (spec: header + root ≤ 16 KB). Lower values force leaf directories (tests). */
  maxRootBytes?: number;
};

type Entry = { tileId: number; offset: number; length: number; runLength: number };

const HEADER_LEN = 127;
const ROOT_MAX = 16384 - HEADER_LEN;

function writeVarint(out: number[], n: number) {
  if (n < 0 || !Number.isSafeInteger(n)) throw new RangeError(`varint out of range: ${n}`);
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

export function serializeDirectory(entries: Entry[]): Uint8Array {
  const out: number[] = [];
  writeVarint(out, entries.length);
  let last = 0;
  for (const e of entries) {
    writeVarint(out, e.tileId - last);
    last = e.tileId;
  }
  for (const e of entries) writeVarint(out, e.runLength);
  for (const e of entries) writeVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    if (i > 0 && prev && e.offset === prev.offset + prev.length) writeVarint(out, 0);
    else writeVarint(out, e.offset + 1);
  });
  return Uint8Array.from(out);
}

function buildDirectories(entries: Entry[], rootMax: number): { root: Uint8Array; leaves: Uint8Array } {
  const root = gzipSync(serializeDirectory(entries));
  if (root.length <= rootMax) return { root, leaves: new Uint8Array() };
  for (let leafSize = 256; ; leafSize *= 2) {
    const rootEntries: Entry[] = [];
    const leafChunks: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const leaf = gzipSync(serializeDirectory(entries.slice(i, i + leafSize)));
      rootEntries.push({ tileId: entries[i]!.tileId, offset, length: leaf.length, runLength: 0 });
      leafChunks.push(leaf);
      offset += leaf.length;
    }
    const r = gzipSync(serializeDirectory(rootEntries));
    if (r.length <= rootMax) return { root: r, leaves: concat(leafChunks) };
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function writePmtiles(tiles: TileInput[], o: WriterOptions): Uint8Array {
  const sorted = tiles.map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id);

  // Deduplicate identical tile contents (e.g. open sea) and run-length encode consecutive repeats.
  const contentOffset = new Map<string, { offset: number; length: number }>();
  const dataChunks: Uint8Array[] = [];
  let dataLen = 0;
  const entries: Entry[] = [];
  for (const t of sorted) {
    const h = createHash('sha256').update(t.data).digest('hex');
    let c = contentOffset.get(h);
    if (!c) {
      c = { offset: dataLen, length: t.data.length };
      contentOffset.set(h, c);
      dataChunks.push(t.data);
      dataLen += t.data.length;
    }
    const last = entries[entries.length - 1];
    if (last && last.offset === c.offset && last.tileId + last.runLength === t.id) {
      last.runLength++;
    } else {
      entries.push({ tileId: t.id, offset: c.offset, length: c.length, runLength: 1 });
    }
  }

  const { root, leaves } = buildDirectories(entries, Math.min(o.maxRootBytes ?? ROOT_MAX, ROOT_MAX));
  const meta = gzipSync(Buffer.from(JSON.stringify(o.metadata)));
  const tileData = concat(dataChunks);

  const rootOff = HEADER_LEN;
  const metaOff = rootOff + root.length;
  const leafOff = metaOff + meta.length;
  const dataOff = leafOff + leaves.length;

  const header = new ArrayBuffer(HEADER_LEN);
  const v = new DataView(header);
  new Uint8Array(header).set(new TextEncoder().encode('PMTiles'), 0);
  v.setUint8(7, 3);
  const u64 = (pos: number, n: number) => v.setBigUint64(pos, BigInt(n), true);
  u64(8, rootOff);
  u64(16, root.length);
  u64(24, metaOff);
  u64(32, meta.length);
  u64(40, leafOff);
  u64(48, leaves.length);
  u64(56, dataOff);
  u64(64, tileData.length);
  u64(72, sorted.length); // addressed tiles
  u64(80, entries.length); // tile entries
  u64(88, dataChunks.length); // tile contents
  v.setUint8(96, 1); // clustered: data ordered by first tileId
  v.setUint8(97, 2); // internal compression gzip
  v.setUint8(98, o.tileCompression);
  v.setUint8(99, o.tileType);
  v.setUint8(100, o.minZoom);
  v.setUint8(101, o.maxZoom);
  const e7 = (pos: number, deg: number) => v.setInt32(pos, Math.round(deg * 1e7), true);
  e7(102, o.bounds[0]);
  e7(106, o.bounds[1]);
  e7(110, o.bounds[2]);
  e7(114, o.bounds[3]);
  v.setUint8(118, o.center[2]);
  e7(119, o.center[0]);
  e7(123, o.center[1]);

  return concat([new Uint8Array(header), root, meta, leaves, tileData]);
}

/** Tile x/y ranges covering a bbox at zoom z (Web Mercator). */
export function tileRange(bounds: WriterOptions['bounds'], z: number) {
  const [minLon, minLat, maxLon, maxLat] = bounds;
  const lon2x = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  return { x0: lon2x(minLon), x1: lon2x(maxLon), y0: lat2y(maxLat), y1: lat2y(minLat) };
}
