// 오프라인 캐시. 파일을 바꿔 다시 올릴 때는 VERSION 숫자를 올려야 기기가 새 파일을 받는다.
const VERSION = "v1";
const CACHE = "hanyu-" + VERSION;
const FILES = [
  "./", "index.html", "app.js", "manifest.webmanifest",
  "vendor/ts-fsrs.umd.js", "data/words.json",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("hanyu-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match("index.html"))),
  );
});
