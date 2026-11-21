// Outline settings for the menu page (Admin -> Menu design -> Outlines).
// Saved inside the existing menu_design JSON in site_settings (key "outlines"), so no SQL / database change is needed.
// Each element group has: on (true / false), w (thickness in px, 0 to 8) and c (colour, #rrggbb).
// A group that is off (or missing) sends nothing to the page, so it keeps its original look.
// Keep OUTLINE_KEYS in step with OUTLINE_GROUPS in frontend/admin.html and the --ol-* names in frontend/menu-page.html.
const OUTLINE_KEYS = [
  'fields',      // every text input and text area (.field-input, .field-textarea)
  'mainbtn',     // main buttons (.primary-btn): Checkout, Pay, Login, Save, Track order ...
  'secondbtn',   // second buttons (.profile-secondary-btn): Register, Log out, Cancel payment
  'promobtn',    // promo "Apply" button (.promo-btn)
  'locbtn',      // location buttons (.loc-btn): GPS, Search, Pick up
  'contactbtn',  // contact buttons (.contact-btn): WhatsApp, Maps
  'dishadd',     // "Add to cart" on the dish card (.row .add)
  'itemadd',     // "Add to cart" in the dish pop-up (.add-cart-btn)
  'iconbtn',     // round close / back buttons (.icon-btn)
  'paybox',      // payment method box (.pay-method)
  'total',       // the Total line in the basket and at checkout (.summary-line.final)
];
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_WIDTH = 8;

function cleanOutlines(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Outline settings are not valid.' };
  }
  for (const key of Object.keys(raw)) {
    if (!OUTLINE_KEYS.includes(key)) return { ok: false, message: `Unknown outline group "${key}".` };
  }
  const value = {};
  for (const key of OUTLINE_KEYS) {
    const item = raw[key];
    if (item == null) continue;
    if (typeof item !== 'object' || Array.isArray(item)) return { ok: false, message: 'Outline settings are not valid.' };
    const width = item.w == null ? 1 : Number(item.w);
    const colour = item.c == null ? '#e3b23c' : String(item.c).trim();
    if (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH) {
      return { ok: false, message: `Outline thickness must be a whole number from 0 to ${MAX_WIDTH} px.` };
    }
    if (!HEX.test(colour)) return { ok: false, message: 'Choose a valid outline color.' };
    value[key] = { on: item.on === true, w: width, c: colour.toLowerCase() };
  }
  return { ok: true, value };
}

// CSS variable declarations ("--ol-fields-w:2px", ...) for the groups that are switched on.
function outlineCssVars(outlines) {
  const out = [];
  if (!outlines || typeof outlines !== 'object' || Array.isArray(outlines)) return out;
  for (const key of OUTLINE_KEYS) {
    const item = outlines[key];
    if (!item || item.on !== true) continue;
    const width = Number(item.w);
    if (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH || !HEX.test(item.c || '')) continue;
    out.push(`--ol-${key}-w:${width}px`, `--ol-${key}-c:${item.c}`);
    // The Total line is plain text, so an outline also needs a little room and rounded corners.
    if (key === 'total') out.push('--ol-total-pad:12px', '--ol-total-r:10px');
  }
  return out;
}

module.exports = { OUTLINE_KEYS, MAX_WIDTH, cleanOutlines, outlineCssVars };
