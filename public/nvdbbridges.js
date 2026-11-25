// Road bridges as they are, from NVDB (Statens vegvesen's road database, NLOD): each bridge's type
// (suspension, cable-stayed, arch, girder...), length, longest span, width and outline (object type
// 60 "Bru"), and the road over it with its real height above the sea (the road network's geometry has
// heights, NN2000). From these a bridge is built in 3D: its deck where the road really is, the main
// span where the deck is highest, and towers and cables, pylons and stays, an arch or piers by its type.
//
// infra.js builds the bridges OpenStreetMap has where NVDB has none (railways, private roads), with
// heights estimated. Pure (no MapLibre), so it is unit tested; infralayer.js fetches and draws.
// The API answers any website with the X-Client header it asks for. Checked 2026-11-26.

import { toLocal, toLonLat } from './infra.js';

export const NVDB = 'https://nvdbapiles.atlas.vegvesen.no';
export const CLIENT = 'Rudder';
export const ATTRIBUTION = 'Bridges © <a href="https://www.vegvesen.no/fag/teknologi/nasjonal-vegdatabank/" target="_blank" rel="noopener">Statens vegvesen NVDB</a> (NLOD)';

/** Bridges (type 60) in a [west, south, east, north] box, with their properties and outlines. */
export function bridgesUrl([w, s, e, n]) {
  return `${NVDB}/vegobjekter/api/v4/vegobjekter/60?${new URLSearchParams({
    inkluder: 'egenskaper,geometri', kartutsnitt: [w, s, e, n].map((x) => x.toFixed(5)).join(','), srid: '4326', antall: '1000',
  })}`;
}

/** The road network's lines (with heights) in a box. */
export function roadsUrl([w, s, e, n]) {
  return `${NVDB}/vegnett/api/v4/veglenkesekvenser/segmentert?${new URLSearchParams({
    kartutsnitt: [w, s, e, n].map((x) => x.toFixed(5)).join(','), srid: '4326', antall: '1000',
  })}`;
}

/**
 * NVDB's WKT in WGS 84 as lists of [lon, lat, z?] (NVDB writes latitude first). Points, lines and
 * polygons (outer rings), also MULTI and Z. [] for anything else.
 */
