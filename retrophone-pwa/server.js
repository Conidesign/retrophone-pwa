// Serveur minimal pour le prototype "Téléphone Rétro" avec notifications push.
//
// Ce serveur ne transporte PAS la voix (ça reste WebRTC / PeerJS en pair-à-pair
// côté navigateur). Son unique rôle : savoir quel abonnement push correspond
// à quel identifiant d'appareil, et déclencher une notification système quand
// quelqu'un lance un appel — y compris si le destinataire a l'app fermée ou
// le téléphone verrouillé. Il gère aussi les rendez-vous et la présence.
//
// IMPORTANT — persistance des données :
// Sur l'offre gratuite de Render (et la plupart des hébergeurs "free tier"),
// le système de fichiers du conteneur est ÉPHÉMÈRE : tout fichier écrit ici
// est perdu à chaque redémarrage, redéploiement, OU mise en veille du service
// après inactivité (le plan gratuit met le service en veille après ~15 min
// sans requête, et le réveil recrée un conteneur "propre"). C'est ce qui fait
// qu'un rendez-vous accepté peut "disparaître après quelques heures".
//
// Trois façons de régler ça, au choix (voir README.md) :
//   1. Rester 100% gratuit en pointant vers un petit stockage JSON hébergé
//      sur un site PHP existant (dossier php-store/ fourni avec ce projet) —
//      variables d'environnement PHP_STORE_URL + PHP_STORE_SECRET.
//   2. Passer le service Render en plan payant "Starter" + disque persistant,
//      puis définir DATA_DIR=/data (chemin du disque monté).
//   3. Migrer vers une vraie base de données externe (ex. Upstash Redis).
// Sans l'une de ces options, ce prototype reste sujet à des pertes de données
// sur l'hébergement gratuit (mais fonctionne très bien pour des tests courts).

const fs = require("fs");
const path = require("path");
const express = require("express");
const webpush = require("web-push");

const DATA_DIR = process.env.DATA_DIR || __dirname;
const KEYS_FILE = path.join(DATA_DIR, "vapid-keys.json");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");
const APPTS_FILE = path.join(DATA_DIR, "appointments.json");

// --- Stockage distant optionnel, sur un site PHP existant (voir php-store/) ---
// Si configuré, TOUT le stockage persistant (clés VAPID, abonnements push,
// rendez-vous) passe par ce petit service PHP au lieu de fichiers locaux —
// ça survit aux redémarrages du conteneur Render, gratuitement, en réutilisant
// un hébergement web classique que beaucoup de gens ont déjà.
const PHP_STORE_URL = process.env.PHP_STORE_URL;
const PHP_STORE_SECRET = process.env.PHP_STORE_SECRET;
// "let" plutôt que "const" : si le store distant est injoignable au démarrage
// (mauvaise config, pare-feu de l'hébergement PHP...), on bascule sur le
// stockage fichier local plutôt que de planter tout le service — mieux vaut
// une app qui tourne sans persistance qu'une app qui ne démarre pas du tout.
let USE_REMOTE_STORE = !!(PHP_STORE_URL && PHP_STORE_SECRET);

if (!USE_REMOTE_STORE && !process.env.DATA_DIR) {
  console.warn(
    "[stockage] Aucun stockage persistant configuré (ni PHP_STORE_URL, ni DATA_DIR) : " +
      "les fichiers sont écrits dans le dossier de l'appli. Sur Render (plan gratuit en " +
      "particulier), ce dossier NE PERSISTE PAS entre deux redémarrages du service — les " +
      "rendez-vous et abonnements push peuvent disparaître. Voir README.md pour corriger."
  );
} else if (USE_REMOTE_STORE) {
  console.log(`[stockage] Stockage distant activé via ${PHP_STORE_URL}`);
}

// Un User-Agent/Accept "normal" (au lieu des valeurs par défaut de fetch,
// souvent absentes ou marquées "node") évite qu'un pare-feu anti-bot côté
// hébergement (mod_security, Cloudflare, etc.) ne bloque la requête avant
// même qu'elle n'atteigne store.php — c'est la cause la plus fréquente d'un
// 403 ici (store.php lui-même ne renvoie jamais 403, seulement 401/400/405).
const REMOTE_STORE_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (compatible; RetroPhoneServer/1.0; +https://render.com)",
};

function explain403(status) {
  return status === 403
    ? " — probablement bloqué par un pare-feu/anti-bot de l'hébergement PHP (mod_security, Cloudflare...). " +
        "Vérifier les réglages de sécurité/WAF du site, ou les logs d'erreur du serveur PHP."
    : "";
}

