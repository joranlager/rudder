import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tideTime, tideUrl, parseTide, valueAt, tideSummary, nearestStep, depthUrl, parseDepth, formatDepth,
  oceanUrl, placeUrl, parsePlaces,
} from '../public/marine.js';

// Trimmed real answers from the services (2026-11-23).
const TIDE_ALL = `<tide><locationdata>
<location name="Stavanger" code="SVG" latitude="58.974000" longitude="5.730000" delay="0" factor="1.00" obsname="Stavanger" obscode="SVG" descr="Tides and observed water level from Stavanger"/>
<reflevelcode>CD</reflevelcode>
<data type="observation" unit="cm"><waterlevel value="69.0" time="2026-11-23T00:00:00+01:00" flag="obs"/>
<waterlevel value="57.2" time="2026-11-23T01:00:00+01:00" flag="obs"/></data>
<data type="prediction" unit="cm"><waterlevel value="75.8" time="2026-11-23T00:00:00+01:00" flag="pre"/>
<waterlevel value="66.8" time="2026-11-23T01:00:00+01:00" flag="pre"/>
<waterlevel value="57.2" time="2026-11-23T02:00:00+01:00" flag="pre"/></data>
</locationdata></tide>`;
const TIDE_TAB = `<tide><locationdata>
<location name="Stavanger" code="SVG" latitude="58.974000" longitude="5.730000"/>
<reflevelcode>CD</reflevelcode>
<data type="prediction" unit="cm"><waterlevel value="53.3" time="2026-11-23T02:54:00+01:00" flag="low"/>
<waterlevel value="97.2" time="2026-11-23T09:10:00+01:00" flag="high"/>
<waterlevel value="55.0" time="2026-11-23T15:14:00+01:00" flag="low"/></data>
</locationdata></tide>`;
const DEPTH = `<msGMLOutput><Dybdelag_layer><gml:name>Dybdelag</gml:name>
<Dybdelag_feature><objtype>Dybdeareal</objtype><oppdateringsdato>2010-08-13 00:00:00+02</oppdateringsdato>
<minimumsdybde>20</minimumsdybde><maksimumsdybde>50</maksimumsdybde></Dybdelag_feature>
<Dybdelag_feature><objtype>Dybdeareal</objtype><oppdateringsdato>2019-03-18 00:00:00+01</oppdateringsdato>
<minimumsdybde>30</minimumsdybde><maksimumsdybde>40</maksimumsdybde></Dybdelag_feature>
</Dybdelag_layer></msGMLOutput>`;

test('tide times are Norwegian wall-clock time', () => {
  assert.equal(tideTime(Date.parse('2026-11-23T12:00:00Z')), '2026-11-23T13:00'); // CET
  assert.equal(tideTime(Date.parse('2026-07-01T12:00:00Z')), '2026-07-01T14:00'); // CEST
  const p = new URL(tideUrl(58.97412345, 5.7, Date.parse('2026-11-23T12:00:00Z'), 'tab')).searchParams;
  assert.equal(p.get('lat'), '58.9741');
  assert.equal(p.get('datatype'), 'tab');
  assert.equal(p.get('fromtime'), '2026-11-23T07:00');
});

test('tide XML is parsed into station and series', () => {
  const t = parseTide(TIDE_ALL);
  assert.equal(t.station.name, 'Stavanger');
  assert.equal(t.station.lat, 58.974);
  assert.equal(t.series.prediction.length, 3);
  assert.equal(t.series.observation[1].cm, 57.2);
  assert.equal(parseTide('<error/>'), null);
});

test('tide level is interpolated and the next high and low found', () => {
  const t = parseTide(TIDE_ALL);
  const half = Date.parse('2026-11-23T00:30:00+01:00');
  assert.ok(Math.abs(valueAt(t.series.prediction, half) - 71.3) < 1e-9);
  assert.equal(valueAt(t.series.prediction, 0), null);
  const s = tideSummary(t, parseTide(TIDE_TAB), half);
  assert.equal(s.rising, false);
  assert.deepEqual(s.next.map((p) => p.flag), ['low', 'high']);
});

test('the forecast step nearest now is picked', () => {
  const j = { properties: { timeseries: [
    { time: '2026-11-23T22:00:00Z', data: { instant: { details: { sea_surface_wave_height: 0.1 } } } },
    { time: '2026-11-23T23:00:00Z', data: { instant: { details: { sea_surface_wave_height: 0.4 } } } },
  ] } };
  assert.equal(nearestStep(j, Date.parse('2026-11-23T22:40:00Z')).sea_surface_wave_height, 0.4);
  assert.equal(nearestStep({}, 0), null);
  assert.ok(oceanUrl(59.123456, 5.5).endsWith('lat=59.1235&lon=5.5'));
});

test('depth: the narrowest band wins, nothing means land', () => {
  const b = parseDepth(DEPTH);
  assert.deepEqual([b.min, b.max, b.updated], [30, 40, '2019-03-18']);
  assert.equal(formatDepth(b), '30–40 m');
  assert.equal(parseDepth('<msGMLOutput></msGMLOutput>'), null);
  assert.equal(formatDepth(null), 'Land, or no depth data');
  const p = new URL(depthUrl(59, 5.4)).searchParams;
  assert.equal(p.get('request'), 'GetFeatureInfo');
  assert.equal(p.get('bbox'), '5.399500,58.999500,5.400500,59.000500');
});

test('place search', () => {
  assert.equal(new URL(placeUrl('Skudenes')).searchParams.get('sok'), 'Skudenes*');
  const places = parsePlaces({ navn: [
    { 'skrivemåte': 'Skudenes', navneobjekttype: 'Fyrlykt', kommuner: [{ kommunenavn: 'Karmøy' }], fylker: [{ fylkesnavn: 'Rogaland' }],
      representasjonspunkt: { nord: 59.14, 'øst': 5.25 } },
    { 'skrivemåte': 'Nowhere' },
  ] });
  assert.deepEqual(places, [{ name: 'Skudenes', type: 'Fyrlykt', where: 'Karmøy, Rogaland', lat: 59.14, lon: 5.25 }]);
});
