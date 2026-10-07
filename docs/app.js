/* Bilan des mobilités douces communal.
   Tout se passe dans le navigateur : la page interroge OpenStreetMap (Overpass) et l'API Découpage
   administratif au moment de la demande, et lit les fichiers par département préparés par les scripts R. */
(function () {
  "use strict";

  // ---------- Réglages ----------
  const GEO = "https://geo.api.gouv.fr";
  // Serveurs publics, essayés tour à tour (le premier est parfois saturé) ; tous acceptent les appels depuis un navigateur.
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"];
  // Historique : seul le serveur principal sait remonter le temps (les autres renvoient l'état actuel
  // sans prévenir). Il est souvent saturé : trois essais espacés.
  const OVERPASS_HISTOIRE = ["https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter"];
  const DATE_REFERENCE = "2020-01-01";   // état du réseau au début de la période évaluée
  const MARGE_DEG = 0.004;               // marge autour de la commune (environ 400 m) pour ne pas couper le réseau
  const TOLERANCE_CONTINUITE_M = 30;     // deux tronçons séparés de moins de 30 m (un carrefour) sont continus
  const RAYON_VOIE_M = 25;               // voies cherchées autour d'une extrémité de tronçon
  const CHAINON_MAX_M = 400;             // longueur maximale d'un chaînon manquant proposé
  const RAYON_CONCENTRATION_M = 40;      // accidents regroupés en un même point
  const SEUIL_CONCENTRATION = 4;         // nombre d'accidents à partir duquel on parle de concentration
  const PROCHE_RESEAU_M = 300;           // habitant ou école « proche » d'un aménagement cyclable
  const PROCHE_BUS_M = 300, PROCHE_GARE_M = 600;
  const GARE_VOISINE_M = 300;            // une gare juste de l'autre côté de la limite communale dessert aussi la commune
  const RAYON_ARCEAUX_ECOLE_M = 100, RAYON_ARCEAUX_GARE_M = 150, RAYON_ACCIDENTS_ECOLE_M = 150;
  const ANNEES = [2019, 2020, 2021, 2022, 2023, 2024];

  const TYPES = {
    piste: { nom: "Piste cyclable", couleur: "#2a78d6", tirets: null },
    bande: { nom: "Bande cyclable", couleur: "#eb6834", tirets: "8 6" },
    verte: { nom: "Voie verte ou partagée avec les piétons", couleur: "#1baf7a", tirets: null },
    bus: { nom: "Couloir de bus ouvert aux vélos", couleur: "#4a3aa7", tirets: "2 6" },
  };
  const ORDRE_TYPES = ["piste", "bande", "verte", "bus"];
  const VOIRIE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)(_link)?$/;
  const RAPIDE = /^(motorway|trunk)(_link)?$/;
  const STRUCTURANT = /^(primary|secondary|tertiary)(_link)?$/;
  const ILE_DE_FRANCE = ["75", "77", "78", "91", "92", "93", "94", "95"];
  // Paris, Lyon et Marseille : les fichiers sont tenus par arrondissement.
  const ARRONDISSEMENTS = { "75056": "751", "69123": "6938", "13055": "132" };

  proj4.defs("EPSG:3035", "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +units=m +no_defs");
  proj4.defs("EPSG:5490", "+proj=utm +zone=20 +ellps=GRS80 +units=m +no_defs");
  proj4.defs("EPSG:2975", "+proj=utm +zone=40 +south +ellps=GRS80 +units=m +no_defs");

  const $ = (s) => document.querySelector(s);
  const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? "n. d." : v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const signe = (v, d = 1) => (v == null || !isFinite(v)) ? "n. d." : (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), d);
  const km = (m) => fmt(m / 1000, 1) + " km";
  const pct = (a, b, d = 0) => (b > 0 ? fmt(100 * a / b, d) + " %" : "n. d.");
  const pluriel = (n, mot, mots) => fmt(n) + " " + (n > 1 ? (mots || mot + "s") : mot);
  const echappe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function json(url, options) {
    const r = await fetch(url, options);
    if (!r.ok) throw new Error(url.split("?")[0] + " a répondu " + r.status);
    return r.json();
  }
  // Fichier à tabulations avec ligne d'en-tête -> tableau d'objets.
  async function tsv(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " a répondu " + r.status);
    const lignes = (await r.text()).split("\n");
    const noms = lignes[0].trim().split("\t");
    const sortie = [];
    for (let i = 1; i < lignes.length; i++) {
      if (!lignes[i]) continue;
      const v = lignes[i].replace(/\r$/, "").split("\t"), o = {};
      for (let k = 0; k < noms.length; k++) o[noms[k]] = v[k];
      sortie.push(o);
    }
    return sortie;
  }

  // ---------- Géométrie ----------
  function dansAnneau(x, y, a) {
    let dedans = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      const xi = a[i][0], yi = a[i][1], xj = a[j][0], yj = a[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
    return dedans;
  }
  function polygones(geom) { return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates; }
  function dansGeometrie(x, y, geom) {
    for (const poly of polygones(geom)) {
      if (!dansAnneau(x, y, poly[0])) continue;
      let trou = false;
      for (let k = 1; k < poly.length; k++) if (dansAnneau(x, y, poly[k])) { trou = true; break; }
      if (!trou) return true;
    }
    return false;
  }
  function emprise(geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polygones(geom)) for (const [x, y] of poly[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }
  // Repère local en mètres autour du centre de la commune : suffisant à l'échelle d'une commune.
  function repere(bbox) {
    const lon0 = (bbox[0] + bbox[2]) / 2, lat0 = (bbox[1] + bbox[3]) / 2;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
    return { xy: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky], geo: (x, y) => [x / kx + lon0, y / ky + lat0] };
  }
  function distSegment(px, py, s) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - s.x1) * dx + (py - s.y1) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
  }
  // Grille de recherche : chaque case liste les segments (ou points) qui la touchent.
  function Grille(pas) { this.pas = pas; this.cases = new Map(); }
  Grille.prototype.cle = function (cx, cy) { return cx * 100003 + cy; };
  Grille.prototype.ajouter = function (x0, y0, x1, y1, objet) {
    const p = this.pas;
    for (let cx = Math.floor(Math.min(x0, x1) / p); cx <= Math.floor(Math.max(x0, x1) / p); cx++)
      for (let cy = Math.floor(Math.min(y0, y1) / p); cy <= Math.floor(Math.max(y0, y1) / p); cy++) {
        const k = this.cle(cx, cy); let c = this.cases.get(k);
        if (!c) this.cases.set(k, c = []);
        c.push(objet);
      }
  };
  Grille.prototype.autour = function (x, y, rayon, f) {
    const p = this.pas, vus = new Set();
    for (let cx = Math.floor((x - rayon) / p); cx <= Math.floor((x + rayon) / p); cx++)
      for (let cy = Math.floor((y - rayon) / p); cy <= Math.floor((y + rayon) / p); cy++) {
        const c = this.cases.get(this.cle(cx, cy));
        if (c) for (const o of c) if (!vus.has(o)) { vus.add(o); f(o); }
      }
  };
  function grilleSegments(segments, pas) {
    const g = new Grille(pas);
    for (const s of segments) g.ajouter(s.x1, s.y1, s.x2, s.y2, s);
    return g;
  }
  function grillePoints(points, pas) {
    const g = new Grille(pas);
    for (const p of points) g.ajouter(p.x, p.y, p.x, p.y, p);
    return g;
  }
  function distanceAuReseau(grille, x, y, rayonMax) {
    let mini = Infinity;
    grille.autour(x, y, rayonMax, (s) => { const d = distSegment(x, y, s); if (d < mini) mini = d; });
    return mini <= rayonMax ? mini : Infinity;
  }
  function pointsAutour(grille, x, y, rayon) {
    const sortie = [];
    grille.autour(x, y, rayon, (p) => { if (Math.hypot(p.x - x, p.y - y) <= rayon) sortie.push(p); });
    return sortie;
  }

  // ---------- Suivi des étapes ----------
  const etapes = new Map();
  function etape(cle, texte, classe) {
    etapes.set(cle, { texte, classe: classe || "" });
    $("#etat").innerHTML = "<ul>" + [...etapes.values()].map((e) => `<li class="${e.classe}">${echappe(e.texte)}</li>`).join("") + "</ul>";
  }

  // ---------- Recherche de commune ----------
  const champ = $("#champ"), liste = $("#propositions");
  let minuterie = null, propositions = [], actif = -1;
  function montrerPropositions() {
    liste.hidden = !propositions.length;
    liste.innerHTML = propositions.map((c, i) =>
      `<li role="option" data-i="${i}" aria-selected="${i === actif}"><span>${echappe(c.nom)}</span><small>${echappe((c.codesPostaux || [])[0] || c.code)} · ${fmt(c.population)} hab.</small></li>`).join("");
  }
  champ.addEventListener("input", () => {
    clearTimeout(minuterie);
    const q = champ.value.trim();
    if (q.length < 2) { propositions = []; montrerPropositions(); return; }
    minuterie = setTimeout(async () => {
      const param = /^\d{5}$/.test(q) ? "codePostal=" + q : "nom=" + encodeURIComponent(q);
      let communes = [];
      try { communes = await json(`${GEO}/communes?${param}&fields=nom,code,codesPostaux,population&boost=population&limit=7`); } catch (e) { communes = []; }
      if (champ.value.trim() !== q) return;
      propositions = communes; actif = communes.length ? 0 : -1;
      montrerPropositions();
    }, 220);
  });
  champ.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!propositions.length) return;
      actif = (actif + (e.key === "ArrowDown" ? 1 : -1) + propositions.length) % propositions.length;
      montrerPropositions(); e.preventDefault();
    } else if (e.key === "Escape") { propositions = []; montrerPropositions(); }
  });
  $("#recherche").addEventListener("submit", (e) => { e.preventDefault(); if (propositions[actif]) choisir(propositions[actif].code); });
  liste.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) choisir(propositions[+li.dataset.i].code); });
  function choisir(code) {
    propositions = []; montrerPropositions();
    if (location.hash === "#" + code) lancer(code); else location.hash = code;
  }
  window.addEventListener("hashchange", depuisAdresse);
  function depuisAdresse() {
    const code = location.hash.replace("#", "");
    if (/^[0-9][0-9AB][0-9]{3}$/.test(code)) lancer(code);
  }

  // ---------- OpenStreetMap ----------
  async function overpass(requete, serveurs, delaiS, pauseS) {
    let derniere = null;
    for (const serveur of serveurs) {
      if (derniere && pauseS) await new Promise((suite) => setTimeout(suite, pauseS * 1000));
      const arret = new AbortController();
      const minuteur = setTimeout(() => arret.abort(), delaiS * 1000);
      try {
        const r = await fetch(serveur, { method: "POST", body: "data=" + encodeURIComponent(requete), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: arret.signal });
        if (!r.ok) throw new Error("réponse " + r.status);
        const d = await r.json();
        if (d.remark && /error|timed out/i.test(d.remark)) throw new Error(d.remark);
        return d;
      } catch (e) { derniere = e; } finally { clearTimeout(minuteur); }
    }
    throw new Error(derniere && derniere.name === "AbortError" ? "délai dépassé" : String(derniere && derniere.message));
  }
  const FILTRE_CYCLABLE = `
    way["highway"="cycleway"];
    way["highway"~"^(path|footway|pedestrian|track|service)$"]["bicycle"="designated"];
    way["highway"]["cycleway"~"^(lane|track|share_busway|opposite_lane|opposite_track|opposite_share_busway)$"];
    way["highway"]["cycleway:left"~"^(lane|track|share_busway|opposite_lane|opposite_track)$"];
    way["highway"]["cycleway:right"~"^(lane|track|share_busway|opposite_lane|opposite_track)$"];
    way["highway"]["cycleway:both"~"^(lane|track|share_busway)$"];`;
  function requeteActuelle(bb) {
    return `[out:json][timeout:90][bbox:${bb}];
    (${FILTRE_CYCLABLE}
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)(_link)?$"];
    nwr["amenity"="bicycle_parking"];
    node["amenity"="bicycle_rental"];
    node["highway"="bus_stop"];
    node["railway"~"^(station|halt|tram_stop)$"];
    );
    out tags geom;`;
  }
  function requeteHistorique(bb) {
    return `[out:json][timeout:170][date:"${DATE_REFERENCE}T00:00:00Z"][bbox:${bb}];(${FILTRE_CYCLABLE});out tags geom;`;
  }

  // Type d'aménagement d'une voie, d'après ses attributs OpenStreetMap (le plus protecteur l'emporte).
  function typeCyclable(t) {
    const hw = t.highway;
    if (hw === "cycleway") return (t.foot === "designated" && t.segregated !== "yes") ? "verte" : "piste";
    if (/^(path|footway|pedestrian|track|service)$/.test(hw) && t.bicycle === "designated") return "verte";
    const v = [t.cycleway, t["cycleway:left"], t["cycleway:right"], t["cycleway:both"]].filter(Boolean).join(" ");
    if (/track/.test(v)) return "piste";
    if (/lane/.test(v)) return "bande";
    if (/share_busway/.test(v)) return "bus";
    return null;
  }
  function estApaisee(t) {
    if (t.highway === "living_street" || t.highway === "pedestrian") return true;
    const v = parseInt(t.maxspeed, 10);
    if (isFinite(v)) return v <= 30;
    return /:(zone)?(30|20)$/.test(t["zone:maxspeed"] || "") || /zone30|zone20|living_street/.test(t["source:maxspeed"] || "") || /:(zone)?(30|20)$/.test(t["maxspeed:type"] || "");
  }
  function gestionnaire(ref) {
    if (/^D\s?\d/i.test(ref || "")) return "Département (route départementale)";
    if (/^[NA]\s?\d/i.test(ref || "")) return "État (route nationale)";
    return "Commune ou intercommunalité (voirie locale)";
  }

  // Découpe les voies en segments dans le repère local ; « dans » = milieu du segment dans la commune.
  function lireVoies(elements, R, commune, garder) {
    const voies = [];
    for (const e of elements) {
      if (e.type !== "way" || !e.geometry || !e.tags || !e.tags.highway) continue;
      const infos = garder(e.tags);
      if (!infos) continue;
      const voie = Object.assign({ id: e.id, tags: e.tags, segments: [], longueur: 0, latlngs: e.geometry.map((p) => [p.lat, p.lon]) }, infos);
      let prec = null;
      for (const p of e.geometry) {
        const q = R.xy(p.lon, p.lat);
        if (prec) {
          const s = { x1: prec[0], y1: prec[1], x2: q[0], y2: q[1], voie };
          s.len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
          const m = R.geo((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2);
          s.dans = dansGeometrie(m[0], m[1], commune.geometry);
          if (s.dans) voie.longueur += s.len;
          voie.segments.push(s);
        }
        prec = q;
      }
      if (voie.segments.length) voies.push(voie);
    }
    return voies;
  }
  function longueursParType(voies) {
    const l = { piste: 0, bande: 0, verte: 0, bus: 0, total: 0 };
    for (const v of voies) { l[v.type] += v.longueur; l.total += v.longueur; }
    return l;
  }

  // ---------- Réseau : longueurs, continuité, coupures ----------
  function analyserReseau(osm, R, commune) {
    const cyclables = lireVoies(osm.elements, R, commune, (t) => { const type = typeCyclable(t); return type ? { type } : null; });
    const rues = lireVoies(osm.elements, R, commune, (t) => VOIRIE.test(t.highway) ? {
      rapide: RAPIDE.test(t.highway), apaisee: estApaisee(t), equipee: !!typeCyclable(t), structurant: STRUCTURANT.test(t.highway),
      sensUnique: (t.oneway === "yes" || t.oneway === "-1") && !RAPIDE.test(t.highway),
      contresens: t["oneway:bicycle"] === "no" || /opposite/.test([t.cycleway, t["cycleway:left"], t["cycleway:right"]].join(" ")),
    } : null);

    const res = { cyclables, rues, longueurs: longueursParType(cyclables) };
    // Voirie : tout sauf autoroutes et voies rapides.
    res.voirie = 0; res.apaisee = 0; res.sensUniqueApaise = 0; res.contresensApaise = 0; res.structurant = 0; res.structurantEquipe = 0;
    for (const r of rues) {
      if (r.rapide) continue;
      res.voirie += r.longueur;
      if (r.apaisee) res.apaisee += r.longueur;
      if (r.structurant) { res.structurant += r.longueur; if (r.equipee) res.structurantEquipe += r.longueur; }
      if (r.apaisee && r.sensUnique && r.tags.highway !== "pedestrian") { res.sensUniqueApaise += r.longueur; if (r.contresens) res.contresensApaise += r.longueur; }
    }

    // Continuité : deux voies cyclables sont reliées si une extrémité de l'une est à moins de 30 m de l'autre.
    const segCyc = cyclables.flatMap((v) => v.segments);
    const gCyc = grilleSegments(segCyc, 60);
    res.grilleCyclable = gCyc;
    const parent = new Map(cyclables.map((v) => [v, v]));
    const racine = (v) => { while (parent.get(v) !== v) { parent.set(v, parent.get(parent.get(v))); v = parent.get(v); } return v; };
    const bouts = [];
    for (const v of cyclables) {
      const a = v.segments[0], b = v.segments[v.segments.length - 1];
      for (const [x, y, dans] of [[a.x1, a.y1, a.dans], [b.x2, b.y2, b.dans]]) {
        let voisins = 0;
        gCyc.autour(x, y, TOLERANCE_CONTINUITE_M, (s) => {
          if (s.voie === v || distSegment(x, y, s) > TOLERANCE_CONTINUITE_M) return;
          voisins++;
          const r1 = racine(v), r2 = racine(s.voie);
          if (r1 !== r2) parent.set(r1, r2);
        });
        bouts.push({ x, y, voie: v, dans, voisins });
      }
    }
    const ensembles = new Map();
    for (const v of cyclables) { const r = racine(v); ensembles.set(r, (ensembles.get(r) || 0) + v.longueur); }
    const tailles = [...ensembles.values()].filter((l) => l > 0).sort((a, b) => b - a);
    res.nbEnsembles = tailles.length;
    res.plusGrand = tailles[0] || 0;
    res.petitsTroncons = tailles.filter((l) => l < 200).length;

    // Coupures : extrémité sans suite cyclable, qui débouche sur une voie ni apaisée ni équipée.
    const segRues = rues.filter((r) => !r.rapide).flatMap((r) => r.segments);
    const gRues = grilleSegments(segRues, 60);
    res.grilleRues = gRues;
    res.coupures = [];
    for (const b of bouts) {
      if (!b.dans || b.voisins) continue;
      let pire = null;
      gRues.autour(b.x, b.y, RAYON_VOIE_M, (s) => {
        const r = s.voie;
        if (r.equipee || r.apaisee || distSegment(b.x, b.y, s) > RAYON_VOIE_M) return;
        if (!pire || (r.structurant && !pire.structurant)) pire = r;
      });
      if (!pire) continue;   // débouche sur une rue apaisée ou hors voirie : pas une coupure
      const g = R.geo(b.x, b.y);
      res.coupures.push({ x: b.x, y: b.y, lon: g[0], lat: g[1], ensemble: racine(b.voie), type: b.voie.type,
        structurant: pire.structurant, rue: pire.tags.name || b.voie.tags.name || "voie sans nom", ref: pire.tags.ref || "" });
    }
    // Chaînons manquants : deux coupures d'ensembles différents, distantes de moins de 400 m.
    res.chainons = [];
    const prises = new Set();
    const paires = [];
    for (let i = 0; i < res.coupures.length; i++) for (let j = i + 1; j < res.coupures.length; j++) {
      const a = res.coupures[i], b = res.coupures[j];
      if (a.ensemble === b.ensemble) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > TOLERANCE_CONTINUITE_M && d <= CHAINON_MAX_M) paires.push({ a, b, d });
    }
    paires.sort((p, q) => p.d - q.d);
    for (const p of paires) {
      if (prises.has(p.a) || prises.has(p.b)) continue;
      prises.add(p.a); prises.add(p.b);
      res.chainons.push({ a: p.a, b: p.b, longueur: p.d, structurant: p.a.structurant || p.b.structurant });
    }
    return res;
  }

  // ---------- Stationnement vélo, arrêts, gares ----------
  function centreElement(e) {
    if (e.type === "node") return [e.lon, e.lat];
    if (e.center) return [e.center.lon, e.center.lat];
    if (e.geometry && e.geometry.length) return [e.geometry.reduce((s, p) => s + p.lon, 0) / e.geometry.length, e.geometry.reduce((s, p) => s + p.lat, 0) / e.geometry.length];
    if (e.bounds) return [(e.bounds.minlon + e.bounds.maxlon) / 2, (e.bounds.minlat + e.bounds.maxlat) / 2];
    return null;
  }
  function analyserLieux(osm, R, commune) {
    const arceaux = [], locations = [], bus = [], brutes = [];
    for (const e of osm.elements) {
      const t = e.tags || {};
      const c = centreElement(e);
      if (!c) continue;
      const [x, y] = R.xy(c[0], c[1]);
      const p = { x, y, lon: c[0], lat: c[1], dans: dansGeometrie(c[0], c[1], commune.geometry) };
      if (t.amenity === "bicycle_parking") {
        const places = parseInt(t.capacity, 10);
        arceaux.push(Object.assign(p, { places: isFinite(places) ? places : null, abrite: t.covered === "yes" || /^(shed|lockers|building)$/.test(t.bicycle_parking || "") }));
      } else if (t.amenity === "bicycle_rental" && e.type === "node") locations.push(Object.assign(p, { nom: t.name || "" }));
      else if (t.highway === "bus_stop" && e.type === "node") bus.push(p);
      else if (e.type === "node" && /^(station|halt|tram_stop)$/.test(t.railway || "")) {
        const mode = t.railway === "tram_stop" ? "tramway" : (t.station === "subway" || t.subway === "yes") ? "métro" : "train ou RER";
        brutes.push(Object.assign(p, { nom: t.name || "Station sans nom", modes: new Set([mode]) }));
      }
    }
    // Une même station figure plusieurs fois (une par ligne ou par quai) : on regroupe par nom à moins de 250 m.
    const gares = [];
    for (const s of brutes) {
      const meme = gares.find((g) => g.nom === s.nom && Math.hypot(g.x - s.x, g.y - s.y) < 250);
      if (meme) { s.modes.forEach((m) => meme.modes.add(m)); meme.dans = meme.dans || s.dans; } else gares.push(s);
    }
    // Gares retenues : dans la commune, ou à moins de 300 m de sa limite (souvent posée sur les voies).
    const contour = [];
    for (const poly of polygones(commune.geometry)) for (const anneau of poly) for (let i = 1; i < anneau.length; i++) {
      const a = R.xy(anneau[i - 1][0], anneau[i - 1][1]), b = R.xy(anneau[i][0], anneau[i][1]);
      contour.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
    }
    for (const g of gares) {
      g.horsCommune = !g.dans;
      if (!g.dans) { let m = Infinity; for (const c of contour) { const dd = distSegment(g.x, g.y, c); if (dd < m) m = dd; } g.dans = m <= GARE_VOISINE_M; g.ecart = m; }
    }
    return { arceaux, locations, bus, gares };
  }

  // ---------- Accidents ----------
  // Une même rue est saisie de plusieurs façons (« PARIS (RUE DE) », « 12 rue de Paris ») :
  // la clé les rapproche, l'affichage garde la graphie accentuée quand elle existe.
  function nomDeVoie(adresse) {
    let brut = adresse.replace(/\s+/g, " ").trim();
    const m = brut.match(/^(.*?)\s*\(([^)]*)\)/);          // « PARIS (RUE DE) » -> « RUE DE PARIS »
    if (m) brut = (m[2] + " " + m[1]).trim();
    brut = brut.replace(/^\d+\s*(bis|ter)?[, ]+/i, "");
    const cle = brut.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    const soigne = /[a-zà-ÿ]/.test(brut);
    const affichage = soigne ? brut : brut.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (x, a, c) => a + c.toUpperCase())
      .replace(/ (De|Du|Des|La|Le|Les|Et|Sur|Sous) /g, (x) => x.toLowerCase()).replace(/ (D|L)'/g, (x) => x.toLowerCase());
    return { cle, affichage, soigne };
  }
  const appartient = (codeFichier, code) => codeFichier === code || (ARRONDISSEMENTS[code] && codeFichier.startsWith(ARRONDISSEMENTS[code]));
  async function chargerAccidents(code, dep, R, commune) {
    const lignes = (await tsv(`data/accidents/${dep}.tsv`)).filter((l) => appartient(l.commune, code));
    const acc = lignes.map((l) => {
      const lon = +l.lon, lat = +l.lat, [x, y] = R.xy(lon, lat);
      return { id: l.id, annee: +l.annee, heure: l.heure, adresse: l.adresse || "", lon, lat, x, y,
        pieton: l.pieton === "1", velo: l.velo === "1", edp: l.edp === "1", victimes: +l.victimes, tues: +l.tues, hospit: +l.hospit,
        gravite: l.gravite, adverse: l.adverse, carrefour: l.int !== "1" && l.int !== "" };
    });
    // Un point placé loin de la commune (erreur de saisie) ne peut pas être cartographié : compté à part.
    const [x0, y0, x1, y1] = commune.bbox;
    for (const a of acc) a.place = a.lon > x0 - 0.01 && a.lon < x1 + 0.01 && a.lat > y0 - 0.01 && a.lat < y1 + 0.01;
    const places = acc.filter((a) => a.place);

    // Points de concentration : on part de l'accident le plus entouré et on retire son voisinage.
    const g = grillePoints(places, RAYON_CONCENTRATION_M);
    for (const a of places) a.voisins = pointsAutour(g, a.x, a.y, RAYON_CONCENTRATION_M).length;
    const pris = new Set(), concentrations = [];
    for (const a of [...places].sort((p, q) => q.voisins - p.voisins)) {
      if (pris.has(a) || a.voisins < SEUIL_CONCENTRATION) continue;
      const groupe = pointsAutour(g, a.x, a.y, RAYON_CONCENTRATION_M).filter((p) => !pris.has(p));
      if (groupe.length < SEUIL_CONCENTRATION) continue;
      groupe.forEach((p) => pris.add(p));
      // Une même rue est saisie de plusieurs façons (« PARIS (RUE DE) », « 12 rue de Paris ») : on les rapproche.
      const noms = new Map();
      for (const p of groupe) {
        const n = nomDeVoie(p.adresse);
        if (!n.cle) continue;
        const o = noms.get(n.cle) || { nb: 0, affichage: n.affichage, soigne: n.soigne };
        o.nb++;
        if (n.soigne && !o.soigne) { o.affichage = n.affichage; o.soigne = true; }
        noms.set(n.cle, o);
      }
      const lieu = [...noms.values()].sort((p, q) => q.nb - p.nb).slice(0, 2).map((n) => n.affichage).join(" / ") || "lieu non renseigné";
      concentrations.push({
        lieu, nb: groupe.length, lon: groupe.reduce((s, p) => s + p.lon, 0) / groupe.length, lat: groupe.reduce((s, p) => s + p.lat, 0) / groupe.length,
        pietons: groupe.filter((p) => p.pieton).length, velos: groupe.filter((p) => p.velo).length, edp: groupe.filter((p) => p.edp).length,
        graves: groupe.filter((p) => p.gravite === "tué" || p.gravite === "blessé hospitalisé").length, tues: groupe.reduce((s, p) => s + p.tues, 0),
      });
    }
    concentrations.sort((p, q) => (q.graves - p.graves) || (q.nb - p.nb));
    return { tous: acc, places, concentrations, grille: g };
  }

  // ---------- Écoles ----------
  async function chargerEcoles(code, dep, R) {
    return (await tsv(`data/equipements/${dep}.tsv`)).filter((l) => appartient(l.commune, code)).map((l) => {
      const lon = +l.lon, lat = +l.lat, [x, y] = R.xy(lon, lat);
      return { nom: l.nom, type: l.type, lon, lat, x, y };
    });
  }

  // ---------- Parts modales ----------
  const MODES = [["marche", "Marche à pied"], ["velo", "Vélo (y compris à assistance électrique)"], ["tc", "Transports en commun"], ["voiture", "Voiture, camion, fourgonnette"], ["drm", "Deux-roues motorisé"], ["aucun", "Pas de déplacement"]];
  async function chargerModes(code, dep) {
    const [lignes, france] = await Promise.all([tsv(`data/parts_modales/${dep}.tsv`), json("data/parts_modales/france.json")]);
    const champs = Object.keys(lignes[0]).filter((k) => k !== "commune");
    const somme = (ls) => { const o = {}; for (const k of champs) o[k] = ls.reduce((s, l) => s + (+l[k] || 0), 0); return o; };
    let propres = lignes.filter((l) => l.commune === code);
    if (!propres.length) propres = lignes.filter((l) => appartient(l.commune, code));
    if (!propres.length) return null;
    const commune = somme(propres);
    if (!(commune.actifs22 > 0)) return null;
    // Rang de la part du vélo parmi les communes du département d'au moins 2 000 actifs occupés.
    const comparables = lignes.filter((l) => +l.actifs22 >= 2000 && !/^(751|6938|132)/.test(l.commune)).map((l) => +l.velo22 / +l.actifs22).sort((a, b) => b - a);
    const part = commune.velo22 / commune.actifs22;
    return { commune, departement: somme(lignes), france, rangVelo: comparables.filter((p) => p > part).length + 1, nbComparables: comparables.length };
  }

  // ---------- Population proche ----------
  let indexCarreaux = null;
  async function chargerPopulation(commune, dep, R, reseau, lieux) {
    if (!indexCarreaux) indexCarreaux = await json("data/carreaux/index.json");
    const info = indexCarreaux[dep];
    if (!info) return null;
    const texte = await (await fetch(`data/carreaux/${dep}.csv`)).text();
    const versGeo = proj4("EPSG:" + info.epsg, "EPSG:4326");
    const [x0, y0, x1, y1] = commune.bbox;
    const gBus = grillePoints(lieux.bus, PROCHE_BUS_M), gGares = grillePoints(lieux.gares, PROCHE_GARE_M);
    const tot = { habitants: 0, presReseau: 0, presTransport: 0, carreaux: 0 };
    const lignes = texte.split("\n");
    for (let i = 1; i < lignes.length; i++) {
      if (!lignes[i]) continue;
      const v = lignes[i].split(",");
      const c = versGeo.forward([+v[1] * 200 + 100, +v[0] * 200 + 100]);
      if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1 || !dansGeometrie(c[0], c[1], commune.geometry)) continue;
      const ind = +v[2], [x, y] = R.xy(c[0], c[1]);
      tot.carreaux++; tot.habitants += ind;
      if (distanceAuReseau(reseau.grilleCyclable, x, y, PROCHE_RESEAU_M) < Infinity) tot.presReseau += ind;
      if (pointsAutour(gBus, x, y, PROCHE_BUS_M).length || pointsAutour(gGares, x, y, PROCHE_GARE_M).length) tot.presTransport += ind;
    }
    return tot.carreaux ? tot : null;
  }

  // ---------- Croisements : écoles et gares ----------
  function croiser(d) {
    const { reseau, lieux, accidents } = d;
    const gArceaux = grillePoints(lieux.arceaux, 100), gLoc = grillePoints(lieux.locations, 100);
    const places = (x, y, r) => { const a = pointsAutour(gArceaux, x, y, r); return { nb: a.length, places: a.reduce((s, p) => s + (p.places || 0), 0), abrites: a.filter((p) => p.abrite).length }; };
    if (d.ecoles) for (const e of d.ecoles) {
      e.distReseau = distanceAuReseau(reseau.grilleCyclable, e.x, e.y, 1000);
      let apaisee = false, voie = false;
      reseau.grilleRues.autour(e.x, e.y, 40, (s) => { if (distSegment(e.x, e.y, s) <= 40) { voie = true; if (s.voie.apaisee) apaisee = true; } });
      e.apaisee = voie ? apaisee : null;
      e.arceaux = places(e.x, e.y, RAYON_ARCEAUX_ECOLE_M);
      const acc = accidents ? pointsAutour(accidents.grille, e.x, e.y, RAYON_ACCIDENTS_ECOLE_M) : [];
      e.accidents = acc.length; e.accidentsGraves = acc.filter((a) => a.gravite === "tué" || a.gravite === "blessé hospitalisé").length;
      // Points d'attention : accidents graves, accidents nombreux, rue non apaisée, pas d'arceau, réseau loin.
      e.points = (e.accidentsGraves ? 2 : 0) + (e.accidents >= 3 ? 1 : 0) + (e.apaisee === false ? 1 : 0) + (e.arceaux.nb === 0 ? 1 : 0) + (e.distReseau > PROCHE_RESEAU_M ? 1 : 0);
    }
    for (const g of lieux.gares) {
      g.arceaux = places(g.x, g.y, RAYON_ARCEAUX_GARE_M);
      g.locations = pointsAutour(gLoc, g.x, g.y, RAYON_ARCEAUX_GARE_M).length;
      g.distReseau = distanceAuReseau(reseau.grilleCyclable, g.x, g.y, 1000);
    }
  }

  // ---------- Actions priorisées ----------
  function proposerActions(d) {
    const actions = [], dep = d.dep, idf = ILE_DE_FRANCE.includes(dep);
    const voirie = "Commune ou intercommunalité, selon le gestionnaire de la voie";
    if (d.accidents) for (const c of d.accidents.concentrations.slice(0, 5)) {
      actions.push({ priorite: c.graves >= 3 ? 1 : 2, theme: "Sécurité", lieu: c.lieu, lon: c.lon, lat: c.lat,
        constat: `${c.nb} accidents de piétons, de cyclistes ou de trottinettes en 6 ans dans un rayon de ${RAYON_CONCENTRATION_M} m (${c.pietons} avec piéton, ${c.velos} avec vélo), dont ${c.graves} avec tué ou blessé hospitalisé`,
        proposition: "Diagnostic de sécurité sur place, puis aménagement du carrefour ou de la traversée", partenaire: voirie + " ; forces de l'ordre pour les procès-verbaux" });
    }
    const chainons = [...d.reseau.chainons].sort((a, b) => (b.structurant - a.structurant) || (a.longueur - b.longueur)).slice(0, 5);
    for (const c of chainons) {
      const rues = [...new Set([c.a.rue, c.b.rue])].join(" et ");
      actions.push({ priorite: c.structurant && c.longueur <= 200 ? 1 : c.structurant ? 2 : 3, theme: "Continuité cyclable", lieu: rues, lon: (c.a.lon + c.b.lon) / 2, lat: (c.a.lat + c.b.lat) / 2,
        constat: `Deux aménagements cyclables s'interrompent à ${fmt(c.longueur)} m l'un de l'autre${c.structurant ? ", sur un axe principal" : ""}`,
        proposition: `Relier les deux tronçons (environ ${fmt(Math.round(c.longueur / 10) * 10)} m à vol d'oiseau)`, partenaire: gestionnaire(c.a.ref || c.b.ref) });
    }
    if (d.ecoles) for (const e of [...d.ecoles].filter((e) => e.points >= 3).sort((a, b) => b.points - a.points).slice(0, 5)) {
      const manques = [];
      if (e.accidents) manques.push(`${pluriel(e.accidents, "accident")} à moins de ${RAYON_ACCIDENTS_ECOLE_M} m en 6 ans${e.accidentsGraves ? ` dont ${e.accidentsGraves} grave${e.accidentsGraves > 1 ? "s" : ""}` : ""}`);
      if (e.apaisee === false) manques.push("rue non limitée à 30 km/h d'après OpenStreetMap");
      if (!e.arceaux.nb) manques.push(`aucun stationnement vélo recensé à moins de ${RAYON_ARCEAUX_ECOLE_M} m`);
      if (e.distReseau > PROCHE_RESEAU_M) manques.push(`aménagement cyclable le plus proche à ${e.distReseau < Infinity ? fmt(e.distReseau) + " m" : "plus de 1 km"}`);
      actions.push({ priorite: e.points >= 5 ? 1 : e.points >= 4 ? 2 : 3, theme: "Abords d'école", lieu: e.nom, lon: e.lon, lat: e.lat, constat: manques.join(" ; "),
        proposition: [e.accidents ? "Diagnostic de sécurité des traversées autour de l'établissement" : "", e.apaisee === false ? "apaiser la rue (zone 30 ou rue scolaire aux heures d'entrée et de sortie)" : "", !e.arceaux.nb ? "poser des arceaux" : "", e.distReseau > PROCHE_RESEAU_M ? "relier au réseau cyclable" : ""].filter(Boolean).join(" ; ").replace(/^./, (c) => c.toUpperCase()), partenaire: "Commune (voirie, éducation) ; parents d'élèves ; Département pour un collège, Région pour un lycée" });
    }
    for (const g of d.lieux.gares.filter((g) => g.dans && g.arceaux.places < 10 && !g.modes.has("tramway")).slice(0, 4)) {
      actions.push({ priorite: 2, theme: "Vélo et transports", lieu: g.nom + " (" + [...g.modes].join(", ") + (g.horsCommune ? ", en limite de commune" : "") + ")", lon: g.lon, lat: g.lat,
        constat: `${g.arceaux.places ? g.arceaux.places + " places de" : "Aucune place de"} stationnement vélo recensée à moins de ${RAYON_ARCEAUX_GARE_M} m${g.arceaux.nb && !g.arceaux.places ? ` (${g.arceaux.nb} emplacement${g.arceaux.nb > 1 ? "s" : ""} sans capacité renseignée)` : ""}`,
        proposition: "Vérifier sur place, puis créer un stationnement vélo abrité et sécurisé", partenaire: idf ? "Île-de-France Mobilités, SNCF ou RATP" : "Autorité organisatrice de la mobilité, SNCF" });
    }
    const r = d.reseau, manque = r.sensUniqueApaise - r.contresensApaise;
    if (manque > 300) actions.push({ priorite: 3, theme: "Double-sens cyclable", lieu: "Rues à sens unique limitées à 30 km/h ou moins", lon: null, lat: null,
      constat: `${km(manque)} de rues apaisées à sens unique sans double-sens cyclable renseigné dans OpenStreetMap, sur ${km(r.sensUniqueApaise)}`,
      proposition: "Vérifier la signalisation en place, puis ouvrir ces rues aux vélos dans les deux sens (règle générale du code de la route dans les rues à 30 km/h ou moins, sauf décision motivée du maire)", partenaire: "Commune (police de la circulation)" });
    actions.sort((a, b) => a.priorite - b.priorite);
    return actions;
  }

  // ---------- Carte ----------
  let carte = null, couches = {}, toile = null;
  function preparerCarte() {
    if (carte) return;
    carte = L.map("carte", { zoomSnap: 0.25, preferCanvas: true });
    toile = L.canvas({ padding: 0.3 });
    L.tileLayer("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
      { attribution: "Fond : IGN, Plan IGN · Données : © contributeurs OpenStreetMap", maxZoom: 19, opacity: 0.6 }).addTo(carte);
    L.control.scale({ imperial: false }).addTo(carte);
  }
  // À l'impression, la carte change de taille : on la recadre sur la commune, puis on revient à l'écran.
  function recadrer() { if (carte && couches.contour) { carte.invalidateSize(); carte.fitBounds(couches.contour.getBounds(), { padding: [8, 8], animate: false }); } }
  window.addEventListener("beforeprint", recadrer);
  window.addEventListener("afterprint", recadrer);
  if (window.matchMedia) window.matchMedia("print").addEventListener("change", recadrer);
  function viderCarte() { for (const c of Object.values(couches)) if (c) carte.removeLayer(c); couches = {}; }
  const CASES = { reseau: "#voir-reseau", apaise: "#voir-apaise", coupures: "#voir-coupures", pieton: "#voir-pieton", velo: "#voir-velo", edp: "#voir-edp", concentrations: "#voir-concentrations", ecoles: "#voir-ecoles", gares: "#voir-gares", arceaux: "#voir-arceaux" };
  function majAffichage() {
    if (!carte) return;
    for (const [cle, sel] of Object.entries(CASES)) {
      const c = couches[cle];
      if (!c) continue;
      if ($(sel).checked) c.addTo(carte); else carte.removeLayer(c);
    }
    majLegende();
  }
  Object.values(CASES).forEach((s) => $(s).addEventListener("input", majAffichage));
  const puce = (classe, lettre) => L.divIcon({ className: "lieu", html: `<span class="puce ${classe}"><span>${lettre}</span></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  const bulle = (html) => `<div class="infobulle">${html}</div>`;

  function dessiner(d) {
    const r = d.reseau;
    couches.apaise = L.featureGroup(r.rues.filter((v) => v.apaisee && v.longueur > 0).map((v) =>
      L.polyline(v.latlngs, { renderer: toile, color: "#9a9892", weight: 2, opacity: 0.9, interactive: false })));
    couches.reseau = L.featureGroup(r.cyclables.filter((v) => v.longueur > 0).map((v) => {
      const t = TYPES[v.type];
      return L.polyline(v.latlngs, { renderer: toile, color: t.couleur, weight: 4, opacity: 0.95, dashArray: t.tirets })
        .bindPopup(bulle(`<b>${t.nom}</b><br>${echappe(v.tags.name || "voie sans nom")} · ${fmt(v.longueur)} m dans la commune`));
    }));
    couches.coupures = L.featureGroup(r.coupures.map((c) =>
      L.marker([c.lat, c.lon], { icon: puce("coupure", "!"), keyboard: false })
        .bindPopup(bulle(`<b>Fin d'aménagement cyclable</b><br>${echappe(TYPES[c.type].nom)} qui s'arrête sur ${echappe(c.rue)}${c.structurant ? " (axe principal)" : ""}, sans suite à moins de ${TOLERANCE_CONTINUITE_M} m.`))));
    if (d.accidents) {
      const rond = (a) => {
        const grave = a.gravite === "tué" || a.gravite === "blessé hospitalisé";
        return L.circleMarker([a.lat, a.lon], { renderer: toile, radius: a.gravite === "tué" ? 8 : grave ? 6 : 4, color: "#fff", weight: 1.5,
          fillColor: a.gravite === "tué" ? "#14213d" : grave ? "#a33a12" : "#d98a6f", fillOpacity: 0.95 })
          .bindPopup(bulle(`<b>Accident de ${a.annee}</b>, vers ${a.heure} h<br>${echappe(a.adresse)}<br>Usager vulnérable : ${[a.pieton && "piéton", a.velo && "cycliste", a.edp && "trottinette ou engin personnel"].filter(Boolean).join(", ")}<br>Gravité la plus forte : ${a.gravite}<br>Autre véhicule : ${echappe(a.adverse)}`));
      };
      // Un accident peut impliquer plusieurs usagers : il est rangé dans une seule couche, par ordre piéton, vélo, trottinette.
      couches.pieton = L.featureGroup(d.accidents.places.filter((a) => a.pieton).map(rond));
      couches.velo = L.featureGroup(d.accidents.places.filter((a) => !a.pieton && a.velo).map(rond));
      couches.edp = L.featureGroup(d.accidents.places.filter((a) => !a.pieton && !a.velo && a.edp).map(rond));
      couches.concentrations = L.featureGroup(d.accidents.concentrations.map((c) =>
        L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "lieu", html: `<span class="puce concentration"><span>${c.nb}</span></span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false, zIndexOffset: -100 })
          .bindPopup(bulle(`<b>${echappe(c.lieu)}</b><br>${c.nb} accidents en 6 ans dans un rayon de ${RAYON_CONCENTRATION_M} m : ${c.pietons} avec piéton, ${c.velos} avec vélo, ${c.edp} avec trottinette.<br>${c.graves} avec tué ou blessé hospitalisé.`))));
    }
    if (d.ecoles) couches.ecoles = L.featureGroup(d.ecoles.map((e) =>
      L.marker([e.lat, e.lon], { icon: puce(e.points >= 3 ? "chaud" : "", e.type === "ecole" ? "É" : e.type === "college" ? "C" : "L"), keyboard: false })
        .bindPopup(bulle(`<b>${echappe(e.nom)}</b><br>Aménagement cyclable le plus proche : ${e.distReseau < Infinity ? fmt(e.distReseau) + " m" : "plus de 1 km"}<br>Rue apaisée : ${e.apaisee == null ? "voie non trouvée" : e.apaisee ? "oui" : "non renseignée"}<br>Stationnement vélo à ${RAYON_ARCEAUX_ECOLE_M} m : ${e.arceaux.nb ? e.arceaux.nb + " emplacement(s), " + e.arceaux.places + " places renseignées" : "aucun recensé"}<br>Accidents à ${RAYON_ACCIDENTS_ECOLE_M} m : ${e.accidents}${e.accidentsGraves ? " dont " + e.accidentsGraves + " grave(s)" : ""}`))));
    couches.gares = L.featureGroup(d.lieux.gares.filter((g) => g.dans).map((g) =>
      L.marker([g.lat, g.lon], { icon: puce("gare", "G"), keyboard: false })
        .bindPopup(bulle(`<b>${echappe(g.nom)}</b> (${[...g.modes].join(", ")})<br>Stationnement vélo à ${RAYON_ARCEAUX_GARE_M} m : ${g.arceaux.nb ? g.arceaux.nb + " emplacement(s), " + g.arceaux.places + " places renseignées" : "aucun recensé"}<br>Vélos en libre-service à ${RAYON_ARCEAUX_GARE_M} m : ${g.locations} station(s)`))));
    couches.arceaux = L.featureGroup(d.lieux.arceaux.filter((a) => a.dans).map((a) =>
      L.circleMarker([a.lat, a.lon], { renderer: toile, radius: 3.5, color: "#fff", weight: 1, fillColor: "#52514e", fillOpacity: 0.95 })
        .bindPopup(bulle(`<b>Stationnement vélo</b><br>${a.places != null ? a.places + " places" : "capacité non renseignée"}${a.abrite ? ", abrité" : ""}`))));
    majAffichage();
  }
  let courant = null;
  function majLegende() {
    const d = courant, blocs = [];
    if (!d || !d.reseau) { $("#legende").innerHTML = ""; return; }
    if ($("#voir-reseau").checked) blocs.push(`<div class="bloc"><div class="titre">Aménagements cyclables</div><div class="puces">${ORDRE_TYPES.map((t) =>
      `<span class="item"><span class="trait ${t}" style="border-top-color:${TYPES[t].couleur}"></span>${TYPES[t].nom}</span>`).join("")}${$("#voir-apaise").checked ? '<span class="item"><span class="trait apaise"></span>Rue à 30 km/h ou moins</span>' : ""}</div></div>`);
    if (d.accidents) blocs.push(`<div class="bloc"><div class="titre">Accidents 2019-2024, gravité la plus forte parmi les usagers vulnérables</div><div class="puces">
      <span class="item"><span class="rond" style="width:9px;height:9px;background:#d98a6f"></span>blessé léger</span>
      <span class="item"><span class="rond" style="width:13px;height:13px;background:#a33a12"></span>blessé hospitalisé</span>
      <span class="item"><span class="rond" style="width:17px;height:17px;background:#14213d"></span>tué</span>
      <span class="item"><span class="puce concentration" style="width:20px;height:20px;font-size:9px">4</span>&nbsp;point de concentration</span></div></div>`);
    blocs.push(`<div class="bloc"><div class="titre">Lieux</div><div class="puces">
      <span class="item"><span class="puce">É</span>&nbsp;école, C collège, L lycée</span>
      <span class="item"><span class="puce chaud">É</span>&nbsp;au moins 3 points d'attention</span>
      <span class="item"><span class="puce gare">G</span>&nbsp;gare ou station</span>
      <span class="item"><span class="puce coupure"><span>!</span></span>&nbsp;fin d'aménagement sans suite</span></div></div>`);
    $("#legende").innerHTML = blocs.join("");
  }

  // ---------- Rédaction ----------
  const nombre = (v, d = 0) => (v == null || !isFinite(v)) ? "" : String(Math.round(v * 10 ** d) / 10 ** d).replace(".", ",");
  function telecharger(nom, lignes) {
    const texte = "﻿" + lignes.map((l) => l.map((c) => { const s = String(c == null ? "" : c); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texte], { type: "text/csv;charset=utf-8" }));
    a.download = nom; document.body.appendChild(a); a.click(); a.remove();
  }
  const barre = (v, max, ref) => `<td class="barre"><div style="width:${Math.max(0, Math.min(100, 100 * v / max))}%"></div>${ref != null ? `<div class="ref" style="width:${Math.max(0, Math.min(100, 100 * ref / max))}%"></div>` : ""}</td>`;

  function texteEvolution(d) {
    const h = d.histoire;
    if (h === undefined) return `<p class="attente" id="evolution">Comparaison avec le réseau au 1ᵉʳ janvier 2020 : calcul en cours, une à trois minutes…</p>`;
    if (h === null) return `<p class="note" id="evolution">La comparaison avec le réseau au 1ᵉʳ janvier 2020 n'a pas abouti (serveur d'historique d'OpenStreetMap saturé). Rechargez la page pour réessayer.</p>`;
    const a = d.reseau.longueurs;
    return `<div id="evolution"><table><thead><tr><th>Type d'aménagement</th><th class="n">1ᵉʳ janvier 2020</th><th class="n">Aujourd'hui</th><th class="n">Évolution</th></tr></thead><tbody>
      ${ORDRE_TYPES.map((t) => `<tr><td>${TYPES[t].nom}</td><td class="n">${km(h[t])}</td><td class="n">${km(a[t])}</td><td class="n">${signe((a[t] - h[t]) / 1000)} km</td></tr>`).join("")}
      <tr><td><b>Ensemble</b></td><td class="n"><b>${km(h.total)}</b></td><td class="n"><b>${km(a.total)}</b></td><td class="n"><b>${signe((a.total - h.total) / 1000)} km</b></td></tr></tbody></table>
      <p class="note">Les deux états sont lus dans OpenStreetMap avec la même méthode. L'écart mêle les aménagements réellement créés et ceux qui existaient déjà mais n'ont été cartographiés qu'après 2020 : il donne un ordre de grandeur, à recouper avec les chantiers connus des services.</p></div>`;
  }

  function rediger(d) {
    const p = d.commune.properties, r = d.reseau, L1 = r.longueurs, a = d.accidents, m = d.modes, pop = d.population, h = [];
    const date = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    h.push(`<h2>${echappe(p.nom)}</h2>
      <p class="sous-titre">Bilan des mobilités douces · ${fmt(p.population)} habitants · ${fmt(p.surface / 100, 1)} km² · établi le ${date}</p>
      <div class="actions"><button id="imprimer">Imprimer ou enregistrer en PDF</button>
      <button id="csv-actions">Actions (CSV pour Excel)</button>${a ? '<button id="csv-accidents">Accidents (CSV)</button>' : ""}${d.ecoles && d.ecoles.length ? '<button id="csv-ecoles">Écoles (CSV)</button>' : ""}</div>`);

    // Synthèse
    const s = [];
    s.push(`<b>${km(L1.total)} d'aménagements cyclables</b> recensés, soit ${fmt(100 * L1.total / r.voirie, 0)} km pour 100 km de voirie${pop ? ` ; ${pct(pop.presReseau, pop.habitants)} des habitants en ont un à moins de ${PROCHE_RESEAU_M} m` : ""}.`);
    if (L1.total > 0) s.push(`Le réseau est morcelé en <b>${pluriel(r.nbEnsembles, "ensemble continu", "ensembles continus")}</b> ; le plus grand porte ${pct(r.plusGrand, L1.total)} du linéaire. ${pluriel(r.coupures.length, "aménagement s'arrête", "aménagements s'arrêtent")} sur une voie ni équipée ni apaisée.`);
    s.push(`${pct(r.apaisee, r.voirie)} de la voirie est limitée à 30 km/h ou moins d'après OpenStreetMap.`);
    if (a) {
      const graves = a.tous.filter((x) => x.gravite === "tué" || x.gravite === "blessé hospitalisé").length, tues = a.tous.reduce((t, x) => t + x.tues, 0);
      s.push(`<b>${pluriel(a.tous.length, "accident corporel", "accidents corporels")}</b> avec un piéton, un cycliste ou une trottinette de 2019 à 2024, dont ${graves} avec tué ou blessé hospitalisé (${pluriel(tues, "personne tuée", "personnes tuées")}) ; ${pluriel(a.concentrations.length, "point de concentration", "points de concentration")}.`);
    }
    if (m) s.push(`Pour aller travailler, <b>${pct(m.commune.velo22, m.commune.actifs22, 1)} des actifs prennent le vélo</b> et ${pct(m.commune.marche22, m.commune.actifs22, 1)} marchent (département : ${pct(m.departement.velo22, m.departement.actifs22, 1)} et ${pct(m.departement.marche22, m.departement.actifs22, 1)}).`);
    if (d.ecoles && d.ecoles.length) s.push(`${d.ecoles.filter((e) => e.arceaux.nb === 0).length} établissements scolaires sur ${d.ecoles.length} n'ont aucun stationnement vélo recensé à moins de ${RAYON_ARCEAUX_ECOLE_M} m.`);
    h.push(`<div class="synthese"><h3>En bref</h3><ul>${s.map((x) => `<li>${x}</li>`).join("")}</ul></div>`);

    // Actions
    const actions = d.actions;
    h.push(`<h3>Actions proposées, par ordre de priorité</h3>`);
    if (actions.length) h.push(`<div class="defile"><table class="actions-table"><thead><tr><th>Prio.</th><th>Thème</th><th>Lieu</th><th>Constat</th><th>Proposition</th><th>Partenaire</th></tr></thead><tbody>
      ${actions.map((x) => `<tr><td><span class="priorite p${x.priorite}">${x.priorite}</span></td><td>${x.theme}</td><td>${echappe(x.lieu)}</td><td>${echappe(x.constat)}</td><td>${echappe(x.proposition)}</td><td>${echappe(x.partenaire)}</td></tr>`).join("")}</tbody></table></div>`);
    else h.push(`<p>Aucune action ne ressort des règles de l'outil pour cette commune.</p>`);
    h.push(`<p class="note">Liste produite par des règles fixes, les mêmes pour toutes les communes : priorité 1 pour un point où au moins trois accidents ont fait un tué ou un blessé hospitalisé, un chaînon manquant de moins de 200 m sur un axe principal, ou une école qui cumule au moins cinq points d'attention. Elle sert à préparer une visite de terrain et un échange avec les services, pas à les remplacer. Les coûts ne sont pas estimés.</p>`);

    // Réseau
    h.push(`<h3>Réseau cyclable</h3><div class="tuiles">
      <div class="tuile"><div class="valeur">${km(L1.total)}</div><div class="libelle">d'aménagements cyclables</div></div>
      <div class="tuile"><div class="valeur">${pct(r.structurantEquipe, r.structurant)}</div><div class="libelle">des axes principaux équipés</div></div>
      <div class="tuile"><div class="valeur">${pct(r.apaisee, r.voirie)}</div><div class="libelle">de la voirie à 30 km/h ou moins</div></div>
      ${pop ? `<div class="tuile"><div class="valeur">${pct(pop.presReseau, pop.habitants)}</div><div class="libelle">des habitants à moins de ${PROCHE_RESEAU_M} m d'un aménagement</div></div>` : ""}</div>
      <table><thead><tr><th>Type</th><th class="n">Longueur</th><th class="n">Part</th><th></th></tr></thead><tbody>
      ${ORDRE_TYPES.map((t) => `<tr><td>${TYPES[t].nom}</td><td class="n">${km(L1[t])}</td><td class="n">${pct(L1[t], L1.total)}</td>${barre(L1[t], Math.max(L1.piste, L1.bande, L1.verte, L1.bus, 1))}</tr>`).join("")}</tbody></table>
      <p class="note">Longueur de voie équipée : une rue avec une bande de chaque côté compte une fois. Voirie de la commune hors autoroutes et voies rapides : ${km(r.voirie)}, dont ${km(r.structurant)} d'axes principaux (routes primaires, secondaires et tertiaires d'OpenStreetMap).</p>
      <p><b>Continuité.</b> ${L1.total > 0 ? `Le réseau forme ${pluriel(r.nbEnsembles, "ensemble continu", "ensembles continus")}, dont ${r.petitsTroncons} de moins de 200 m. Le plus grand mesure ${km(r.plusGrand)}, soit ${pct(r.plusGrand, L1.total)} du linéaire. ${pluriel(r.coupures.length, "extrémité débouche", "extrémités débouchent")} sur une voie sans aménagement et non apaisée, dont ${r.coupures.filter((c) => c.structurant).length} sur un axe principal ; ${pluriel(r.chainons.length, "chaînon manquant", "chaînons manquants")} de moins de ${CHAINON_MAX_M} m ${r.chainons.length > 1 ? "sont repérés" : "est repéré"}.` : "Aucun aménagement cyclable n'est recensé dans OpenStreetMap pour cette commune."}</p>
      <p><b>Double-sens cyclable.</b> ${r.sensUniqueApaise > 0 ? `${km(r.sensUniqueApaise)} de rues à sens unique sont limitées à 30 km/h ou moins ; le double-sens cyclable est renseigné sur ${pct(r.contresensApaise, r.sensUniqueApaise)} de ce linéaire.` : "Aucune rue à sens unique limitée à 30 km/h n'est renseignée."}</p>
      <p><b>Évolution depuis 2020.</b></p>${texteEvolution(d)}`);

    // Accidents
    if (a) {
      const parAn = ANNEES.map((an) => { const l = a.tous.filter((x) => x.annee === an); return { an, nb: l.length, pietons: l.filter((x) => x.pieton).length, velos: l.filter((x) => x.velo).length, edp: l.filter((x) => x.edp).length, graves: l.filter((x) => x.gravite === "tué" || x.gravite === "blessé hospitalisé").length }; });
      const maxi = Math.max(1, ...parAn.map((x) => x.nb));
      const adverses = new Map(); for (const x of a.tous) adverses.set(x.adverse, (adverses.get(x.adverse) || 0) + 1);
      const debut = parAn[0].nb + parAn[1].nb + parAn[2].nb, fin = parAn[3].nb + parAn[4].nb + parAn[5].nb;
      h.push(`<h3>Accidents de piétons, de cyclistes et de trottinettes</h3>
        <table><thead><tr><th>Année</th><th class="n">Accidents</th><th></th><th class="n">avec piéton</th><th class="n">avec vélo</th><th class="n">avec trottinette</th><th class="n">avec tué ou hospitalisé</th></tr></thead><tbody>
        ${parAn.map((x) => `<tr><td>${x.an}</td><td class="n">${x.nb}</td>${barre(x.nb, maxi)}<td class="n">${x.pietons}</td><td class="n">${x.velos}</td><td class="n">${x.edp}</td><td class="n">${x.graves}</td></tr>`).join("")}</tbody></table>
        <p>${fin} accidents de 2022 à 2024 contre ${debut} de 2019 à 2021${debut ? ` (${signe(100 * (fin - debut) / debut, 0)} %)` : ""}. ${pct(a.tous.filter((x) => x.carrefour).length, a.tous.length)} ont lieu en intersection. Autre véhicule en cause : ${[...adverses.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([k, v]) => `${k} (${pct(v, a.tous.length)})`).join(", ")}.</p>`);
      if (a.concentrations.length) h.push(`<div class="defile"><table><thead><tr><th>Point de concentration</th><th class="n">Accidents</th><th class="n">Piétons</th><th class="n">Vélos</th><th class="n">Accidents avec tué ou hospitalisé</th></tr></thead><tbody>
        ${a.concentrations.map((c) => `<tr><td>${echappe(c.lieu)}</td><td class="n">${c.nb}</td><td class="n">${c.pietons}</td><td class="n">${c.velos}</td><td class="n">${c.graves}</td></tr>`).join("")}</tbody></table></div>`);
      h.push(`<p class="note">Accidents corporels enregistrés par les forces de l'ordre (ONISR). Les chutes de cyclistes seuls et les accidents légers y sont très sous-déclarés ; 2020 est marquée par les confinements. Un point de concentration regroupe au moins ${SEUIL_CONCENTRATION} accidents dans un rayon de ${RAYON_CONCENTRATION_M} m en 6 ans.${a.tous.length - a.places.length ? ` ${a.tous.length - a.places.length} accident(s) localisé(s) hors de la commune par erreur de saisie sont comptés mais non cartographiés.` : ""}</p>`);
    }

    // Écoles
    if (d.ecoles && d.ecoles.length) {
      const e = d.ecoles;
      h.push(`<h3>Abords des établissements scolaires</h3><div class="tuiles">
        <div class="tuile"><div class="valeur">${e.filter((x) => x.distReseau <= PROCHE_RESEAU_M).length} sur ${e.length}</div><div class="libelle">à moins de ${PROCHE_RESEAU_M} m d'un aménagement cyclable</div></div>
        <div class="tuile"><div class="valeur">${e.filter((x) => x.apaisee).length} sur ${e.length}</div><div class="libelle">dans une rue à 30 km/h ou moins</div></div>
        <div class="tuile"><div class="valeur">${e.filter((x) => x.arceaux.nb > 0).length} sur ${e.length}</div><div class="libelle">avec un stationnement vélo à ${RAYON_ARCEAUX_ECOLE_M} m</div></div></div>
        <div class="defile"><table><thead><tr><th>Établissement</th><th class="n">Points d'attention</th><th class="n">Réseau cyclable</th><th>Rue apaisée</th><th class="n">Places vélo à ${RAYON_ARCEAUX_ECOLE_M} m</th><th class="n">Accidents à ${RAYON_ACCIDENTS_ECOLE_M} m</th></tr></thead><tbody>
        ${[...e].sort((x, y) => y.points - x.points).map((x) => `<tr><td>${echappe(x.nom)}</td><td class="n">${x.points}</td><td class="n">${x.distReseau < Infinity ? fmt(x.distReseau) + " m" : "> 1 km"}</td><td>${x.apaisee == null ? "n. d." : x.apaisee ? "oui" : "non"}</td><td class="n">${x.arceaux.nb ? x.arceaux.places || "non rens." : "0"}</td><td class="n">${x.accidents}${x.accidentsGraves ? ", dont " + x.accidentsGraves + (x.accidentsGraves > 1 ? " graves" : " grave") : ""}</td></tr>`).join("")}</tbody></table></div>
        <p class="note">Écoles, collèges et lycées de la Base permanente des équipements 2025. Distances à vol d'oiseau depuis le point de l'établissement, qui n'est pas toujours son entrée. Points d'attention : accident grave à proximité (2), au moins trois accidents (1), rue non apaisée (1), aucun stationnement vélo (1), réseau cyclable à plus de ${PROCHE_RESEAU_M} m (1).</p>`);
    }

    // Stationnement et transports
    const arc = d.lieux.arceaux.filter((x) => x.dans), places = arc.reduce((t, x) => t + (x.places || 0), 0), sans = arc.filter((x) => x.places == null).length;
    const gares = d.lieux.gares.filter((g) => g.dans), bus = d.lieux.bus.filter((b) => b.dans).length, loc = d.lieux.locations.filter((l) => l.dans).length;
    h.push(`<h3>Stationnement vélo et transports</h3><div class="tuiles">
      <div class="tuile"><div class="valeur">${fmt(places)}</div><div class="libelle">places de stationnement vélo renseignées (${fmt(arc.length)} emplacements)</div></div>
      <div class="tuile"><div class="valeur">${fmt(loc)}</div><div class="libelle">${loc > 1 ? "stations" : "station"} de vélos en libre-service</div></div>
      <div class="tuile"><div class="valeur">${fmt(gares.length)}</div><div class="libelle">gares et stations (train, RER, métro, tramway), y compris à moins de ${GARE_VOISINE_M} m de la limite communale</div></div>
      ${pop ? `<div class="tuile"><div class="valeur">${pct(pop.presTransport, pop.habitants)}</div><div class="libelle">des habitants à moins de ${PROCHE_BUS_M} m d'un arrêt de bus ou ${PROCHE_GARE_M} m d'une gare</div></div>` : ""}</div>
      <p class="note">${fmt(places)} places pour ${fmt(p.population)} habitants, soit ${fmt(1000 * places / p.population, 1)} pour 1 000 habitants ; ${sans} emplacement(s) sans capacité renseignée ne sont pas comptés dans les places ; ${arc.filter((x) => x.abrite).length} emplacement(s) abrité(s). ${fmt(bus)} arrêts de bus recensés. La fréquence des lignes n'est pas analysée.</p>`);
    if (gares.length) h.push(`<div class="defile"><table><thead><tr><th>Gare ou station</th><th>Mode</th><th class="n">Places vélo à ${RAYON_ARCEAUX_GARE_M} m</th><th class="n">Libre-service à ${RAYON_ARCEAUX_GARE_M} m</th><th class="n">Réseau cyclable</th></tr></thead><tbody>
      ${gares.sort((x, y) => x.arceaux.places - y.arceaux.places).map((g) => `<tr><td>${echappe(g.nom)}${g.horsCommune ? " (à " + fmt(g.ecart) + " m de la limite)" : ""}</td><td>${[...g.modes].join(", ")}</td><td class="n">${g.arceaux.nb ? g.arceaux.places || "non rens." : "0"}</td><td class="n">${g.locations}</td><td class="n">${g.distReseau < Infinity ? fmt(g.distReseau) + " m" : "> 1 km"}</td></tr>`).join("")}</tbody></table></div>`);

    // Parts modales
    if (m) {
      const part = (o, k) => 100 * o[k + "22"] / o.actifs22;
      const maxi = Math.max(...MODES.map(([k]) => Math.max(part(m.commune, k), part(m.departement, k))));
      const evo = (k16, k22) => 100 * m.commune[k22] / m.commune.actifs22 - 100 * m.commune[k16] / m.commune.actifs16;
      h.push(`<h3>Comment les habitants vont travailler</h3>
        <table><thead><tr><th>Mode principal (2022)</th><th class="n">Commune</th><th>Commune, et département en gris</th><th class="n">Département</th><th class="n">France</th></tr></thead><tbody>
        ${MODES.map(([k, nom]) => `<tr><td>${nom}</td><td class="n">${fmt(part(m.commune, k), 1)} %</td>${barre(part(m.commune, k), maxi, part(m.departement, k))}<td class="n">${fmt(part(m.departement, k), 1)} %</td><td class="n">${fmt(part(m.france, k), 1)} %</td></tr>`).join("")}</tbody></table>
        <p>La commune est au ${m.rangVelo}ᵉ rang sur ${m.nbComparables} pour la part du vélo parmi les communes du département d'au moins 2 000 actifs occupés. ${pct(m.commune.sur_place22, m.commune.actifs22)} des actifs travaillent dans la commune, donc sur des distances courtes.${m.commune.actifs16 > 0 ? ` De 2016 à 2022 : marche ${signe(evo("marche16", "marche22"))} point, transports en commun ${signe(evo("tc16", "tc22"))}, voiture ${signe(evo("voiture16", "voiture22"))}, deux-roues (vélo et motorisés ensemble) ${signe(100 * (m.commune.velo22 + m.commune.drm22) / m.commune.actifs22 - 100 * m.commune.deuxroues16 / m.commune.actifs16)}.` : ""}</p>
        <p class="note">INSEE, recensements 2022 et 2016, actifs occupés de 15 ans ou plus, mode de transport principal. En 2016, le vélo n'était pas séparé des deux-roues motorisés : son évolution propre n'est pas calculable. Ces chiffres ne couvrent que les trajets vers le travail, pas l'école, les achats ni les loisirs.</p>`);
    }

    h.push(`<h3>Lire ces résultats</h3>
      <p class="note">Le réseau, le stationnement et les limitations de vitesse viennent d'OpenStreetMap, carte collaborative : ce qui n'y est pas dessiné n'est pas compté, et une rue à 30 km/h non renseignée apparaît comme non apaisée. Chaque constat est à vérifier sur le terrain avant d'engager une dépense.</p>
      <p class="note">Deux tronçons cyclables séparés de moins de ${TOLERANCE_CONTINUITE_M} m sont considérés comme continus (traversée d'un carrefour). Une fin d'aménagement n'est comptée comme coupure que si elle débouche sur une voie sans aménagement et non limitée à 30 km/h. Les distances sont à vol d'oiseau. La population proche est estimée depuis le centre des carreaux de 200 m de l'INSEE (2019).</p>
      <p class="note">L'outil ne connaît pas le contenu du plan de mobilités de la commune : il mesure l'état du territoire et son évolution, à rapprocher ensuite des engagements pris.</p>`);
    $("#fiche-contenu").innerHTML = h.join("");

    $("#imprimer").onclick = () => window.print();
    $("#csv-actions").onclick = () => telecharger(`actions_mobilites_${p.code}.csv`,
      [["priorite", "theme", "lieu", "constat", "proposition", "partenaire", "longitude", "latitude", "cout_estime", "echeance", "pilote"]]
        .concat(actions.map((x) => [x.priorite, x.theme, x.lieu, x.constat, x.proposition, x.partenaire, nombre(x.lon, 5), nombre(x.lat, 5), "", "", ""])));
    if ($("#csv-accidents")) $("#csv-accidents").onclick = () => telecharger(`accidents_${p.code}.csv`,
      [["identifiant", "annee", "heure", "adresse", "pieton", "velo", "trottinette", "gravite", "tues", "hospitalises", "autre_vehicule", "longitude", "latitude"]]
        .concat(a.tous.map((x) => [x.id, x.annee, x.heure, x.adresse, +x.pieton, +x.velo, +x.edp, x.gravite, x.tues, x.hospit, x.adverse, nombre(x.lon, 5), nombre(x.lat, 5)])));
    if ($("#csv-ecoles")) $("#csv-ecoles").onclick = () => telecharger(`ecoles_${p.code}.csv`,
      [["nom", "type", "points_attention", "distance_reseau_cyclable_m", "rue_apaisee", "emplacements_velo", "places_velo", "accidents", "accidents_graves", "longitude", "latitude"]]
        .concat(d.ecoles.map((x) => [x.nom, x.type, x.points, x.distReseau < Infinity ? nombre(x.distReseau) : "", x.apaisee == null ? "" : +x.apaisee, x.arceaux.nb, x.arceaux.places, x.accidents, x.accidentsGraves, nombre(x.lon, 5), nombre(x.lat, 5)])));
  }

  // ---------- Enchaînement ----------
  let numero = 0;
  async function lancer(code) {
    const moi = ++numero;
    const perime = () => moi !== numero;
    etapes.clear();
    $("#accueil").hidden = true; $("#resultat").hidden = false;
    $("#fiche-contenu").innerHTML = ""; $("#legende").innerHTML = "";
    preparerCarte(); viderCarte(); carte.invalidateSize();
    const d = courant = { code, erreurs: {} };
    window.__bilan = d;
    try {
      etape("commune", "Contour de la commune…");
      let commune;
      try { commune = await json(`${GEO}/communes/${code}?fields=nom,code,population,surface&format=geojson&geometry=contour`); }
      catch (e) { etape("commune", "Commune introuvable (code " + code + ").", "ko"); d.termine = true; return; }
      if (perime()) return;
      commune.bbox = emprise(commune.geometry);
      d.commune = commune;
      const dep = d.dep = code.startsWith("97") ? code.slice(0, 3) : code.slice(0, 2);
      const R = repere(commune.bbox);
      champ.value = commune.properties.nom;
      document.title = commune.properties.nom + " · Bilan des mobilités douces";
      etape("commune", "Contour de la commune", "ok");
      couches.contour = L.geoJSON(commune, { interactive: false, style: { color: "#14213d", weight: 2.5, fill: false } }).addTo(carte);
      carte.fitBounds(couches.contour.getBounds(), { padding: [12, 12] });

      const b = commune.bbox, bb = [b[1] - MARGE_DEG, b[0] - MARGE_DEG, b[3] + MARGE_DEG, b[2] + MARGE_DEG].map((v) => v.toFixed(5)).join(",");
      etape("osm", "Réseau, stationnement et arrêts (OpenStreetMap)…");
      etape("acc", "Accidents 2019-2024 (ONISR)…");
      const pAccidents = chargerAccidents(code, dep, R, commune).catch((e) => { console.error(e); return null; });
      const pEcoles = chargerEcoles(code, dep, R).catch((e) => { console.error(e); return null; });
      const pModes = chargerModes(code, dep).catch((e) => { console.error(e); return null; });

      let osm;
      try { osm = await overpass(requeteActuelle(bb), OVERPASS, 60, 6); }
      catch (e) {
        if (perime()) return;
        etape("osm", "Les serveurs publics d'OpenStreetMap sont saturés (" + e.message + ").", "ko");
        $("#fiche-contenu").innerHTML = '<p>Le bilan ne peut pas être établi sans le réseau. Les serveurs se libèrent en général en une ou deux minutes.</p><div class="actions"><button id="reessayer">Réessayer</button></div>';
        $("#reessayer").onclick = () => lancer(code);
        d.erreurs.osm = e.message; d.termine = true; return;
      }
      if (perime()) return;
      d.reseau = analyserReseau(osm, R, commune);
      d.lieux = analyserLieux(osm, R, commune);
      etape("osm", `Réseau, stationnement et arrêts (${km(d.reseau.longueurs.total)} d'aménagements cyclables)`, "ok");

      // Réseau de 2020 : long (une à deux minutes), lancé sans bloquer le reste.
      overpass(requeteHistorique(bb), OVERPASS_HISTOIRE, 180, 20).then((ancien) => {
        const voies = lireVoies(ancien.elements, R, commune, (t) => { const type = typeCyclable(t); return type ? { type } : null; });
        d.histoire = longueursParType(voies);
      }).catch((e) => { console.error(e); d.histoire = null; d.erreurs.histoire = e.message; }).then(() => {
        if (perime()) return;
        const el = $("#evolution");
        if (el) el.outerHTML = texteEvolution(d);
        d.histoireTerminee = true;
      });

      d.accidents = await pAccidents;
      if (perime()) return;
      etape("acc", d.accidents ? `Accidents 2019-2024 (${fmt(d.accidents.tous.length)})` : "Accidents indisponibles pour ce département", d.accidents ? "ok" : "ko");
      d.ecoles = await pEcoles;
      d.modes = await pModes;
      etape("pop", "Population proche du réseau (INSEE)…");
      d.population = await chargerPopulation(commune, dep, R, d.reseau, d.lieux).catch((e) => { console.error(e); return null; });
      if (perime()) return;
      etape("pop", d.population ? "Population proche du réseau" : "Pas de carreaux de population pour ce territoire", d.population ? "ok" : "ko");
      etape("lieux", `Écoles (${d.ecoles ? d.ecoles.length : "indisponibles"}) et modes de déplacement${d.modes ? "" : " (indisponibles)"}`, d.ecoles && d.modes ? "ok" : "ko");

      croiser(d);
      d.actions = proposerActions(d);
      dessiner(d);
      rediger(d);
      d.termine = true;
    } catch (e) {
      console.error(e);
      if (!perime()) { etape("erreur", "Le bilan s'est interrompu : " + e.message, "ko"); d.termine = true; d.erreurs.fatale = e.message; }
    }
  }

  depuisAdresse();
})();
