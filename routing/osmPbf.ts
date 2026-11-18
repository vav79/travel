/**
 * Minimal streaming reader for OSM .osm.pbf extracts (https://wiki.openstreetmap.org/wiki/PBF_Format).
 * Reads blob by blob (zlib only — what Geofabrik ships), decodes nodes (plain and dense) and ways; relations are skipped.
 * Memory stays bounded: the caller decides what to keep (e.g. only nodes inside a bbox).
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import Pbf from 'pbf';

export type PbfHeader = { writingProgram?: string; replicationTimestamp?: number; replicationBaseUrl?: string; requiredFeatures: string[] };
export type PbfNode = { id: number; lon: number; lat: number; tags: Record<string, string> | null };
export type PbfWay = { id: number; refs: number[]; tags: Record<string, string> };
export type PbfHandlers = { header?(h: PbfHeader): void; node?(n: PbfNode): void; way?(w: PbfWay): void; wantNodeTags?: boolean };

function readExactly(fd: number, len: number): Buffer | null {
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, null);
    if (n === 0) return off === 0 ? null : (() => { throw new Error('truncated .osm.pbf'); })();
    off += n;
  }
  return buf;
}

function blobData(bytes: Uint8Array): Uint8Array {
  const pbf = new Pbf(bytes);
  let raw: Uint8Array | null = null;
  let zlib: Uint8Array | null = null;
  pbf.readFields((tag, _r, p) => {
    if (tag === 1) raw = p!.readBytes();
    else if (tag === 3) zlib = p!.readBytes();
  }, null);
  if (raw) return raw;
  if (zlib) return inflateSync(zlib);
  throw new Error('unsupported blob compression (only raw and zlib)');
}

function readHeader(bytes: Uint8Array): PbfHeader {
  const h: PbfHeader = { requiredFeatures: [] };
  new Pbf(bytes).readFields((tag, _r, p) => {
    if (tag === 4) h.requiredFeatures.push(p!.readString());
    else if (tag === 16) h.writingProgram = p!.readString();
    else if (tag === 32) h.replicationTimestamp = p!.readVarint(true);
    else if (tag === 34) h.replicationBaseUrl = p!.readString();
  }, null);
  return h;
}

function readBlock(bytes: Uint8Array, on: PbfHandlers): void {
  const pbf = new Pbf(bytes);
  const strings: string[] = [];
  let granularity = 100;
  let latOff = 0;
  let lonOff = 0;
  const groups: [number, number][] = [];
  pbf.readFields((tag, _r, p) => {
    if (tag === 1) {
      const end = p!.readVarint() + p!.pos;
      while (p!.pos < end) {
        const key = p!.readVarint();
        if (key >> 3 === 1) strings.push(p!.readString());
        else p!.skip(key);
      }
    } else if (tag === 2) {
      const len = p!.readVarint();
      groups.push([p!.pos, p!.pos + len]);
      p!.pos += len;
    } else if (tag === 17) granularity = p!.readVarint();
    else if (tag === 19) latOff = p!.readVarint(true);
    else if (tag === 20) lonOff = p!.readVarint(true);
  }, null);
  const coord = (v: number, off: number) => 1e-9 * (off + granularity * v);
  const tagsOf = (keys: number[], vals: number[]) => {
    const t: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) t[strings[keys[i]!]!] = strings[vals[i]!]!;
    return t;
  };

  for (const [start, end] of groups) {
    pbf.pos = start;
    while (pbf.pos < end) {
      const key = pbf.readVarint();
      const field = key >> 3;
      const len = pbf.readVarint();
      const fEnd = pbf.pos + len;
      if (field === 2 && on.node) {
        // DenseNodes
        let ids: number[] = [];
        let lats: number[] = [];
        let lons: number[] = [];
        let kv: number[] = [];
        while (pbf.pos < fEnd) {
          const k = pbf.readVarint();
          const f = k >> 3;
          if (f === 1) ids = pbf.readPackedSVarint([]);
          else if (f === 8) lats = pbf.readPackedSVarint([]);
          else if (f === 9) lons = pbf.readPackedSVarint([]);
          else if (f === 10) kv = pbf.readPackedVarint([]);
          else pbf.skip(k);
        }
        let id = 0;
        let lat = 0;
        let lon = 0;
        let j = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]!;
          lat += lats[i]!;
          lon += lons[i]!;
          let tags: Record<string, string> | null = null;
          if (kv.length) {
            while (kv[j] !== 0 && j < kv.length) {
              if (on.wantNodeTags) (tags ??= {})[strings[kv[j]!]!] = strings[kv[j + 1]!]!;
              j += 2;
            }
            j++;
          }
          on.node({ id, lon: coord(lon, lonOff), lat: coord(lat, latOff), tags });
        }
      } else if (field === 1 && on.node) {
        let id = 0;
        let lat = 0;
        let lon = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        while (pbf.pos < fEnd) {
          const k = pbf.readVarint();
          const f = k >> 3;
          if (f === 1) id = pbf.readSVarint();
          else if (f === 2) keys = pbf.readPackedVarint([]);
          else if (f === 3) vals = pbf.readPackedVarint([]);
          else if (f === 8) lat = pbf.readSVarint();
          else if (f === 9) lon = pbf.readSVarint();
          else pbf.skip(k);
        }
        on.node({ id, lon: coord(lon, lonOff), lat: coord(lat, latOff), tags: keys.length && on.wantNodeTags ? tagsOf(keys, vals) : null });
      } else if (field === 3 && on.way) {
        let id = 0;
        let keys: number[] = [];
        let vals: number[] = [];
        let refs: number[] = [];
        while (pbf.pos < fEnd) {
          const k = pbf.readVarint();
          const f = k >> 3;
          if (f === 1) id = pbf.readVarint();
          else if (f === 2) keys = pbf.readPackedVarint([]);
          else if (f === 3) vals = pbf.readPackedVarint([]);
          else if (f === 8) refs = pbf.readPackedSVarint([]);
          else pbf.skip(k);
        }
        let r = 0;
        for (let i = 0; i < refs.length; i++) refs[i] = r += refs[i]!;
        on.way({ id, refs, tags: tagsOf(keys, vals) });
      }
      pbf.pos = fEnd;
    }
  }
}

/** Streams the file once, block by block. */
export function readOsmPbf(path: string, on: PbfHandlers): void {
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const lenBuf = readExactly(fd, 4);
      if (!lenBuf) break;
      const header = readExactly(fd, lenBuf.readUInt32BE(0))!;
      let type = '';
      let dataSize = 0;
      new Pbf(header).readFields((tag, _r, p) => {
        if (tag === 1) type = p!.readString();
        else if (tag === 3) dataSize = p!.readVarint();
      }, null);
      const blob = readExactly(fd, dataSize)!;
      const data = blobData(blob);
      if (type === 'OSMHeader') {
        const h = readHeader(data);
        const unsupported = h.requiredFeatures.filter((f) => f !== 'OsmSchema-V0.6' && f !== 'DenseNodes');
        if (unsupported.length) throw new Error(`unsupported .osm.pbf features: ${unsupported.join(', ')}`);
        on.header?.(h);
      } else if (type === 'OSMData') readBlock(data, on);
    }
  } finally {
    closeSync(fd);
  }
}
