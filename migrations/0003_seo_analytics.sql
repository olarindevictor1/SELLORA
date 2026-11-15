-- SELLORA Additive Migration 0003: Product/Category SEO Metadata & First-Party Privacy-Safe Analytics

ALTER TABLE products ADD COLUMN seo_canonical_url TEXT;
ALTER TABLE products ADD COLUMN seo_image_url TEXT;
ALTER TABLE products ADD COLUMN image_alt TEXT;

ALTER TABLE categories ADD COLUMN seo_title TEXT;
ALTER TABLE categories ADD COLUMN seo_description TEXT;

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK(event_name IN ('page_view', 'view_item', 'add_to_cart', 'begin_checkout')),
  path TEXT NOT NULL DEFAULT '/',
  referrer_source TEXT NOT NULL DEFAULT 'direct',
  device_category TEXT NOT NULL DEFAULT 'desktop',
  product_id TEXT,
  value_kobo INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at, event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session ON analytics_events(session_key, created_at);
