# Téléphone Rétro — prototype PWA avec notifications push

Version du prototype qui ajoute une notification système ("Léo t'appelle 📞")
lorsqu'un appel arrive, même si l'app est fermée ou le téléphone verrouillé.

Ce que ça résout, et ce que ça ne résout pas :

- ✅ L'identifiant d'appareil ne change plus au rafraîchissement (stocké en local).
- ✅ Le micro n'est demandé qu'une fois par appareil (à condition d'être servi en
  http/https, pas ouvert en fichier local — voir plus bas).
- ⚠️ Le téléphone peut maintenant être réveillé par une notification même
  verrouillé/app fermée. Ce n'est PAS un vrai écran d'appel système comme
  CallKit sur iOS : c'est une notification standard. Il y a un léger délai
  (quelques secondes) le temps que l'app se rouvre et que l'appel se connecte
  après le tap. Pour un vrai "ça sonne et je décroche instantanément, écran
  verrouillé", il faut la version app native avec CallKit + PushKit.
- ✅ Pastille "en ligne" sur chaque contact : chaque appareil envoie un
  battement de vie au serveur toutes les 15 s tant que l'app est ouverte ;
  les autres sondent ce statut au même rythme (`/api/presence`). Décalage
  possible jusqu'à ~15-30 s — pas du temps réel à la seconde, mais suffisant
  pour savoir si un ami a son app active.
- ✅ Rendez-vous ("🗓️ Rendez-vous" sur la fiche d'un contact) : si personne
  n'est en ligne, on propose une date/heure. L'autre reçoit une notification,
  accepte ou refuse depuis "Mes rendez-vous" (icône 🗓️ en haut). Un rendez-vous
  confirmé peut être ajouté au calendrier natif du téléphone (bouton "📅 Ajouter
  à mon calendrier", génère un .ics avec un rappel intégré 10 min avant — ce
  rappel-là vient du vrai calendrier du téléphone, pas de cette app). En plus,
  le serveur envoie lui-même une notification de rappel (10 min avant + à
  l'heure) à ceux qui n'auraient pas ajouté l'événement à leur calendrier.

## Message "Notifications indisponibles" ?

Si l'espace parent affiche "Notifications indisponibles" (sur Safari **et**
Chrome, ordinateur ou téléphone), la cause est presque toujours la même : la
page n'est pas servie par le serveur, elle a été ouverte directement comme
fichier (double-clic, ou glissée dans le navigateur). Un service worker (ce
qui permet les notifications) refuse de s'enregistrer dans ce cas — c'est une
règle des navigateurs, pas un bug réparable côté code.

Il faut systématiquement passer par le serveur Node (`npm start`) et ouvrir
l'adresse qu'il donne (`http://localhost:3000` sur l'ordinateur qui l'héberge,
ou l'URL https d'un tunnel/hébergement pour un téléphone — voir étapes 1 et 2
ci-dessous). Une adresse locale de type `http://192.168.x.x:3000` (l'IP de ton
ordinateur sur le wifi) ne suffit PAS non plus : seules `https://` et
`http://localhost` sont acceptées par les navigateurs pour les service
workers, donc pour tester depuis un téléphone il faut vraiment l'étape 2
(tunnel) ou l'étape 3 (hébergement).

## 1. Lancer en local (pour développer/tester sur ordinateur)

Prérequis : Node.js installé sur l'ordinateur (pas sur le téléphone). Pour
vérifier, ouvrir un Terminal et taper `node -v` — si ça renvoie un numéro de
version (ex. `v20.11.0`), c'est bon. Sinon, installer Node.js depuis
https://nodejs.org (version "LTS").

Ensuite, dans le dossier `retrophone-pwa` (celui de ce fichier) :

```bash
cd retrophone-pwa
npm install
npm start
```

Le terminal doit afficher `Téléphone Rétro (PWA + push) en écoute sur le port
3000` et rester ouvert (ne pas fermer ce terminal — tant qu'il tourne, le
serveur est actif ; si tu le fermes, le serveur s'arrête et plus rien ne
fonctionne, y compris les notifications).

Ouvre `http://localhost:3000` dans le navigateur. Les clés VAPID (nécessaires
aux notifications push) sont générées automatiquement au premier lancement,
dans `vapid-keys.json` — ne pas supprimer ce fichier une fois des appareils
abonnés, sinon leurs abonnements deviennent invalides.

## 2. Tester sur un vrai téléphone (rapide, sans hébergement permanent)

Un service worker exige une adresse https (ou `localhost`). Pour tester vite
sur ton iPhone/Android sans déployer, expose ton serveur local via un tunnel :

```bash
npm install -g localtunnel
npm start                     # dans un premier terminal
lt --port 3000                # dans un second terminal, donne une URL https://xxxx.loca.lt
```

Ouvre l'URL https donnée sur le téléphone, dans Safari (iOS) ou Chrome (Android).

**Étape importante sur iOS** : les notifications push ne fonctionnent QUE si la
page est ajoutée à l'écran d'accueil (Partager ⬆️ → « Sur l'écran d'accueil »),
pas juste ouverte dans un onglet Safari. Une bannière dans l'app le rappelle.
Sur Android/Chrome, ça fonctionne aussi depuis un onglet ouvert, mais l'ajout à
l'écran d'accueil reste recommandé pour l'expérience finale (pas de barre
d'adresse visible).

## 3. Héberger durablement (pour un vrai pilote avec plusieurs familles)

N'importe quel hébergeur Node.js convient (le service doit rester allumé en
permanence pour recevoir les demandes de notification). Options simples :

