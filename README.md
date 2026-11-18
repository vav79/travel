# Скрипты сборки данных OpenStreetMap для офлайн-пакетов городов

Здесь — всё, чем из данных OpenStreetMap собираются три части пакета города в приложении-путеводителе:
офлайн-карта, база отелей и граф пешеходных маршрутов. Код приложения и контент (места, правила, фразы) сюда не входят.

## Данные в текущих пакетах

| Регион | Что | Источник | Данные OSM на | Лицензия |
|---|---|---|---|---|
| tr-antalya | Офлайн-карта (PMTiles) | Protomaps daily build 20261117 (https://build.protomaps.com/20261117.pmtiles) | 2026-11-17 | ODbL — Produced Work; стиль Protomaps — CC0 |
| tr-antalya | База отелей (JSON) | Overpass API, tourism=hotel/resort/apartment/guest_house/hostel/motel | 2026-11-18 | ODbL 1.0 — производная база данных |
| tr-antalya | Граф пешеходных маршрутов | Geofabrik turkey-261117.osm.pbf (md5 3df085693284dd15a36ea9ed8085053a), фильтр v2 | 2026-11-17 | ODbL 1.0 — производная база данных |

Рамки регионов — `regions.json`.

## Как пересобрать

Нужен Node.js 22.18 или новее (запускает TypeScript без сборки).

```
npm install
# 1. Офлайн-карта: вырезка региона из ежедневной сборки Protomaps → build/maps/<регион>.pmtiles
node map/extract-city.ts --city tr-antalya --build 20261117
# 2. База отелей: один запрос к Overpass API → build/hotels/<регион>.osm.json
node hotels/fetch-osm-hotels.ts tr-antalya
# 3. Граф пешеходных маршрутов из региональной выгрузки Geofabrik → build/routing/<регион>.walk.graph(.gz) + provenance.json
#    выгрузку скачайте сами: https://download.geofabrik.de/europe/turkey.html
node --max-old-space-size=6144 routing/build-graph.ts --pbf turkey-261117.osm.pbf --city tr-antalya
```

Формат графа (`WG01`, little-endian) описан в начале `routing/graph.ts`: координаты узлов, смежность в формате CSR,
длины рёбер в дециметрах. Фильтр дорог (v2) — в `routing/build-graph.ts`, функция `walkable`; в граф входит только
самая большая связная часть сети.

## Лицензии

- **Данные:** © участники OpenStreetMap, Open Database License (ODbL) 1.0 — https://www.openstreetmap.org/copyright .
  База отелей и граф маршрутов — производные базы данных OSM и распространяются под ODbL 1.0.
  Офлайн-карта — изображение по данным OSM (Produced Work); стиль карты Protomaps — CC0.
- **Источники:** Protomaps daily builds (https://maps.protomaps.com/builds/), Geofabrik (https://download.geofabrik.de/),
  Overpass API (https://wiki.openstreetmap.org/wiki/Overpass_API).
- **Код скриптов:** MIT (файл `LICENSE`).