async function remoteLoad(key, fallbackJson) {
  const res = await fetch(`${PHP_STORE_URL}?key=${encodeURIComponent(key)}`, {
    headers: { "X-Store-Secret": PHP_STORE_SECRET, ...REMOTE_STORE_HEADERS },
  });
  if (!res.ok) {
    throw new Error(`stockage distant : lecture "${key}" a échoué (${res.status})${explain403(res.status)}`);
  }
  const text = await res.text();
  if (!text.trim()) return fallbackJson;
  return JSON.parse(text);
}
async function remoteSave(key, value) {
  const res = await fetch(`${PHP_STORE_URL}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "X-Store-Secret": PHP_STORE_SECRET, "Content-Type": "application/json", ...REMOTE_STORE_HEADERS },
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    throw new Error(`stockage distant : écriture "${key}" a échoué (${res.status})${explain403(res.status)}`);
  }
}

// --- Clés VAPID : générées une seule fois puis réutilisées (sinon les abonnements
// existants deviendraient invalides à chaque redémarrage du serveur). ---
async function loadOrCreateVapidKeys() {
  if (USE_REMOTE_STORE) {
    try {
      // Le store distant renvoie "{}" par défaut quand la clé n'existe pas
      // encore (indiscernable d'un objet vide) — on vérifie donc la présence
      // réelle de publicKey plutôt que la simple vérité de l'objet.
      const existing = await remoteLoad("vapid-keys", null);
      if (existing && existing.publicKey && existing.privateKey) return existing;
      const keys = webpush.generateVAPIDKeys();
      await remoteSave("vapid-keys", keys);
      return keys;
    } catch (err) {
      // On dégrade plutôt que de planter : l'app démarre quand même, juste
      // sans persistance tant que le store distant n'est pas accessible.
      console.error(
        `[stockage] Store distant injoignable au démarrage (${err.message}) — ` +
          "bascule temporaire sur le stockage fichier local (non persistant sur Render). " +
          "Corriger PHP_STORE_URL/PHP_STORE_SECRET puis redéployer pour réactiver la persistance."
      );
      USE_REMOTE_STORE = false;
    }
  }
  if (fs.existsSync(KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

// --- Abonnements push, indexés par identifiant d'appareil (le même "Peer ID"
// que celui utilisé côté WebRTC) ---
async function loadSubs() {
  if (USE_REMOTE_STORE) return remoteLoad("subscriptions", {});
  if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  return {};
}
async function saveSubs(subs) {
  if (USE_REMOTE_STORE) return remoteSave("subscriptions", subs);
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

// --- Rendez-vous ("on s'appelle plus tard") — doit survivre à un redémarrage
// du serveur (un rendez-vous pris la veille doit encore exister le lendemain). ---
async function loadAppointments() {
  if (USE_REMOTE_STORE) return remoteLoad("appointments", []);
  if (fs.existsSync(APPTS_FILE)) return JSON.parse(fs.readFileSync(APPTS_FILE, "utf8"));
  return [];
}
async function saveAppointments(list) {
  if (USE_REMOTE_STORE) return remoteSave("appointments", list);
  fs.writeFileSync(APPTS_FILE, JSON.stringify(list, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Petit utilitaire réutilisé par les rendez-vous : envoie une notif "best effort"
// (n'échoue jamais bruyamment — l'app fonctionne aussi sans notification si le
// destinataire n'y est pas abonné).
async function pushTo(peerId, payloadObj) {
  const subs = await loadSubs();
  const subscription = subs[peerId];
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payloadObj));
  } catch (err) {
    console.warn(`[push] échec d'envoi à ${peerId} :`, err.statusCode);
    if (err.statusCode === 410 || err.statusCode === 404) {
      delete subs[peerId];
      await saveSubs(subs);
    }
  }
}

function formatWhenForNotif(whenISO) {
  try {
    return new Date(whenISO).toLocaleString("fr-FR", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (e) {
    return whenISO;
  }
}

// --- Présence ("qui a l'app ouverte en ce moment") ---
//
// Volontairement en mémoire (pas de fichier, pas de stockage distant) : la
// présence n'a de sens que tant que le serveur tourne, pas besoin de survivre
// à un redémarrage. Chaque appareil envoie un battement de vie régulier tant
// que l'app est ouverte ; on le considère "en ligne" tant qu'on a eu de ses
// nouvelles récemment.
const presence = {}; // peerId -> { lastSeen, name }
const ONLINE_THRESHOLD_MS = 40000; // ~2-3 battements manqués avant de considérer "hors ligne"

app.post("/api/presence/ping", (req, res) => {
  const { peerId, name } = req.body || {};
  if (!peerId) return res.status(400).json({ error: "peerId requis" });
  presence[peerId] = { lastSeen: Date.now(), name: name || "" };
  res.json({ ok: true });
});

// L'appareil qui se ferme proprement peut le signaler explicitement (best
// effort seulement : sur mobile, ce signal n'arrive pas toujours — le
// timeout ci-dessus reste la vraie garantie de fraîcheur du statut).
app.post("/api/presence/offline", (req, res) => {
  const { peerId } = req.body || {};
  if (peerId) delete presence[peerId];
  res.json({ ok: true });
});

app.get("/api/presence", (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const now = Date.now();
  const result = {};
  for (const id of ids) {
    const entry = presence[id];
    result[id] = !!entry && now - entry.lastSeen < ONLINE_THRESHOLD_MS;
  }
  res.json(result);
});

// Ménage occasionnel pour ne pas accumuler indéfiniment des appareils qui ne
// reviendront plus (purge après 24h d'inactivité — sans lien avec le seuil
// "en ligne" ci-dessus, qui reste beaucoup plus court).
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(presence)) {
    if (now - presence[id].lastSeen > 24 * 60 * 60 * 1000) delete presence[id];
  }
}, 60 * 60 * 1000);