- **Render.com** ou **Railway.app** : connecter le dossier, ils détectent
  `npm start` automatiquement, HTTPS fourni d'office.
- **Fly.io** : `fly launch` puis `fly deploy`.

Après déploiement, chaque famille ouvre l'URL fournie, l'ajoute à l'écran
d'accueil, et échange les identifiants d'appareil comme dans la version
précédente du prototype (via l'icône ⚙️).

### ⚠️ Important sur Render (plan gratuit) : les rendez-vous/abonnements disparaissent

Sur le plan **gratuit** de Render, le service se met en veille après ~15 min
sans requête, et se réveille dans un conteneur "propre" à la requête suivante.
Les fichiers `appointments.json`, `subscriptions.json` et `vapid-keys.json`
sont réécrits à chaque démarrage, donc **tout ce qui a été enregistré depuis
le dernier démarrage est perdu** — c'est ce qui explique un rendez-vous
accepté qui "disparaît après quelques heures".

Trois façons de corriger ça, au choix :

1. **Réutiliser un hébergement PHP existant (gratuit, recommandé si tu as
   déjà un site perso)** : le dossier `php-store/` fourni avec ce projet est
   un tout petit service PHP qui lit/écrit un fichier JSON par donnée — et le
   stockage fichier d'un hébergement PHP classique, lui, persiste vraiment
   dans la durée (contrairement au conteneur Render gratuit). Étapes :
   - Uploader le dossier `php-store/` (avec `store.php`, `data/` et son
     `.htaccess`) sur ton site PHP, par ex. dans `/retro-store/`.
   - Dans `php-store/store.php`, remplacer `CHANGE_MOI_...` par une longue
     phrase secrète aléatoire.
   - Vérifier que `php-store/data/` est accessible en écriture par PHP
     (généralement le cas par défaut après upload FTP).
   - Dans Render → le service → *Environment*, ajouter :
     `PHP_STORE_URL` = `https://tondomaine.fr/retro-store/store.php` et
     `PHP_STORE_SECRET` = la même phrase secrète.
   - Redéployer. Les logs Render doivent afficher "Stockage distant activé".
2. **Disque persistant Render (payant, ~7-8 $/mois au total)** : passer le
   service au plan "Starter", ajouter un "Persistent Disk" (1 Go suffit
   largement) monté par exemple sur `/data`, puis dans Render → *Environment*,
   ajouter la variable `DATA_DIR` = `/data`. Le serveur lit déjà cette
   variable — aucune autre modification nécessaire.
3. **Base de données externe** (ex. Upstash Redis, gratuit) : demande une
   petite adaptation du code, possible sur demande.

Sans l'une des trois, le prototype reste utilisable pour tester, mais pas
fiable pour un usage réel avec plusieurs familles.

## Limites connues (prototype, pas prêt pour la production)

- Signalisation WebRTC via le broker public de démo PeerJS + serveurs STUN
  Google : pas de TURN dédié, certains réseaux avec pare-feu strict peuvent
  bloquer l'appel une fois les deux app ouvertes.
- Abonnements push stockés dans un simple fichier JSON (`subscriptions.json`)
  — à remplacer par une vraie base de données au-delà de quelques familles
  testeuses.
- Pas d'authentification / de validation mutuelle des contacts : n'importe qui
  connaissant l'identifiant d'un appareil peut l'ajouter comme contact. Le
  cahier des charges produit prévoit une validation par les parents — à
  implémenter avant tout usage réel.