export function parseWkt(wkt) {
  const s = String(wkt ?? '').trim();
  const m = s.match(/^(MULTI)?(POINT|LINESTRING|POLYGON)\s*(Z)?\s*\((.*)\)$/is);
  if (!m) return [];
  const body = m[4];
  const coords = (t) => t.split(',').map((p) => {
    const [lat, lon, z] = p.trim().split(/\s+/).map(Number);
    return Number.isFinite(z) ? [lon, lat, z] : [lon, lat];
  }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  // innermost bracketed lists
  const lists = [...body.matchAll(/\(([^()]*)\)/g)].map((x) => x[1]);
  if (!lists.length) return [coords(body)];
  if (m[2].toUpperCase() === 'POLYGON') {
    // outer rings only: the first list of each polygon
    const polys = m[1] ? [...body.matchAll(/\(\s*\(([^()]*)\)/g)].map((x) => x[1]) : [lists[0]];
    return polys.map(coords);
  }
  return lists.map(coords);
}

// ---------- what NVDB says about a bridge ----------

/** The kind of structure from NVDB's Byggverkstype ("Hengebru (723)", "Kassebru (415)"...), or null for no bridge. */
export function bridgeKind(type) {
  const t = String(type ?? '').toLowerCase();
  if (!t || /tunnel|kulvert|ferjekai|støttemur|mur\b|portal|rør|kai\b/.test(t)) return null;
  if (t.includes('hengebru')) return 'suspension';
  if (t.includes('skråstag')) return 'cable-stayed';
  if (/bue|hvelv/.test(t)) return 'arch';
  if (t.includes('flytebru')) return 'floating';
  if (/fritt frambygg|frittframbygg|kassebru/.test(t)) return 'box';
  return 'girder';
}

/** An NVDB bridge object as { id, name, kind, length, span, width, outline: [[lon, lat]], z: [[lon, lat, z]] }, or null. */
export function bridgeFromNvdb(o) {
  const p = {};
  for (const e of o?.egenskaper ?? []) p[e.navn] = e.verdi;
  const kind = bridgeKind(p.Byggverkstype);
  if (!kind) return null;
  const parts = parseWkt(o.geometri?.wkt);
  if (!parts.length) return null;
  const isPolygon = /POLYGON/i.test(o.geometri?.wkt ?? '');
  const flat = parts.flat();
  const num = (x) => (Number(x) > 0 ? Number(x) : null);
  return {
    id: o.id,
    name: p.Navn ?? '',
    type: p.Byggverkstype ?? '',
    kind,
    length: num(p.Lengde),
    span: num(p['Lengste spenn']),
    width: num(p.Bredde),
    outline: isPolygon ? parts[0].map(([lon, lat]) => [lon, lat]) : null,
    line: isPolygon ? null : parts[0].map(([lon, lat]) => [lon, lat]),
    z: flat.filter((c) => c.length === 3 && c[2] > 0.5), // heights some objects carry themselves
  };
}

/** The road network's segments as { kind, line: [[lon, lat, z]] } (only those with heights). */
export function roadsFromNvdb(json) {
  const out = [];
  for (const o of json?.objekter ?? []) {
    for (const line of parseWkt(o.geometri?.wkt)) {
      if (line.length >= 2 && line.every((c) => c.length === 3)) out.push({ kind: o.typeVeg ?? '', line });
    }
  }
  return out;
}

// ---------- geometry ----------

/** Is [x, y] inside the ring (local metres)? */
export function inside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function segDist([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
/** Distance from a point to a ring or line (0 inside a ring), local metres. */
export function distanceTo(p, pts, closed) {
  if (closed && inside(p, pts)) return 0;
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(p, pts[i], pts[i + 1]));
  return d;
}

/** The two points of a set furthest apart (a bridge's ends). */
function ends(pts) {
  let a = pts[0], b = pts[0], best = -1;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    if (d > best) { best = d; a = pts[i]; b = pts[j]; }
  }
  return [a, b, Math.max(best, 1)];
}

/**
 * The deck's line and heights: the road points over the bridge (within its outline, or near its line),
 * cars' roads before footpaths, along the bridge from one end to the other, as { o, a, ax, length,
 * profile: [{ t, x, y, z }] } in local metres from o. null without heights.
 */
export function deckProfile(bridge, roads) {
  const o = (bridge.outline ?? bridge.line)[0];
  const shape = (bridge.outline ?? bridge.line).map((p) => toLocal(p, o));
  const closed = Boolean(bridge.outline);
  const reach = closed ? 2 : (bridge.width ?? 8) / 2 + 3;
  const [a, b, d] = ends(shape.length > 1 ? shape : [[0, 0], [1, 0]]);
  const ax = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  // Points of roads running along the bridge (within 30°): a road passing under it is left out.
  const along = (p, q) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
    return l > 0.1 && Math.abs((dx * ax[0] + dy * ax[1]) / l) >= Math.cos(Math.PI / 6);
  };
  const on = (kinds) => {
    const pts = [];
    for (const r of roads) {
      if (!kinds(r.kind)) continue;
      const loc = r.line.map((c) => toLocal(c, o));
      for (let i = 0; i < loc.length; i++) {
        const ok = (i > 0 && along(loc[i - 1], loc[i])) || (i + 1 < loc.length && along(loc[i], loc[i + 1]));
        if (ok && distanceTo(loc[i], shape, closed) <= reach) pts.push([loc[i][0], loc[i][1], r.line[i][2]]);
      }
    }
    return pts;
  };
  let pts = on((k) => !/gang|sykkel|fortau|trapp|ferje/i.test(k));
  if (pts.length < 2) pts = on((k) => !/ferje/i.test(k));
  if (pts.length < 2) pts = bridge.z.map((c) => { const p = toLocal(c, o); return [p[0], p[1], c[2]]; });
  if (pts.length < 2) return null;
  const t = (p) => ((p[0] - a[0]) * ax[0] + (p[1] - a[1]) * ax[1]) / d;
  const profile = pts.map((p) => ({ t: t(p), x: p[0], y: p[1], z: p[2] })).sort((p, q) => p.t - q.t);
  return { o, a, ax, length: d, profile };
}

/** The deck's height at `t` (0..1 along the bridge), from its profile (the highest of the points near). */
export function heightAt(profile, t) {
  const pr = profile.profile;
  if (t <= pr[0].t) return pr[0].z;
  if (t >= pr[pr.length - 1].t) return pr[pr.length - 1].z;
  // two carriageways may be listed: take the highest of those around t
  let lo = null, hi = null;
  for (const p of pr) {
    if (p.t <= t && (!lo || p.t > lo.t || (p.t === lo.t && p.z > lo.z))) lo = p;
    if (p.t >= t && (!hi || p.t < hi.t || (p.t === hi.t && p.z > hi.z))) hi = p;
  }
  if (!lo || !hi || hi.t === lo.t) return (lo ?? hi).z;
  return lo.z + ((hi.z - lo.z) * (t - lo.t)) / (hi.t - lo.t);
}

// ---------- building ----------

const box = ([x, y], half, o) => {
  const r = [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]];
  return [[...r, r[0]].map((p) => toLonLat(p, o))];
};
const quad = (p0, p1, half, o) => {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * half, ny = (dx / l) * half;
  const r = [[p0[0] + nx, p0[1] + ny], [p1[0] + nx, p1[1] + ny], [p1[0] - nx, p1[1] - ny], [p0[0] - nx, p0[1] - ny]];
  return [[...r, r[0]].map((p) => toLonLat(p, o))];
};
const part = (kind, base, top, color, coordinates) => ({ type: 'Feature', properties: { part: kind, base: Math.max(0, base), top: Math.max(top, base + 0.2), color, nvdb: true }, geometry: { type: 'Polygon', coordinates } });

