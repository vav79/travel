/**
 * Cuts a city region out of a Protomaps daily build into a local PMTiles file.
 *   node map/extract-city.ts --city tr-antalya [--build 20261117] [--maxzoom 15]
 * Regions are defined in regions.json. Output: build/maps/<city>.pmtiles + <city>.json (provenance).
 * Data: © OpenStreetMap contributors (ODbL), Protomaps basemap (tiles = OSM produced work).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { FetchSource, PMTiles } from 'pmtiles';

import { tileRange, writePmtiles, type TileInput } from './pmtilesWriter.ts';

type Region = { id: string; name: string; bounds: [number, number, number, number]; center: [number, number, number] };

const { values } = parseArgs({
  options: {
    city: { type: 'string' },
    build: { type: 'string' },
    maxzoom: { type: 'string', default: '15' },
  },
});
if (!values.city) throw new Error('--city is required');

const root = join(import.meta.dirname, '..');
const regions = JSON.parse(readFileSync(join(root, 'regions.json'), 'utf8')) as Region[];
const region = regions.find((r) => r.id === values.city);
if (!region) throw new Error(`Unknown region ${values.city}`);
const maxZoom = Number(values.maxzoom);

async function latestBuild(): Promise<string> {
  for (let back = 0; back < 10; back++) {
    const d = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
    const res = await fetch(`https://build.protomaps.com/${d}.pmtiles`, { method: 'HEAD' });
    if (res.ok) return d;
  }
  throw new Error('No Protomaps build found in the last 10 days');
}

const build = values.build ?? (await latestBuild());
const url = `https://build.protomaps.com/${build}.pmtiles`;
const src = new PMTiles(new FetchSource(url, new Headers({ 'User-Agent': 'travel-app-package-build/0.1' })));
const header = await src.getHeader();
const metadata = (await src.getMetadata()) as Record<string, unknown>;

const tiles: TileInput[] = [];
let raw = 0;
for (let z = header.minZoom; z <= maxZoom; z++) {
  const r = tileRange(region.bounds, z);
  const jobs: [number, number][] = [];
  for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push([x, y]);
  for (let i = 0; i < jobs.length; i += 32) {
    const batch = jobs.slice(i, i + 32);
    const res = await Promise.all(batch.map(([x, y]) => src.getZxy(z, x, y)));
    res.forEach((t, k) => {
      if (!t?.data) return;
      const [x, y] = batch[k]!;
      raw += t.data.byteLength;
      // The reader returns decompressed MVT; store gzip (tileCompression = 2), as in the source build.
      tiles.push({ z, x, y, data: gzipSync(new Uint8Array(t.data)) });
    });
  }
  process.stdout.write(`z${z} done (${tiles.length} tiles)\n`);
}

const attribution = '© OpenStreetMap contributors';
const file = writePmtiles(tiles, {
  tileCompression: 2,
  tileType: 1,
  minZoom: header.minZoom,
  maxZoom,
  bounds: region.bounds,
  center: region.center,
  metadata: { ...metadata, name: region.name, attribution, source_build: build, bounds: region.bounds },
});

const outDir = join(root, 'build', 'maps');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${region.id}.pmtiles`), file);
writeFileSync(
  join(outDir, `${region.id}.json`),
  JSON.stringify(
    {
      region: region.id,
      source: url,
      sourceBuild: build,
      maxZoom,
      bounds: region.bounds,
      tiles: tiles.length,
      bytes: file.length,
      rawBytes: raw,
      license: 'ODbL 1.0 (OpenStreetMap produced work); Protomaps basemap design CC0',
      attribution,
      extractedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);
console.log(`${region.id}: ${tiles.length} tiles, ${(file.length / 1048576).toFixed(2)} MB (raw ${(raw / 1048576).toFixed(2)} MB)`);