async function main() {
  const vapidKeys = await loadOrCreateVapidKeys();
  webpush.setVapidDetails(
    "mailto:contact@example.com", // à remplacer par un vrai contact avant hébergement public
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );

  // Clé publique VAPID, nécessaire côté navigateur pour s'abonner au push.
  app.get("/api/vapid-public-key", (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  // Enregistre/replace l'abonnement push d'un appareil.
  app.post("/api/subscribe", async (req, res) => {
    const { peerId, subscription } = req.body || {};
    if (!peerId || !subscription) {
      return res.status(400).json({ error: "peerId et subscription requis" });
    }
    try {
      const subs = await loadSubs();
      subs[peerId] = subscription;
      await saveSubs(subs);
      console.log(`[subscribe] abonnement push enregistré pour ${peerId}`);
      res.json({ ok: true });
    } catch (err) {
      console.error("[subscribe] échec :", err.message);
      res.status(502).json({ error: "Échec d'enregistrement de l'abonnement" });
    }
  });

  // Déclenche une notification "on t'appelle" sur l'appareil visé.
  app.post("/api/notify-call", async (req, res) => {
    const { toPeerId, fromName, fromPeerId } = req.body || {};
    if (!toPeerId) return res.status(400).json({ error: "toPeerId requis" });

    const subs = await loadSubs();
    const subscription = subs[toPeerId];
    if (!subscription) {
      // Normal si ce contact n'a jamais ouvert l'app / accepté les notifications :
      // dans ce cas seul l'appel WebRTC en direct fonctionnera (app déjà ouverte).
      return res.status(404).json({ error: "Aucun abonnement push connu pour ce contact" });
    }

    const payload = JSON.stringify({
      kind: "call",
      title: "Téléphone Rétro",
      body: `${fromName || "Quelqu'un"} t'appelle`,
      fromPeerId: fromPeerId || "",
    });

    try {
      await webpush.sendNotification(subscription, payload);
      res.json({ ok: true });
    } catch (err) {
      console.error("[notify-call] échec d'envoi push:", err.statusCode, err.body);
      // 410/404 = abonnement expiré ou révoqué -> on le nettoie
      if (err.statusCode === 410 || err.statusCode === 404) {
        delete subs[toPeerId];
        await saveSubs(subs);
      }
      res.status(502).json({ error: "Échec d'envoi de la notification push" });
    }
  });

  // Propose un rendez-vous : notifie le destinataire, qui devra l'accepter/refuser.
  app.post("/api/appointments", async (req, res) => {
    const { fromPeerId, fromName, toPeerId, toName, whenISO, note } = req.body || {};
    if (!fromPeerId || !toPeerId || !whenISO) {
      return res.status(400).json({ error: "fromPeerId, toPeerId et whenISO requis" });
    }
    if (isNaN(new Date(whenISO).getTime())) {
      return res.status(400).json({ error: "whenISO invalide" });
    }

    const appt = {
      id: "appt-" + Math.random().toString(36).slice(2, 10),
      fromPeerId,
      fromName: fromName || "Un ami",
      toPeerId,
      toName: toName || "",
      whenISO,
      note: (note || "").slice(0, 200),
      status: "proposed", // proposed -> accepted | declined | cancelled
      createdAt: Date.now(),
      remindedAt10: false,
      remindedAtStart: false,
    };

    const list = await loadAppointments();
    list.push(appt);
    await saveAppointments(list);

    const when = formatWhenForNotif(whenISO);
    await pushTo(toPeerId, {
      kind: "appointment",
      title: "Téléphone Rétro",
      body: `${appt.fromName} te propose un rendez-vous ${when}`,
    });

    res.json(appt);
  });

  // Liste les rendez-vous concernant un appareil (proposés par lui ou à lui),
  // en excluant ce qui est trop vieux pour rester utile à afficher.
  app.get("/api/appointments", async (req, res) => {
    const peerId = req.query.peerId;
    if (!peerId) return res.status(400).json({ error: "peerId requis" });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const all = await loadAppointments();
    const list = all.filter(
      (a) =>
        (a.fromPeerId === peerId || a.toPeerId === peerId) &&
        (new Date(a.whenISO).getTime() > cutoff || a.status === "proposed")
    );
    list.sort((a, b) => new Date(a.whenISO) - new Date(b.whenISO));
    res.json(list);
  });

  // Le destinataire accepte ou refuse une proposition.
  app.post("/api/appointments/:id/respond", async (req, res) => {
    const { peerId, response } = req.body || {};
    if (!["accepted", "declined"].includes(response)) {
      return res.status(400).json({ error: "response doit être 'accepted' ou 'declined'" });
    }
    const list = await loadAppointments();
    const appt = list.find((a) => a.id === req.params.id);
    if (!appt) return res.status(404).json({ error: "Rendez-vous introuvable" });
    if (appt.toPeerId !== peerId) {
      return res.status(403).json({ error: "Seul le destinataire peut répondre à cette proposition" });
    }

    appt.status = response;
    await saveAppointments(list);

    const when = formatWhenForNotif(appt.whenISO);
    await pushTo(appt.fromPeerId, {
      kind: "appointment",
      title: "Téléphone Rétro",
      body:
        response === "accepted"
          ? `${appt.toName || "Ton ami"} a accepté le rendez-vous ${when} ✓`
          : `${appt.toName || "Ton ami"} a décliné le rendez-vous ${when}`,
    });

    res.json(appt);
  });

  // L'une ou l'autre partie peut annuler.
  app.post("/api/appointments/:id/cancel", async (req, res) => {
    const { peerId } = req.body || {};
    const list = await loadAppointments();
    const appt = list.find((a) => a.id === req.params.id);
    if (!appt) return res.status(404).json({ error: "Rendez-vous introuvable" });
    if (appt.fromPeerId !== peerId && appt.toPeerId !== peerId) {
      return res.status(403).json({ error: "Pas partie de ce rendez-vous" });
    }
    appt.status = "cancelled";
    await saveAppointments(list);
    res.json(appt);
  });

  // Supprime définitivement un rendez-vous de la liste (contrairement à "cancel",
  // qui garde une trace avec le statut "Annulé", ceci le fait disparaître pour de
  // bon — utile pour faire le ménage dans les vieux rendez-vous refusés/annulés).
  app.delete("/api/appointments/:id", async (req, res) => {
    const peerId = req.query.peerId || (req.body && req.body.peerId);
    const list = await loadAppointments();
    const idx = list.findIndex((a) => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Rendez-vous introuvable" });
    const appt = list[idx];
    if (appt.fromPeerId !== peerId && appt.toPeerId !== peerId) {
      return res.status(403).json({ error: "Pas partie de ce rendez-vous" });
    }
    list.splice(idx, 1);
    await saveAppointments(list);
    res.json({ ok: true });
  });

  // Vérifie régulièrement les rendez-vous confirmés à venir et envoie un rappel
  // push aux deux participants — en plus de l'alerte du calendrier natif (si le
  // rendez-vous y a été ajouté), pour ceux qui ne l'auraient pas fait.
  setInterval(async () => {
    let list;
    try {
      list = await loadAppointments();
    } catch (err) {
      console.warn("[rappels] impossible de lire les rendez-vous :", err.message);
      return;
    }
    const now = Date.now();
    let changed = false;

    for (const appt of list) {
      if (appt.status !== "accepted") continue;
      const start = new Date(appt.whenISO).getTime();
      if (isNaN(start)) continue;

      if (!appt.remindedAt10 && start - now > 0 && start - now <= 10 * 60 * 1000) {
        appt.remindedAt10 = true;
        changed = true;
        const body = "Rendez-vous téléphonique dans 10 minutes !";
        await pushTo(appt.fromPeerId, { kind: "appointment", title: "Téléphone Rétro", body });
        await pushTo(appt.toPeerId, { kind: "appointment", title: "Téléphone Rétro", body });
      }

      if (!appt.remindedAtStart && now >= start && now - start < 5 * 60 * 1000) {
        appt.remindedAtStart = true;
        changed = true;
        const body = "C'est l'heure de votre rendez-vous téléphonique !";
        await pushTo(appt.fromPeerId, { kind: "appointment", title: "Téléphone Rétro", body });
        await pushTo(appt.toPeerId, { kind: "appointment", title: "Téléphone Rétro", body });
      }
    }

    if (changed) await saveAppointments(list);
  }, 30 * 1000);

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Téléphone Rétro (PWA + push) en écoute sur le port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("[démarrage] échec :", err);
  process.exit(1);
});
