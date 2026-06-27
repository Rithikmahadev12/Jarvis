// Minimal service worker — JARVIS needs a live connection to its own
// server anyway (Groq, voice, sockets), so this intentionally doesn't
// do offline caching. Its only job is to exist, since Chrome requires
// a registered service worker before it'll offer to install a PWA.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* pass-through, no caching */ });
