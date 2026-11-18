const supabase = require('./supabase');

// Customer list + CSV exports for Admin. Customers are built from paid orders (nobody is listed for an abandoned
// payment). One customer = one phone number, matched on its digits so "+966 50 123 4567" and "0501234567" are the same person.
const TIME_ZONE = 'Asia/Riyadh';
const PAGE = 1000;
const MAX_ROWS = 50000;

function isMissingColumn(e) { return Boolean(e && (e.code === '42703' || e.code === 'PGRST204')); }

// Digits only, Saudi numbers brought to the 966 form: 0501234567 / 501234567 / +966501234567 / 00966501234567.
function normalisePhone(raw) {
  let d = String(raw || '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))   // Arabic-Indic digits
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))                         // Persian/Urdu digits
    .replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`;
  else if (/^5\d{8}$/.test(d)) d = `966${d}`;
  return d;
}

// Read every order (Supabase returns at most 1000 rows per request, so page through them).
async function fetchOrders(columns, apply) {
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let query = supabase.from('orders').select(columns).order('created_at', { ascending: false }).range(from, from + PAGE - 1);
    if (apply) query = apply(query);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

async function fetchOrdersWithOptionalColumns(base, extras, apply) {
  try {
    return { rows: await fetchOrders(`${base}, ${extras}`, apply), extras: true };
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    return { rows: await fetchOrders(base, apply), extras: false };   // db/07_customers_promos.sql has not been run yet
  }
}

const money = (n) => (Math.round(Number(n || 0) * 100) / 100);

async function buildCustomers() {
  const base = 'id, customer_name, customer_phone, delivery_type, delivery_address, status, payment_status, total, created_at';
  const { rows, extras } = await fetchOrdersWithOptionalColumns(base, 'whatsapp_optin');
  const byKey = new Map();
  // rows are newest first, so the first row seen for a phone holds the latest name and address
  for (const o of rows) {
    if (o.payment_status !== 'paid') continue;
    const key = normalisePhone(o.customer_phone) || `name:${String(o.customer_name || '').trim().toLowerCase()}`;
    let c = byKey.get(key);
    if (!c) {
      c = { key, name: o.customer_name || '', phone: o.customer_phone || '', phone_digits: normalisePhone(o.customer_phone),
        last_address: '', last_type: o.delivery_type, orders: 0, spent: 0, first_order: o.created_at, last_order: o.created_at, whatsapp_optin: false };
      byKey.set(key, c);
    }
    if (!c.last_address && o.delivery_address) c.last_address = o.delivery_address;
    if (o.status !== 'cancelled') { c.orders += 1; c.spent = money(c.spent + Number(o.total || 0)); }
    if (o.created_at < c.first_order) c.first_order = o.created_at;
    if (o.whatsapp_optin === true) c.whatsapp_optin = true;   // opted in on any order stays opted in
  }
  const customers = [...byKey.values()].filter((c) => c.orders > 0).sort((a, b) => (a.last_order < b.last_order ? 1 : -1));
  return { customers, optinColumn: extras };
}

// ---- CSV (opens correctly in Excel: UTF-8 with BOM, so Arabic/Urdu/Chinese names are not garbled) ----
function csvCell(value, { text = false } = {}) {
  let s = value == null ? '' : String(value);
  // spreadsheet formula injection: a customer typed "=HYPERLINK(...)" as their name -> keep it as plain text
  if (!text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  const lines = [headers.map((h) => csvCell(h, { text: true })).join(',')];
  rows.forEach((r) => lines.push(r.map((v) => (v && typeof v === 'object' && v.text !== undefined ? csvCell(v.text, { text: true }) : csvCell(v))).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}
function localStamp(iso) {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function customersCsv(customers) {
  const headers = ['Name', 'Phone', 'WhatsApp opt-in', 'Orders', 'Total spent (SAR)', 'Average order (SAR)', 'First order', 'Last order', 'Last address', 'Last order type'];
  const rows = customers.map((c) => [
    c.name, { text: c.phone_digits || c.phone }, c.whatsapp_optin ? 'Yes' : 'No', c.orders, c.spent.toFixed(2),
    c.orders ? (c.spent / c.orders).toFixed(2) : '0.00', localStamp(c.first_order), localStamp(c.last_order), c.last_address, c.last_type,
  ]);
  return toCsv(headers, rows);
}

async function buildOrdersCsv({ from, to } = {}) {
  const base = 'id, order_number, customer_name, customer_phone, delivery_type, delivery_address, status, payment_status, subtotal, total, notes, created_at, order_items(name_snapshot, quantity)';
  const apply = (q) => {
    if (from) q = q.gte('created_at', `${from}T00:00:00+03:00`);
    if (to) q = q.lte('created_at', `${to}T23:59:59.999+03:00`);
    return q;
  };
  const { rows } = await fetchOrdersWithOptionalColumns(base, 'whatsapp_optin, promo_code, discount', apply);
  const headers = ['Order number', 'Date (Riyadh)', 'Customer', 'Phone', 'Order type', 'Address', 'Items', 'Subtotal (SAR)', 'Promo code', 'Discount (SAR)', 'Delivery fee (SAR)', 'Total (SAR)', 'Payment', 'Order status', 'WhatsApp opt-in', 'Notes'];
  const lines = rows.map((o) => {
    const discount = money(o.discount);
    const delivery = money(Number(o.total || 0) - Number(o.subtotal || 0) + discount);
    const items = (o.order_items || []).map((i) => `${i.quantity}x ${i.name_snapshot}`).join('; ');
    return [o.order_number, localStamp(o.created_at), o.customer_name, { text: normalisePhone(o.customer_phone) || o.customer_phone }, o.delivery_type,
      o.delivery_address, items, money(o.subtotal).toFixed(2), o.promo_code || '', discount.toFixed(2), Math.max(0, delivery).toFixed(2),
      money(o.total).toFixed(2), o.payment_status, o.status, o.whatsapp_optin === true ? 'Yes' : 'No', o.notes];
  });
  return toCsv(headers, lines);
}

module.exports = { buildCustomers, customersCsv, buildOrdersCsv, normalisePhone, csvCell, toCsv, localStamp };
