// Offline cache for the app shell. Data requests to Firebase are never touched.
const CACHE = 'habits-1791398606580';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './firebase-app-compat.js', './firebase-auth-compat.js', './firebase-firestore-compat.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
// To-do calendar export: the app links to event.ics?d=<event, base64url>; answer with a real calendar file
function icsResponse(url) {
  try {
    const b = (url.searchParams.get('d') || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '==='.slice((b.length + 3) % 4));
    const text = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    if (!text.startsWith('BEGIN:VCALENDAR')) throw new Error('bad');
    const name = (url.searchParams.get('n') || 'aufgabe.ics').replace(/[^\w.-]/g, '_');
    return new Response(text, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="' + name + '"', 'Cache-Control': 'no-store' } });
  } catch (err) {
    return new Response('Kalender-Datei ungültig', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const mine = url.origin === location.origin;
  const font = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!mine && !font) return;
  if (mine && url.pathname.endsWith('/event.ics')) { e.respondWith(icsResponse(url)); return; }
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || (mine ? caches.match('./index.html') : Response.error()))));
});
