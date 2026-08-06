// Service worker — reçoit les notifications push même quand l'app n'est pas ouverte,
// et les affiche comme une alerte système (bannière + son), y compris téléphone verrouillé.
//
// Limite importante à garder en tête : un service worker ne peut PAS établir
// d'appel WebRTC lui-même (RTCPeerConnection n'existe pas dans ce contexte).
// Il peut seulement afficher une notification. C'est en tapant dessus que
// l'app s'ouvre réellement et que l'appel WebRTC se connecte.

const APP_URL = "/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // "kind" distingue un appel (réponse immédiate attendue, doit pouvoir
  // déclencher le rappel automatique) d'un rendez-vous (juste une info à
  // consulter — ne doit surtout pas être traité comme un appel manqué).
  let data = { kind: "call", title: "Téléphone Rétro", body: "Quelqu'un t'appelle", fromPeerId: "" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // payload non-JSON, on garde les valeurs par défaut
  }

  const isCall = data.kind === "call";
  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // Tag distinct par type : un rendez-vous ne doit pas effacer une notif
    // d'appel en cours (et inversement), mais deux rappels du même rendez-vous
    // peuvent se remplacer l'un l'autre sans s'empiler.
    tag: isCall ? "retrophone-incoming-call" : "retrophone-appointment",
    renotify: true,
    requireInteraction: isCall, // un appel doit rester bien visible ; un rappel de rendez-vous, moins critique
    vibrate: isCall ? [300, 150, 300, 150, 300] : [200, 100, 200],
    data: { kind: data.kind, fromPeerId: data.fromPeerId || "" },
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      // Si l'app est déjà ouverte (premier plan ou arrière-plan proche), on la
      // prévient tout de suite plutôt que d'attendre le prochain sondage —
      // c'est ce qui permet à la bannière "nouveau rendez-vous" et au son
      // d'alerte de réagir immédiatement, sans dépendre du clic sur la notif.
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) =>
          client.postMessage({ type: "push-received", kind: data.kind, fromPeerId: data.fromPeerId || "" })
        );
      }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const kind = event.notification.data?.kind || "call";
  const fromPeerId = event.notification.data?.fromPeerId || "";

  let targetUrl = APP_URL;
  if (kind === "call" && fromPeerId) targetUrl = `${APP_URL}?incomingFrom=${encodeURIComponent(fromPeerId)}`;
  else if (kind === "appointment") targetUrl = `${APP_URL}?openAppointments=1`;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "notification-tapped", kind, fromPeerId });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
