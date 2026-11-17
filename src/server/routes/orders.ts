import { Hono } from 'hono';
import { z } from 'zod';
import { randomHex, randomUuid } from '../crypto';
import type { AppContext } from '../context';
import {
  extractDbGuardCode,
  isUniqueConstraintError,
  type BatchStatement,
} from '../db';
import { triggerOrderNotifications } from '../email';
import { respondWithCapturedError } from '../error-monitor';
import {
  checkPersistentRateLimit,
  getTrustedClientIp,
  sanitizeUploadFilename,
  validateUploadedFileBytes,
  verifyTurnstileToken,
  writeAuditLog,
} from '../security';
import { normalizeNgPhone } from '../../shared/nigeria-locations';
import { formatNgn } from '../../shared/types';

function generateOrderNumber(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = randomHex(3).toUpperCase();
  return `SLR-${y}${m}${d}-${rand}`;
}

export function createOrderRoutes() {
  const app = new Hono<AppContext>();

  app.post('/checkout', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);

    const rl = await checkPersistentRateLimit(db, `checkout:${ip}`, 15, 60_000);
    if (!rl.allowed) {
      return c.json({ error: 'Too many checkout attempts. Please wait a moment.' }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      items: z
        .array(
          z.object({
            productId: z.string().min(1),
            variantId: z.string().min(1),
            quantity: z.number().int().min(1).max(50),
          })
        )
        .min(1),
      address: z.object({
        fullName: z.string().min(2).max(120),
        email: z.string().email(),
        phone: z.string().min(7).max(24),
        state: z.string().min(2).max(60),
        lga: z.string().min(2).max(80),
        city: z.string().min(2).max(80),
        streetAddress: z.string().min(4).max(240),
        additionalInstructions: z.string().max(300).optional(),
      }),
      couponCode: z.string().max(40).optional().nullable(),
      idempotencyKey: z.string().min(8).max(120).optional(),
      turnstileToken: z.string().optional(),
      source: z.enum(['web', 'android']).optional(),
    });

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid checkout input' }, 400);
    }

    const turnstileCheck = await verifyTurnstileToken({
      token: parsed.data.turnstileToken,
      secretKey: env.turnstileSecretKey,
      siteKey: env.turnstileSiteKey,
      remoteIp: ip,
      db,
    });
    if (!turnstileCheck.ok) {
      return c.json({ error: turnstileCheck.error }, 400);
    }

    const idempotencyKey = parsed.data.idempotencyKey || `chk_${randomUuid()}`;
    const existingOrder = await db.get<Record<string, unknown>>(
      `SELECT order_id, order_number, total_kobo FROM orders WHERE idempotency_key = ?`,
      [idempotencyKey]
    );
    if (existingOrder) {
      return c.json({
        ok: true,
        duplicate: true,
        orderId: existingOrder.order_id,
        orderNumber: existingOrder.order_number,
        totalKobo: existingOrder.total_kobo,
      });
    }

    const addr = parsed.data.address;
    const customerEmail = (user?.email || addr.email).trim().toLowerCase();

    try {
      // Aggregate duplicate (productId, variantId) lines so stock deduction and order items align cleanly
      const mergedReqItems: Array<{ productId: string; variantId: string; quantity: number }> = [];
      const itemIndexMap = new Map<string, number>();
      for (const reqItem of parsed.data.items) {
        const key = `${reqItem.productId}::${reqItem.variantId}`;
        const existingIdx = itemIndexMap.get(key);
        if (existingIdx !== undefined) {
          const nextQty = mergedReqItems[existingIdx].quantity + reqItem.quantity;
          if (nextQty > 50) {
            return c.json({ error: 'Maximum quantity per line item is 50.' }, 400);
          }
          mergedReqItems[existingIdx].quantity = nextQty;
        } else {
          itemIndexMap.set(key, mergedReqItems.length);
          mergedReqItems.push({ ...reqItem });
        }
      }

      let subtotalKobo = 0;
      const resolvedItems: Array<{
        orderItemId: string;
        productId: string;
        variantId: string;
        productName: string;
        variantName: string;
        sku: string;
        quantity: number;
        unitPriceKobo: number;
        costPriceKobo: number | null;
        lineTotalKobo: number;
        trackInventory: number;
        prevStock: number;
      }> = [];

      for (const reqItem of mergedReqItems) {
        const prod = await db.get<Record<string, unknown>>(
          `SELECT * FROM products WHERE id = ? AND status = 'active'`,
          [reqItem.productId]
        );
        if (!prod) {
          return c.json({ error: `Product ${reqItem.productId} is unavailable.` }, 400);
        }
        const variant = await db.get<Record<string, unknown>>(
          `SELECT * FROM product_variants WHERE id = ? AND product_id = ? AND is_active = 1`,
          [reqItem.variantId, reqItem.productId]
        );
        if (!variant) {
          return c.json({ error: `Selected variant for ${prod.name} is unavailable.` }, 400);
        }

        const trackInventory = Number(prod.track_inventory) === 1 ? 1 : 0;
        const prevStock = Number(variant.stock_quantity || 0);
        if (trackInventory && prevStock < reqItem.quantity) {
          return c.json(
            { error: `Insufficient stock for ${prod.name} (${variant.name}). Only ${prevStock} available.` },
            400
          );
        }

        const unitPriceKobo = Number(
          variant.sale_price_kobo ?? variant.price_kobo ?? prod.sale_price_kobo ?? prod.price_kobo
        );
        const costPriceKobo =
          variant.cost_price_kobo !== null && variant.cost_price_kobo !== undefined
            ? Number(variant.cost_price_kobo)
            : prod.cost_price_kobo !== null && prod.cost_price_kobo !== undefined
              ? Number(prod.cost_price_kobo)
              : null;
        const lineTotalKobo = unitPriceKobo * reqItem.quantity;
        subtotalKobo += lineTotalKobo;

        resolvedItems.push({
          orderItemId: `oi_${randomUuid()}`,
          productId: String(prod.id),
          variantId: String(variant.id),
          productName: String(prod.name),
          variantName: String(variant.name),
          sku: String(variant.sku),
          quantity: reqItem.quantity,
          unitPriceKobo,
          costPriceKobo,
          lineTotalKobo,
          trackInventory,
          prevStock,
        });
      }

      // Validate delivery zone from DB rules (never invent fees)
      const exactZone = await db.get<Record<string, unknown>>(
        `SELECT * FROM delivery_zones WHERE LOWER(state) = LOWER(?) AND LOWER(lga) = LOWER(?) AND is_enabled = 1 LIMIT 1`,
        [addr.state.trim(), addr.lga.trim()]
      );
      const stateZone =
        exactZone ||
        (await db.get<Record<string, unknown>>(
          `SELECT * FROM delivery_zones WHERE LOWER(state) = LOWER(?) AND lga = '*' AND is_enabled = 1 LIMIT 1`,
          [addr.state.trim()]
        ));

      if (!stateZone) {
        return c.json(
          {
            error: `Delivery is currently unavailable for ${addr.lga}, ${addr.state}. Choose an enabled delivery location.`,
          },
          400
        );
      }

      // Pre-validate coupon server-side if provided (re-enforced atomically inside db.batch triggers)
      let discountKobo = 0;
      let appliedCoupon: string | null = null;
      let appliedCouponId: string | null = null;
      if (parsed.data.couponCode && parsed.data.couponCode.trim()) {
        const code = parsed.data.couponCode.trim().toUpperCase();
        const coupon = await db.get<Record<string, unknown>>(
          `SELECT * FROM coupons WHERE UPPER(code) = ? AND is_active = 1`,
          [code]
        );
        if (!coupon) return c.json({ error: 'Invalid or inactive discount code.' }, 400);
        const nowIso = new Date().toISOString();
        if (coupon.starts_at && String(coupon.starts_at) > nowIso) {
          return c.json({ error: 'This discount code is not active yet.' }, 400);
        }
        if (coupon.expires_at && String(coupon.expires_at) < nowIso) {
          return c.json({ error: 'This discount code has expired.' }, 400);
        }
        if (coupon.max_uses !== null && Number(coupon.used_count) >= Number(coupon.max_uses)) {
          return c.json({ error: 'This discount code has reached its usage limit.' }, 400);
        }
        if (subtotalKobo < Number(coupon.min_spend_kobo || 0)) {
          return c.json(
            { error: 'Order does not meet the minimum spend for this discount code.' },
            400
          );
        }

        discountKobo =
          coupon.discount_type === 'percentage'
            ? Math.floor((subtotalKobo * Number(coupon.discount_value)) / 100)
            : Math.min(subtotalKobo, Number(coupon.discount_value));
        appliedCoupon = String(coupon.code);
        appliedCouponId = String(coupon.id);
      }

      const discountedSubtotal = Math.max(0, subtotalKobo - discountKobo);
      const freeThreshold =
        stateZone.free_threshold_kobo !== null && stateZone.free_threshold_kobo !== undefined
          ? Number(stateZone.free_threshold_kobo)
          : null;
      const deliveryFeeKobo =
        freeThreshold !== null && discountedSubtotal >= freeThreshold
          ? 0
          : Number(stateZone.fee_kobo);

      const totalKobo = discountedSubtotal + deliveryFeeKobo;
      const orderId = `ord_${randomUuid()}`;
      const orderNumber = generateOrderNumber();
      const now = new Date().toISOString();

      const maxDays = Number(stateZone.estimated_days_max || 3);
      const estDate = new Date(Date.now() + maxDays * 86_400_000).toISOString().slice(0, 10);

      const addressSnapshot = {
        fullName: addr.fullName.trim(),
        email: customerEmail,
        phone: normalizeNgPhone(addr.phone.trim()),
        state: addr.state.trim(),
        lga: addr.lga.trim(),
        city: addr.city.trim(),
        streetAddress: addr.streetAddress.trim(),
        additionalInstructions: (addr.additionalInstructions || '').trim(),
      };

      const statements: BatchStatement[] = [];

      // 1. Atomic stock movements & deductions (DB triggers + CHECK + NOT NULL abort entire batch on failure)
      for (const item of resolvedItems) {
        if (item.trackInventory) {
          statements.push({
            sql: `INSERT INTO inventory_movements (
              id, product_id, variant_id, change_amount, previous_qty, new_qty,
              reason, reference_type, reference_id, actor_id, created_at
            ) VALUES (
              ?, ?, ?, ?,
              (SELECT pv.stock_quantity FROM product_variants pv JOIN products p ON p.id = pv.product_id
               WHERE pv.id = ? AND pv.product_id = ? AND pv.is_active = 1 AND p.status = 'active'),
              (SELECT pv.stock_quantity - ? FROM product_variants pv JOIN products p ON p.id = pv.product_id
               WHERE pv.id = ? AND pv.product_id = ? AND pv.is_active = 1 AND p.status = 'active'),
              'Order Placed', 'order', ?, ?, ?
            )`,
            params: [
              `mov_${randomUuid()}`,
              item.productId,
              item.variantId,
              -item.quantity,
              item.variantId,
              item.productId,
              item.quantity,
              item.variantId,
              item.productId,
              orderId,
              user?.id ?? null,
              now,
            ],
          });
          statements.push({
            sql: `UPDATE product_variants
                  SET stock_quantity = stock_quantity - ?
                  WHERE id = ? AND is_active = 1`,
            params: [item.quantity, item.variantId],
          });
        }
      }

      // 2. Atomic coupon increment (trg_coupons_validate_usage aborts batch on inactive/start/expiry/max_uses)
      if (appliedCouponId) {
        statements.push({
          sql: `UPDATE coupons SET used_count = used_count + 1 WHERE id = ?`,
          params: [appliedCouponId],
        });
      }

      // 3. Order creation (trg_orders_validate_checkout aborts batch if delivery zone/coupon disappeared)
      statements.push({
        sql: `INSERT INTO orders (
          order_id, order_number, customer_id, customer_name, customer_email, customer_phone,
          delivery_address_snapshot_json, delivery_zone_id, delivery_fee_kobo, subtotal_kobo,
          discount_kobo, total_kobo, coupon_code, order_status, payment_status, delivery_status,
          courier_name, estimated_delivery_date, needs_attention, source, idempotency_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', 'pending_payment', 'awaiting_fulfilment', ?, ?, 1, ?, ?, ?, ?)`,
        params: [
          orderId,
          orderNumber,
          user?.id ?? null,
          addressSnapshot.fullName,
          customerEmail,
          addressSnapshot.phone,
          JSON.stringify(addressSnapshot),
          String(stateZone.id),
          deliveryFeeKobo,
          subtotalKobo,
          discountKobo,
          totalKobo,
          appliedCoupon,
          String(stateZone.courier_name || ''),
          estDate,
          parsed.data.source || 'web',
          idempotencyKey,
          now,
          now,
        ],
      });

      // 4. Order items (trg_order_items_validate_variant aborts batch if product/variant disappeared/deactivated)
      for (const item of resolvedItems) {
        statements.push({
          sql: `INSERT INTO order_items (
            order_item_id, order_id, product_id, variant_id, product_name, variant_name,
            sku, quantity, unit_price_kobo, cost_price_kobo, line_total_kobo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            item.orderItemId,
            orderId,
            item.productId,
            item.variantId,
            item.productName,
            item.variantName,
            item.sku,
            item.quantity,
            item.unitPriceKobo,
            item.costPriceKobo,
            item.lineTotalKobo,
          ],
        });
      }

      // 5. Payment record, initial status history, and cart clear
      statements.push({
        sql: `INSERT INTO payments (id, order_id, method, expected_amount_kobo, status, created_at, updated_at)
              VALUES (?, ?, 'bank_transfer', ?, 'pending_payment', ?, ?)`,
        params: [`pay_${randomUuid()}`, orderId, totalKobo, now, now],
      });

      statements.push({
        sql: `INSERT INTO order_status_history (
          id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at
        ) VALUES (?, ?, 'order', NULL, 'pending_payment', ?, ?, 'Order placed via storefront checkout. Awaiting manual bank transfer.', ?)`,
        params: [`hist_${randomUuid()}`, orderId, user?.id ?? null, addressSnapshot.fullName, now],
      });

      if (user) {
        statements.push({
          sql: `DELETE FROM carts WHERE user_id = ?`,
          params: [user.id],
        });
      }

      await db.batch(statements);

      const created = {
        orderId,
        orderNumber,
        subtotalKobo,
        discountKobo,
        deliveryFeeKobo,
        totalKobo,
        addressSnapshot,
        resolvedItems,
        estimatedDeliveryDate: estDate,
      };

      // Trigger customer & admin Brevo notifications asynchronously after DB commit
      triggerOrderNotifications(db, env, {
        eventKey: 'order_placed',
        orderId: created.orderId,
        orderNumber: created.orderNumber,
        customerName: created.addressSnapshot.fullName,
        customerEmail: created.addressSnapshot.email,
        statusLabel: 'Pending Payment',
        totalFormatted: formatNgn(created.totalKobo),
        deliveryLocation: `${created.addressSnapshot.lga}, ${created.addressSnapshot.state}`,
        extraRows: [
          { label: 'Items', value: String(created.resolvedItems.reduce((a, b) => a + b.quantity, 0)) },
          { label: 'Delivery Fee', value: formatNgn(created.deliveryFeeKobo) },
        ],
        customerTitle: 'Order Confirmation',
        customerIntro:
          'Thank you for placing your order with SELLORA. Please complete your bank transfer and upload your payment receipt so our team can verify and begin processing.',
        adminTitle: 'New Order Received',
        adminIntro: `A new order (${created.orderNumber}) has been placed and requires payment monitoring and acknowledgement.`,
      }).catch(() => {});

      return c.json({ ok: true, ...created }, 201);
    } catch (err) {
      if (isUniqueConstraintError(err, 'idempotency_key')) {
        const dup = await db.get<Record<string, unknown>>(
          `SELECT order_id, order_number, total_kobo FROM orders WHERE idempotency_key = ?`,
          [idempotencyKey]
        );
        if (dup) {
          return c.json({
            ok: true,
            duplicate: true,
            orderId: dup.order_id,
            orderNumber: dup.order_number,
            totalKobo: dup.total_kobo,
          });
        }
      }

      const guardCode = extractDbGuardCode(err);
      const errMsg = err instanceof Error ? err.message : '';
      if (guardCode === 'INSUFFICIENT_STOCK' || /stock_quantity/i.test(errMsg)) {
        return c.json(
          { error: 'Insufficient stock for one or more items. Please adjust your cart and retry.' },
          400
        );
      }
      if (guardCode === 'VARIANT_UNAVAILABLE' || /inventory_movements\.(previous_qty|new_qty)/i.test(errMsg)) {
        return c.json(
          { error: 'One or more selected products or variants are no longer available.' },
          400
        );
      }
      if (guardCode === 'DELIVERY_ZONE_UNAVAILABLE') {
        return c.json(
          { error: 'Delivery is currently unavailable for the selected location.' },
          400
        );
      }
      if (guardCode === 'COUPON_NOT_STARTED') {
        return c.json({ error: 'This discount code is not active yet.' }, 400);
      }
      if (guardCode === 'COUPON_EXPIRED') {
        return c.json({ error: 'This discount code has expired.' }, 400);
      }
      if (guardCode === 'COUPON_LIMIT_EXCEEDED') {
        return c.json({ error: 'This discount code has reached its usage limit.' }, 400);
      }
      if (guardCode === 'COUPON_INACTIVE' || guardCode === 'COUPON_INVALID') {
        return c.json({ error: 'Invalid or inactive discount code.' }, 400);
      }

      return respondWithCapturedError(c, {
        status: 400,
        publicMessage: 'Unable to complete checkout right now. Please try again.',
        serviceCategory: 'checkout',
        failedOperation: 'customer_checkout',
        location: 'orders.ts:POST /checkout',
        error: err,
      });
    }
  });

  // Authenticated customer order history
  app.get('/orders', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const orders = await db.all(
      `SELECT order_id, order_number, total_kobo, subtotal_kobo, delivery_fee_kobo, discount_kobo,
              order_status, payment_status, delivery_status, estimated_delivery_date, created_at
       FROM orders WHERE customer_id = ? ORDER BY created_at DESC`,
      [user.id]
    );
    return c.json({ orders });
  });

  app.get('/orders/:orderNumber', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const orderNumber = c.req.param('orderNumber');

    const order = await db.get<Record<string, unknown>>(
      `SELECT * FROM orders WHERE order_number = ? AND customer_id = ?`,
      [orderNumber, user.id]
    );
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const items = await db.all(`SELECT * FROM order_items WHERE order_id = ?`, [order.order_id]);
    const history = await db.all(
      `SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
      [order.order_id]
    );
    const evidence = await db.all(
      `SELECT id, reference_number, amount_submitted_kobo, transfer_date, receipt_original_name, receipt_mime_type, notes, created_at
       FROM payment_evidence WHERE order_id = ? ORDER BY created_at DESC`,
      [order.order_id]
    );
    const payment = await db.get(`SELECT * FROM payments WHERE order_id = ?`, [order.order_id]);

    return c.json({
      order: {
        ...order,
        deliveryAddress: JSON.parse(String(order.delivery_address_snapshot_json)),
      },
      items,
      history,
      payment,
      evidence,
    });
  });

  app.post('/orders/:orderNumber/cancel-request', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    const db = c.get('db');
    const orderNumber = c.req.param('orderNumber');
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim();
    if (reason.length < 4) return c.json({ error: 'Please provide a cancellation reason.' }, 400);

    const order = await db.get<Record<string, unknown>>(
      `SELECT * FROM orders WHERE order_number = ? AND customer_id = ?`,
      [orderNumber, user.id]
    );
    if (!order) return c.json({ error: 'Order not found' }, 404);
    if (['delivered', 'cancelled', 'refunded'].includes(String(order.order_status))) {
      return c.json({ error: 'This order can no longer be cancelled.' }, 400);
    }

    const now = new Date().toISOString();
    await db.run(
      `UPDATE orders SET order_status = 'cancellation_requested', cancellation_reason = ?, needs_attention = 1, updated_at = ? WHERE order_id = ?`,
      [reason, now, order.order_id]
    );
    await db.run(
      `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
       VALUES (?, ?, 'order', ?, 'cancellation_requested', ?, ?, ?, ?)`,
      [`hist_${randomUuid()}`, order.order_id, order.order_status, user.id, user.name, reason, now]
    );
    return c.json({ ok: true });
  });

  // Public & Authenticated Track Order Lookup
  app.post('/tracking/lookup', async (c) => {
    const db = c.get('db');
    const user = c.get('user');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `track:${ip}`, 20, 60_000);
    if (!rl.allowed) {
      return c.json(
        { error: `Too many tracking attempts. Please wait ${rl.retryAfterSec}s.` },
        429
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const orderNumber = String(body.orderNumber || '').trim().toUpperCase();
    const verification = String(body.verification || '').trim();
    if (!orderNumber) {
      return c.json({ error: 'Order Number is required.' }, 400);
    }

    const order = await db.get<Record<string, unknown>>(
      `SELECT * FROM orders WHERE UPPER(order_number) = ?`,
      [orderNumber]
    );
    if (!order) {
      return c.json({ error: 'No matching order found. Check your Order Number and contact info.' }, 404);
    }

    const isOwner = Boolean(user && order.customer_id === user.id);
    const isStaff = Boolean(user && user.role !== 'customer');

    if (!isOwner && !isStaff) {
      if (!verification) {
        return c.json(
          { error: 'Please enter the email address or phone number associated with this order.' },
          401
        );
      }
      const emailMatch = verification.toLowerCase() === String(order.customer_email).toLowerCase();
      const phoneMatch =
        normalizeNgPhone(verification) === normalizeNgPhone(String(order.customer_phone));
      if (!emailMatch && !phoneMatch) {
        return c.json(
          { error: 'Verification failed. Check your Order Number and contact details.' },
          403
        );
      }
    }

    const items = await db.all(
      `SELECT order_item_id, product_name, variant_name, sku, quantity, unit_price_kobo, line_total_kobo
       FROM order_items WHERE order_id = ?`,
      [order.order_id]
    );
    const history = await db.all(
      `SELECT id, status_field, previous_status, new_status, note, created_at
       FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
      [order.order_id]
    );
    const payment = await db.get(
      `SELECT status, rejection_reason, verified_at FROM payments WHERE order_id = ?`,
      [order.order_id]
    );
    const evidence = await db.all(
      `SELECT id, reference_number, amount_submitted_kobo, transfer_date, receipt_original_name, created_at
       FROM payment_evidence WHERE order_id = ? ORDER BY created_at DESC`,
      [order.order_id]
    );

    const addr = JSON.parse(String(order.delivery_address_snapshot_json));
    // Mask street details for unauthenticated guest view
    const maskedStreet =
      isOwner || isStaff
        ? addr.streetAddress
        : addr.streetAddress.length > 6
          ? `${addr.streetAddress.slice(0, 4)}••••${addr.streetAddress.slice(-2)}`
          : '••••••';

    return c.json({
      order: {
        orderNumber: order.order_number,
        createdAt: order.created_at,
        orderStatus: order.order_status,
        paymentStatus: order.payment_status,
        deliveryStatus: order.delivery_status,
        subtotalKobo: order.subtotal_kobo,
        discountKobo: order.discount_kobo,
        deliveryFeeKobo: order.delivery_fee_kobo,
        totalKobo: order.total_kobo,
        courierName: order.courier_name,
        trackingReference: order.tracking_reference,
        estimatedDeliveryDate: order.estimated_delivery_date,
        deliveryNotes: order.delivery_notes,
        acknowledgedAt: order.acknowledged_at,
        cancellationReason: order.cancellation_reason,
        deliveryAddress: {
          fullName: isOwner || isStaff ? addr.fullName : `${String(addr.fullName).split(' ')[0]} •••`,
          state: addr.state,
          lga: addr.lga,
          city: addr.city,
          streetAddress: maskedStreet,
        },
      },
      items,
      history,
      payment,
      evidence,
    });
  });

  // Upload Manual Bank Transfer Payment Evidence (stored privately in R2/local)
  app.post('/payments/:orderNumber/evidence', async (c) => {
    const db = c.get('db');
    const storage = c.get('storage');
    const user = c.get('user');
    const env = c.get('env');
    const ip = getTrustedClientIp(c.req.raw.headers, env);
    const rl = await checkPersistentRateLimit(db, `evidence:${ip}`, 12, 60_000);
    if (!rl.allowed) {
      return c.json(
        { error: `Too many upload attempts. Please wait ${rl.retryAfterSec}s.` },
        429
      );
    }
    const orderNumber = c.req.param('orderNumber').trim().toUpperCase();

    const order = await db.get<Record<string, unknown>>(
      `SELECT * FROM orders WHERE UPPER(order_number) = ?`,
      [orderNumber]
    );
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: 'Multipart form data required' }, 400);

    const verificationEmail = String(form.get('verificationEmail') || '').trim().toLowerCase();
    const isOwner = Boolean(user && order.customer_id === user.id);
    if (!isOwner && verificationEmail !== String(order.customer_email).toLowerCase()) {
      return c.json({ error: 'Verify the order email address to upload payment evidence.' }, 403);
    }

    const referenceNumber = String(form.get('referenceNumber') || '').trim();
    const amountNairaRaw = Number(form.get('amountNaira') || 0);
    const amountSubmittedKobo = Math.round(amountNairaRaw * 100);
    const transferDate = String(form.get('transferDate') || '').trim();
    const notes = String(form.get('notes') || '').trim();
    const idempotencyKey =
      String(form.get('idempotencyKey') || '').trim() || `ev_${randomUuid()}`;
    const file = form.get('receipt');

    if (referenceNumber.length < 3) {
      return c.json({ error: 'Enter a valid bank transfer reference.' }, 400);
    }
    if (!Number.isFinite(amountSubmittedKobo) || amountSubmittedKobo <= 0) {
      return c.json({ error: 'Enter a valid transfer amount.' }, 400);
    }
    if (!transferDate) {
      return c.json({ error: 'Transfer date is required.' }, 400);
    }
    if (!(file instanceof File)) {
      return c.json({ error: 'Receipt image or PDF file is required.' }, 400);
    }

    const allowedMimes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!allowedMimes.includes(file.type)) {
      return c.json({ error: 'Only PNG, JPEG, WEBP, or PDF receipts are accepted.' }, 400);
    }
    if (file.size > 5 * 1024 * 1024) {
      return c.json({ error: 'Receipt file size must be 5MB or less.' }, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const magicCheck = validateUploadedFileBytes(bytes, file.type, allowedMimes);
    if (!magicCheck.ok) {
      return c.json({ error: magicCheck.error }, 400);
    }

    const existingEv = await db.get<{ id: string }>(
      `SELECT id FROM payment_evidence WHERE idempotency_key = ?`,
      [idempotencyKey]
    );
    if (existingEv) {
      return c.json({ ok: true, duplicate: true, evidenceId: existingEv.id });
    }

    const payment = await db.get<{ id: string; status: string }>(
      `SELECT id, status FROM payments WHERE order_id = ?`,
      [order.order_id]
    );
    if (!payment) {
      return respondWithCapturedError(c, {
        status: 500,
        publicMessage: 'Unable to locate payment record for this order.',
        serviceCategory: 'payment',
        failedOperation: 'upload_payment_evidence',
        location: 'orders.ts:POST /payments/:orderNumber/evidence',
        error: new Error(`Payment record missing for order ${String(order.order_id)}`),
      });
    }
    if (payment.status === 'payment_confirmed') {
      return c.json({ error: 'Payment for this order is already confirmed.' }, 400);
    }

    const evidenceId = `pev_${randomUuid()}`;
    const r2Key = `receipts/${order.order_id}/${evidenceId}.${magicCheck.extension}`;
    const safeOriginalName = sanitizeUploadFilename(file.name, `receipt.${magicCheck.extension}`);
    await storage.put(r2Key, bytes, magicCheck.detectedMime);

    const now = new Date().toISOString();
    try {
      await db.batch([
        {
          // trg_payment_evidence_block_confirmed aborts if payment is missing or already confirmed
          sql: `INSERT INTO payment_evidence (
            id, payment_id, order_id, customer_id, reference_number, amount_submitted_kobo,
            transfer_date, receipt_r2_key, receipt_mime_type, receipt_original_name, notes,
            idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            evidenceId,
            payment.id,
            order.order_id,
            user?.id ?? null,
            referenceNumber,
            amountSubmittedKobo,
            transferDate,
            r2Key,
            magicCheck.detectedMime,
            safeOriginalName,
            notes,
            idempotencyKey,
            now,
          ],
        },
        {
          // Uploading evidence NEVER marks an order paid — moves to Payment Under Review; trigger guards state
          sql: `UPDATE payments SET status = 'payment_under_review', updated_at = ? WHERE id = ?`,
          params: [now, payment.id],
        },
        {
          sql: `UPDATE orders SET
            order_status = CASE
              WHEN order_status IN ('pending_payment', 'payment_under_review', 'payment_rejected')
              THEN 'payment_under_review'
              ELSE order_status
            END,
            payment_status = 'payment_under_review',
            needs_attention = 1,
            updated_at = ?
            WHERE order_id = ?`,
          params: [now, order.order_id],
        },
        {
          sql: `INSERT INTO order_status_history (
            id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at
          ) VALUES (?, ?, 'payment', ?, 'payment_under_review', ?, ?, ?, ?)`,
          params: [
            `hist_${randomUuid()}`,
            order.order_id,
            payment.status,
            user?.id ?? null,
            String(order.customer_name),
            `Payment evidence submitted (Ref: ${referenceNumber}, Amount: ${formatNgn(amountSubmittedKobo)})`,
            now,
          ],
        },
      ]);
    } catch (err) {
      // Compensating R2 cleanup so failed DB batches never leave orphaned receipts attached
      try {
        await storage.delete(r2Key);
      } catch (cleanupErr) {
        console.error('Failed to delete orphaned receipt from storage:', r2Key, cleanupErr);
        try {
          await db.run(
            `INSERT OR IGNORE INTO storage_orphan_records (id, r2_key, prefix, reason, status, created_at)
             VALUES (?, ?, 'receipts', ?, 'pending', ?)`,
            [
              `orp_${randomUuid()}`,
              r2Key,
              cleanupErr instanceof Error ? cleanupErr.message : 'delete_failed_after_db_abort',
              new Date().toISOString(),
            ]
          );
        } catch {
          // Non-fatal if DB itself is unavailable; prefix reconciliation handles recovery
        }
      }

      if (isUniqueConstraintError(err, 'idempotency_key')) {
        const dup = await db.get<{ id: string }>(
          `SELECT id FROM payment_evidence WHERE idempotency_key = ?`,
          [idempotencyKey]
        );
        if (dup) {
          return c.json({ ok: true, duplicate: true, evidenceId: dup.id });
        }
      }

      const guardCode = extractDbGuardCode(err);
      if (guardCode === 'PAYMENT_ALREADY_CONFIRMED') {
        return c.json({ error: 'Payment for this order is already confirmed.' }, 400);
      }
      if (guardCode === 'PAYMENT_NOT_FOUND') {
        return c.json({ error: 'Payment record missing.' }, 404);
      }

      return respondWithCapturedError(c, {
        status: 500,
        publicMessage: 'Unable to record payment evidence. Please try again.',
        serviceCategory: 'payment',
        failedOperation: 'record_payment_evidence',
        location: 'orders.ts:POST /payments/:orderNumber/evidence',
        error: err,
      });
    }

    await writeAuditLog(db, {
      actorId: user?.id ?? null,
      actorEmail: String(order.customer_email),
      actorRole: user?.role ?? 'guest',
      action: 'PAYMENT_EVIDENCE_SUBMITTED',
      targetType: 'order',
      targetId: String(order.order_id),
      details: { orderNumber, referenceNumber, amountSubmittedKobo },
    });

    triggerOrderNotifications(db, env, {
      eventKey: 'payment_evidence_submitted',
      orderId: String(order.order_id),
      orderNumber: String(order.order_number),
      customerName: String(order.customer_name),
      customerEmail: String(order.customer_email),
      statusLabel: 'Payment Under Review',
      totalFormatted: formatNgn(Number(order.total_kobo)),
      extraRows: [
        { label: 'Transfer Reference', value: referenceNumber },
        { label: 'Amount Submitted', value: formatNgn(amountSubmittedKobo) },
      ],
      customerTitle: 'Payment Evidence Received',
      customerIntro:
        'We have received your bank transfer proof. An administrator will review and verify your payment shortly.',
      adminTitle: 'Payment Proof Requires Review',
      adminIntro: `Customer submitted bank transfer evidence for order ${order.order_number}. Please inspect the private receipt in the Payment Review dashboard.`,
      uniqueSuffix: evidenceId,
    }).catch(() => {});

    return c.json({ ok: true, evidenceId, status: 'payment_under_review' }, 201);
  });

  // Private Payment Receipt Retrieval (strictly restricted to order owner or authorized staff)
  app.get('/payments/evidence/:evidenceId/file', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);

    const db = c.get('db');
    const storage = c.get('storage');
    const evidenceId = c.req.param('evidenceId');

    const row = await db.get<{
      receipt_r2_key: string;
      receipt_mime_type: string;
      receipt_original_name: string;
      order_customer_id: string | null;
    }>(
      `SELECT pe.receipt_r2_key, pe.receipt_mime_type, pe.receipt_original_name, o.customer_id as order_customer_id
       FROM payment_evidence pe
       JOIN orders o ON o.order_id = pe.order_id
       WHERE pe.id = ?`,
      [evidenceId]
    );
    if (!row) return c.json({ error: 'Receipt not found' }, 404);

    const isOrderOwner = row.order_customer_id === user.id;
    const canReviewPayments = user.permissions.includes('payments:review');
    if (!isOrderOwner && !canReviewPayments) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const fileObj = await storage.get(row.receipt_r2_key);
    if (!fileObj) return c.json({ error: 'Receipt file missing from storage' }, 404);

    const safeFilename = sanitizeUploadFilename(row.receipt_original_name, 'receipt');
    return new Response(new Uint8Array(fileObj.data), {
      status: 200,
      headers: {
        'Content-Type': row.receipt_mime_type || fileObj.contentType,
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return app;
}
