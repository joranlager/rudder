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

## Reload

Tap the **Rudder logo** (top left) **four times** quickly (within 2.5 seconds) for a hard reload: the
page and every file it loaded from Rudder's own site are fetched again past the browser cache, then
the page reloads at the same chart position. Useful right after a deploy, since GitHub Pages lets
browsers keep files for 10 minutes. Code: `public/reload.js`.

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

The search box finds places, lights, skerries and harbours in Kartverket's place-name register,
and, with BarentsWatch AIS access set up, **ships**: by name (Norwegian letters may be typed plainly,
so *vedero* finds VEDERØY), MMSI, IMO number or call sign. Ships come first in the results, with
their type, MMSI, call sign and when they were last heard. Choosing one switches the ships on, flies
close enough to see it as a 3D model and opens its card. BarentsWatch has no search by name, but
answers with every ship heard in Norwegian waters in the last 24 hours when asked for no particular
area; that list is fetched on the first ship search, kept for 10 minutes and searched on the device
(`matchVessels` in `public/ais.js`). Without AIS access the results offer to set it up.

## Land heights in 3D

Under the layers button, **Land heights in 3D** drapes the chart over Kartverket's terrain model
(hoydedata.no), with a light hillshade, as Rope does: the chart tilts to 50° when it is switched on
from a flat view, and lies flat again when it is switched off. The choice is remembered. MapLibre
draws 3D terrain from height tiles; no public service offers them for the Norwegian model, so each
tile is made on demand from Kartverket's elevation service (WCS `wcs.hoyde-dtm-nhm-25833`, coverage
`nhm_dtm_topo_25833`): a 128 x 128 GeoTIFF of heights is fetched, decoded, resampled to the map's
projection and written as a "Terrarium" picture (`public/terrain.js`, `public/demprotocol.js`, both
from Rope with their tests). Heights are drawn 1.5 times taller than true on the chart, and true from
a ship's bridge. Sea is height 0, so the ships stay on the water (the ship layer allows for the
ground height MapLibre lowers the world by when the middle of the view is on land).
Code: `public/landheights.js`.

**From the bridge.** MapLibre 4 stops drawing the ground a little below the horizon; from a bridge
some 15 m up that is only about a kilometre. So the bridge view adds a far view
(`public/farview.js`): drawn with three.js under everything else, it shows the land for 20 km
around the ship (one 384 x 384 height grid, about 105 m between samples, from the same service,
fetched again after 6 km) and the sea out to 40 km, with MapLibre's camera made to see 60 km. Up
close MapLibre's own chart, terrain and ships draw over it as usual, and its ground is drawn nearer
the true horizon while the view is on. The land is shown when the land heights are on; the sea always.

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

**Access.** BarentsWatch's AIS API needs a token from your own free BarentsWatch client (on
[Min side](https://www.barentswatch.no/minside/), under **Utviklertilganger**, open **AIS - API** and
create one). A web page cannot get that token itself: BarentsWatch's login server only lets its own
website read its answers in a browser (CORS: `access-control-allow-origin` is sent for
`https://www.barentswatch.no` only, whatever the client; checked 2026-11-24). The AIS API itself
answers any website.

WebAssembly does not get around this: it runs inside the browser under the same rules. So Rudder
gets the token one of three ways, none of which installs anything. **Get a new token** in the layers
panel, when one runs out (about an hour), picks the way that suits the device.

