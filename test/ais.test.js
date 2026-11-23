import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenRequestBody, parseToken, pastedToken, bboxPolygon, latestRequest, bboxInside, typeGroup, typeName, navStatusText,
  drawHeading, vesselSize, draughtM, vesselOutline, mergeVessels, pruneVessels, toGeoJson, kindFromAis, hullFromAis,
} from '../public/ais.js';
import { distanceM, bearingDeg } from '../public/nav.js';

// An AIS combined report as BarentsWatch sends it (modelType Full, modelFormat Json).
const report = (over = {}) => ({
  mmsi: 257012345, msgtime: '2026-11-23T12:00:00+00:00', latitude: 59.0, longitude: 5.5, courseOverGround: 90.2,
  speedOverGround: 12.4, trueHeading: 90, navigationalStatus: 0, imoNumber: 9241061, callSign: 'LABC', name: 'TEST SHIP   ',
  destination: 'BERGEN', draught: 72, shipLength: 120, shipWidth: 20, shipType: 70,
  dimensionA: 90, dimensionB: 30, dimensionC: 8, dimensionD: 12, ...over,
});
const NOW = Date.parse('2026-11-23T12:05:00Z');

test('the token request is the client-credentials flow for the ais scope', () => {
  const p = new URLSearchParams(tokenRequestBody('me@example.com:rudder', 's3cr&t'));
  assert.equal(p.get('grant_type'), 'client_credentials');
  assert.equal(p.get('client_id'), 'me@example.com:rudder');
  assert.equal(p.get('client_secret'), 's3cr&t');
  assert.equal(p.get('scope'), 'ais');
});

test('a token is used until a minute before it expires', () => {
  assert.deepEqual(parseToken({ access_token: 'abc', expires_in: 3600 }, 0), { token: 'abc', expiresAt: 3540_000 });
  assert.throws(() => parseToken({ error: 'invalid_client' }), /invalid_client/);
});

