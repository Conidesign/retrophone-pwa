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
  let data = { title: "Téléphone Rétro", body: "Quelqu'un t'appelle", fromPeerId: "" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // payload non-JSON, on garde les valeurs par défaut
  }

  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "retrophone-incoming-call", // remplace une notif précédente au lieu d'empiler
    renotify: true,
    requireInteraction: true, // reste affichée tant qu'on ne tape pas dessus (où c'est supporté)
    vibrate: [300, 150, 300, 150, 300],
    data: { fromPeerId: data.fromPeerId || "" },
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const fromPeerId = event.notification.data?.fromPeerId || "";
  const targetUrl = fromPeerId ? `${APP_URL}?incomingFrom=${encodeURIComponent(fromPeerId)}` : APP_URL;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "notification-tapped", fromPeerId });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
