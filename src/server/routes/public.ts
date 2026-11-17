import { Hono } from 'hono';
import { z } from 'zod';
import { randomUuid } from '../crypto';
import type { AppContext } from '../context';
import {
  checkPersistentRateLimit,
  getTrustedClientIp,
  isTurnstileConfigured,
} from '../security';
import { getEffectiveSeoConfig } from '../seo';
import { NIGERIAN_STATES_LGAS } from '../../shared/nigeria-locations';

export function createPublicRoutes() {
  const app = new Hono<AppContext>();

  app.get('/health', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    try {
      await db.get('SELECT 1 as ok');
      const hasStorage = Boolean(storage && typeof storage.get === 'function');
      return c.json(
        {
          ok: hasStorage,
          service: 'sellora-api',
          timezone: 'Africa/Lagos',
          currency: 'NGN',
          timestamp: new Date().toISOString(),
        },
        hasStorage ? 200 : 503
      );
    } catch {
      return c.json({ ok: false, error: 'Database unavailable' }, 503);
    }
  });

  app.get('/me', async (c) => {
    const user = c.get('user');
    const env = c.get('env');
    const turnstileEnabled = isTurnstileConfigured(env);
    const trimmedGa = (env.gaMeasurementId || '').trim();
    const gaValid = /^G-[A-Z0-9]{4,}$/i.test(trimmedGa) && !/^G-X+$/i.test(trimmedGa);
    return c.json({
      user,
      capabilities: {
        googleOAuthEnabled: Boolean(env.googleClientId && env.googleClientSecret),
        turnstileEnabled,
        turnstileSiteKey: turnstileEnabled ? env.turnstileSiteKey?.trim() || null : null,
        gaConfigured: gaValid,
        searchConsoleConfigured: Boolean(env.googleSiteVerification && env.googleSiteVerification.trim()),
      },
    });
  });

  app.patch('/me/profile', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      name: z.string().min(2).max(100),
      phone: z.string().max(24).optional().nullable(),
      notifyOrderUpdates: z.boolean().optional(),
      notifyPromotions: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid profile data' }, 400);
    }

    const db = c.get('db');
    await db.run(
      `UPDATE user SET name = ?, phone = ?, notifyOrderUpdates = ?, notifyPromotions = ?, updatedAt = ? WHERE id = ?`,
      [
        parsed.data.name.trim(),
        parsed.data.phone ?? user.phone,
        parsed.data.notifyOrderUpdates !== undefined ? (parsed.data.notifyOrderUpdates ? 1 : 0) : user.notifyOrderUpdates ? 1 : 0,
        parsed.data.notifyPromotions !== undefined ? (parsed.data.notifyPromotions ? 1 : 0) : user.notifyPromotions ? 1 : 0,
        new Date().toISOString(),
        user.id,
      ]
    );
    return c.json({ ok: true });
  });

  app.get('/storefront/config', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const themeRow = await db.get<{ value_json: string }>(
      `SELECT value_json FROM store_settings WHERE key = 'theme'`
    );
    const bankRow = await db.get<{ value_json: string }>(
      `SELECT value_json FROM store_settings WHERE key = 'bank_transfer'`
    );
    const seo = await getEffectiveSeoConfig(db, env);
    const categories = await db.all(
      `SELECT id, name, slug, description, image_url, sort_order, seo_title, seo_description FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name ASC`
    );
    const collections = await db.all(
      `SELECT id, name, slug, description, banner_url, is_featured FROM collections WHERE is_active = 1 ORDER BY is_featured DESC, name ASC`
    );

    const theme = themeRow?.value_json ? JSON.parse(themeRow.value_json) : {};
    const bank = bankRow?.value_json ? JSON.parse(bankRow.value_json) : { configured: false };

    return c.json({
      theme,
      seo,
      bankTransfer: {
        configured: Boolean(bank.bankName && bank.accountName && bank.accountNumber),
        bankName: bank.bankName || '',
        accountName: bank.accountName || '',
        accountNumber: bank.accountNumber || '',
        paymentInstructions: bank.paymentInstructions || '',
        referenceInstructions: bank.referenceInstructions || '',
      },
      categories,
      collections,
      nigeriaStates: NIGERIAN_STATES_LGAS,
    });
  });

  app.post('/analytics/collect', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `analytics:${ip}`, 120, 60_000);
    if (!rl.allowed) return c.json({ ok: false }, 429);

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      sessionKey: z.string().min(4).max(80),
      eventName: z.enum(['page_view', 'view_item', 'add_to_cart', 'begin_checkout']),
      path: z.string().max(240).default('/'),
      referrer: z.string().max(300).optional(),
      productId: z.string().max(120).optional(),
      valueKobo: z.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false }, 400);

    // Strip any query string to avoid leaking customer parameters or order/email data
    const cleanPath = parsed.data.path.split('?')[0].slice(0, 200) || '/';
    const ua = (c.req.header('user-agent') || '').toLowerCase();
    const deviceCategory = /ipad|tablet/.test(ua)
      ? 'tablet'
      : /mobi|android|iphone/.test(ua)
        ? 'mobile'
        : 'desktop';

    let referrerSource = 'direct';
    if (parsed.data.referrer) {
      try {
        const refHost = new URL(parsed.data.referrer).hostname.toLowerCase();
        if (/google\.|bing\.|yahoo\.|duckduckgo\./.test(refHost)) referrerSource = 'search';
        else if (/facebook\.|instagram\.|t\.co|twitter\.|x\.com|linkedin\.|tiktok\./.test(refHost))
          referrerSource = 'social';
        else if (refHost) referrerSource = refHost;
      } catch {
        referrerSource = 'direct';
      }
    }

    await db
      .run(
        `INSERT INTO analytics_events (id, session_key, event_name, path, referrer_source, device_category, product_id, value_kobo, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
        [
          `ana_${randomUuid()}`,
          parsed.data.sessionKey.slice(0, 80),
          parsed.data.eventName,
          cleanPath,
          referrerSource,
          deviceCategory,
          parsed.data.productId || null,
          parsed.data.valueKobo ?? null,
          new Date().toISOString(),
        ]
      )
      .catch(() => {});

    return c.json({ ok: true });
  });

  app.get('/products', async (c) => {
    const db = c.get('db');
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const category = c.req.query('category') || '';
    const collection = c.req.query('collection') || '';
    const inStock = c.req.query('inStock') === 'true';
    const minPrice = c.req.query('minPrice') ? Number(c.req.query('minPrice')) : null;
    const maxPrice = c.req.query('maxPrice') ? Number(c.req.query('maxPrice')) : null;
    const sort = c.req.query('sort') || 'featured';

    let sql = `
      SELECT p.*, c.name as category_name, c.slug as category_slug, col.name as collection_name, col.slug as collection_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN collections col ON col.id = p.collection_id
      WHERE p.status = 'active'
    `;
    const params: unknown[] = [];

    if (q) {
      sql += ` AND (LOWER(p.name) LIKE ? OR LOWER(p.short_description) LIKE ? OR LOWER(p.sku) LIKE ? OR LOWER(p.brand) LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (category) {
      sql += ` AND (c.slug = ? OR p.category_id = ?)`;
      params.push(category, category);
    }
    if (collection) {
      sql += ` AND (col.slug = ? OR p.collection_id = ?)`;
      params.push(collection, collection);
    }
    if (minPrice !== null && !Number.isNaN(minPrice)) {
      sql += ` AND COALESCE(p.sale_price_kobo, p.price_kobo) >= ?`;
      params.push(minPrice);
    }
    if (maxPrice !== null && !Number.isNaN(maxPrice)) {
      sql += ` AND COALESCE(p.sale_price_kobo, p.price_kobo) <= ?`;
      params.push(maxPrice);
    }

    if (sort === 'price_asc') {
      sql += ` ORDER BY COALESCE(p.sale_price_kobo, p.price_kobo) ASC`;
    } else if (sort === 'price_desc') {
      sql += ` ORDER BY COALESCE(p.sale_price_kobo, p.price_kobo) DESC`;
    } else if (sort === 'newest') {
      sql += ` ORDER BY p.created_at DESC`;
    } else {
      sql += ` ORDER BY p.is_featured DESC, p.created_at DESC`;
    }

    const products = await db.all<Record<string, unknown>>(sql, params);
    const variants = await db.all<Record<string, unknown>>(
      `SELECT * FROM product_variants WHERE is_active = 1 ORDER BY created_at ASC`
    );
    const reviewAgg = await db.all<{ product_id: string; avg_rating: number; review_count: number }>(
      `SELECT product_id, AVG(rating) as avg_rating, COUNT(*) as review_count
       FROM reviews WHERE status = 'approved' GROUP BY product_id`
    );

    const varByProd = new Map<string, Record<string, unknown>[]>();
    for (const v of variants) {
      const pid = String(v.product_id);
      if (!varByProd.has(pid)) varByProd.set(pid, []);
      varByProd.get(pid)!.push({
        ...v,
        attributes: JSON.parse(String(v.attributes_json || '{}')),
      });
    }
    const revMap = new Map(reviewAgg.map((r) => [r.product_id, r]));

    const enriched = products
      .map((p) => {
        const pid = String(p.id);
        const pVars = varByProd.get(pid) || [];
        const totalStock = pVars.reduce((acc, v) => acc + Number(v.stock_quantity || 0), 0);
        const rev = revMap.get(pid);
        return {
          ...p,
          trackInventory: Boolean(p.track_inventory),
          media: JSON.parse(String(p.media_json || '[]')),
          specifications: JSON.parse(String(p.specifications_json || '[]')),
          variants: pVars,
          totalStock,
          averageRating: rev ? Number(rev.avg_rating.toFixed(1)) : null,
          reviewCount: rev ? Number(rev.review_count) : 0,
        };
      })
      .filter((p) => (!inStock ? true : p.totalStock > 0 || !p.trackInventory));

    return c.json({ products: enriched });
  });

  app.get('/products/:slugOrId', async (c) => {
    const db = c.get('db');
    const slugOrId = c.req.param('slugOrId');
    const product = await db.get<Record<string, unknown>>(
      `SELECT p.*, c.name as category_name, c.slug as category_slug, col.name as collection_name, col.slug as collection_slug
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN collections col ON col.id = p.collection_id
       WHERE (p.slug = ? OR p.id = ?) AND p.status = 'active'`,
      [slugOrId, slugOrId]
    );
    if (!product) return c.json({ error: 'Product not found' }, 404);

    const pid = String(product.id);
    const variants = await db.all<Record<string, unknown>>(
      `SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY created_at ASC`,
      [pid]
    );
    const reviews = await db.all(
      `SELECT id, customer_name, rating, title, body, is_verified_purchase, admin_reply, created_at
       FROM reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC`,
      [pid]
    );
    const questions = await db.all(
      `SELECT id, customer_name, question, answer, created_at
       FROM product_questions WHERE product_id = ? AND status = 'answered' ORDER BY created_at DESC`,
      [pid]
    );
    const related = await db.all<Record<string, unknown>>(
      `SELECT id, name, slug, price_kobo, sale_price_kobo, media_json
       FROM products WHERE status = 'active' AND id != ? AND (category_id = ? OR collection_id = ?) LIMIT 3`,
      [pid, product.category_id, product.collection_id]
    );

    const totalStock = variants.reduce((acc, v) => acc + Number(v.stock_quantity || 0), 0);

    return c.json({
      product: {
        ...product,
        media: JSON.parse(String(product.media_json || '[]')),
        specifications: JSON.parse(String(product.specifications_json || '[]')),
        variants: variants.map((v) => ({
          ...v,
          attributes: JSON.parse(String(v.attributes_json || '{}')),
        })),
        totalStock,
      },
      reviews,
      questions,
      related: related.map((r) => ({
        ...r,
        media: JSON.parse(String(r.media_json || '[]')),
      })),
    });
  });

  app.post('/products/:productId/reviews', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Please sign in to submit a product review.' }, 401);

    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `review:${user.id}:${ip}`, 10, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many review submissions. Please wait a moment.' }, 429);

    const productId = c.req.param('productId');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      rating: z.number().int().min(1).max(5),
      title: z.string().max(120).optional(),
      body: z.string().min(5).max(2000),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid review' }, 400);
    }

    const verifiedRow = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM orders o
       JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.customer_id = ? AND oi.product_id = ? AND o.payment_status = 'payment_confirmed'`,
      [user.id, productId]
    );

    const id = `rev_${randomUuid()}`;
    await db.run(
      `INSERT INTO reviews (id, product_id, customer_id, customer_name, rating, title, body, is_verified_purchase, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        productId,
        user.id,
        user.name,
        parsed.data.rating,
        parsed.data.title || '',
        parsed.data.body.trim(),
        (verifiedRow?.cnt ?? 0) > 0 ? 1 : 0,
        new Date().toISOString(),
      ]
    );

    return c.json({ ok: true, id, status: 'pending' }, 201);
  });

  app.post('/products/:productId/questions', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `question:${ip}`, 10, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many questions submitted. Please wait a moment.' }, 429);
    const productId = c.req.param('productId');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      customerName: z.string().min(2).max(80).optional(),
      question: z.string().min(5).max(600),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid question' }, 400);
    }

    const name = user?.name || parsed.data.customerName?.trim();
    if (!name) return c.json({ error: 'Name is required' }, 400);

    const id = `qna_${randomUuid()}`;
    await db.run(
      `INSERT INTO product_questions (id, product_id, customer_id, customer_name, question, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [id, productId, user?.id ?? null, name, parsed.data.question.trim(), new Date().toISOString()]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.get('/delivery/zones', async (c) => {
    const db = c.get('db');
    const zones = await db.all(
      `SELECT id, state, lga, location_name, fee_kobo, free_threshold_kobo, estimated_days_min, estimated_days_max, instructions, courier_name
       FROM delivery_zones WHERE is_enabled = 1 ORDER BY state ASC, lga ASC`
    );
    return c.json({ zones });
  });

  app.post('/delivery/quote', async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      state: z.string().min(1),
      lga: z.string().min(1),
      subtotalKobo: z.number().int().min(0),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ available: false, error: 'State and LGA are required' }, 400);
    }

    const state = parsed.data.state.trim();
    const lga = parsed.data.lga.trim();

    // Exact State + LGA match first, then State wildcard '*'
    const exactZone = await db.get<Record<string, unknown>>(
      `SELECT * FROM delivery_zones WHERE LOWER(state) = LOWER(?) AND LOWER(lga) = LOWER(?) AND is_enabled = 1 LIMIT 1`,
      [state, lga]
    );
    const stateZone =
      exactZone ||
      (await db.get<Record<string, unknown>>(
        `SELECT * FROM delivery_zones WHERE LOWER(state) = LOWER(?) AND lga = '*' AND is_enabled = 1 LIMIT 1`,
        [state]
      ));

    if (!stateZone) {
      return c.json({
        available: false,
        reason: `Delivery is currently unavailable for ${lga}, ${state}. No delivery zone is enabled for this location.`,
      });
    }

    const baseFee = Number(stateZone.fee_kobo);
    const freeThreshold =
      stateZone.free_threshold_kobo !== null && stateZone.free_threshold_kobo !== undefined
        ? Number(stateZone.free_threshold_kobo)
        : null;
    const isFree = freeThreshold !== null && parsed.data.subtotalKobo >= freeThreshold;

    return c.json({
      available: true,
      zoneId: stateZone.id,
      feeKobo: isFree ? 0 : baseFee,
      originalFeeKobo: baseFee,
      freeDeliveryApplied: isFree,
      freeThresholdKobo: freeThreshold,
      estimatedDaysMin: Number(stateZone.estimated_days_min),
      estimatedDaysMax: Number(stateZone.estimated_days_max),
      instructions: stateZone.instructions || '',
      courierName: stateZone.courier_name || '',
    });
  });

  app.post('/coupons/validate', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `coupon:${ip}`, 20, 60_000);
    if (!rl.allowed) return c.json({ valid: false, error: 'Too many code attempts. Please wait a moment.' }, 429);
    const body = await c.req.json().catch(() => ({}));
    const code = String(body.code || '').trim().toUpperCase();
    const subtotalKobo = Number(body.subtotalKobo || 0);
    if (!code) return c.json({ valid: false, error: 'Enter a discount code.' }, 400);

    const coupon = await db.get<Record<string, unknown>>(
      `SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1`,
      [code]
    );
    if (!coupon) return c.json({ valid: false, error: 'Discount code is invalid or inactive.' }, 404);

    const now = new Date().toISOString();
    if (coupon.starts_at && String(coupon.starts_at) > now) {
      return c.json({ valid: false, error: 'This promotion has not started yet.' }, 400);
    }
    if (coupon.expires_at && String(coupon.expires_at) < now) {
      return c.json({ valid: false, error: 'This discount code has expired.' }, 400);
    }
    if (coupon.max_uses !== null && Number(coupon.used_count) >= Number(coupon.max_uses)) {
      return c.json({ valid: false, error: 'This discount code has reached its usage limit.' }, 400);
    }
    if (subtotalKobo < Number(coupon.min_spend_kobo || 0)) {
      return c.json(
        {
          valid: false,
          error: `Minimum spend of ₦${(Number(coupon.min_spend_kobo) / 100).toLocaleString()} required.`,
        },
        400
      );
    }

    const discountKobo =
      coupon.discount_type === 'percentage'
        ? Math.floor((subtotalKobo * Number(coupon.discount_value)) / 100)
        : Math.min(subtotalKobo, Number(coupon.discount_value));

    return c.json({
      valid: true,
      code: coupon.code,
      discountType: coupon.discount_type,
      discountValue: Number(coupon.discount_value),
      discountKobo,
    });
  });

  app.post('/newsletter', async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `newsletter:${ip}`, 10, 60_000);
    if (!rl.allowed) return c.json({ error: 'Too many requests' }, 429);

    const body = await c.req.json().catch(() => ({}));
    const parsed = z.object({ email: z.string().email() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'Enter a valid email address.' }, 400);

    await db.run(
      `INSERT OR IGNORE INTO newsletter_subscribers (id, email, created_at) VALUES (?, ?, ?)`,
      [`sub_${randomUuid()}`, parsed.data.email.trim().toLowerCase(), new Date().toISOString()]
    );
    return c.json({ ok: true });
  });

  return app;
}