const COLORS = { deck: '#a9adb3', pier: '#8f9399', tower: '#7d8288', cable: '#3a3f45', arch: '#9a9ea4' };

/**
 * A bridge in 3D from NVDB (bridgeFromNvdb) and the roads over it (roadsFromNvdb): polygon features
 * with { part, base, top, color } (metres above the sea), as infra.js's buildBridges gives. Its deck
 * follows the road's real heights; the main span (its longest span) is centred where the deck is
 * highest; the rest follows its kind. [] when NVDB has no heights for it.
 */
export function buildNvdbBridge(bridge, roads) {
  const pf = deckProfile(bridge, roads);
  if (!pf) return [];
  const { o, a, ax, length } = pf;
  const out = [];
  const W = Math.max(3, bridge.width ?? 8);
  const half = W / 2;
  const at = (t) => [a[0] + ax[0] * length * t, a[1] + ax[1] * length * t];
  const side = (p, off) => [p[0] - ax[1] * off, p[1] + ax[0] * off];
  const z = (t) => heightAt(pf, t);
  const S = Math.min(length, bridge.span ?? Math.min(length, 40));
  const thick = bridge.kind === 'suspension' || bridge.kind === 'cable-stayed' ? 2.5 : Math.min(8, Math.max(0.8, S / 22));
  // The deck: pieces a few metres long along the bridge, at the road's height.
  const n = Math.max(2, Math.min(160, Math.ceil(length / 6)));
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, top = z((t0 + t1) / 2);
    out.push(part('deck', top - thick, top + 0.4, COLORS.deck, quad(at(t0 - 0.002), at(t1 + 0.002), half, o)));
  }
  // The main span: centred where the deck is highest (ships pass there), its length the longest span.
  let tc = 0.5, best = -Infinity;
  for (let i = 1; i < 60; i++) { const t = i / 60, h = z(t); if (h > best + 0.05) { best = h; tc = t; } }
  const s = S / length;
  const m0 = Math.max(0.02, Math.min(tc - s / 2, 0.98 - s)), m1 = Math.min(0.98, m0 + s);
  const pier = (t, w = Math.max(1.5, Math.min(4, W * 0.18))) => {
    const top = z(t) - thick;
    if (top < 2) return;
    for (const k of [-1, 1]) out.push(part('pier', 0, top, COLORS.pier, box(side(at(t), k * half * 0.6), w, o)));
  };
  // Supports outside the main span, spaced like it is on the approaches (shorter spans on long ones).
  const approaches = (metres) => {
    const dt = metres / length;
    for (let t = m0 - dt; t > 0.01; t -= dt) pier(t);
    for (let t = m1 + dt; t < 0.99; t += dt) pier(t);
  };
  // A cable as pieces from point to point (each level, at its middle height): continuous seen from afar.
  const cableBoxes = (pts, r) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, h] = pts[i], [q, g] = pts[i + 1];
      const lo = Math.min(h, g) - r, hi = Math.max(h, g) + r;
      out.push(part('cable', lo, hi, COLORS.cable, quad(p, q, r, o)));
    }
  };
  if (bridge.kind === 'suspension') {
    // Two towers at the main span's ends, a main cable on each side hanging between them (sag 1/10 of
    // the span) and down to the ends, and hangers from the cable to the deck.
    const deckTop = Math.max(z(m0), z(m1));
    const towerTop = deckTop + S * 0.1 + 6;
    for (const t of [m0, m1]) for (const k of [-1, 1]) out.push(part('tower', 0, towerTop, COLORS.tower, box(side(at(t), k * (half + 1.2)), 2.2, o)));
    // The cable: from the tower tops down to just over the deck at mid-span (a parabola), and on the
    // side spans down to the deck at the bridge's ends.
    const low = z((m0 + m1) / 2) + 2;
    const cable = (t) => {
      if (t >= m0 && t <= m1) { const u = (t - m0) / (m1 - m0); return towerTop - (towerTop - low) * (1 - (2 * u - 1) ** 2); }
      const f = t < m0 ? t / m0 : (1 - t) / (1 - m1);
      return z(t) + 1 + (towerTop - z(t) - 1) * f ** 1.4;
    };
    for (const k of [-1, 1]) {
      const steps = Math.max(30, Math.ceil(length / 3)), pts = [];
      for (let i = 0; i <= steps; i++) pts.push([side(at(i / steps), k * (half + 0.6)), cable(i / steps)]);
      cableBoxes(pts, 0.6);
      // hangers every ~12 m in the main span
      const hs = Math.max(4, Math.round(((m1 - m0) * length) / 12));
      for (let i = 1; i < hs; i++) {
        const t = m0 + ((m1 - m0) * i) / hs;
        out.push(part('cable', z(t), cable(t), COLORS.cable, box(side(at(t), k * (half + 0.6)), 0.25, o)));
      }
    }
    approaches(Math.max(25, S * 0.25));
  } else if (bridge.kind === 'cable-stayed') {
    // Pylons at the main span's ends, stays fanning from their tops to the deck on both sides.
    const towerTop = Math.max(z(m0), z(m1)) + S * 0.22 + 4;
    for (const t of [m0, m1]) {
      for (const k of [-1, 1]) out.push(part('tower', 0, towerTop, COLORS.tower, box(side(at(t), k * (half + 1)), 2, o)));
      for (const k of [-1, 1]) {
        for (let j = 1; j <= 8; j++) {
          for (const dir of [-1, 1]) {
            const tEnd = t + dir * (s / 2) * (j / 8) * 0.95;
            if (tEnd <= 0.01 || tEnd >= 0.99) continue;
            const hTop = towerTop - j * 1.5, steps = 18, pts = [];
            for (let i = 1; i < steps; i++) {
              const u = i / steps, tt = t + (tEnd - t) * u;
              pts.push([side(at(tt), k * (half + 0.4)), hTop + (z(tEnd) + 1 - hTop) * u]);
            }
            cableBoxes(pts, 0.3);
          }
        }
      }
    }
    approaches(Math.max(25, S * 0.3));
  } else if (bridge.kind === 'arch') {
    // An arch under the main span, springing from the water (or ground) at its ends.
    const steps = Math.max(12, Math.ceil((m1 - m0) * length / 4));
    for (let i = 0; i < steps; i++) {
      const u = (i + 0.5) / steps, t = m0 + (m1 - m0) * u;
      const rise = (z(t) - thick) * (1 - (2 * u - 1) ** 2);
      out.push(part('arch', Math.max(0, rise - 2.5), rise, COLORS.arch, quad(at(m0 + (m1 - m0) * (i / steps)), at(m0 + (m1 - m0) * ((i + 1) / steps)), half * 0.8, o)));
    }
    approaches(Math.max(12, S * 0.5));
  } else if (bridge.kind === 'floating') {
    // floating bridges lie on pontoons: no piers
  } else {
    // Girder and box bridges: piers at the main span's ends, and spaced like it along the rest.
    pier(m0, Math.max(2, Math.min(5, W * 0.25)));
    pier(m1, Math.max(2, Math.min(5, W * 0.25)));
    approaches(Math.max(12, Math.min(S, 60)));
  }
  return out;
}

/** Is a point (lon, lat) on one of these NVDB bridges (within `slack` metres of its outline or line)? */
export function onBridge([lon, lat], bridges, slack = 8) {
  for (const b of bridges) {
    const shape = b.outline ?? b.line;
    if (!shape) continue;
    const o = shape[0];
    const d = distanceTo(toLocal([lon, lat], o), shape.map((p) => toLocal(p, o)), Boolean(b.outline));
    if (d <= (b.outline ? slack : (b.width ?? 8) / 2 + slack)) return true;
  }
  return false;
}
