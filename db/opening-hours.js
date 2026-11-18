const supabase = require('./supabase');

// Opening hours / "closed now". Edited in Admin -> Opening hours, stored in site_settings (key 'opening_hours').
//   mode 'open'     -> always taking orders (the default: nothing changes until someone sets this up)
//   mode 'schedule' -> follow the weekly hours below
//   mode 'closed'   -> not taking orders now (a one-tap pause)
// days[0] is Sunday ... days[6] is Saturday. A closing time earlier than the opening time means "after midnight".
const SETTINGS_KEY = 'opening_hours';
const TIME_ZONE = 'Asia/Riyadh';
const LANGS = ['en', 'ar', 'ur', 'zh'];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_DAYS = Array.from({ length: 7 }, () => ({ closed: false, open: '12:00', close: '23:00' }));
const DEFAULTS = { mode: 'open', days: DEFAULT_DAYS, message: { en: '', ar: '', ur: '', zh: '' } };

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function normalise(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const mode = ['open', 'schedule', 'closed'].includes(s.mode) ? s.mode : 'open';
  const days = DEFAULT_DAYS.map((d, i) => {
    const r = Array.isArray(s.days) && s.days[i] && typeof s.days[i] === 'object' ? s.days[i] : {};
    return {
      closed: r.closed === true,
      open: TIME_PATTERN.test(r.open || '') ? r.open : d.open,
      close: TIME_PATTERN.test(r.close || '') ? r.close : d.close,
    };
  });
  const message = {};
  LANGS.forEach((l) => { message[l] = s.message && typeof s.message[l] === 'string' ? s.message[l].trim().slice(0, 140) : ''; });
  return { mode, days, message };
}

function validate(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Nothing to save.' };
  if (!['open', 'schedule', 'closed'].includes(body.mode)) return { ok: false, message: 'Choose open, follow the hours, or closed.' };
  if (!Array.isArray(body.days) || body.days.length !== 7) return { ok: false, message: 'The hours need all 7 days.' };
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const r = body.days[i] && typeof body.days[i] === 'object' ? body.days[i] : {};
    const closed = r.closed === true;
    if (!closed) {
      if (!TIME_PATTERN.test(r.open || '') || !TIME_PATTERN.test(r.close || '')) return { ok: false, message: 'Times must look like 12:00 (24-hour clock).' };
      if (r.open === r.close) return { ok: false, message: 'Opening and closing time can not be the same.' };
    }
    days.push({ closed, open: TIME_PATTERN.test(r.open || '') ? r.open : '12:00', close: TIME_PATTERN.test(r.close || '') ? r.close : '23:00' });
  }
  const message = {};
  for (const l of LANGS) {
    const text = body.message && body.message[l] != null ? body.message[l] : '';
    if (typeof text !== 'string') return { ok: false, message: 'Messages must be plain text.' };
    if (text.trim().length > 140) return { ok: false, message: 'A message can be 140 characters at most.' };
    message[l] = text.trim();
  }
  return { ok: true, value: { mode: body.mode, days, message } };
}

// The wall-clock time in Riyadh: { dow: 0-6 (Sunday = 0), minutes: minutes since midnight }
function localClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { dow, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

// Pure function (easy to test): is the restaurant taking orders at `now`, and if not, when does it open next?
function computeStatus(settings, now = new Date()) {
  const s = normalise(settings);
  const base = { mode: s.mode, message: s.message };
  if (s.mode === 'open') return { ...base, open: true, nextOpen: null };
  if (s.mode === 'closed') return { ...base, open: false, nextOpen: null };

  const { dow, minutes } = localClock(now);
  const today = s.days[dow];
  const yesterday = s.days[(dow + 6) % 7];
  // still inside last night's after-midnight shift?
  if (!yesterday.closed && toMinutes(yesterday.close) < toMinutes(yesterday.open) && minutes < toMinutes(yesterday.close)) {
    return { ...base, open: true, nextOpen: null, closesAt: yesterday.close };
  }
  if (!today.closed) {
    const o = toMinutes(today.open); const c = toMinutes(today.close);
    if (c > o ? (minutes >= o && minutes < c) : minutes >= o) {
      return { ...base, open: true, nextOpen: null, closesAt: today.close };
    }
    if (minutes < o) return { ...base, open: false, nextOpen: { dayOffset: 0, dow, time: today.open } };
  }
  for (let offset = 1; offset <= 7; offset += 1) {
    const d = (dow + offset) % 7;
    if (!s.days[d].closed) return { ...base, open: false, nextOpen: { dayOffset: offset, dow: d, time: s.days[d].open } };
  }
  return { ...base, open: false, nextOpen: null };   // every day is marked closed
}

function isMissingTable(error) {
  return error && (error.code === '42P01' || error.code === 'PGRST205');
}

let cache = null;   // 10 s, cleared when the admin saves, so config requests do not each hit the database
async function readSettings() {
  if (cache && Date.now() - cache.at < 10000) return cache.value;
  const { data, error } = await supabase.from('site_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  if (error) {
    if (!isMissingTable(error)) console.error('Could not read the opening hours:', error.message);
    return cache ? cache.value : normalise(null);   // if the database is unreachable keep taking orders rather than closing the shop
  }
  const value = normalise(data ? data.value : null);
  cache = { at: Date.now(), value };
  return value;
}

async function getSettings() { return readSettings(); }
async function getStatus(now) { return computeStatus(await readSettings(), now); }

async function saveSettings(value) {
  const { error } = await supabase.from('site_settings').upsert({ key: SETTINGS_KEY, value, updated_at: new Date().toISOString() });
  if (error) throw error;
  cache = null;
}

module.exports = { getSettings, getStatus, saveSettings, validate, computeStatus, normalise, DEFAULTS, LANGS, TIME_ZONE };