**Any browser (Windows, Mac, Linux, Android): the "Rudder token" bookmark** (`public/bwlogin.js`).
The login server's own site, `https://id.barentswatch.no`, is not cross-site to it, and its pages
show without logging in. Save your client ID and secret in **Settings → 1. Your BarentsWatch
client**, and drag the **Rudder token** link from Settings to the bookmarks bar (once). **Get token
from BarentsWatch** opens `id.barentswatch.no` in a new window; click the bookmark there. It runs as
part of that page: it asks Rudder (the window that opened it, by `postMessage` to Rudder's origin)
for the client ID and secret, posts them to `/connect/token`, sends the answer back and closes the
window. Rudder keeps the token, tests it and switches the ships on. The bookmark holds no secret,
Rudder answers only the window it opened and only while it shows `id.barentswatch.no` or
`www.barentswatch.no`, and the bookmark only talks to Rudder's origin. The login pages are
sandboxed without dialogs, so the bookmark reports in a banner at the top of the page, closed by a click (messages about using it in the wrong place also close by themselves). Clicked on Rudder itself, it opens Settings and points to **Get token from BarentsWatch** instead. On Android
Chrome, run it by typing its name in the address bar. Checked 2026-11-24: from that page the login
server answers (BarentsWatch's real `invalid_client` for a made-up client).

**iPhone, iPad, Mac: the Shortcuts app** (`public/handoff.js`), which is not a browser and not held
to CORS. Set up once, as Settings explains: a shortcut named exactly **Rudder token** with *Get
Contents of URL* (POST, form: `grant_type=client_credentials`, `client_id`, `client_secret`,
`scope=ais` to `https://id.barentswatch.no/connect/token`) and *Get Dictionary Value*
`access_token`. **Get token with Shortcuts** opens
`shortcuts://x-callback-url/run-shortcut?name=Rudder%20token&x-success=…`; Shortcuts runs it and
opens Rudder again with the token appended as `result`. Rudder takes it out of the address at once
(keeping the chart position). Shortcuts opens Rudder in the default browser, so use Rudder there.

**Windows or Mac: a command, then paste.** curl comes with Windows 10/11 and macOS. Settings shows the
command with your client filled in (`curl.exe … | clip` for PowerShell or Command Prompt,
`curl … | pbcopy` for Terminal); it copies BarentsWatch's answer to the clipboard, and **Paste token**
reads it back. A token, `Bearer …` or the whole JSON answer can also be pasted by hand.

The token and the client ID and secret are
kept **only on the device**, in the browser's storage for Rudder (`localStorage`,
`rudder.barentswatch.v1`; `public/credentials.js`), and sent only to BarentsWatch. There is no
Rudder server. Saving asks the browser to keep the data (`navigator.storage.persist`), and Settings
shows whether it agreed. On iPhone and iPad, Safari clears a website's storage after about 7 days
without a visit unless it is on the home screen; the app has a web manifest and icons for that.
**Remove my BarentsWatch access** in Settings deletes it all.

The layer asks only for the area in view (plus 30 %), from zoom 7, every 30 seconds and after a
pan out of that area; later polls ask only for what changed (`since`). Code: `public/ais.js`
(requests, decoding, shapes; tested) and `public/aismap.js` (fetching, drawing, panel).

**3D ships up close.** When the metric scale bar reads **200 m or less** (about zoom 14 and in), ships
with a known size and heading are drawn as **3D models** on the chart instead of flat outlines: the
same models as **Open 3D model** builds from AIS (type, length, beam, draught, name on the hull),
turned to their heading and placed by their GPS antenna. Tilt the chart (two fingers, or right-drag)
to see them from the side. Only the part above the waterline is drawn, since the chart is the sea.
Their outlines stay, invisible, so hovering and tapping work as before; ships without a heading
keep their dot. The scale reading is computed as MapLibre's scale bar does (`public/scalebar.js`).
The models are drawn with three.js in a MapLibre custom layer sharing the map's WebGL context
(`public/shipmodels.js`), at most the 40 ships nearest the middle of the view; each is built once
(5–15 ms) and only moved after that, with its hull painting reduced to 1024 px for the chart.
three.js is loaded the first time models are needed.

**The models move by themselves.** Between AIS reports each modelled ship is moved by dead reckoning
from its last report (`public/motion.js`): along its course over ground at its speed over ground,
on an arc while it reports a rate of turn (for at most a minute, then straight on), with the bow on
its reported heading. A ship not heard from for 5 minutes is held where it got to. Ships lying
still (under 1 kn, or at anchor, moored or aground and under 3 kn) are not dead reckoned and are held
steady: alongside, their GPS position wanders a few metres and their compass a few degrees, and their
course over ground points anywhere, which turned about the antenna made the stern swing. A steady
ship keeps its place and heading unless a report moves it more than 10 m or turns it more than 5°,
and its heading never comes from its course. When a new report arrives, the difference between where the ship was
shown and where the report puts it is eased away over 4 seconds, so ships never jump. While any
ship is under way the chart redraws about 30 times a second; when all lie still it redraws only
when needed. Hovering and tapping follow the moving model, not its last reported position.

**View from the bridge.** In a ship's card, **View from the bridge** puts the chart's camera on that
ship's bridge, looking along its heading, and moves it with the ship (dead reckoning between
reports, as the models do). The eye is at the ship's GPS antenna, at the bridge's height estimated
from its model (freeboard, the decks below the bridge, 1.7 m eye height), looking at the sea far
enough ahead that the horizon shows (82° from straight down). The ship's own deckhouse, funnels and
masts are hidden, since the eye is inside them; its hull and deck stay, so its bow is seen ahead.
Other ships in view are drawn as 3D models whatever the scale. While the view is on, the chart
cannot be dragged or zoomed: the ship moves it. The bar at the bottom shows speed and heading, looks
**Port**, **Ahead**, **Stbd** or **Astern** (or ← → in 15° steps, ↑ ahead, ↓ astern), and **Exit**
(or Esc) puts the chart back as it was. It needs the ship's size and heading from AIS. Code:
`public/pov.js`, using MapLibre's `calculateCameraOptionsFromTo` with the tilt limit raised to 85°.

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
