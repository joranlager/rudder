import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  camerasUrl, parseCameras, readLooks, pickPlace, directionTo, directionQuality, withView, cleanCalibration,
  destination, sectorRing, sectorRange, camerasGeoJson, relAngle, projectShip, pictureX, pictureY, horizonDip,
  DEFAULT_FOV, MAST, SHIP_RANGE_M,
} from '../public/webcams.js';
import { bearingDeg, distanceM } from '../public/nav.js';
import { mergeSettings, defaultSettings } from '../public/layers.js';

const feature = (o = {}) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [13.514091, 66.738655] },
  properties: {
    CAMERA_ID: '3001087_1', DESCRIPTION: 'Forøya ferjekai', ORIENTATION_DESCRIPTION: 'Esøya', STILL_IMAGE_URL: 'https://kamera.atlas.vegvesen.no/api/images/3001087_1',
    STATUS_STILL_IMAGE_AVAILABILITY: 'videoOrImagesAvailable', VIDEO_SERVICE_LEVEL: 1, ROAD_NUMBER: 'F17', STILL_IMAGE_URL_DESCRIPTION: 'https://www.yr.no/x', ...o,
  },
});

test('the cameras come from Statens vegvesen\'s open WFS', () => {
  const u = new URL(camerasUrl());
  assert.equal(u.host, 'ogckart-sn1.atlas.vegvesen.no');
  assert.equal(u.searchParams.get('typeNames'), 'datex_3_1:CctvSimple_v2');
  assert.equal(u.searchParams.get('outputFormat'), 'application/json');
  const [c, ...rest] = parseCameras({ features: [feature(), feature({ CAMERA_ID: '9_2', STATUS_STILL_IMAGE_AVAILABILITY: 'videoOrImagesUnavailableDueToCameraFault' }), feature({ STILL_IMAGE_URL: null }), { properties: {} }] });
  assert.deepEqual(c, {
    id: '3001087_1', site: '3001087', name: 'Forøya ferjekai', looks: 'Esøya', lat: 66.738655, lon: 13.514091,
    image: 'https://kamera.atlas.vegvesen.no/api/images/3001087_1', video: true, ok: true, road: 'F17', forecast: 'https://www.yr.no/x',
  });
  assert.equal(rest.length, 1);
  assert.equal(rest[0].ok, false);
  assert.equal(rest[0].site, '9');
});

test('what a camera says it looks to: a place, a compass word, or nothing usable', () => {
  assert.deepEqual(readLooks('Stamsund'), { place: 'Stamsund' });
  assert.deepEqual(readLooks('mot Eggedal'), { place: 'Eggedal' });
  assert.deepEqual(readLooks('Rosten/E6'), { place: 'Rosten' });
  assert.deepEqual(readLooks('E134 Notodden'), { place: 'Notodden' });
  assert.deepEqual(readLooks('Nesvik fk'), { place: 'Nesvik' });
  assert.deepEqual(readLooks('nord'), { bearing: 0 });
  assert.deepEqual(readLooks('Sørvest'), { bearing: 225 });
  for (const x of ['skifter', 'Finland', 'mot Sverige', 'sentrum', 'Mot Sentrum', 'ferjekaien', 'XE16', '', null, 'Tunnel plassert Vest']) assert.equal(readLooks(x), null, String(x));
});

test('the place looked to is the nearest of its name, not the camera\'s own spot', () => {
  const cam = { lat: 68.1577, lon: 13.6959 };
  const places = [
    { name: 'Stamsund', lat: 68.1577, lon: 13.6960 }, // the camera's site itself
    { name: 'Stamsund kirke', lat: 68.1439, lon: 13.8392 },
    { name: 'Stamsund', lat: 68.1301, lon: 13.8493 },
    { name: 'Stamsund', lat: 59.9, lon: 10.7 }, // too far
  ];
  assert.equal(pickPlace(cam, places, 'Stamsund').lat, 68.1301, 'the name itself first');
  assert.equal(pickPlace(cam, places).name, 'Stamsund kirke', 'else the nearest');
  assert.equal(pickPlace(cam, [places[0], places[3]]), null);
  const d = directionTo(cam, places[2]);
  assert.ok(Math.abs(d.bearing - bearingDeg(cam.lat, cam.lon, 68.1301, 13.8493)) < 0.1);
  assert.equal(d.quality, 'good');
  assert.equal(directionQuality(30_000), 'rough');
  assert.equal(directionQuality(90_000), 'very rough');
});

test('a camera\'s view: worked out, with what was set on this device over it', () => {
  const [c] = parseCameras({ features: [feature()] });
  const dirs = { '3001087_1': { bearing: 48.8, target: 'Esøya', distance: 893, quality: 'good', ground: 4.3 } };
  const v = withView(c, dirs).view;
  assert.equal(v.bearing, 48.8);
  assert.equal(v.fov, DEFAULT_FOV);
  assert.equal(v.height, 4.3 + MAST);
  assert.equal(v.targetBearing, 48.8);
  assert.equal(v.own, false);
  const w = withView(c, dirs, { '3001087_1': { bearing: 55, fov: 40 } }).view;
  assert.deepEqual([w.bearing, w.fov, w.quality, w.own, w.targetBearing], [55, 40, 'set here', true, 48.8]);
  const u = withView(c, {}).view;
  assert.equal(u.bearing, null);
  assert.equal(u.quality, 'unknown');
});

