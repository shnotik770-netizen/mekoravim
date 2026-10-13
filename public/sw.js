// Service worker מינימלי — קיומו (עם fetch handler) הוא מה שמאפשר ל-Chrome/Android
// להציע "התקנה כאפליקציה". בלי מטמון: כל הבקשות ממשיכות כרגיל לרשת.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
