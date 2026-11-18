-- Customer list, WhatsApp opt-in and promo codes (client request 18/11/2026).
-- Run this once in the Supabase SQL Editor. Safe to run more than once.
-- Until it is run the site keeps working: orders are saved without these three columns (opt-in tick and promo
-- discount are then not stored on the order, but the discounted total is still what is charged).

alter table orders add column if not exists whatsapp_optin boolean not null default false;
alter table orders add column if not exists promo_code     text;
alter table orders add column if not exists discount       numeric(10,2) not null default 0;

create index if not exists idx_orders_customer_phone on orders (customer_phone);
create index if not exists idx_orders_promo_code on orders (promo_code) where promo_code is not null;

-- make the API see the new columns straight away
notify pgrst, 'reload schema';
