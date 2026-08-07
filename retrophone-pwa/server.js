// Serveur minimal pour le prototype "Téléphone Rétro" avec notifications push.
//
// Ce serveur ne transporte PAS la voix (ça reste WebRTC / PeerJS en pair-à-pair
// côté navigateur). Son unique rôle : savoir quel abonnement push correspond
// à quel identifiant d'appareil, et déclencher une notification système quand
// quelqu'un lance un appel — y compris si le destinataire a l'app fermée ou
// le téléphone verrouillé.
//
// Stockage volontairement simple (fichier JSON) : suffisant pour un prototype
// avec quelques familles testeuses. À remplacer par une vraie base de données
// avant tout usage à plus grande échelle.

const fs = require("fs");
const path = require("path");
const express = require("express");
const webpush = require("web-push");

// IMPORTANT — persistance des données :
// Sur l'offre gratuite de Render (et la plupart des hébergeurs "free tier"),
// le système de fichiers du conteneur est ÉPHÉMÈRE : tout fichier écrit ici
// est perdu à chaque redémarrage, redéploiement, OU mise en veille du service
// après inactivité (le plan gratuit met le service en veille après ~15 min
// sans requête, et le réveil recrée un conteneur "propre"). C'est très
// probablement la cause d'un rendez-vous accepté qui "disparaît après
// quelques heures" : le service s'est juste rendormi puis réveillé entre deux.
//
// Pour que les données survivent réellement, DATA_DIR doit pointer vers un
// disque persistant. Deux options :
//   1. Passer le service en plan payant "Starter" + attacher un "Persistent
//      Disk" Render (ex: monté sur /data), puis définir la variable
//      d'environnement DATA_DIR=/data dans Render → Settings → Environment.
//   2. Rester gratuit et migrer vers un stockage externe persistant (ex:
//      Upstash Redis, gratuit) — nécessite une petite adaptation du code.
// Sans l'une de ces deux options, ce prototype restera sujet à des pertes de
// données sur l'hébergement gratuit.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!process.env.DATA_DIR) {
  console.warn(
    "[stockage] DATA_DIR non défini : les fichiers sont écrits dans le dossier de l'appli. " +
      "Sur Render (plan gratuit en particulier), ce dossier NE PERSISTE PAS entre deux redémarrages " +
      "du service — les rendez-vous et abonnements push peuvent disparaître. " +
      "Voir les commentaires en haut de server.js pour la solution."
  );
}
const KEYS_FILE = path.join(DATA_DIR, "vapid-keys.json");
const SUBS_FILE = path.join(DATA_DIR, "subscriptions.json");

// --- Clés VAPID : générées une seule fois puis réutilisées (sinon les abonnements
// existants deviendraient invalides à chaque redémarrage du serveur). ---
function loadOrCreateVapidKeys() {
  if (fs.existsSync(KEYS_FILE)) {
    return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  return keys;
}
const vapidKeys = loadOrCreateVapidKeys();
webpush.setVapidDetails(
  "mailto:contact@example.com", // à remplacer par un vrai contact avant hébergement public
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// --- Abonnements push, indexés par identifiant d'appareil (le même "Peer ID"
// que celui utilisé côté WebRTC) ---
function loadSubs() {
  if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  return {};
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Clé publique VAPID, nécessaire côté navigateur pour s'abonner au push.
app.get("/api/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Enregistre/replace l'abonnement push d'un appareil.
app.post("/api/subscribe", (req, res) => {
  const { peerId, subscription } = req.body || {};
  if (!peerId || !subscription) {
    return res.status(400).json({ error: "peerId et subscription requis" });
  }
  const subs = loadSubs();
  subs[peerId] = subscription;
  saveSubs(subs);
  console.log(`[subscribe] abonnement push enregistré pour ${peerId}`);
  res.json({ ok: true });
});

// Déclenche une notification "on t'appelle" sur l'appareil visé.
app.post("/api/notify-call", async (req, res) => {
  const { toPeerId, fromName, fromPeerId } = req.body || {};
  if (!toPeerId) return res.status(400).json({ error: "toPeerId requis" });

  const subs = loadSubs();
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
      saveSubs(subs);
    }
    res.status(502).json({ error: "Échec d'envoi de la notification push" });
  }
});

// Petit utilitaire réutilisé par les rendez-vous : envoie une notif "best effort"
// (n'échoue jamais bruyamment — l'app fonctionne aussi sans notification si le
// destinataire n'y est pas abonné).
async function pushTo(peerId, payloadObj) {
  const subs = loadSubs();
  const subscription = subs[peerId];
  if (!subscription) return;
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payloadObj));
  } catch (err) {
    console.warn(`[push] échec d'envoi à ${peerId} :`, err.statusCode);
    if (err.statusCode === 410 || err.statusCode === 404) {
      delete subs[peerId];
      saveSubs(subs);
    }
  }
}

