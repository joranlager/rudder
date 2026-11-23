// Ship inspector: Wikidata SPARQL search and the facts query for one vessel.

const ENDPOINT = 'https://query.wikidata.org/sparql';
/** Roots that count as "a ship" for search: ship, watercraft, ship class, boat. */
const ROOTS = 'wd:Q11446 wd:Q1229765 wd:Q559026 wd:Q35872';
function escapeLiteral(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}
async function sparql(query, signal) {
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/sparql-results+json' },
  });
  if (!res.ok) throw new Error(`Wikidata query failed (${res.status})`);
  const json = await res.json();
  return json.results.bindings;
}
const qidOf = (uri) => uri.substring(uri.lastIndexOf('/') + 1);
const num = (b) => (b && b.value !== '' && !Number.isNaN(+b.value) ? +b.value : undefined);
const list = (b) =>
  b && b.value
    ? Array.from(
        new Set(
          b.value
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      )
    : [];
/**
 * Full-text entity search (via the MediaWiki API service inside SPARQL),
 * restricted to items that are ships, watercraft or ship classes.
 */
export async function searchShips(term, lang = 'en', signal) {
  const q = escapeLiteral(term.trim());
  if (!q) return [];
  const query = `
SELECT ?item ?itemLabel ?itemDescription (SAMPLE(?typeLabel) AS ?type) (SAMPLE(?img) AS ?image) (SAMPLE(?len) AS ?length) (MIN(?num) AS ?rank) WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:endpoint "www.wikidata.org";
                    wikibase:api "EntitySearch";
                    mwapi:search "${q}";
                    mwapi:language "${lang}";
                    mwapi:limit "50".
    ?item wikibase:apiOutputItem mwapi:item.
    ?num wikibase:apiOrdinal true.
  }
  ?item wdt:P31 ?t.
  ?t wdt:P279* ?root.
  VALUES ?root { ${ROOTS} }
  OPTIONAL { ?t rdfs:label ?typeLabel. FILTER(LANG(?typeLabel) = "${lang}") }
  OPTIONAL { ?item wdt:P18 ?img. }
  OPTIONAL { ?item p:P2043/psn:P2043/wikibase:quantityAmount ?len. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en,mul". }
}
GROUP BY ?item ?itemLabel ?itemDescription
ORDER BY ?rank
LIMIT 25`;
  const rows = await sparql(query, signal);
  return rows.map((r) => ({
    qid: qidOf(r.item.value),
    label: r.itemLabel?.value ?? qidOf(r.item.value),
    description: r.itemDescription?.value,
    type: r.type?.value,
    image: r.image?.value,
    length: num(r.length),
  }));
}
/** The Wikidata item with this IMO number (P458), or null. An exact match, unlike a name search. */
export async function findByImo(imo, signal) {
  const n = String(imo ?? '').replace(/\D/g, '');
  if (n.length !== 7) return null;
  const rows = await sparql(`SELECT ?item WHERE { ?item wdt:P458 "${n}" } LIMIT 1`, signal);
  return rows[0] ? qidOf(rows[0].item.value) : null;
}

/** Fetch everything the inspector shows for a single item. */
export async function fetchShipFacts(qid, lang = 'en', signal) {
  if (!/^Q\d+$/.test(qid)) throw new Error('Invalid Wikidata id');
  const L = (v, p) => `OPTIONAL { wd:${qid} wdt:${p} ?${v}_. ?${v}_ rdfs:label ?${v}. FILTER(LANG(?${v}) IN ("${lang}", "en", "mul")) }`;
  // Quantities: prefer SI-normalised values (psn:) and fall back to the raw statement value.
  // Items often carry several values (LOA and LPP, design and scantling draft...):
  // take the largest length/beam/draft, and the smallest height as the closest to air draft.
  const Q = (v, p) => `OPTIONAL { wd:${qid} p:${p}/psn:${p}/wikibase:quantityAmount ?${v}N. }
  OPTIONAL { wd:${qid} wdt:${p} ?${v}R. }`;
  const query = `
SELECT ?itemLabel ?itemDescription
  (MAX(COALESCE(?lenN, ?lenR)) AS ?length)
  (MAX(COALESCE(?beamN, ?beamR)) AS ?beam)
  (MAX(COALESCE(?draftN, ?draftR)) AS ?draft)
  (MIN(COALESCE(?heightN, ?heightR)) AS ?height)
  (MAX(?gtR) AS ?gt)
  (MAX(?speedN) AS ?speed)
  (SAMPLE(?capR) AS ?capacity)
  (SAMPLE(?img) AS ?image) (SAMPLE(?cc) AS ?commons)
  (SAMPLE(?imoV) AS ?imo) (SAMPLE(?mmsiV) AS ?mmsi) (SAMPLE(?callV) AS ?call)
  (SAMPLE(?inc) AS ?inception) (SAMPLE(?entry) AS ?serviceEntry) (SAMPLE(?retire) AS ?serviceRetirement)
  (SAMPLE(?article) AS ?wikipedia)
  (GROUP_CONCAT(DISTINCT ?type; separator="|") AS ?types)
  (GROUP_CONCAT(DISTINCT ?builder; separator="|") AS ?builders)
  (GROUP_CONCAT(DISTINCT ?operator; separator="|") AS ?operators)
  (GROUP_CONCAT(DISTINCT ?owner; separator="|") AS ?owners)
  (GROUP_CONCAT(DISTINCT ?flag; separator="|") AS ?flags)
  (GROUP_CONCAT(DISTINCT ?port; separator="|") AS ?ports)
  (GROUP_CONCAT(DISTINCT ?cls; separator="|") AS ?classes)
  (GROUP_CONCAT(DISTINCT ?color; separator="|") AS ?colors)
WHERE {
  BIND(wd:${qid} AS ?item)
  ${L('type', 'P31')}
  ${L('builder', 'P176')}
  ${L('operator', 'P137')}
  ${L('owner', 'P127')}
  ${L('flag', 'P8047')}
  ${L('port', 'P504')}
  ${L('cls', 'P289')}
  ${L('color', 'P462')}
  ${Q('len', 'P2043')}
  ${Q('beam', 'P2261')}
  ${Q('draft', 'P2262')}
  ${Q('height', 'P2048')}
  OPTIONAL { wd:${qid} wdt:P1093 ?gtR. }
  OPTIONAL { wd:${qid} p:P2052/psn:P2052/wikibase:quantityAmount ?speedN. }
  OPTIONAL { wd:${qid} wdt:P1083 ?capR. }
  OPTIONAL { wd:${qid} wdt:P18 ?img. }
  OPTIONAL { wd:${qid} wdt:P373 ?cc. }
  OPTIONAL { wd:${qid} wdt:P458 ?imoV. }
  OPTIONAL { wd:${qid} wdt:P587 ?mmsiV. }
  OPTIONAL { wd:${qid} wdt:P2317 ?callV. }
  OPTIONAL { wd:${qid} wdt:P571 ?inc. }
  OPTIONAL { wd:${qid} wdt:P729 ?entry. }
  OPTIONAL { wd:${qid} wdt:P730 ?retire. }
  OPTIONAL { ?article schema:about wd:${qid}; schema:isPartOf <https://${lang}.wikipedia.org/>. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en,mul". }
}
GROUP BY ?itemLabel ?itemDescription
LIMIT 1`;
  const [r] = await sparql(query, signal);
  if (!r) throw new Error(`No data for ${qid}`);
  const speedMs = num(r.speed);
  const year = (b) => (b?.value ? b.value.substring(0, 10) : undefined);
  return {
    qid,
    label: r.itemLabel?.value ?? qid,
    description: r.itemDescription?.value,
    types: list(r.types),
    length: num(r.length),
    beam: num(r.beam),
    draft: num(r.draft),
    height: num(r.height),
    grossTonnage: num(r.gt),
    speedKnots: speedMs !== undefined ? speedMs / 0.514444 : undefined,
    capacity: num(r.capacity),
    image: r.image?.value,
    commonsCategory: r.commons?.value,
    imo: r.imo?.value,
    mmsi: r.mmsi?.value,
    callSign: r.call?.value,
    inception: year(r.inception),
    serviceEntry: year(r.serviceEntry),
    serviceRetirement: year(r.serviceRetirement),
    wikipedia: r.wikipedia?.value,
    builders: list(r.builders),
    operators: list(r.operators),
    owners: list(r.owners),
    flags: list(r.flags),
    homePorts: list(r.ports),
    shipClass: list(r.classes),
    colors: list(r.colors),
  };
}
