// Service worker: membuat halaman bisa dibuka (cangkangnya) tanpa internet dan terpasang seperti aplikasi.
// Data dari Supabase TIDAK di-cache di sini; permintaan lintas-domain dibiarkan lewat apa adanya.
const VERSI = 'bandul-v5';
const CANGKANG = ['./', 'index.html', 'analisis.js', 'config.js', 'demo-data.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSI).then((c) => c.addAll(CANGKANG)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSI).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// stale-while-revalidate untuk berkas milik sendiri
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSI).then(async (c) => {
    const lama = await c.match(e.request);
    const baru = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => lama);
    return lama || baru;
  }));
});