// --- Présence ("qui a l'app ouverte en ce moment") ---
//
// Volontairement en mémoire (pas de fichier) : la présence n'a de sens que tant
// que le serveur tourne, pas besoin de survivre à un redémarrage. Chaque
// appareil envoie un battement de vie régulier tant que l'app est ouverte ;
// on le considère "en ligne" tant qu'on a eu de ses nouvelles récemment.
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

// --- Rendez-vous ("on s'appelle plus tard") ---
//
// Contrairement à la présence, ça doit survivre à un redémarrage du serveur
// (un rendez-vous pris la veille doit encore exister le lendemain) : stockage
// fichier, comme les abonnements push.
const APPTS_FILE = path.join(DATA_DIR, "appointments.json");
function loadAppointments() {
  if (fs.existsSync(APPTS_FILE)) return JSON.parse(fs.readFileSync(APPTS_FILE, "utf8"));
  return [];
}
function saveAppointments(list) {
  fs.writeFileSync(APPTS_FILE, JSON.stringify(list, null, 2));
}

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

  const list = loadAppointments();
  list.push(appt);
  saveAppointments(list);

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
app.get("/api/appointments", (req, res) => {
  const peerId = req.query.peerId;
  if (!peerId) return res.status(400).json({ error: "peerId requis" });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const list = loadAppointments().filter(
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
  const list = loadAppointments();
  const appt = list.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ error: "Rendez-vous introuvable" });
  if (appt.toPeerId !== peerId) {
    return res.status(403).json({ error: "Seul le destinataire peut répondre à cette proposition" });
  }

  appt.status = response;
  saveAppointments(list);

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
app.post("/api/appointments/:id/cancel", (req, res) => {
  const { peerId } = req.body || {};
  const list = loadAppointments();
  const appt = list.find((a) => a.id === req.params.id);
  if (!appt) return res.status(404).json({ error: "Rendez-vous introuvable" });
  if (appt.fromPeerId !== peerId && appt.toPeerId !== peerId) {
    return res.status(403).json({ error: "Pas partie de ce rendez-vous" });
  }
  appt.status = "cancelled";
  saveAppointments(list);
  res.json(appt);
});

// Supprime définitivement un rendez-vous de la liste (contrairement à "cancel",
// qui garde une trace avec le statut "Annulé", ceci le fait disparaître pour de
// bon — utile pour faire le ménage dans les vieux rendez-vous refusés/annulés).
app.delete("/api/appointments/:id", (req, res) => {
  const peerId = req.query.peerId || (req.body && req.body.peerId);
  const list = loadAppointments();
  const idx = list.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Rendez-vous introuvable" });
  const appt = list[idx];
  if (appt.fromPeerId !== peerId && appt.toPeerId !== peerId) {
    return res.status(403).json({ error: "Pas partie de ce rendez-vous" });
  }
  list.splice(idx, 1);
  saveAppointments(list);
  res.json({ ok: true });
});

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

// Vérifie régulièrement les rendez-vous confirmés à venir et envoie un rappel
// push aux deux participants — en plus de l'alerte du calendrier natif (si le
// rendez-vous y a été ajouté), pour ceux qui ne l'auraient pas fait.
setInterval(async () => {
  const list = loadAppointments();
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

  if (changed) saveAppointments(list);
}, 30 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Téléphone Rétro (PWA + push) en écoute sur le port ${PORT}`);
});
