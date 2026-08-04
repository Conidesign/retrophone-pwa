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

const DATA_DIR = __dirname;
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Téléphone Rétro (PWA + push) en écoute sur le port ${PORT}`);
});
