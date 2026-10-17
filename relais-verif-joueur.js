// D:\LOS BASTARDOS\VerifJoueur\relais-verif-joueur.js
// Relais Vérif joueur 1.0.0 : Cloudflare Worker (offre gratuite), par weapon666.
//
// Pourquoi un relais : la page sur GitHub Pages ne peut pas appeler l'API Steam elle-même
// (la clé serait visible de tous et Steam bloque les appels venant d'un navigateur).
// Le relais garde les clés en secret, interroge Steam, FACEIT et Leetify, et renvoie un JSON simple.
//
// Secrets à créer dans Cloudflare (Settings > Variables and Secrets, type « Secret ») :
//   STEAM_KEY    obligatoire  https://steamcommunity.com/dev/apikey
//   FACEIT_KEY   optionnel    https://developers.faceit.com  (ton app > API Keys > Server side)
//   LEETIFY_KEY  optionnel    https://leetify.com/app/developer  (sans clé ça marche, avec une limite plus basse)
// Variable optionnelle (type « Text ») :
//   ORIGINES     sites autorisés en plus de https://weapon8.github.io, séparés par des virgules
//
// Routes, toutes en GET et testables en tapant l'adresse dans le navigateur :
//   /                        état du relais (quelles clés sont en place)
//   /scan?ids=7656…,7656…    bans + résumé Steam, jusqu'à 100 joueurs en un appel
//   /joueur?id=7656…         fiche complète : Steam, heures CS2, FACEIT, Leetify
//   /vanity?nom=pseudo       convertit steamcommunity.com/id/pseudo en SteamID64

const VERSION = "1.0.0";
const ORIGINES_DE_BASE = ["https://weapon8.github.io"];
const CACHE_MS = 10 * 60 * 1000;   // une fiche reste en mémoire 10 min
const CACHE_MAX = 400;             // entrées gardées au maximum
const DELAI_MS = 7000;             // au-delà, la source est notée « injoignable »
const MAX_IDS = 100;               // limite de l'API Steam par appel
const APPID_CS2 = 730;
const RE_ID64 = /^7656119\d{10}$/;

/* Cache en mémoire : il vit tant que Cloudflare garde l'instance chaude, ça suffit
   pour éviter de re-interroger les API quand plusieurs modos regardent le même joueur. */
const memoire = new Map();

export default {
  async fetch(request, env) {
    const origine = request.headers.get("Origin");
    const cors = enTetesCors(origine, env);

    // Navigateur sur un site non autorisé : refus. Sans en-tête Origin (adresse tapée à la main), on laisse passer.
    if (origine && !cors["Access-Control-Allow-Origin"]) {
      return json({ erreur: "Site non autorisé à utiliser ce relais." }, 403, cors);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ erreur: "Seul GET est accepté." }, 405, cors);

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "") || "/";

    if (route === "/") {
      return json({
        relais: "verif-joueur",
        version: VERSION,
        steam: Boolean(env.STEAM_KEY),
        faceit: Boolean(env.FACEIT_KEY),
        leetifyCle: Boolean(env.LEETIFY_KEY)
      }, 200, cors);
    }

    if (!env.STEAM_KEY) return json({ erreur: "Le secret STEAM_KEY n'est pas configuré sur le relais." }, 503, cors);

    let cle;
    let calcul;

    if (route === "/scan") {
      const ids = lireIds(url.searchParams.get("ids"));
      if (!ids.length) return json({ erreur: "Paramètre ids vide ou invalide : SteamID64 séparés par des virgules." }, 400, cors);
      cle = "scan:" + ids.slice().sort().join(",");
      calcul = () => scan(env, ids);
    } else if (route === "/joueur") {
      const id = (url.searchParams.get("id") || "").trim();
      if (!RE_ID64.test(id)) return json({ erreur: "Paramètre id invalide : SteamID64 attendu." }, 400, cors);
      cle = "joueur:" + id;
      calcul = () => joueur(env, id);
    } else if (route === "/vanity") {
      const nom = (url.searchParams.get("nom") || "").trim();
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(nom)) return json({ erreur: "Paramètre nom invalide." }, 400, cors);
      cle = "vanity:" + nom.toLowerCase();
      calcul = () => vanity(env, nom);
    } else {
      return json({ erreur: "Route inconnue. Routes : /scan, /joueur, /vanity." }, 404, cors);
    }

    const enMemoire = lireMemoire(cle);
    if (enMemoire) return json(enMemoire.corps, enMemoire.statut, cors, true);

    let resultat;
    try {
      resultat = await calcul();
    } catch (e) {
      return json({ erreur: messageErreur(e) }, e instanceof ErreurSource ? 502 : 500, cors);
    }

    // On ne garde en mémoire que les réponses complètes, pour retenter les sources tombées.
    const complet = resultat.statut === 200 && !(resultat.corps.erreurs && Object.keys(resultat.corps.erreurs).length);
    if (complet || resultat.statut === 404) ecrireMemoire(cle, resultat);

    return json(resultat.corps, resultat.statut, cors, complet);
  }
};

