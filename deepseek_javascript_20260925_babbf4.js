/* ============================================================
   Account Tracker — Service Worker  (sw.js)
   Version : 3.11.0
   ------------------------------------------------------------
   Strategies
   • App shell (index.html)   → Network-first  (fresh HTML, offline fallback)
   • CDN libs / Google Fonts  → Stale-while-revalidate
   • Same-origin static files → Stale-while-revalidate
   • Firebase APIs            → Never cached  (always network)
   • Cross-origin navigation  → Untouched (auth popups etc.)
   ============================================================ */

const VERSION    = '3.11.0';
const CACHE_NAME = 'account-tracker-v' + VERSION;
const CACHE_PREFIX = 'account-tracker-';

/* ---------- Same-origin app shell ---------- */
const SHELL = ['./', './index.html'];

/* ---------- Third-party assets used by index.html ---------- */
const CDN_ASSETS = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://fonts.googleapis.com/css2?family=Baloo+Da+2:wght@600;700;800&family=Noto+Sans+Bengali:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap'
];

/* ---------- Hosts that may be cached at runtime ---------- */
const RUNTIME_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'www.gstatic.com'
];

/* ---------- Hosts that must NEVER be cached ---------- */
const BYPASS_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebaseappcheck.googleapis.com',
  'content-firebaseappcheck.googleapis.com',
  'www.googleapis.com',
  'apis.google.com',
  'accounts.google.com',
  'firebaseio.com',
  'firebaseapp.com'
];

/* ============================================================
   Helpers
   ============================================================ */

/** Exact hostname or sub-domain match */
function hostIn(hostname, list) {
  return list.some(function (h) {
    return hostname === h || hostname.endsWith('.' + h);
  });
}

/** Absolute URLs that represent the app shell */
function shellUrls() {
  var scope = self.registration.scope;
  return [scope, new URL('index.html', scope).href];
}

/** Fetch + store a single asset, falling back to no-cors for CDNs */
async function cacheAsset(cache, url, preferNoCors) {
  var attempts = preferNoCors
    ? [{ mode: 'no-cors', cache: 'reload' }, { mode: 'cors', cache: 'reload' }]
    : [{ mode: 'cors', cache: 'reload' }, { mode: 'no-cors', cache: 'reload' }];

  for (var i = 0; i < attempts.length; i++) {
    try {
      var res = await fetch(new Request(url, attempts[i]));
      if (res && res.type !== 'error' && (res.ok || res.type === 'opaque')) {
        await cache.put(url, res);
        return true;
      }
    } catch (e) {
      /* try the next mode */
    }
  }
  return false;
}

/** Minimal offline page (only shown if the shell was never cached) */
function offlineResponse() {
  return new Response(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Offline — Account Tracker</title></head>' +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:linear-gradient(135deg,#112343,#1c4c91);' +
    'color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'text-align:center;padding:24px">' +
    '<div><div style="font-size:52px;margin-bottom:14px">📡</div>' +
    '<h1 style="margin:0 0 8px;font-size:20px">You are offline</h1>' +
    '<p style="margin:0;opacity:.8;font-size:14px;line-height:1.7">' +
    'Please check your internet connection<br>and reload the page.</p>' +
    '<button onclick="location.reload()" style="margin-top:22px;padding:12px 26px;' +
    'border:0;border-radius:11px;background:#fff;color:#1c4c91;font-weight:700;' +
    'font-size:14px;cursor:pointer">🔄 Reload</button></div></body></html>',
    {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }
  );
}

/* ============================================================
   Install — precache shell + CDN libs
   ============================================================ */
self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    var cache = await caches.open(CACHE_NAME);

    /* App shell (must succeed on at least one URL) */
    var shellResults = await Promise.all(
      SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' }))
          .then(function () { return true; })
          .catch(function (err) {
            console.warn('[SW] shell precache skipped:', url, err && err.message);
            return false;
          });
      })
    );

    /* CDN libraries (best effort, in parallel) */
    await Promise.all(
      CDN_ASSETS.map(function (url) {
        return cacheAsset(cache, url, true).then(function (ok) {
          if (!ok) console.warn('[SW] cdn precache skipped:', url);
        });
      })
    );

    if (!shellResults.some(Boolean)) {
      console.warn('[SW] Could not precache the app shell — offline mode may be limited.');
    }

    await self.skipWaiting();
  })());
});