test('what is stored on the device is kept within sense', () => {
  assert.deepEqual(cleanCalibration({ a: { bearing: 370, fov: 500, tilt: -90, height: 0, x: 1 }, b: 'no', c: {} }), { a: { bearing: 10, fov: 150, tilt: -20, height: 0.5 } });
  assert.deepEqual(cleanCalibration(null), {});
});

test('the sector fans out from the camera across its view', () => {
  const [c] = parseCameras({ features: [feature()] });
  const cam = withView(c, { '3001087_1': { bearing: 90, distance: 2000 } });
  const ring = sectorRing(cam);
  assert.deepEqual(ring[0], [cam.lon, cam.lat]);
  assert.deepEqual(ring.at(-1), ring[0]);
  const b0 = bearingDeg(cam.lat, cam.lon, ring[1][1], ring[1][0]), b1 = bearingDeg(cam.lat, cam.lon, ring.at(-2)[1], ring.at(-2)[0]);
  assert.ok(Math.abs(b0 - 60) < 0.5 && Math.abs(b1 - 120) < 0.5, `${b0} ${b1}`);
  assert.ok(Math.abs(distanceM(cam.lat, cam.lon, ring[1][1], ring[1][0]) - 2000) < 2);
  assert.equal(sectorRange({ distance: 50 }), 800);
  assert.equal(sectorRange({ distance: 90_000 }), 6000);
  const gj = camerasGeoJson([cam, withView(c, {})]);
  assert.deepEqual(gj.features.map((f) => [f.properties.known, f.properties.bearing]), [[true, 90], [false, 0]]);
});

test('a ship straight ahead is in the middle; to the right, right; behind, not in view', () => {
  const cam = { lat: 66.7, lon: 13.5, view: { bearing: 45, fov: 60, tilt: 0, height: 10 } };
  const at = (b, m) => { const [lon, lat] = destination(cam.lat, cam.lon, b, m); return { lat, lon }; };
  const ahead = projectShip(cam, at(45, 2000), { length: 80, beam: 14 }, 135);
  assert.ok(Math.abs(ahead.x - 0.5) < 1e-3, `x ${ahead.x}`);
  assert.ok(ahead.inView);
  assert.ok(ahead.y > 0.5, 'the waterline below level, from 10 m up');
  assert.ok(ahead.top < ahead.y, 'its top above its waterline');
  assert.ok(ahead.half > 0.005 && ahead.half < 0.1, `half ${ahead.half}`);
  const right = projectShip(cam, at(65, 2000), { length: 80 }, 0);
  assert.ok(right.x > 0.75 && right.x < 1 && right.inView);
  const left = projectShip(cam, at(25, 2000), { length: 80 }, 0);
  assert.ok(Math.abs(left.x - (1 - right.x)) < 1e-3, 'symmetric');
  assert.equal(projectShip(cam, at(225, 2000), {}).inView, false);
  assert.equal(projectShip(cam, at(45, SHIP_RANGE_M + 500), {}).inView, false, 'too far');
  const near = projectShip(cam, at(45, 500), {}), far = projectShip(cam, at(45, 5000), {});
  assert.ok(near.y > far.y, 'nearer ships lie lower in the picture');
  assert.ok(near.half > far.half, 'and look bigger');
  // broadside looks longer than bow-on
  assert.ok(projectShip(cam, at(45, 2000), { length: 100, beam: 15 }, 135).half > projectShip(cam, at(45, 2000), { length: 100, beam: 15 }, 45).half * 3);
  assert.equal(projectShip({ ...cam, view: { ...cam.view, bearing: null } }, at(45, 100), {}), null);
});

test('the picture\'s helpers: across, down, the horizon', () => {
  const v = { bearing: 90, fov: 60, tilt: 0 };
  assert.equal(pictureX(v, 90), 0.5);
  assert.equal(pictureX(v, 200), null);
  assert.ok(pictureX(v, 100) > 0.5);
  assert.equal(pictureY(v, 0), 0.5);
  assert.ok(pictureY({ ...v, tilt: 5 }, 0) < 0.5, 'tilted down, the level line rises');
  assert.ok(Math.abs(horizonDip(10) - 0.1015) < 0.002, 'about 6 minutes of arc from 10 m');
  assert.equal(relAngle(10, 350), 20);
  assert.equal(relAngle(350, 10), -20);
});

test('the directions shipped with the page are sound', () => {
  const j = JSON.parse(readFileSync('public/webcams.json', 'utf8'));
  const dirs = Object.entries(j.directions);
  assert.ok(dirs.length > 500);
  let withBearing = 0;
  for (const [id, d] of dirs) {
    assert.match(id, /^\d+_\d+$/);
    if (d.bearing !== undefined) {
      withBearing++;
      assert.ok(d.bearing >= 0 && d.bearing < 360, id);
      assert.ok(['good', 'rough', 'very rough'].includes(d.quality), id);
    }
  }
  assert.ok(withBearing > 600, `${withBearing} with a direction`);
});

test('the webcams layer is remembered, off at first', () => {
  assert.equal(defaultSettings().webcams, false);
  assert.equal(mergeSettings({ webcams: true }).webcams, true);
  assert.equal(mergeSettings({ webcams: 1 }).webcams, false);
});