/* ═══════════ Routes ═══════════ */

async function scan(env, ids) {
  const [resumes, bans] = await Promise.all([steamResumes(env, ids), steamBans(env, ids)]);
  const joueurs = {};
  ids.forEach(function (id) {
    joueurs[id] = Object.assign({ id64: id }, resumes[id] || { introuvable: true }, bans[id] || {});
  });
  return { statut: 200, corps: { joueurs: joueurs } };
}

async function joueur(env, id) {
  const sources = await Promise.allSettled([
    steamResumes(env, [id]),
    steamBans(env, [id]),
    steamNiveau(env, id),
    steamJeux(env, id),
    faceit(env, id),
    leetify(env, id)
  ]);

  const erreurs = {};
  function valeur(i, nom) {
    if (sources[i].status === "fulfilled") return sources[i].value;
    erreurs[nom] = messageErreur(sources[i].reason);
    return null;
  }

  const resumes = valeur(0, "steam");
  const bans = valeur(1, "bans");
  const niveau = valeur(2, "niveau");
  const jeux = valeur(3, "jeux");
  const fiche = {
    id64: id,
    steam: Object.assign({}, resumes ? resumes[id] || { introuvable: true } : null, bans ? bans[id] : null, {
      niveau: niveau,
      jeux: jeux
    }),
    faceit: valeur(4, "faceit"),
    leetify: valeur(5, "leetify"),
    erreurs: erreurs
  };
  return { statut: 200, corps: fiche };
}

async function vanity(env, nom) {
  const d = await steamApi(env, "ISteamUser/ResolveVanityURL/v1/", { vanityurl: nom });
  const r = d && d.response;
  if (!r || r.success !== 1 || !RE_ID64.test(String(r.steamid))) {
    return { statut: 404, corps: { erreur: "Aucun compte Steam avec cette adresse personnalisée." } };
  }
  return { statut: 200, corps: { nom: nom, id64: String(r.steamid) } };
}

/* ═══════════ Steam ═══════════ */

async function steamApi(env, chemin, params) {
  const u = new URL("https://api.steampowered.com/" + chemin);
  u.searchParams.set("key", env.STEAM_KEY);
  Object.keys(params).forEach(function (k) { u.searchParams.set(k, String(params[k])); });
  const r = await recuperer("steam", u.toString());
  if (r.statut === 401 || r.statut === 403) throw new ErreurSource("steam", "clé Steam refusée (" + r.statut + ")");
  if (r.statut !== 200) throw new ErreurSource("steam", "réponse " + r.statut);
  return r.donnees;
}

