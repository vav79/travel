/**
 * Builds the pedestrian routing graph for a city package from a regional OSM extract (Geofabrik .osm.pbf),
 * not from Overpass. One streaming pass: nodes inside the bbox are kept, walkable ways are cut to the bbox,
 * then only the largest connected component is shipped (islands produce "no route" for random points).
 *   node routing/build-graph.ts --pbf build/osm/turkey-261117.osm.pbf --city tr-antalya [--bbox w,s,e,n] [--out-name tr-antalya]
 *        [--filter v1|v2] [--keep-islands] [--pairs 200]
 * Output: build/routing/<name>.walk.graph (+ .gz, shipped in the package), <name>.report.json, <name>.provenance.json (ODbL: source, date, script).
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { buildGraph, components, haversineM, routeAStar, serializeGraph, subgraph, type OsmWay } from './graph.ts';
import { readOsmPbf } from './osmPbf.ts';

const root = join(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    pbf: { type: 'string' },
    city: { type: 'string', default: 'tr-antalya' },
    bbox: { type: 'string' },
    'out-name': { type: 'string' },
    filter: { type: 'string', default: 'v2' },
    'keep-islands': { type: 'boolean', default: false },
    pairs: { type: 'string', default: '200' },
  },
});
if (!values.pbf || !existsSync(values.pbf)) {
  console.error('usage: build-graph.ts --pbf <extract.osm.pbf> --city <id> [--bbox w,s,e,n]');
  process.exit(2);
}
const regions = JSON.parse(readFileSync(join(root, 'regions.json'), 'utf8')) as { id: string; bounds: [number, number, number, number] }[];
const bbox = (values.bbox?.split(',').map(Number) ?? regions.find((r) => r.id === values.city)?.bounds) as [number, number, number, number] | undefined;
if (!bbox || bbox.length !== 4) throw new Error(`no bbox for ${values.city}`);
const [W, S, E, N] = bbox;
const name = values['out-name'] ?? values.city!;

/**
 * Walkable ways.
 * v1 = the Overpass experiment's filter (kept to reproduce it).
 * v2 = adds trunk / trunk_link (in Turkey pedestrians may use them unless foot=no; city avenues are often trunk),
 *      pedestrian areas and bridleways; respects foot / access tags.
 */
