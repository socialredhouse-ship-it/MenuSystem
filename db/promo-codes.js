const supabase = require('./supabase');

// Promo codes are edited in Admin -> Promo codes and stored in site_settings (key 'promo_codes'), so no SQL is needed
// for the codes themselves. The discount applies to the food subtotal only (never to the delivery fee) and is always
// recomputed on the server when an order is placed.
const SETTINGS_KEY = 'promo_codes';
const MAX_CODES = 100;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,19}$/;
const TIME_ZONE = 'Asia/Riyadh';

const toMoney = (n) => Math.round(n * 100) / 100;

function todayInRiyadh(now = new Date()) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function isMissingTable(error) {
  return error && (error.code === '42P01' || error.code === 'PGRST205');
}

async function readCodes() {
  const { data, error } = await supabase.from('site_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
  if (error) {
    if (!isMissingTable(error)) console.error('Could not read the promo codes:', error.message);
    return [];
  }
  const codes = data && data.value && Array.isArray(data.value.codes) ? data.value.codes : [];
  return codes.filter((c) => c && typeof c.code === 'string');
}

// Admin input -> clean list, or { ok:false, message }.
function validate(body) {
  if (!body || !Array.isArray(body.codes)) return { ok: false, message: 'Nothing to save.' };
  if (body.codes.length > MAX_CODES) return { ok: false, message: `At most ${MAX_CODES} codes.` };
  const seen = new Set();
  const codes = [];
  for (const raw of body.codes) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const code = String(row.code || '').trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) return { ok: false, message: `"${code || '(empty)'}": a code is 3 to 20 letters, numbers, - or _.` };
    if (seen.has(code)) return { ok: false, message: `The code ${code} is listed twice.` };
    seen.add(code);
    const type = row.type === 'fixed' ? 'fixed' : row.type === 'percent' ? 'percent' : null;
    if (!type) return { ok: false, message: `${code}: choose percent or fixed amount.` };
    const value = Number(row.value);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, message: `${code}: the discount must be more than 0.` };
    if (type === 'percent' && value > 100) return { ok: false, message: `${code}: a percentage can be 100 at most.` };
    if (type === 'fixed' && value > 100000) return { ok: false, message: `${code}: that amount is too large.` };
    const minOrder = row.minOrder === '' || row.minOrder == null ? 0 : Number(row.minOrder);
    if (!Number.isFinite(minOrder) || minOrder < 0) return { ok: false, message: `${code}: the minimum order must be 0 or more.` };
    const maxUses = row.maxUses === '' || row.maxUses == null ? 0 : Number(row.maxUses);
    if (!Number.isInteger(maxUses) || maxUses < 0) return { ok: false, message: `${code}: the number of uses must be a whole number (0 = unlimited).` };
    const expiresAt = String(row.expiresAt || '').trim();
    if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return { ok: false, message: `${code}: the expiry date must look like 2026-12-31.` };
    codes.push({
      code, type, value: type === 'percent' ? Math.round(value * 100) / 100 : toMoney(value),
      minOrder: toMoney(minOrder), maxUses, expiresAt, active: row.active !== false,
    });
  }
  return { ok: true, value: { codes } };
}

async function saveCodes(value) {
  const { error } = await supabase.from('site_settings').upsert({ key: SETTINGS_KEY, value, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// How many paid orders used a code (0 if the orders.promo_code column has not been added yet).
async function countUses(code) {
  const { count, error } = await supabase
    .from('orders').select('id', { count: 'exact', head: true })
    .eq('promo_code', code).eq('payment_status', 'paid');
  if (error) return 0;
  return count || 0;
}

async function getAdminList() {
  const codes = await readCodes();
  const uses = await Promise.all(codes.map((c) => countUses(c.code)));
  return { codes: codes.map((c, i) => ({ ...c, uses: uses[i] })) };
}

async function hasActiveCodes() {
  const today = todayInRiyadh();
  return (await readCodes()).some((c) => c.active !== false && (!c.expiresAt || c.expiresAt >= today));
}

// Check one code against a food subtotal. Never trusts anything from the browser except the code text.
async function evaluate(rawCode, subtotal) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'invalid' };
  const promo = (await readCodes()).find((c) => c.code === code);
  if (!promo) return { ok: false, reason: 'invalid' };
  if (promo.active === false) return { ok: false, reason: 'inactive' };
  if (promo.expiresAt && promo.expiresAt < todayInRiyadh()) return { ok: false, reason: 'expired' };
  if (promo.minOrder && subtotal < promo.minOrder) return { ok: false, reason: 'min_order', minOrder: promo.minOrder };
  if (promo.maxUses && (await countUses(code)) >= promo.maxUses) return { ok: false, reason: 'used_up' };
  let discount = promo.type === 'percent' ? toMoney(subtotal * promo.value / 100) : Math.min(promo.value, subtotal);
  // keep at least 1 SAR of food to pay for, so the card payment is never below Moyasar's minimum
  discount = toMoney(Math.max(0, Math.min(discount, subtotal - 1)));
  if (discount <= 0) return { ok: false, reason: 'invalid' };
  return { ok: true, code, discount, type: promo.type, value: promo.value };
}

module.exports = { validate, readCodes, saveCodes, getAdminList, hasActiveCodes, evaluate, countUses, todayInRiyadh };
