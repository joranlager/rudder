# Rudder

A marine simulator on Norway's official, public sea charts and marine data. This first part is
the map: real charts, depths and live marine conditions. The vessel comes next.

It is plain static files with no backend, so it runs on GitHub Pages.

```bash
npm start      # http://localhost:8080 (local static server)
npm test       # parsers, URL builders, navigation maths
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

## Not used, and why

- **ENC (S-57) WMS** `wms.geonorge.no/skwms1/wms.ecc_enc`: restricted to approved IP addresses.
- **Live AIS**: BarentsWatch's open AIS API needs an OAuth client secret, which a static page can't
  keep secret. Kystverket's raw AIS feed is a TCP socket, which browsers can't open.
- **High-resolution bathymetry** inside 12 nm is graded (military restriction); public depth data
  there is coarse.

All services are open data (NLOD / CC BY 4.0), need no key and allow browser requests (CORS).
Every layer credits its source on the map.