test('a pasted token takes its expiry from the JWT, or an hour', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${b64({ alg: 'RS256' })}.${b64({ exp: 2_000_000 })}.sig`;
  assert.equal(pastedToken(`Bearer ${jwt}`, 0).expiresAt, 2_000_000 * 1000 - 30_000);
  assert.equal(pastedToken('opaque', 0).expiresAt, 3600_000);
  assert.equal(pastedToken('   '), null);
});

test('the request asks for full static data inside the view, as a closed polygon', () => {
  const body = latestRequest([5, 58.9, 6, 59.1], Date.parse('2026-11-23T12:00:00Z'));
  assert.equal(body.modelType, 'Full');
  assert.equal(body.modelFormat, 'Json');
  assert.equal(body.since, '2026-11-23T12:00:00.000Z');
  const ring = body.geometry.coordinates[0];
  assert.equal(body.geometry.type, 'Polygon');
  assert.deepEqual(ring[0], ring.at(-1));
  assert.deepEqual(bboxPolygon([5, 59, 6, 60], 0.5).coordinates[0][0], [4.5, 58.5]);
  assert.equal(latestRequest([5, 58.9, 6, 59.1]).since, undefined);
  assert.ok(bboxInside([5.2, 59, 5.8, 59.1], [5, 58.9, 6, 59.2]));
  assert.ok(!bboxInside([4.9, 59, 5.8, 59.1], [5, 58.9, 6, 59.2]));
});

test('ship types group and read as words', () => {
  assert.equal(typeGroup(60).id, 'passenger');
  assert.equal(typeGroup(79).id, 'cargo');
  assert.equal(typeGroup(84).id, 'tanker');
  assert.equal(typeGroup(30).id, 'fishing');
  assert.equal(typeGroup(52).id, 'tug');
  assert.equal(typeGroup(37).id, 'pleasure');
  assert.equal(typeGroup(0).id, 'other');
  assert.equal(typeName(52), 'Tug');
  assert.equal(typeName(71), 'Cargo, carrying dangerous goods (A)');
  assert.equal(typeName(0), 'Not given');
  assert.equal(navStatusText(5), 'Moored');
  assert.equal(navStatusText(15), 'Not defined');
});

test('the heading is the true heading, else the course when moving', () => {
  assert.equal(drawHeading(report()), 90);
  assert.equal(drawHeading(report({ trueHeading: 511 })), 90.2);
  assert.equal(drawHeading(report({ trueHeading: 511, speedOverGround: 0 })), null);
  assert.equal(drawHeading(report({ trueHeading: null, courseOverGround: 360 })), null);
});

test('size comes from the antenna offsets; draught is in tenths of a metre', () => {
  assert.deepEqual(vesselSize(report()), { length: 120, beam: 20, toBow: 90, toPort: 8 });
  assert.deepEqual(vesselSize(report({ dimensionA: 0, dimensionB: 0, dimensionC: 0, dimensionD: 0 })), { length: 120, beam: 20, toBow: 60, toPort: 10 });
  assert.equal(draughtM(report()), 7.2);
  assert.equal(draughtM(report({ draught: 0 })), null);
});

test('the outline is the true size, heading the right way, with the antenna where it is', () => {
  const v = report(); // heading east, antenna 90 m from the bow, 8 m from port
  const ring = vesselOutline(v);
  assert.deepEqual(ring[0], ring.at(-1));
  const bow = ring[2];
  const [lon, lat] = [v.longitude, v.latitude];
  assert.ok(Math.abs(distanceM(lat, lon, bow[1], bow[0]) - 90) < 2, 'bow 90 m ahead of the antenna');
  assert.ok(Math.abs(bearingDeg(lat, lon, bow[1], bow[0]) - 90) < 4, 'bow points east');
  const sternPort = ring[0], sternStb = ring[4];
  assert.ok(Math.abs(distanceM(sternPort[1], sternPort[0], sternStb[1], sternStb[0]) - 20) < 0.5, 'beam 20 m');
  assert.ok(sternPort[1] > sternStb[1], 'port side is north when heading east');
  assert.equal(vesselOutline(report({ trueHeading: 511, speedOverGround: 0 })), null);
  assert.equal(vesselOutline(report({ dimensionA: 0, dimensionB: 0, shipLength: 0 })), null);
});

test('reports merge by MMSI, newest wins, and old ships are forgotten', () => {
  const m = new Map();
  mergeVessels(m, [report(), report({ mmsi: 2, latitude: null })]);
  mergeVessels(m, [report({ msgtime: '2026-11-23T11:00:00Z', latitude: 1 })]);
  assert.equal(m.size, 1);
  assert.equal(m.get(257012345).latitude, 59);
  mergeVessels(m, [report({ msgtime: '2026-11-23T12:01:00Z', speedOverGround: 3 })]);
  assert.equal(m.get(257012345).speedOverGround, 3);
  assert.equal(m.get(257012345).name, 'TEST SHIP   ', 'static data kept');
  pruneVessels(m, Date.parse('2026-11-23T15:00:00Z'));
  assert.equal(m.size, 0);
});

test('GeoJSON carries colour, heading and staleness, with an outline when the size is known', () => {
  const { points, outlines } = toGeoJson([report(), report({ mmsi: 3, dimensionA: 0, dimensionB: 0, shipLength: null, msgtime: '2026-11-23T11:00:00Z' })], NOW);
  assert.equal(points.features.length, 2);
  assert.equal(outlines.features.length, 1);
  const p = points.features[0].properties;
  assert.equal(p.name, 'TEST SHIP');
  assert.equal(p.color, typeGroup(70).color);
  assert.equal(p.heading, 90);
  assert.equal(p.stale, false);
  assert.equal(points.features[1].properties.stale, true);
});

test('AIS becomes hull parameters, with AIS values marked as such', () => {
  assert.equal(kindFromAis(60, 300), 'cruise');
  assert.equal(kindFromAis(69, 120), 'ferry');
  assert.equal(kindFromAis(70, 366, 51), 'container');
  assert.equal(kindFromAis(70, 120, 20), 'cargo');
  assert.equal(kindFromAis(52), 'tug');
  assert.equal(kindFromAis(36), 'sailing');
  const { params, sources } = hullFromAis(report());
  assert.equal(params.kind, 'cargo');
  assert.equal(params.length, 120);
  assert.equal(params.beam, 20);
  assert.equal(params.draft, 7.2);
  assert.ok(params.depth > params.draft);
  assert.deepEqual(sources, { length: 'ais', beam: 'ais', draft: 'ais', airDraft: 'estimated' });
  assert.equal(hullFromAis(report({ draught: 0 })).sources.draft, 'estimated');
});
