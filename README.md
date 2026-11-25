# Rudder

A marine simulator on Norway's official, public sea charts and marine data. This first part is
the map: real charts, depths and live marine conditions, plus a 3D ship inspector that builds the
vessels (see [Ships](#ships)).

It is plain static files with no backend, so it runs on GitHub Pages.

```bash
npm start      # http://localhost:8080 (local static server)
npm test       # parsers, URL builders, navigation maths, AIS, ship models
npm run vendor # rebuilds public/vendor/three.js and three-io.js from the pinned devDependencies (after npm ci)
npm run vessels # lists the models in public/vessels/ in its index.json
npm run webcams # works out where each webcam looks (public/webcams.json); behind a proxy: NODE_USE_ENV_PROXY=1
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
in progress. The footer shows which branch and commit is live. Every script and stylesheet the page
loads is stamped with that commit (`?v=<commit>`, `scripts/versioning.mjs`), so a browser never mixes
files from two deploys (GitHub Pages lets browsers keep files for ten minutes).

## Map

| Layer | Source | Service |
|---|---|---|
| Nautical chart (default background) | Kartverket | WMTS `cache.kartverket.no`, layer `sjokartraster`, web mercator |
| Topographic, grey and colour | Kartverket | WMTS `topograatone`, `topo` |
| Satellite | EOX (Copernicus Sentinel-2) | Sentinel-2 cloudless 2024, WMTS `tiles.maps.eox.at`, 10 m |
| Roads, bridges, buildings | OpenStreetMap via OpenFreeMap | Vector tiles `tiles.openfreemap.org/planet` (OpenMapTiles schema) |
| Road bridges in 3D | Statens vegvesen (NVDB) | API v4 `nvdbapiles.atlas.vegvesen.no`: bridges (type 60) and the road network with heights |
| Webcams | Statens vegvesen | WFS `ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs`, `CctvSimple_v2`; pictures `kamera.atlas.vegvesen.no` |
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

**Find a ship.** While the ships (AIS) are on and loading, a second search field, **Find a ship**,
sits next to **Ships** in the top bar (on a phone, on its own row below it). It finds ships by name
(Norwegian letters may be typed plainly, so *vedero* finds VEDERØY), MMSI, IMO number or call sign,
and lists each with its type, MMSI, call sign and when it was last heard. Choosing one flies close
enough to see it as a 3D model and opens its card. It searches the ships already loaded around the
map at once, and every ship heard in Norwegian waters in the last 24 hours: BarentsWatch has no
search by name, but answers with all of them when asked for no particular area, so that list is
fetched on the first search, kept for 10 minutes and searched on the device (`matchVessels` in
`public/ais.js`). If that list cannot be fetched, the results say why and still show the ships
near the map. The field is hidden while the ships are off or failing.

## Ships tracker: recording and playback

The **Ships tracker** button in the top bar (next to Settings) opens a panel for recording every
ship's AIS positions in Norwegian waters and playing them back.

**Recording.** Rudder has no server, so the open app does the recording: with **Record every ship's
positions** on, it asks BarentsWatch every minute for every ship's latest report (no area: all of
Norway; the first time in full, then only what changed) and keeps the positions in the browser's
database on this device (IndexedDB, `public/trackstore.js`). It records only while Rudder is open
with BarentsWatch access, and in one tab at a time (others say they are waiting). A position is
kept when the ship has moved 25 m or turned 5° since its last kept one, or 10 minutes have passed,
so ships lying alongside cost little (`public/track.js`, `public/recorder.js`). Positions older
than the chosen number of days (1 to 30) are dropped; **Clear recordings** deletes them all.
The recorder notes when it ran (stretches of polls a minute apart; a pause while Rudder was closed
starts a new stretch), and playback starts inside a stretch: a time before the recording began, or
in a pause, moves to the next stretch, and the panel says so. (The first poll also brings each
ship's latest report from up to a day before, which says little about that time.)
The panel shows the ships tracked, positions stored, the span recorded, positions in the last hour,
ships under way at the last poll and the storage used.

**Export and import.** **Export recordings** saves everything recorded (positions, ship descriptions
and when the recorder ran) as one file, `rudder-tracks-<date>.ndjson.gz`: gzip-compressed text with one
JSON value per line, a header first, then the ships, then each position as a compact array
`[mmsi, time, lat, lon, speed, course, heading]`. **Import recordings…** reads such a file back, on this
or another device, a batch at a time with progress, and adds it to what is recorded: positions are
stored once per ship and time, so importing a file twice (or one that overlaps the recording) adds
only what is new, and the summary says how much was already there. Lines that are not sound
positions are skipped and counted; a file that is not a Rudder tracks file is refused
(`public/trackfile.js`). The recordings on the device were moved to this keying once, when Rudder
first opened them after the change.

**Playback.** Choose where to start, a while ago (hours:minutes, for example 1:30) or a date and
time, and a speed (1x to 600x), and **Play back**. Live AIS pauses and the ships move as recorded:
between two recorded positions each ship follows a smooth curve that leaves the first and reaches
the second at the speed and course the ship reported there (a cubic Hermite curve), so turns come
out as arcs; where the course does not fit the move, the straight line is used. A ship silent for
more than 30 minutes waits at its last place for 15 minutes (two hours if it was lying still, as on
the live chart) and is then gone until it reports again. The 3D ships, the bridge view and tapping work as with live ships. The slider moves to any
point in the recording; Pause, Play and **Back to live** do what they say (`public/playback.js`).

**Traces.** Tap a ship and **Track this ship** (live) or **Give it a trace** (in playback): a
coloured line of where it sails, growing as it goes. Live, the line follows the ship where it is
drawn (between reports by dead reckoning, as the 3D ships), sampled every second; in playback it
follows the same smooth path as the ship. Each trace's colour can be changed and the line shown or
hidden, in the ship's card or under Traces in the panel; **Clear trace** empties the line and starts
it again from where the ship is now (recorded positions are not touched), and **Stop** ends the
trace. The ships tracked live, their colours and whether each line is shown are remembered on the
device, so tracking goes on after a reload; if positions are being recorded, the line is rebuilt
from the recording then (`public/livetraces.js`).

## Taking the helm

**Take the helm** (in a ship's card, or in the bar of the view from the bridge) gives you command of
that ship. Its real AIS reports are ignored while you have it; **Hand back the helm** lets the next
real report put it back where it really is. The ship moves by a handling model
(`public/shiphandling.js`) and the view goes to its bridge, with a bridge console below
(`public/helm.js`). The console is a compact strip along the bottom: a row of read-outs above one row
of controls (about 130 px on a computer, a third of a phone's screen), and the map ends where it
begins, so nothing hides behind it.

- **Engine telegraph**: one row from full astern to full ahead, with stop in the middle, and the
  engine's answer (the speed reached) beneath it. Speed builds up and dies away with the ship's size (a 140 m ferry takes about a
  minute to get most of the way; with the engine stopped it carries its way a long time), and astern
  gives about half the speed of ahead. Taking the helm keeps the order nearest the speed it had.
- **Steering stick**: drag the lever (or tap its track) to the port or starboard side for that much
  rudder, up to 35° at the ends; a yellow mark shows where the rudder actually is. Double-click it,
  or Midships, to centre it; Hard port and Hard stbd go to the ends; with the stick focused the arrow
  keys move it a degree at a time. The rudder follows at a believable speed (about 28 s hard over to hard over on a big ship)
  and turns the ship only with water flowing past it: the ship's own speed and the propeller's wash.
  Hard over gives a turning circle of about four ship lengths, and the ship loses speed in the turn.
  Tugs turn much tighter.
- **Thrusters**, where the type has them (ferries and cruise ships bow and stern; cargo ships,
  tankers, container ships and yachts a bow thruster; sailing ships and tugs none): push the bow or
  stern sideways, turning the ship on the spot or moving it sideways. They lose their grip as the
  ship gathers way, and have none from about 5 knots. Double-click a slider to stop a thruster.
- **Instruments**: gyro heading, speed over ground (and going astern or sideways), rate of turn,
  rudder angle (ordered and actual) and depth under the keel.
- **Other ships**: the ship cannot sail through them. Each ship is an outline (a box with a pointed
  bow, placed by its GPS antenna, where it is drawn now); a move that would push the outlines deeper
  into each other is refused and the ship stops, with a **collision** alarm naming the other ship.
  Moving apart is always allowed. (`public/contact.js`)
- **Ground**: every 2 seconds the hull is sounded at its bow, stern, antenna and both sides with
  Kartverket's height service (`ws.geonorge.no/hoydedata/v1/punkt`), which gives the depth at sea
  (from the chart's depth contours, harbour basins included) and the height on land. Land (a quay, a
  beach) or less water than the draught at any of these points puts the ship **aground** there: it
  stops, and only moving away from that point (astern off the bow, ahead off the stern, sideways off
  a side) takes it off.
- **Keys**: W/S engine, A/D rudder 5° at a time, X midships, Q/E bow thruster, Z/C stern thruster.

The chart symbols, card and search follow the simulated ship. **Bridge view** in the console leaves
or returns to the bridge, so the ship can also be conned from the chart. Speeds and turning come
from rules of thumb by type and size, not from any one ship's trials; wind and current are not
modelled.

**Looking around from the bridge**: drag (mouse or one finger) to look around and up or down; the
mouse wheel or a pinch zooms (like binoculars). The Port, Ahead, Stbd and Astern buttons put the view
back level and unzoomed. With the console open, the map ends where the console begins, so the view is
centred in the window above it. The eye is on the bridge, high enough to see over the bow and cargo
(about 8 % of the ship's length above the deck at least), and the ships within 6 km are drawn,
nearest first.

## Satellite, roads, bridges and buildings

**Satellite** (a background under the layers button) shows the land and sea as Copernicus's
Sentinel-2 satellites see them: EOX's cloud-free mosaic of 2024, 10 m a pixel, so it is sharp to
about zoom 14 and enlarged beyond. It is licensed CC BY-NC-SA 4.0: free for non-commercial use with
credit, which the map gives. (Norway's own aerial photos, Norge i bilder, are sharper, but their
open service answers only registered addresses, so a web page cannot use them.)

**Roads, bridges and buildings** (under Land in the layers panel, remembered) draws what is built on
the land from OpenStreetMap, over any background and under the ships (`public/infra.js`,
`public/infralayer.js`, tested):

- roads by class (motorways to paths) at their true width from zoom 15, railways, ferry routes,
  piers and runways; tunnels dashed;
- buildings raised to their height (from zoom 13);
- road bridges built in 3D (from zoom 13) as they are, from NVDB, Statens vegvesen's road database
  (`nvdbapiles.atlas.vegvesen.no`, API v4, NLOD; `public/nvdbbridges.js`, tested). Each bridge's type
  (suspension, cable-stayed, arch, box or girder, floating), length, longest span, width and outline
  come from its bridge record (object type 60); the deck follows the road over it at its real height
  above the sea (the road network's geometry has heights, NN2000; roads passing under the bridge are
  left out). The main span, as long as the bridge's longest span, is centred where the deck is
  highest. A suspension bridge gets two towers at its ends, a main cable on each side sagging a tenth
  of the span and hangers; a cable-stayed bridge two pylons with stays fanning out (NVDB does not say
  how many pylons: a bridge with one, like Grenlandsbrua, still gets two); an arch bridge an arch
  under its main span; others piers at the main span's ends and along the approaches. Breviksbrua
  (suspension, 676 m, main span 272 m) comes out with its deck at 48.7 m and its towers at 81 m.
  NVDB is asked for the map in cells of about 1 km, each once a visit.
- other bridges (railways, private roads, and where NVDB has no heights) from OpenStreetMap: a deck
  that rises from its ends and stands over the water, on piers, with two towers on long spans, and
  its outline on the water as a shadow. OpenStreetMap does not give a bridge's height, so it is
  estimated from its length (about 3 m + 2.6 % of the length, at most 70 m). A bridge cut into
  several tiles is put together by its OpenStreetMap id, so it is built as one.
- With land heights on, MapLibre stands extruded shapes on the ground, so a deck over a valley (not
  over the sea) is drawn that much too high.

Switching it on tilts the chart to show the heights. Best on the Satellite background with land
heights on.

## Webcams

Under the layers button, **Webcams** (remembered) shows Statens vegvesen's open cameras, about 900 at
ferry quays, bridges, harbours and along the roads, from its open WFS
(`ogckart-sn1.atlas.vegvesen.no/datex_3_1/wfs`, layer `CctvSimple_v2`, NLOD, answers any website).
Each is an icon with a cone turned the way it looks (a plain icon where that is not known; faded
when the camera reports a fault).

**Tap a camera** for its card: its latest picture, where it looks and how sure that is, and the
ships with AIS in its view now. Its sector (the camera's field of view, out to the place it looks to,
0.8 to 6 km) is drawn on the chart, and an **eye** stands on the camera. Cameras that share a site
are listed at the top of the card.

**The eye** (on the chart, or on the card's picture) opens the view through the camera: its picture
over the whole screen, refreshed every minute, with the ships in it marked where they are now (dead
reckoned, as on the chart): a frame from the waterline to about the top of the ship, and a tag with
the name, type, distance, speed and course. Ships just outside the picture are named at its edge.
Tapping a tag leaves the view and opens the ship's card. Behind the view the chart moves to the
camera, so the ships around it are loaded (Ships (AIS) must be on). Escape or × leaves it.
(`public/webcamlayer.js`, `public/webcamview.js`, the geometry in `public/webcams.js`, tested.)

**Where a camera looks.** The cameras do not publish a compass bearing (the DATEX field `bearing` is
empty for all of them, checked 2026-11-25); each names the place it looks towards ("Esøya", "mot
Eggedal", "Rosten/E6"). `npm run webcams` (`scripts/webcams.mjs`) looks each place up in Kartverket's
place-name register, takes the nearest place of that name, and stores the bearing from the camera to
it in `public/webcams.json`, with how sure it is: *good* when the place is within 15 km (most ferry
quay and bridge cameras), *rough* or *very rough* for road cameras that name a far town (they look
along the road, not straight at it). It also stores the ground height under each camera (from the
full DATEX record) for the height of the lens. About 140 cameras name no place ("skifter": it turns;
"Finland"; "sentrum"): their direction is unknown. The field of view is taken as 60°.

**Adjust view** in the view lines it up and keeps it on this device: the direction (so a landmark
sits under the place's name, marked ▾ at the top of the picture), the width of view, the tilt (so
the dashed line lies on the sea's horizon) and the lens's height above the sea. A ship's place in the
picture follows from these (a pinhole camera, with the earth's curve); the picture itself can be a
few minutes old, so moving ships may be a little ahead of their marks. Land between a ship and the
camera is not taken into account.

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

**Ships that tell no heading.** Many small craft send no compass heading (AIS 511), and a ship lying
still has no course to go by, so such a ship used to be only a dot. Up close (from zoom 12.5) it now
gets a guessed heading and is drawn at its true size and as a 3D model: along the quay or shore it lies
at, when one is within 30 m of its side (OpenStreetMap's water outlines and piers, from OpenFreeMap's
tiles; the bow the way the ship pointed before, or its last course, else either way), else the heading
it told earlier, else its last course, else north. A guessed heading has a dashed outline and no arrow,
and the ship's card says how it was guessed (`public/shoreline.js`, tested).

**Ships move by themselves, at every scale.** The chart's symbols (arrows, dots and outlines) are
redrawn a few times a second where each ship is drawn now, the same as the 3D models below, so ships
under way glide across the chart between AIS reports instead of jumping every 30 seconds. Ships
lying still are not redrawn.

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
- **Texture**: put a picture on the ship, either a photo along the hull or a texture (painted steel,
  rust, teak, plating) repeated over the hull, deck, superstructure or funnels, or over any material
  of a model from a file. Pictures come from Wikimedia Commons, Openverse (openly licensed pictures
  from Flickr, museums and others), Poly Haven (CC0 surface textures), the ship's own Commons photos,
  any picture's web address (when its site allows other pages to use it; CORS), or a picture on the
  device. Each shows who made it and its licence. (`ships/texturesources.js`, `ships/vesselmodel.js`;
  the hull photo is painted in `ships/hullText.js`.)
- **Models**: upload a model (`.glb`, `.gltf`, `.obj` + `.mtl` + pictures, `.stl`), turn it upright
  with the bow forward, scale it to the ship's length (or its own units) and set its waterline;
  **Save on this device** keeps it (built or uploaded, with its textures) as one `.glb` in the
  browser's database (IndexedDB, `public/vessellibrary.js`), under the ship's name, MMSI, IMO number
  and call sign. Download the model in view as `.glb`, as `.glb` + `.json` for the vessels folder, or
  (built ships) as Wavefront `.obj` + `.mtl` + the painted hull pictures (metres, Y up, bow towards +X).

**The vessels folder.** Before building a ship from its type, Rudder looks for a model of it: first in
its own vessels folder (`public/vessels/`, listed in `vessels/index.json`), then among the models
saved on the device. A model is matched to a ship by MMSI, then IMO number, then call sign, then name
(`public/vesselcatalog.js`, tested). When one is found, the inspector shows it (and says so; **Show
the built model** compares), and the chart draws it as that ship's 3D model, stretched to its AIS
length and set at its AIS draught. To add a model for everyone, put it and a `.json` sidecar in
`public/vessels/` and run `npm run vessels`; see [public/vessels/README.md](public/vessels/README.md).
The loaders and the glTF exporter (`public/vendor/three-io.js`, about 100 kB) are loaded only when a
model file is needed.

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
