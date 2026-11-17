import { Hono } from 'hono';
import { z } from 'zod';
import { randomUuid } from '../crypto';
import type { AppContext } from '../context';
import type { BatchStatement } from '../db';
import { checkPersistentRateLimit, getTrustedClientIp, writeAuditLog } from '../security';

export function createCustomerRoutes() {
  const app = new Hono<AppContext>();

  // Saved Nigerian Addresses
  app.get('/addresses', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const addresses = await db.all(
      `SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, updated_at DESC`,
      [user.id]
    );
    return c.json({ addresses });
  });

  app.post('/addresses', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      fullName: z.string().min(2).max(120),
      email: z.string().email(),
      phone: z.string().min(7).max(24),
      state: z.string().min(2).max(60),
      lga: z.string().min(2).max(80),
      city: z.string().min(2).max(80),
      streetAddress: z.string().min(4).max(240),
      additionalInstructions: z.string().max(300).optional(),
      isDefault: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid address' }, 400);
    }

    const db = c.get('db');
    const now = new Date().toISOString();
    const addressId = `addr_${randomUuid()}`;

    if (parsed.data.isDefault === true) {
      await db.batch([
        {
          sql: `UPDATE addresses SET is_default = 0 WHERE customer_id = ?`,
          params: [user.id],
        },
        {
          sql: `INSERT INTO addresses (
            address_id, customer_id, full_name, email, phone, state, lga, city,
            street_address, additional_instructions, is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          params: [
            addressId,
            user.id,
            parsed.data.fullName.trim(),
            parsed.data.email.trim().toLowerCase(),
            parsed.data.phone.trim(),
            parsed.data.state.trim(),
            parsed.data.lga.trim(),
            parsed.data.city.trim(),
            parsed.data.streetAddress.trim(),
            (parsed.data.additionalInstructions || '').trim(),
            now,
            now,
          ],
        },
      ]);
    } else {
      await db.run(
        `INSERT INTO addresses (
          address_id, customer_id, full_name, email, phone, state, lga, city,
          street_address, additional_instructions, is_default, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN NOT EXISTS (SELECT 1 FROM addresses WHERE customer_id = ? AND is_default = 1) THEN 1 ELSE 0 END,
          ?, ?
        )`,
        [
          addressId,
          user.id,
          parsed.data.fullName.trim(),
          parsed.data.email.trim().toLowerCase(),
          parsed.data.phone.trim(),
          parsed.data.state.trim(),
          parsed.data.lga.trim(),
          parsed.data.city.trim(),
          parsed.data.streetAddress.trim(),
          (parsed.data.additionalInstructions || '').trim(),
          user.id,
          now,
          now,
        ]
      );
    }

    return c.json({ ok: true, addressId }, 201);
  });

  app.patch('/addresses/:addressId', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const addressId = c.req.param('addressId');

    const existing = await db.get<{ address_id: string }>(
      `SELECT address_id FROM addresses WHERE address_id = ? AND customer_id = ?`,
      [addressId, user.id]
    );
    if (!existing) return c.json({ error: 'Address not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      fullName: z.string().min(2).max(120).optional(),
      email: z.string().email().optional(),
      phone: z.string().min(7).max(24).optional(),
      state: z.string().min(2).max(60).optional(),
      lga: z.string().min(2).max(80).optional(),
      city: z.string().min(2).max(80).optional(),
      streetAddress: z.string().min(4).max(240).optional(),
      additionalInstructions: z.string().max(300).optional(),
      isDefault: z.boolean().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid address update' }, 400);
    }

    const statements: BatchStatement[] = [];
    if (parsed.data.isDefault) {
      // Only clear previous default if the target address still exists for this customer
      statements.push({
        sql: `UPDATE addresses SET is_default = 0 WHERE customer_id = ? AND EXISTS (SELECT 1 FROM addresses WHERE address_id = ? AND customer_id = ?)`,
        params: [user.id, addressId, user.id],
      });
    }
    statements.push({
      sql: `UPDATE addresses SET
        full_name = COALESCE(?, full_name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        state = COALESCE(?, state),
        lga = COALESCE(?, lga),
        city = COALESCE(?, city),
        street_address = COALESCE(?, street_address),
        additional_instructions = COALESCE(?, additional_instructions),
        is_default = COALESCE(?, is_default),
        updated_at = ?
      WHERE address_id = ? AND customer_id = ?`,
      params: [
        parsed.data.fullName ?? null,
        parsed.data.email ?? null,
        parsed.data.phone ?? null,
        parsed.data.state ?? null,
        parsed.data.lga ?? null,
        parsed.data.city ?? null,
        parsed.data.streetAddress ?? null,
        parsed.data.additionalInstructions ?? null,
        parsed.data.isDefault !== undefined ? (parsed.data.isDefault ? 1 : 0) : null,
        new Date().toISOString(),
        addressId,
        user.id,
      ],
    });

    const results = await db.batch(statements);
    if (results[results.length - 1].changes === 0) {
      return c.json({ error: 'Address not found' }, 404);
    }

    return c.json({ ok: true });
  });

  app.delete('/addresses/:addressId', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const addressId = c.req.param('addressId');
    const res = await db.run(
      `DELETE FROM addresses WHERE address_id = ? AND customer_id = ?`,
      [addressId, user.id]
    );
    if (res.changes === 0) return c.json({ error: 'Address not found' }, 404);
    return c.json({ ok: true });
  });

  // Wishlist
  app.get('/wishlist', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ items: [] });
    const db = c.get('db');
    const items = await db.all<Record<string, unknown>>(
      `SELECT w.id as wishlist_id, w.product_id, w.variant_id, w.created_at,
              p.name, p.slug, p.price_kobo, p.sale_price_kobo, p.media_json, p.status
       FROM wishlists w
       JOIN products p ON p.id = w.product_id
       WHERE w.customer_id = ? AND p.status = 'active'
       ORDER BY w.created_at DESC`,
      [user.id]
    );
    return c.json({
      items: items.map((i) => ({ ...i, media: JSON.parse(String(i.media_json || '[]')) })),
    });
  });

  app.post('/wishlist', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Sign in to save items to your wishlist.' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const productId = String(body.productId || '');
    const variantId = body.variantId ? String(body.variantId) : null;
    if (!productId) return c.json({ error: 'productId is required' }, 400);

    const db = c.get('db');
    await db.run(
      `INSERT OR IGNORE INTO wishlists (id, customer_id, product_id, variant_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`wish_${randomUuid()}`, user.id, productId, variantId, new Date().toISOString()]
    );
    return c.json({ ok: true }, 201);
  });

  app.delete('/wishlist/:productId', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    await db.run(`DELETE FROM wishlists WHERE customer_id = ? AND product_id = ?`, [
      user.id,
      c.req.param('productId'),
    ]);
    return c.json({ ok: true });
  });

  // Persistent Cart
  app.get('/cart', async (c) => {
    const user = c.get('user');
    const guestToken = c.req.header('x-cart-token') || '';
    const db = c.get('db');

    let row: { items_json: string; coupon_code: string | null } | null = null;
    if (user) {
      row = await db.get(`SELECT items_json, coupon_code FROM carts WHERE user_id = ?`, [user.id]);
    } else if (guestToken) {
      row = await db.get(`SELECT items_json, coupon_code FROM carts WHERE guest_token = ?`, [guestToken]);
    }

    return c.json({
      items: row ? JSON.parse(row.items_json || '[]') : [],
      couponCode: row?.coupon_code || null,
    });
  });

  app.put('/cart', async (c) => {
    const user = c.get('user');
    const guestToken = c.req.header('x-cart-token') || '';
    if (!user && !guestToken) {
      return c.json({ error: 'Cart session token required' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      items: z.array(
        z.object({
          productId: z.string(),
          variantId: z.string(),
          quantity: z.number().int().min(1).max(99),
        })
      ),
      couponCode: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid cart payload' }, 400);

    const db = c.get('db');
    const now = new Date().toISOString();
    if (user) {
      const existing = await db.get<{ id: string }>(`SELECT id FROM carts WHERE user_id = ?`, [user.id]);
      if (existing) {
        await db.run(`UPDATE carts SET items_json = ?, coupon_code = ?, updated_at = ? WHERE id = ?`, [
          JSON.stringify(parsed.data.items),
          parsed.data.couponCode ?? null,
          now,
          existing.id,
        ]);
      } else {
        await db.run(
          `INSERT INTO carts (id, user_id, items_json, coupon_code, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [`cart_${randomUuid()}`, user.id, JSON.stringify(parsed.data.items), parsed.data.couponCode ?? null, now]
        );
      }
    } else {
      const existing = await db.get<{ id: string }>(`SELECT id FROM carts WHERE guest_token = ?`, [guestToken]);
      if (existing) {
        await db.run(`UPDATE carts SET items_json = ?, coupon_code = ?, updated_at = ? WHERE id = ?`, [
          JSON.stringify(parsed.data.items),
          parsed.data.couponCode ?? null,
          now,
          existing.id,
        ]);
      } else {
        await db.run(
          `INSERT INTO carts (id, guest_token, items_json, coupon_code, updated_at) VALUES (?, ?, ?, ?, ?)`,
          [`cart_${randomUuid()}`, guestToken, JSON.stringify(parsed.data.items), parsed.data.couponCode ?? null, now]
        );
      }
    }
    return c.json({ ok: true });
  });

  // Support Tickets
  app.get('/support', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ tickets: [] });
    const db = c.get('db');
    const tickets = await db.all(
      `SELECT * FROM support_tickets WHERE customer_id = ? ORDER BY created_at DESC`,
      [user.id]
    );
    return c.json({ tickets });
  });

  app.post('/support', async (c) => {
    const user = c.get('user');
    const db = c.get('db');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `support:${user?.id || ip}`, 10, 60_000);
    if (!rl.allowed) {
      return c.json({ error: 'Too many support requests. Please wait a moment.' }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      customerName: z.string().min(2).max(120).optional(),
      customerEmail: z.string().email().optional(),
      orderNumber: z.string().max(40).optional(),
      subject: z.string().min(3).max(160),
      message: z.string().min(10).max(4000),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid support request' }, 400);
    }

    const name = user?.name || parsed.data.customerName;
    const email = user?.email || parsed.data.customerEmail;
    if (!name || !email) return c.json({ error: 'Name and email are required.' }, 400);

    const now = new Date().toISOString();
    const id = `tkt_${randomUuid()}`;
    await db.run(
      `INSERT INTO support_tickets (id, customer_id, customer_name, customer_email, order_number, subject, message, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      [
        id,
        user?.id ?? null,
        name.trim(),
        email.trim().toLowerCase(),
        (parsed.data.orderNumber || '').trim(),
        parsed.data.subject.trim(),
        parsed.data.message.trim(),
        now,
        now,
      ]
    );
    return c.json({ ok: true, id }, 201);
  });

  // Privacy Export & Deletion Request
  app.get('/me/export', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const profile = await db.get(
      `SELECT id, name, email, phone, role, createdAt, updatedAt FROM user WHERE id = ?`,
      [user.id]
    );
    const addresses = await db.all(`SELECT * FROM addresses WHERE customer_id = ?`, [user.id]);
    const orders = await db.all(
      `SELECT order_id, order_number, total_kobo, order_status, payment_status, delivery_status, created_at FROM orders WHERE customer_id = ?`,
      [user.id]
    );
    return c.json({ exportedAt: new Date().toISOString(), profile, addresses, orders });
  });

  app.post('/me/privacy-request', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      requestType: z.enum(['export', 'deletion']),
      notes: z.string().max(500).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid privacy request' }, 400);

    const db = c.get('db');
    const now = new Date().toISOString();
    const id = `prv_${randomUuid()}`;
    await db.run(
      `INSERT INTO privacy_requests (id, customer_id, request_type, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [id, user.id, parsed.data.requestType, parsed.data.notes || '', now, now]
    );
    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: `PRIVACY_REQUEST_${parsed.data.requestType.toUpperCase()}`,
      targetType: 'user',
      targetId: user.id,
    });
    return c.json({ ok: true, id }, 201);
  });

  return app;
}
