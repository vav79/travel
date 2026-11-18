/**
 * Verifies an extracted city PMTiles against the Protomaps source build: for sample points and every
 * zoom, the tile in our file must be byte-identical (after decompression) to the source tile.
 *   node map/verify-extract.ts tr-antalya <build> <lon,lat> [<lon,lat> ...]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FetchSource, PMTiles, type Source } from 'pmtiles';

const [cityId, build, ...points] = process.argv.slice(2);
if (!cityId || !build || points.length === 0) throw new Error('usage: verify-extract.ts <cityId> <build> <lon,lat>...');

const buf = readFileSync(join(import.meta.dirname, '..', 'build', 'maps', `${cityId}.pmtiles`));
const local: Source = {
  getKey: () => 'local',
  getBytes: async (offset: number, length: number) => {
    const s = buf.subarray(offset, offset + length);
    return { data: s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) as ArrayBuffer };
  },
};
const ours = new PMTiles(local);
const src = new PMTiles(new FetchSource(`https://build.protomaps.com/${build}.pmtiles`, new Headers({ 'User-Agent': 'travel-app-package-build/0.1' })));

let bad = 0;
for (const p of points) {
  const [lon, lat] = p.split(',').map(Number) as [number, number];
  for (let z = 0; z <= 15; z++) {
    const x = Math.floor(((lon + 180) / 360) * 2 ** z);
    const r = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
    const [a, b] = await Promise.all([ours.getZxy(z, x, y), src.getZxy(z, x, y)]);
    const same = !!a && !!b && Buffer.from(a.data).equals(Buffer.from(b.data));
    if (!same) bad++;
    console.log(`${p} z${z} ${x}/${y}: ours=${a?.data.byteLength ?? 'none'} src=${b?.data.byteLength ?? 'none'} ${same ? 'OK' : 'MISMATCH'}`);
  }
}
console.log(bad ? `${bad} mismatches` : 'all tiles identical');
process.exit(bad ? 1 : 0);