async function steamResumes(env, ids) {
  const d = await steamApi(env, "ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.join(",") });
  const liste = (d && d.response && d.response.players) || [];
  const parId = {};
  liste.forEach(function (p) {
    parId[String(p.steamid)] = {
      nom: p.personaname || "",
      avatar: p.avatarmedium || p.avatar || "",
      profil: p.profileurl || "",
      public: p.communityvisibilitystate === 3,
      configure: p.profilestate === 1,
      creeLe: typeof p.timecreated === "number" ? p.timecreated : null,
      pays: p.loccountrycode || null,
      enJeu: p.gameid ? Number(p.gameid) === APPID_CS2 ? "CS2" : (p.gameextrainfo || "un jeu") : null
    };
  });
  return parId;
}

async function steamBans(env, ids) {
  const d = await steamApi(env, "ISteamUser/GetPlayerBans/v1/", { steamids: ids.join(",") });
  const liste = (d && d.players) || [];
  const parId = {};
  liste.forEach(function (b) {
    parId[String(b.SteamId)] = {
      vac: b.NumberOfVACBans || 0,
      banJeu: b.NumberOfGameBans || 0,
      joursDepuisBan: (b.NumberOfVACBans || b.NumberOfGameBans) ? b.DaysSinceLastBan : null,
      banCommu: Boolean(b.CommunityBanned),
      banEco: b.EconomyBan && b.EconomyBan !== "none" ? b.EconomyBan : null
    };
  });
  return parId;
}

async function steamNiveau(env, id) {
  const d = await steamApi(env, "IPlayerService/GetSteamLevel/v1/", { steamid: id });
  const n = d && d.response && d.response.player_level;
  return typeof n === "number" ? n : null;   // null : profil privé
}

async function steamJeux(env, id) {
  const d = await steamApi(env, "IPlayerService/GetOwnedGames/v1/", {
    steamid: id,
    include_played_free_games: 1,
    include_appinfo: 0
  });
  const r = d && d.response;
  if (!r || typeof r.game_count !== "number") return { visible: false };
  const cs2 = (r.games || []).find(function (g) { return g.appid === APPID_CS2; });
  return {
    visible: true,
    nombre: r.game_count,
    cs2Minutes: cs2 ? cs2.playtime_forever || 0 : 0,
    cs2Minutes2sem: cs2 ? cs2.playtime_2weeks || 0 : 0,
    cs2Possede: Boolean(cs2)
  };
}

/* ═══════════ FACEIT ═══════════ */

async function faceitApi(env, chemin) {
  const r = await recuperer("faceit", "https://open.faceit.com/data/v4/" + chemin, {
    headers: { Authorization: "Bearer " + env.FACEIT_KEY, Accept: "application/json" }
  });
  if (r.statut === 404) return null;
  if (r.statut === 401 || r.statut === 403) throw new ErreurSource("faceit", "clé FACEIT refusée (" + r.statut + ")");
  if (r.statut !== 200) throw new ErreurSource("faceit", "réponse " + r.statut);
  return r.donnees;
}

async function faceit(env, id) {
  if (!env.FACEIT_KEY) return { indispo: "clé FACEIT non configurée sur le relais" };

  // Les comptes jamais passés sur CS2 ne sont trouvés qu'avec game=csgo.
  let p = await faceitApi(env, "players?game=cs2&game_player_id=" + id);
  if (!p) p = await faceitApi(env, "players?game=csgo&game_player_id=" + id);
  if (!p || !p.player_id) return { trouve: false };

  const jeu = (p.games && (p.games.cs2 || p.games.csgo)) || {};
  const nomJeu = p.games && p.games.cs2 ? "cs2" : "csgo";
  const pid = encodeURIComponent(p.player_id);

  const [stats, bans] = await Promise.allSettled([
    faceitApi(env, "players/" + pid + "/stats/" + nomJeu),
    faceitApi(env, "players/" + pid + "/bans?offset=0&limit=20")
  ]);

  const vie = stats.status === "fulfilled" && stats.value && stats.value.lifetime ? stats.value.lifetime : null;
  const listeBans = bans.status === "fulfilled" && bans.value && bans.value.items ? bans.value.items : [];

  return {
    trouve: true,
    pseudo: p.nickname || "",
    url: (p.faceit_url || ("https://www.faceit.com/{lang}/players/" + encodeURIComponent(p.nickname || ""))).replace("{lang}", "fr"),
    pays: p.country || null,
    jeu: nomJeu,
    niveau: typeof jeu.skill_level === "number" ? jeu.skill_level : null,
    elo: typeof jeu.faceit_elo === "number" ? jeu.faceit_elo : null,
    inscritLe: p.activated_at || null,
    verifie: Boolean(p.verified),
    stats: vie ? {
      matchs: nombre(vie, ["Matches", "Total Matches"]),
      winrate: nombre(vie, ["Win Rate %", "Winrate %"]),
      kd: nombre(vie, ["Average K/D Ratio", "K/D Ratio"]),
      hs: nombre(vie, ["Average Headshots %", "Total Headshots %"]),
      adr: nombre(vie, ["ADR", "Average ADR"])
    } : null,
    statsErreur: stats.status === "rejected" ? messageErreur(stats.reason) : null,
    bans: listeBans.map(function (b) {
      return { type: b.type || "", raison: b.reason || "", debut: b.starts_at || null, fin: b.ends_at || null };
    })
  };
}

/* ═══════════ Leetify ═══════════ */

async function leetify(env, id) {
  const enTetes = { Accept: "application/json" };
  if (env.LEETIFY_KEY) enTetes._leetify_key = env.LEETIFY_KEY;
  const r = await recuperer("leetify", "https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=" + id, { headers: enTetes });
  if (r.statut === 404) return { trouve: false };
  if (r.statut === 429) throw new ErreurSource("leetify", "trop de demandes, réessaie dans une minute");
  if (r.statut !== 200 || !r.donnees) throw new ErreurSource("leetify", "réponse " + r.statut);

  const p = r.donnees;
  const rangs = p.ranks || {};
  const note = p.rating || {};
  const s = p.stats || {};
  return {
    trouve: true,
    url: "https://leetify.com/app/profile/" + id,
    nom: p.name || "",
    prive: p.privacy_mode && p.privacy_mode !== "public" ? p.privacy_mode : null,
    matchs: num(p.total_matches),
    winrate: num(p.winrate),
    premierMatch: p.first_match_date || null,
    rangs: {
      leetify: num(rangs.leetify),
      premier: num(rangs.premier),
      faceit: num(rangs.faceit),
      faceitElo: num(rangs.faceit_elo),
      wingman: num(rangs.wingman),
      renommee: num(rangs.renown)
    },
    notes: {
      aim: num(note.aim),
      placement: num(note.positioning),
      utilitaires: num(note.utility),
      clutch: num(note.clutch),
      ouverture: num(note.opening)
    },
    stats: {
      reaction: num(s.reaction_time_ms),
      preaim: num(s.preaim),
      precisionTete: num(s.accuracy_head),
      precisionVue: num(s.accuracy_enemy_spotted),
      spray: num(s.spray_accuracy)
    },
    bans: (p.bans || []).map(function (b) {
      return { plateforme: b.platform || "", pseudo: b.platform_nickname || "", depuis: b.banned_since || null };
    }),
    derniers: (p.recent_matches || []).slice(0, 5).map(function (m) {
      return {
        date: m.finished_at || null,
        carte: m.map_name || "",
        source: m.data_source || "",
        resultat: m.outcome || "",
        note: num(m.leetify_rating),
        score: Array.isArray(m.score) ? m.score : null
      };
    })
  };
}

/* ═══════════ Outils ═══════════ */

class ErreurSource extends Error {
  constructor(source, message) {
    super(source + " : " + message);
    this.source = source;
  }
}

function messageErreur(e) {
  if (!e) return "erreur inconnue";
  return String(e.message || e);
}

async function recuperer(source, url, init) {
  let reponse;
  try {
    reponse = await fetch(url, Object.assign({ signal: AbortSignal.timeout(DELAI_MS) }, init || {}));
  } catch (e) {
    throw new ErreurSource(source, e && e.name === "TimeoutError" ? "pas de réponse en " + DELAI_MS / 1000 + " s" : "injoignable");
  }
  let donnees = null;
  const texte = await reponse.text();
  if (texte) {
    try { donnees = JSON.parse(texte); } catch (e) { donnees = null; }
  }
  return { statut: reponse.status, donnees: donnees };
}

function lireIds(brut) {
  const vus = new Set();
  String(brut || "").split(/[\s,;]+/).forEach(function (id) {
    if (RE_ID64.test(id) && vus.size < MAX_IDS) vus.add(id);
  });
  return Array.from(vus);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nombre(objet, cles) {
  for (let i = 0; i < cles.length; i++) {
    const v = num(objet[cles[i]]);
    if (v !== null) return v;
  }
  return null;
}

function lireMemoire(cle) {
  const e = memoire.get(cle);
  if (!e) return null;
  if (Date.now() - e.quand > CACHE_MS) {
    memoire.delete(cle);
    return null;
  }
  return e.valeur;
}

function ecrireMemoire(cle, valeur) {
  if (memoire.size >= CACHE_MAX) memoire.delete(memoire.keys().next().value);
  memoire.set(cle, { quand: Date.now(), valeur: valeur });
}

function enTetesCors(origine, env) {
  const h = { Vary: "Origin" };
  if (!origine) return h;
  const autorisees = ORIGINES_DE_BASE.concat(String(env.ORIGINES || "").split(",").map(function (o) { return o.trim(); }).filter(Boolean));
  // « null » = page ouverte depuis le disque (file://), pratique pour tester avant de pousser sur GitHub.
  const locale = origine === "null" || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origine);
  if (autorisees.indexOf(origine) !== -1 || locale) {
    h["Access-Control-Allow-Origin"] = origine;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(corps, statut, enTetes, cacheable) {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheable ? "public, max-age=600" : "no-store"
    }, enTetes)
  });
}
