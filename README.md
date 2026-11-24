# Rudder

A marine simulator on Norway's official, public sea charts and marine data. This first part is
the map: real charts, depths and live marine conditions, plus a 3D ship inspector that builds the
vessels (see [Ships](#ships)).

It is plain static files with no backend, so it runs on GitHub Pages.

```bash
npm start      # http://localhost:8080 (local static server)
npm test       # parsers, URL builders, navigation maths, AIS, ship models
npm run vendor # rebuilds public/vendor/three.js from the pinned devDependencies (after npm ci)
npm run build  # copies public/ to dist/ and stamps the build
```

## Deploy

`.github/workflows/pages.yml` tests, builds and deploys **every branch** to GitHub Pages on each
push. All branches share one Pages site, so **the last deploy wins**: a newer run cancels one still
in progress. The footer shows which branch and commit is live.

## Map

| Layer | Source | Service |
|---|---|---|
| Nautical chart (default background) | Kartverket | WMTS `cache.kartverket.no`, layer `sjokartraster`, web mercator |
| Topographic, grey and colour | Kartverket | WMTS `topograatone`, `topo` |
| Depth areas (from zoom 9) | Kartverket | WMS `wms.dybdedata2`, `Dybdelag` |
| Depth contours, soundings, rocks (from zoom 12) | Kartverket | WMS `wms.dybdedata2` |
| Not surveyed areas | Kartverket | WMS `wms.dybdedata2`, `IkkeSjomalt` |
| Pilotage guidelines | Kystverket (Routeinfo) | WMS `a3cloudmap.kystverket.no`, `layer_52` |
| Wave forecast, ice chart, fishing gear | BarentsWatch | WMS `geo.barentswatch.no/geoserver` |

Choose the background and overlays, and each overlay's opacity, under the layers button. The choice
is remembered on the device. The map position is kept in the address (`#at=zoom/lat/lon`), so a
link opens the same view. The scale shows nautical miles and metres, and the pointer position is
shown in degrees and decimal minutes.

## Tap the sea

Tapping a point shows, for that position:

- **Depth band** below chart datum, from Kartverket's depth areas (WMS GetFeatureInfo). Where
  surveys overlap, the narrowest band is used.
- **Tide**: level now (forecast, else prediction), observed level, rising or falling, the next low
  and high, and a curve for the next day, from Kartverket's tide API (Se havnivå), above chart datum.
- **Sea now**: significant wave height and direction, surface current and sea temperature, from
  MET Norway's oceanforecast.
- **Weather now**: wind, air temperature and pressure, from MET Norway's locationforecast.

The search box finds places, lights, skerries and harbours in Kartverket's place-name register.

## Ships on the chart (AIS)

Under the layers button, **Ships (AIS)** (once access is set up in Settings) shows live ship positions from Kystverket's AIS, served by
BarentsWatch (Norwegian waters). Each ship is an arrow in its type's colour, turned to its heading
(a dot when the heading is unknown); from zoom 13 it is drawn at its true size and heading, placed
by where its GPS antenna sits. Reports older than 15 minutes are faded and those older than two
hours dropped. Hover for the name; tap a ship for its card (type, status, speed, course, size,
draught, destination, MMSI, IMO, call sign) and **Open 3D model**, which builds it in the ship
inspector from its AIS report: length, beam and draught from AIS (marked *AIS*), the rest
estimated from its type, and, when its IMO number is on Wikidata, its type, height and photos from
there.

**Access.** BarentsWatch's AIS API needs your own free BarentsWatch client. On
[Min side](https://www.barentswatch.no/minside/), under **Utviklertilganger**, open **AIS - API**
(not BarentsWatch - API) and create a client. Then open **Settings** (the gear in the top bar), enter
the client ID and secret under **BarentsWatch AIS**, and press **Save on this phone**: Rudder tests
them at once (a token, then a small AIS request) and says what is wrong if anything is.

They are kept **only on the device**, in the browser's storage for Rudder (`localStorage`,
`rudder.barentswatch.v1`; `public/credentials.js`), and sent only to BarentsWatch. There is no Rudder
server. Saving asks the browser to keep the data (`navigator.storage.persist`), and Settings shows
whether it agreed. On iPhone and iPad, Safari clears a website's storage after about 7 days without a
visit, so add Rudder to the home screen (Share → Add to Home Screen) and open it from there; the app
has a web manifest and icons for that. **Remove my BarentsWatch access** in Settings deletes them.
Anyone who can use the phone unlocked can use the access too.

Whether BarentsWatch's login server answers a web page is not yet verified with a real client. If it
does not, Settings says so, and **Use an access token instead** takes a token fetched elsewhere
(valid about an hour). The AIS API itself answers browsers (CORS `*`, checked 2026-11-23). For other
people to use Rudder, put a small relay in front that keeps the secret (for example behind a Google
sign-in).

The layer asks only for the area in view (plus 30 %), from zoom 7, every 30 seconds and after a
pan out of that area; later polls ask only for what changed (`since`). Code: `public/ais.js`
(requests, decoding, shapes; tested) and `public/aismap.js` (fetching, drawing, panel).

## Ships

**Ships** in the top bar covers the chart with a 3D ship inspector (`public/ships/`). Close it with
the same button, the × in its sheet, Escape, or the layers button.

- **Find a ship** on Wikidata (SPARQL, limited to ships, boats and ship classes): type, class,
  dimensions, tonnage, speed, builder, operator, flag, home port, IMO/MMSI and service dates, with
  photos from Wikimedia Commons (the item's image, its category and a text search).
- **Build** the hull from length, beam, draft, depth and fullness, with a bulbous, raked, plumb or
  clipper bow and a transom or cruiser stern. Deckhouses, funnels, masts, cargo and sails follow the
  vessel type (container ship, tanker, bulk, cargo, cruise ship, ferry, liner, warship, aircraft
  carrier, sailing ship, yacht, tug). Values missing on Wikidata are estimated and marked *est.*
- **Livery** sampled from a photo (k-means, sky and water left out); name, port of registry, side
  name, IMO number, draft marks and load-line mark painted on the hull.
- **Look** in a studio, at sea (sea state, speed with a wake, sun height; the hull heaves, pitches
  and rolls on the waves) or under water, with dimension lines in metres or feet.
- **Export** Wavefront `.obj` + `.mtl` + the painted hull pictures (metres, Y up, bow towards +X).

It is loaded the first time it is opened, so the chart never waits for three.js (about 0.7 MB,
vendored in `public/vendor/three.js` by `npm run vendor`). The hull builder takes the same inputs
an AIS static report carries (length and beam from the antenna offsets, draught, ship type), so
ships in sight on the chart can later be modelled from AIS; Wikidata and Commons then fill in what
AIS does not carry, matched by IMO/MMSI.

## Not used, and why

- **ENC (S-57) WMS** `wms.geonorge.no/skwms1/wms.ecc_enc`: restricted to approved IP addresses.
- **Kystverket's raw AIS feed**: a TCP socket, which browsers can't open (the AIS layer uses
  BarentsWatch's API instead, see above).
- **High-resolution bathymetry** inside 12 nm is graded (military restriction); public depth data
  there is coarse.

All services are open data (NLOD / CC BY 4.0), need no key and allow browser requests (CORS).
Every layer credits its source on the map.
