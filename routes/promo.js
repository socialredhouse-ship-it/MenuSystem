const express = require('express');
const rateLimit = require('express-rate-limit');
const supabase = require('../db/supabase');
const promoCodes = require('../db/promo-codes');

const router = express.Router();

// Customers try a code at checkout; the limit stops a script from guessing codes.
const promoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many promo code attempts. Please wait a while and try again.', code: 'RATE_LIMITED' },
});

// POST /api/promo/validate  { code, items: [{ menu_item_id, quantity }] }
// -> { valid: true, code, discount } or { valid: false, reason: invalid | inactive | expired | min_order | used_up, minOrder? }
// The subtotal is priced here from the database (never taken from the browser) so "minimum order" is honest.
router.post('/promo/validate', promoLimiter, async (req, res) => {
  const { code, items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) return res.status(400).json({ error: 'items must be a non-empty array' });
  const ids = items.map((i) => Number(i && i.menu_item_id));
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) return res.status(400).json({ error: 'Every item needs a valid menu_item_id' });

  const { data: dbItems, error } = await supabase.from('menu_items').select('id, price, is_available').in('id', ids);
  if (error) return res.status(500).json({ error: 'Could not check the promo code. Please try again.' });
  const byId = new Map(dbItems.map((i) => [i.id, i]));
  let subtotal = 0;
  for (const line of items) {
    const item = byId.get(Number(line.menu_item_id));
    const qty = Number(line.quantity);
    if (!item || !item.is_available || !Number.isInteger(qty) || qty <= 0 || qty > 50) return res.status(400).json({ error: 'An item in the basket is not available.' });
    subtotal = Math.round((subtotal + Number(item.price) * qty) * 100) / 100;
  }
  const result = await promoCodes.evaluate(code, subtotal);
  if (!result.ok) return res.json({ valid: false, reason: result.reason, minOrder: result.minOrder });
  res.json({ valid: true, code: result.code, discount: result.discount });
});

module.exports = router;