const HIGHWAY_V1 = new Set(['footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'track', 'cycleway', 'tertiary_link', 'secondary_link', 'primary_link', 'corridor']);
const HIGHWAY_V2 = new Set([...HIGHWAY_V1, 'trunk', 'trunk_link', 'road', 'bridleway']);
const FOOT_YES = new Set(['yes', 'designated', 'permissive', 'destination']);
function walkable(t: Record<string, string>): boolean {
  const hw = t.highway;
  if (!hw || !(values.filter === 'v1' ? HIGHWAY_V1 : HIGHWAY_V2).has(hw)) return false;
  if (t.foot === 'no' || t.foot === 'private' || t.foot === 'use_sidepath') return false;
  if ((t.access === 'private' || t.access === 'no') && !FOOT_YES.has(t.foot ?? '')) return false;
  if (values.filter !== 'v1' && (t.sidewalk === 'no' || t.sidewalk === 'none') && (hw === 'trunk' || hw === 'trunk_link') && !FOOT_YES.has(t.foot ?? '')) return false;
  return true;
}

const t0 = performance.now();
const coords = new Map<number, [number, number]>();
const ways: OsmWay[] = [];
let header: { replicationTimestamp?: number; writingProgram?: string } = {};
let waysSeen = 0;
readOsmPbf(values.pbf, {
  header: (h) => (header = h),
  node: (n) => {
    if (n.lon >= W && n.lon <= E && n.lat >= S && n.lat <= N) coords.set(n.id, [n.lon, n.lat]);
  },
  way: (w) => {
    waysSeen++;
    if (!walkable(w.tags)) return;
    // Cut to the bbox: consecutive runs of nodes that are inside.
    let run: number[] = [];
    const flush = () => {
      if (run.length > 1) ways.push({ nodes: run, coords: run.map((id) => coords.get(id)!) });
      run = [];
    };
    for (const id of w.refs) {
      if (coords.has(id)) run.push(id);
      else flush();
    }
    flush();
  },
});
const readMs = performance.now() - t0;

const full = buildGraph(ways);
const comp = components(full);
const graph = values['keep-islands'] ? full : subgraph(full, (i) => comp.label[i] === comp.largest);
const bin = serializeGraph(graph);

// Same pseudo-random pairs as the Overpass experiment (scripts/routing/experiment.ts).
const rnd = (() => {
  let x = 42;
  return () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
})();
const pairs = Number(values.pairs);
function bench(maxM: number | null) {
  const times: number[] = [];
  let found = 0;
  for (let i = 0; i < pairs; i++) {
    const a = Math.floor(rnd() * graph.nodeCount);
    let b = Math.floor(rnd() * graph.nodeCount);
    // Walking-sized pairs: resample the target until it is within maxM of the start (as the crow flies).
    for (let k = 0; maxM !== null && k < 500 && haversineM(graph.lonlat[a * 2]!, graph.lonlat[a * 2 + 1]!, graph.lonlat[b * 2]!, graph.lonlat[b * 2 + 1]!) > maxM; k++) b = Math.floor(rnd() * graph.nodeCount);
    const t = performance.now();
    if (routeAStar(graph, a, b)) found++;
    times.push(performance.now() - t);
  }
  times.sort((x, y) => x - y);
  const pct = (p: number) => +times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!.toFixed(1);
  return { pairs, found, p50ms: pct(50), p90ms: pct(90), maxMs: pct(100) };
}
const anyPairs = bench(null);
const walkPairs = bench(5000);

const md5 = await new Promise<string>((res, rej) => {
  const h = createHash('md5');
  createReadStream(values.pbf!).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
const osmDataAt = header.replicationTimestamp ? new Date(header.replicationTimestamp * 1000).toISOString() : null;
const out = join(root, 'build', 'routing');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${name}.walk.graph`), bin);
// Shipped compressed in the package (routing/walk.graph.gz); the app inflates it with fflate.
writeFileSync(join(out, `${name}.walk.graph.gz`), gzipSync(bin, { level: 9 }));
const sortedSizes = [...comp.sizes].sort((a, b) => b - a);
const report = {
  name,
  bbox,
  filter: values.filter,
  waysInExtract: waysSeen,
  walkableWayRuns: ways.length,
  components: comp.sizes.length,
  largestShare: +(sortedSizes[0]! / full.nodeCount).toFixed(4),
  droppedIslandNodes: full.nodeCount - graph.nodeCount,
  nodes: graph.nodeCount,
  edges: graph.edgeCount,
  graphBytes: bin.length,
  graphGzipBytes: gzipSync(bin, { level: 9 }).length,
  readSeconds: Math.round(readMs / 1000),
  routes: anyPairs,
  walkingRoutesUpTo5km: walkPairs,
  engine: 'Node/V8',
};
writeFileSync(join(out, `${name}.report.json`), JSON.stringify(report, null, 2) + '\n');
const provenance = {
  kind: 'walking graph (derivative database of OpenStreetMap)',
  license: 'ODbL 1.0',
  attribution: '© OpenStreetMap contributors',
  source: { file: basename(values.pbf), url: `https://download.geofabrik.de/europe/${basename(values.pbf)}`, md5, osmDataAt, provider: 'Geofabrik GmbH' },
  bbox,
  filter: values.filter,
  islands: values['keep-islands'] ? 'kept' : 'dropped (largest connected component only)',
  script: 'routing/build-graph.ts',
  builtAt: new Date().toISOString(),
};
writeFileSync(join(out, `${name}.provenance.json`), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ ...report, osmDataAt }, null, 2));