/* ============================================================
   Activate — clean old caches + take control
   ============================================================ */
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(
      keys
        .filter(function (k) {
          return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME;
        })
        .map(function (k) { return caches.delete(k); })
    );

    /* Enable navigation preload when supported (faster first paint) */
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* noop */ }
    }

    await self.clients.claim();
    console.log('[SW] activated:', CACHE_NAME);
  })());
});

/* ============================================================
   Fetch
   ============================================================ */
self.addEventListener('fetch', function (event) {
  var req = event.request;

  /* Only GET requests are cacheable */
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  /* Only http(s) */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* Firebase / Google APIs — never intercept */
  if (hostIn(url.hostname, BYPASS_HOSTS)) return;

  /* ---- HTML navigations (same-origin only) ---- */
  if (req.mode === 'navigate') {
    if (url.origin === self.location.origin) {
      event.respondWith(handleNavigation(event, req));
    }
    return; /* cross-origin navigations (auth popups) pass through */
  }

  /* ---- Same-origin static assets ---- */
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  /* ---- Known CDN / font hosts ---- */
  if (hostIn(url.hostname, RUNTIME_HOSTS)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/* ============================================================
   Strategy: Network-first (HTML / app shell)
   ============================================================ */
async function handleNavigation(event, req) {
  var cache = await caches.open(CACHE_NAME);
  var urls = shellUrls();

  /* 1) Navigation preload response (if available) */
  try {
    if (event.preloadResponse) {
      var preloaded = await event.preloadResponse;
      if (preloaded && preloaded.ok) {
        /* keep the shell copy fresh in the background */
        cache.put(urls[1], preloaded.clone()).catch(function () {});
        return preloaded;
      }
    }
  } catch (e) { /* fall through to normal fetch */ }

  /* 2) Network */
  try {
    var fresh = await fetch(req);
    if (fresh && fresh.ok) {
      /* refresh both shell keys so the offline fallback stays current */
      cache.put(urls[0], fresh.clone()).catch(function () {});
      cache.put(urls[1], fresh.clone()).catch(function () {});
    }
    return fresh;
  } catch (e) {
    /* 3) Offline — serve the cached shell */
    var cached =
      (await cache.match(req, { ignoreSearch: true })) ||
      (await cache.match(urls[1])) ||
      (await cache.match(urls[0]));

    if (cached) return cached;
    return offlineResponse();
  }
}

/* ============================================================
   Strategy: Stale-while-revalidate (static assets)
   ============================================================ */
async function staleWhileRevalidate(req) {
  var cache = await caches.open(CACHE_NAME);
  var cached = await cache.match(req, { ignoreSearch: false });

  var networkFetch = fetch(req)
    .then(function (res) {
      if (res && res.type !== 'error' && (res.ok || res.type === 'opaque')) {
        cache.put(req, res.clone()).catch(function () {});
      }
      return res;
    })
    .catch(function () { return null; });

  if (cached) {
    /* Serve instantly, refresh in the background */
    networkFetch.catch(function () {});
    return cached;
  }

  var res = await networkFetch;
  if (res) return res;

  /* Last resort for fonts / css: return a tiny empty response so the
     page does not break completely while offline */
  return new Response('', {
    status: 504,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

/* ============================================================
   Messages (from the page)
   ============================================================ */
self.addEventListener('message', function (event) {
  var data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil((async function () {
      var keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; })
          .map(function (k) { return caches.delete(k); })
      );
      if (event.source && event.source.postMessage) {
        event.source.postMessage({ type: 'CACHE_CLEARED' });
      }
    })());
    return;
  }

  if (data.type === 'GET_VERSION') {
    if (event.source && event.source.postMessage) {
      event.source.postMessage({ type: 'VERSION', version: VERSION });
    }
  }
});

console.log('[SW] loaded — Account Tracker v' + VERSION);