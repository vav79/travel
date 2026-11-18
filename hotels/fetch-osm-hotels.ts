/**
 * Fetches accommodation objects for a city region from OpenStreetMap (Overpass API) into
 * build/hotels/<cityId>.osm.json. Data © OpenStreetMap contributors, ODbL.
 *   node hotels/fetch-osm-hotels.ts tr-antalya
 * One query per run; respects the Overpass usage policy (single request, identifying User-Agent).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Region = { id: string; bounds: [number, number, number, number] };
type OsmEl = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };

const cityId = process.argv[2];
if (!cityId) throw new Error('usage: fetch-osm-hotels.ts <cityId>');
const root = join(import.meta.dirname, '..');
const region = (JSON.parse(readFileSync(join(root, 'regions.json'), 'utf8')) as Region[]).find((r) => r.id === cityId);
if (!region) throw new Error(`unknown region ${cityId}`);
const [w, s, e, n] = region.bounds;

const query = `[out:json][timeout:120];nwr["tourism"~"^(hotel|resort|apartment|guest_house|hostel|motel)$"](${s},${w},${n},${e});out tags center;`;
// Overpass often answers 502/504 under load: retry a few times with growing pauses.
// Public Overpass instances (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
const ENDPOINTS = [process.env.OVERPASS_URL, 'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'].filter(Boolean) as string[];
let res: Response | null = null;
for (let attempt = 1; attempt <= 4; attempt++) {
  const endpoint = ENDPOINTS[(attempt - 1) % ENDPOINTS.length]!;
  console.log(`querying ${endpoint}`);
  res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'travel-app-package-build/0.1' },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (res.ok) break;
  console.warn(`Overpass ${res.status}, retry ${attempt}/4`);
  await new Promise((r) => setTimeout(r, 15_000 * attempt));
}
if (!res?.ok) throw new Error(`Overpass ${res?.status}`);
const data = (await res.json()) as { osm3s?: { timestamp_osm_base?: string }; elements: OsmEl[] };

const composeAddress = (t: Record<string, string>) => {
  if (t['addr:full']) return t['addr:full'];
  const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
  const parts = [street, t['addr:neighbourhood'] ?? t['addr:suburb'], t['addr:district'], t['addr:city'], t['addr:postcode']].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
};

const hotels = data.elements
  .filter((el) => el.tags?.name)
  .map((el) => {
    const t = el.tags!;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    return {
      osmRef: `${el.type}/${el.id}`,
      kind: t.tourism,
      name: t.name,
      nameRu: t['name:ru'] ?? null,
      nameEn: t['name:en'] ?? null,
      addressLocal: composeAddress(t),
      phone: t.phone ?? t['contact:phone'] ?? null,
      coord: lat !== undefined && lon !== undefined ? [Number(lon.toFixed(6)), Number(lat.toFixed(6))] : null,
    };
  })
  .filter((h) => h.coord);

const out = {
  source: {
    id: 'osm-overpass-hotels',
    title: 'OpenStreetMap (Overpass API) — tourism=hotel|resort|apartment|guest_house|hostel|motel',
    url: `https://www.openstreetmap.org/#map=11/${region.bounds[1]}/${region.bounds[0]}`,
    license: 'ODbL 1.0, © OpenStreetMap contributors',
    osmBase: data.osm3s?.timestamp_osm_base ?? null,
    fetchedAt: new Date().toISOString(),
  },
  hotels,
};
mkdirSync(join(root, 'build', 'hotels'), { recursive: true });
writeFileSync(join(root, 'build', 'hotels', `${cityId}.osm.json`), JSON.stringify(out));
const withAddr = hotels.filter((h) => h.addressLocal).length;
console.log(`${cityId}: ${hotels.length} named objects, ${withAddr} with address, ${hotels.filter((h) => h.phone).length} with phone`);
