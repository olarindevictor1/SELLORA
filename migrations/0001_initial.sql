-- SELLORA D1 / SQLite Initial Schema Migration
-- All monetary values are stored as INTEGER in Nigerian Kobo (1 NGN = 100 Kobo)
-- Timestamps stored in ISO 8601 UTC format

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ==========================================
-- BETTER AUTH CORE TABLES + RBAC EXTENSIONS
-- ==========================================

CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  phone TEXT,
  permissionsJson TEXT NOT NULL DEFAULT '[]',
  isActive INTEGER NOT NULL DEFAULT 1,
  notifyOrderUpdates INTEGER NOT NULL DEFAULT 1,
  notifyPromotions INTEGER NOT NULL DEFAULT 0,
  customerNotes TEXT DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_userId ON session(userId);
CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_userId ON account(userId);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT,
  updatedAt TEXT
);

-- ==========================================
-- STORE SETTINGS & CMS
-- ==========================================

CREATE TABLE IF NOT EXISTS store_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- ==========================================
-- CATALOG: CATEGORIES, COLLECTIONS, PRODUCTS
-- ==========================================

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  banner_url TEXT,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  brand TEXT NOT NULL DEFAULT 'SELLORA',
  short_description TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  specifications_json TEXT NOT NULL DEFAULT '[]',
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  price_kobo INTEGER NOT NULL CHECK(price_kobo >= 0),
  sale_price_kobo INTEGER CHECK(sale_price_kobo IS NULL OR sale_price_kobo >= 0),
  cost_price_kobo INTEGER CHECK(cost_price_kobo IS NULL OR cost_price_kobo >= 0),
  track_inventory INTEGER NOT NULL DEFAULT 1,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft', 'active', 'archived')),
  is_featured INTEGER NOT NULL DEFAULT 0,
  publish_at TEXT,
  seo_title TEXT,
  seo_description TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',
  video_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_collection ON products(collection_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  price_kobo INTEGER NOT NULL CHECK(price_kobo >= 0),
  sale_price_kobo INTEGER CHECK(sale_price_kobo IS NULL OR sale_price_kobo >= 0),
  cost_price_kobo INTEGER CHECK(cost_price_kobo IS NULL OR cost_price_kobo >= 0),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK(stock_quantity >= 0),
  reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK(reserved_quantity >= 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  change_amount INTEGER NOT NULL,
  previous_qty INTEGER NOT NULL,
  new_qty INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inv_movements_variant ON inventory_movements(variant_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  is_verified_purchase INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  admin_reply TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_questions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT,
  answered_by TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'answered', 'hidden')),
  created_at TEXT NOT NULL
);

-- ==========================================
-- ADDRESSES, DELIVERY ZONES, WISHLISTS, CARTS
-- ==========================================

CREATE TABLE IF NOT EXISTS addresses (
  address_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  state TEXT NOT NULL,
  lga TEXT NOT NULL,
  city TEXT NOT NULL,
  street_address TEXT NOT NULL,
  additional_instructions TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  lga TEXT NOT NULL DEFAULT '*',
  location_name TEXT NOT NULL DEFAULT '',
  fee_kobo INTEGER NOT NULL CHECK(fee_kobo >= 0),
  free_threshold_kobo INTEGER CHECK(free_threshold_kobo IS NULL OR free_threshold_kobo >= 0),
  estimated_days_min INTEGER NOT NULL DEFAULT 1,
  estimated_days_max INTEGER NOT NULL DEFAULT 3,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  courier_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(state, lga, location_name)
);

CREATE TABLE IF NOT EXISTS wishlists (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  guest_token TEXT UNIQUE,
  items_json TEXT NOT NULL DEFAULT '[]',
  coupon_code TEXT,
  updated_at TEXT NOT NULL
);

-- ==========================================
-- COUPONS & MARKETING
-- ==========================================

CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percentage', 'fixed')),
  discount_value INTEGER NOT NULL CHECK(discount_value > 0),
  min_spend_kobo INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_automatic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- ==========================================
-- ORDERS, ORDER ITEMS, STATUS HISTORY, PAYMENTS
-- ==========================================

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  customer_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  delivery_address_snapshot_json TEXT NOT NULL,
  delivery_zone_id TEXT REFERENCES delivery_zones(id) ON DELETE SET NULL,
  delivery_fee_kobo INTEGER NOT NULL CHECK(delivery_fee_kobo >= 0),
  subtotal_kobo INTEGER NOT NULL CHECK(subtotal_kobo >= 0),
  discount_kobo INTEGER NOT NULL DEFAULT 0 CHECK(discount_kobo >= 0),
  total_kobo INTEGER NOT NULL CHECK(total_kobo >= 0),
  coupon_code TEXT,
  order_status TEXT NOT NULL DEFAULT 'pending_payment',
  payment_status TEXT NOT NULL DEFAULT 'pending_payment',
  delivery_status TEXT NOT NULL DEFAULT 'awaiting_fulfilment',
  tracking_reference TEXT DEFAULT '',
  courier_name TEXT DEFAULT '',
  estimated_delivery_date TEXT,
  internal_notes TEXT DEFAULT '',
  delivery_notes TEXT DEFAULT '',
  cancellation_reason TEXT DEFAULT '',
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  needs_attention INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'web' CHECK(source IN ('web', 'pos', 'android')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status, payment_status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  unit_price_kobo INTEGER NOT NULL CHECK(unit_price_kobo >= 0),
  cost_price_kobo INTEGER,
  line_total_kobo INTEGER NOT NULL CHECK(line_total_kobo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  status_field TEXT NOT NULL CHECK(status_field IN ('order', 'payment', 'delivery')),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_history_order ON order_status_history(order_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  method TEXT NOT NULL DEFAULT 'bank_transfer',
  expected_amount_kobo INTEGER NOT NULL CHECK(expected_amount_kobo >= 0),
  status TEXT NOT NULL DEFAULT 'pending_payment',
  verified_by TEXT,
  verified_at TEXT,
  rejection_reason TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_evidence (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  reference_number TEXT NOT NULL,
  amount_submitted_kobo INTEGER NOT NULL CHECK(amount_submitted_kobo > 0),
  transfer_date TEXT NOT NULL,
  receipt_r2_key TEXT NOT NULL,
  receipt_mime_type TEXT NOT NULL,
  receipt_original_name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payment_evidence_order ON payment_evidence(order_id, created_at);

-- ==========================================
-- SUPPORT, EXPENSES, EMAIL QUEUE & AUDIT LOGS
-- ==========================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES user(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  order_number TEXT DEFAULT '',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_reply TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK(request_type IN ('export', 'deletion')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'rejected')),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_kobo INTEGER NOT NULL CHECK(amount_kobo >= 0),
  incurred_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_notification_events (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id TEXT,
  order_number TEXT,
  recipient_email TEXT NOT NULL,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('customer', 'admin', 'test')),
  notification_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'pending', 'accepted_by_provider', 'sent', 'delivered', 'bounced', 'failed')),
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_events_status ON email_notification_events(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_email_events_order ON email_notification_events(order_id);

CREATE TABLE IF NOT EXISTS email_delivery_attempts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES email_notification_events(event_id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  http_status INTEGER,
  error_message TEXT,
  attempted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
