// In-memory snapshot of everything the public menu page needs (menu, categories, design, poster,
// public config, contact). Built at server start, rebuilt only after an admin save or a payment,
// otherwise served from memory with no Supabase calls.
//
//   init(loader)        loader() -> object with the snapshot data (see server.js loadSnapshot)
//   ensure()            resolves the current snapshot (rebuilding first if something changed);
//                       resolves null if there has never been a successful build
//   invalidate()        mark stale (next ensure() rebuilds; concurrent callers share one rebuild)
//   watcher(req,res,n)  Express middleware: any successful non-GET marks the snapshot stale
//   htmlFor(key, make)  per-snapshot cache for rendered HTML (cleared on every rebuild)

let loader = null;
let current = null;
let inflight = null;
let dirty = true;
let failedAt = 0;
const html = new Map();

function init(fn, { refreshMinutes = 0 } = {}) {
  loader = fn;
  ensure().then((s) => console.log(s ? '[snapshot] ready' : '[snapshot] first build failed; serving live data'));
  // optional safety net for edits made straight in the Supabase SQL editor (off unless asked for)
  if (refreshMinutes > 0) setInterval(invalidate, refreshMinutes * 60 * 1000).unref();
}

function invalidate() { dirty = true; }

async function ensure() {
  if (!loader) return current;
  if (inflight) { await inflight; return current; }   // a rebuild is running: wait for it, never serve the stale copy
  if (!dirty && current) return current;
  if (current && failedAt && Date.now() - failedAt < 5000) return current; // DB trouble: don't hammer it
  if (!inflight) {
    inflight = (async () => {
      dirty = false; // a save that lands mid-build sets it again and triggers one more rebuild
      try {
        const next = await loader();
        current = { ...next, version: Date.now().toString(36), builtAt: new Date().toISOString() };
        html.clear();
        failedAt = 0;
      } catch (error) {
        dirty = true;
        failedAt = Date.now();
        console.error('[snapshot] rebuild failed, keeping the previous one:', error.message);
      } finally {
        inflight = null;
      }
    })();
  }
  await inflight;
  return current;
}

function htmlFor(key, make) {
  if (!html.has(key)) html.set(key, make());
  return html.get(key);
}

// Mount on '/api/admin' (every admin write path starts with it) and on '/api/orders/payment'
// (a confirmed payment changes promo usage). Marks the snapshot stale only when the write succeeded.
function watcher(req, res, next) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/translate')) {
    res.on('finish', () => { if (res.statusCode < 400) invalidate(); });
  }
  next();
}

module.exports = { init, ensure, invalidate, watcher, htmlFor };
