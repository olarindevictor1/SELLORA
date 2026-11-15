import { Hono } from 'hono';
import { z } from 'zod';
import { randomHex, randomUuid } from '../crypto';
import type { AppContext } from '../context';
import {
  dispatchSingleEmailEvent,
  getEffectiveEmailConfig,
  processEmailOutbox,
  queueEmailEvent,
  renderSelloraEmailHtml,
  triggerOrderNotifications,
} from '../email';
import { writeAuditLog } from '../security';
import { getEffectiveSeoConfig } from '../seo';
import {
  ALL_PERMISSIONS,
  formatNgn,
  ORDER_STATUS_LABELS,
  ROLE_DEFAULT_PERMISSIONS,
  STAFF_ROLES,
  type OrderStatus,
  type Permission,
  type StaffRole,
} from '../../shared/types';

function requirePerm(perm?: Permission) {
  return async (c: any, next: () => Promise<void>) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'Authentication required' }, 401);
    if (user.role === 'customer') return c.json({ error: 'Administrator access required' }, 403);
    if (perm && !user.permissions.includes(perm)) {
      return c.json({ error: `Missing permission: ${perm}` }, 403);
    }
    await next();
  };
}

export function createAdminRoutes() {
  const app = new Hono<AppContext>();

  // ==========================================
  // ANALYTICS & EXPENSES
  // ==========================================
  app.get('/analytics', requirePerm('analytics:read'), async (c) => {
    const db = c.get('db');
    const from = c.req.query('from') || '';
    const to = c.req.query('to') || '';

    let dateClause = '';
    const params: unknown[] = [];
    if (from) {
      dateClause += ` AND created_at >= ?`;
      params.push(`${from}T00:00:00.000Z`);
    }
    if (to) {
      dateClause += ` AND created_at <= ?`;
      params.push(`${to}T23:59:59.999Z`);
    }

    const orderSummary = await db.get<{
      total_orders: number;
      gross_sales_kobo: number | null;
      net_sales_kobo: number | null;
      confirmed_revenue_kobo: number | null;
      unconfirmed_revenue_kobo: number | null;
      discounts_kobo: number | null;
      refunded_kobo: number | null;
      delivery_fees_kobo: number | null;
      pending_attention: number;
    }>(
      `SELECT
        COUNT(*) as total_orders,
        SUM(CASE WHEN order_status != 'cancelled' THEN total_kobo ELSE 0 END) as gross_sales_kobo,
        SUM(CASE WHEN order_status NOT IN ('cancelled', 'refunded') THEN total_kobo ELSE 0 END) as net_sales_kobo,
        SUM(CASE WHEN payment_status = 'payment_confirmed' AND order_status NOT IN ('cancelled', 'refunded') THEN total_kobo ELSE 0 END) as confirmed_revenue_kobo,
        SUM(CASE WHEN payment_status IN ('pending_payment', 'payment_under_review') AND order_status != 'cancelled' THEN total_kobo ELSE 0 END) as unconfirmed_revenue_kobo,
        SUM(CASE WHEN order_status != 'cancelled' THEN discount_kobo ELSE 0 END) as discounts_kobo,
        SUM(CASE WHEN order_status = 'refunded' OR payment_status = 'refunded' THEN total_kobo ELSE 0 END) as refunded_kobo,
        SUM(CASE WHEN order_status != 'cancelled' THEN delivery_fee_kobo ELSE 0 END) as delivery_fees_kobo,
        SUM(CASE WHEN needs_attention = 1 THEN 1 ELSE 0 END) as pending_attention
       FROM orders WHERE 1=1 ${dateClause}`,
      params
    );

    const cogsRow = await db.get<{
      total_cogs_kobo: number | null;
      missing_cost_count: number;
    }>(
      `SELECT
        SUM(oi.cost_price_kobo * oi.quantity) as total_cogs_kobo,
        SUM(CASE WHEN oi.cost_price_kobo IS NULL THEN 1 ELSE 0 END) as missing_cost_count
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE o.payment_status = 'payment_confirmed'
         AND o.order_status NOT IN ('cancelled', 'refunded')
         ${dateClause.replace(/created_at/g, 'o.created_at')}`,
      params
    );

    let expClause = '';
    const expParams: unknown[] = [];
    if (from) {
      expClause += ` AND incurred_at >= ?`;
      expParams.push(from);
    }
    if (to) {
      expClause += ` AND incurred_at <= ?`;
      expParams.push(to);
    }
    const expRow = await db.get<{ total_expenses_kobo: number | null }>(
      `SELECT SUM(amount_kobo) as total_expenses_kobo FROM expenses WHERE 1=1 ${expClause}`,
      expParams
    );

    const customerStats = await db.get<{
      total_customers: number;
      repeat_customers: number;
    }>(
      `SELECT
        COUNT(DISTINCT customer_email) as total_customers,
        SUM(CASE WHEN order_cnt > 1 THEN 1 ELSE 0 END) as repeat_customers
       FROM (
         SELECT customer_email, COUNT(*) as order_cnt FROM orders WHERE order_status != 'cancelled' ${dateClause} GROUP BY customer_email
       )`,
      params
    );

    const inventoryStats = await db.get<{
      total_units: number | null;
      retail_value_kobo: number | null;
      cost_value_kobo: number | null;
      low_stock_count: number;
      out_of_stock_count: number;
    }>(
      `SELECT
        SUM(pv.stock_quantity) as total_units,
        SUM(pv.stock_quantity * COALESCE(pv.sale_price_kobo, pv.price_kobo)) as retail_value_kobo,
        SUM(pv.stock_quantity * COALESCE(pv.cost_price_kobo, 0)) as cost_value_kobo,
        SUM(CASE WHEN pv.stock_quantity > 0 AND pv.stock_quantity <= p.low_stock_threshold THEN 1 ELSE 0 END) as low_stock_count,
        SUM(CASE WHEN pv.stock_quantity = 0 THEN 1 ELSE 0 END) as out_of_stock_count
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.status = 'active' AND pv.is_active = 1`
    );

    const bestsellers = await db.all(
      `SELECT oi.product_id, oi.product_name, SUM(oi.quantity) as units_sold, SUM(oi.line_total_kobo) as revenue_kobo
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE o.payment_status = 'payment_confirmed'
         AND o.order_status NOT IN ('cancelled', 'refunded')
         ${dateClause.replace(/created_at/g, 'o.created_at')}
       GROUP BY oi.product_id, oi.product_name
       ORDER BY revenue_kobo DESC, units_sold DESC LIMIT 8`,
      params
    );

    const slowMovers = await db.all(
      `SELECT p.id, p.name, p.sku,
              COALESCE(SUM(CASE WHEN o.payment_status = 'payment_confirmed' AND o.order_status NOT IN ('cancelled', 'refunded') THEN oi.quantity ELSE 0 END), 0) as units_sold,
              (SELECT COALESCE(SUM(stock_quantity), 0) FROM product_variants WHERE product_id = p.id) as stock
       FROM products p
       LEFT JOIN order_items oi ON oi.product_id = p.id
       LEFT JOIN orders o ON o.order_id = oi.order_id
       WHERE p.status = 'active'
       GROUP BY p.id
       ORDER BY units_sold ASC LIMIT 5`
    );

    const salesTrendDaily = await db.all(
      `SELECT substr(created_at, 1, 10) as period, COUNT(*) as orders, SUM(total_kobo) as total_kobo
       FROM orders
       WHERE payment_status = 'payment_confirmed'
         AND order_status NOT IN ('cancelled', 'refunded')
         ${dateClause}
       GROUP BY substr(created_at, 1, 10)
       ORDER BY period ASC LIMIT 60`,
      params
    );

    const salesTrendWeekly = await db.all(
      `SELECT strftime('%Y-W%W', created_at) as period, COUNT(*) as orders, SUM(total_kobo) as total_kobo
       FROM orders
       WHERE payment_status = 'payment_confirmed'
         AND order_status NOT IN ('cancelled', 'refunded')
         ${dateClause}
       GROUP BY strftime('%Y-W%W', created_at)
       ORDER BY period ASC LIMIT 26`,
      params
    );

    const salesTrendMonthly = await db.all(
      `SELECT substr(created_at, 1, 7) as period, COUNT(*) as orders, SUM(total_kobo) as total_kobo
       FROM orders
       WHERE payment_status = 'payment_confirmed'
         AND order_status NOT IN ('cancelled', 'refunded')
         ${dateClause}
       GROUP BY substr(created_at, 1, 7)
       ORDER BY period ASC LIMIT 24`,
      params
    );

    const orderStatusRows = await db.all<{ status: string; count: number }>(
      `SELECT order_status as status, COUNT(*) as count
       FROM orders WHERE 1=1 ${dateClause}
       GROUP BY order_status`,
      params
    );

    const paymentMethodRows = await db.all<{
      method: string;
      count: number;
      confirmed_kobo: number | null;
    }>(
      `SELECT p.method as method,
              COUNT(*) as count,
              SUM(CASE WHEN p.status = 'payment_confirmed' AND o.order_status NOT IN ('cancelled', 'refunded') THEN o.total_kobo ELSE 0 END) as confirmed_kobo
       FROM payments p
       JOIN orders o ON o.order_id = p.order_id
       WHERE 1=1 ${dateClause.replace(/created_at/g, 'o.created_at')}
       GROUP BY p.method
       ORDER BY count DESC`,
      params
    );

    const funnelStats = await db
      .get<{
        unique_visitors: number;
        page_views: number;
        product_views: number;
        add_to_cart: number;
        begin_checkout: number;
      }>(
        `SELECT
          COUNT(DISTINCT session_key) as unique_visitors,
          SUM(CASE WHEN event_name = 'page_view' THEN 1 ELSE 0 END) as page_views,
          SUM(CASE WHEN event_name = 'view_item' THEN 1 ELSE 0 END) as product_views,
          SUM(CASE WHEN event_name = 'add_to_cart' THEN 1 ELSE 0 END) as add_to_cart,
          SUM(CASE WHEN event_name = 'begin_checkout' THEN 1 ELSE 0 END) as begin_checkout
         FROM analytics_events WHERE 1=1 ${dateClause}`,
        params
      )
      .catch(() => null);

    const confirmedCountRow = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM orders WHERE payment_status = 'payment_confirmed' AND order_status NOT IN ('cancelled', 'refunded') ${dateClause}`,
      params
    );
    const trafficSources = await db
      .all<{ source: string; visitors: number; events: number }>(
        `SELECT referrer_source as source, COUNT(DISTINCT session_key) as visitors, COUNT(*) as events
         FROM analytics_events WHERE event_name = 'page_view' ${dateClause}
         GROUP BY referrer_source ORDER BY visitors DESC LIMIT 12`,
        params
      )
      .catch(() => []);
    const landingPages = await db
      .all(
        `SELECT path, COUNT(*) as views, COUNT(DISTINCT session_key) as visitors
         FROM analytics_events WHERE event_name = 'page_view' ${dateClause}
         GROUP BY path ORDER BY views DESC LIMIT 8`,
        params
      )
      .catch(() => []);
    const deviceCategories = await db
      .all<{ device: string; visitors: number }>(
        `SELECT device_category as device, COUNT(DISTINCT session_key) as visitors
         FROM analytics_events WHERE event_name = 'page_view' ${dateClause}
         GROUP BY device_category ORDER BY visitors DESC`,
        params
      )
      .catch(() => []);

    const sourceCategoryMap = new Map<string, number>();
    for (const row of trafficSources) {
      const raw = String(row.source || '').toLowerCase();
      const bucket =
        raw === 'search' || raw === 'organic_search'
          ? 'Organic Search'
          : raw === 'direct'
            ? 'Direct'
            : raw === 'social'
              ? 'Social'
              : raw === 'other' || raw === ''
                ? 'Other'
                : 'Referral';
      sourceCategoryMap.set(bucket, (sourceCategoryMap.get(bucket) || 0) + Number(row.visitors || 0));
    }
    const trafficSourceCategories = Array.from(sourceCategoryMap.entries()).map(([category, visitors]) => ({
      category,
      visitors,
    }));

    const totalOrders = Number(orderSummary?.total_orders || 0);
    const confirmedRev = Number(orderSummary?.confirmed_revenue_kobo || 0);
    const totalCogs = Number(cogsRow?.total_cogs_kobo || 0);
    const totalExpenses = Number(expRow?.total_expenses_kobo || 0);
    const missingCostCount = Number(cogsRow?.missing_cost_count || 0);
    const netProfitKobo =
      confirmedRev > 0 && missingCostCount === 0
        ? confirmedRev - totalCogs - totalExpenses
        : null;
    const uniqueVisitors = Number(funnelStats?.unique_visitors || 0);
    const confirmedPurchases = Number(confirmedCountRow?.cnt || 0);
    const conversionRatePct =
      uniqueVisitors > 0 ? Number(((confirmedPurchases / uniqueVisitors) * 100).toFixed(2)) : null;

    return c.json({
      metrics: {
        totalOrders,
        grossSalesKobo: Number(orderSummary?.gross_sales_kobo || 0),
        netSalesKobo: Number(orderSummary?.net_sales_kobo || 0),
        confirmedRevenueKobo: confirmedRev,
        unconfirmedRevenueKobo: Number(orderSummary?.unconfirmed_revenue_kobo || 0),
        averageOrderValueKobo: totalOrders > 0 ? Math.round(Number(orderSummary?.gross_sales_kobo || 0) / totalOrders) : null,
        discountsKobo: Number(orderSummary?.discounts_kobo || 0),
        refundedKobo: Number(orderSummary?.refunded_kobo || 0),
        deliveryFeesKobo: Number(orderSummary?.delivery_fees_kobo || 0),
        cogsKobo: totalCogs,
        expensesKobo: totalExpenses,
        netProfitKobo,
        profitAvailabilityNote:
          confirmedRev === 0
            ? 'No confirmed payments in selected range.'
            : missingCostCount > 0
              ? 'Unavailable until unit cost prices are set on all sold items.'
              : 'Calculated from confirmed revenue minus item COGS and recorded expenses.',
        pendingAttention: Number(orderSummary?.pending_attention || 0),
      },
      customers: {
        totalOrderingCustomers: Number(customerStats?.total_customers || 0),
        repeatCustomers: Number(customerStats?.repeat_customers || 0),
      },
      inventory: {
        totalUnits: Number(inventoryStats?.total_units || 0),
        retailValueKobo: Number(inventoryStats?.retail_value_kobo || 0),
        costValueKobo: Number(inventoryStats?.cost_value_kobo || 0),
        lowStockCount: Number(inventoryStats?.low_stock_count || 0),
        outOfStockCount: Number(inventoryStats?.out_of_stock_count || 0),
      },
      insights: {
        uniqueVisitors,
        pageViews: Number(funnelStats?.page_views || 0),
        productViews: Number(funnelStats?.product_views || 0),
        addToCart: Number(funnelStats?.add_to_cart || 0),
        beginCheckout: Number(funnelStats?.begin_checkout || 0),
        confirmedPurchases,
        conversionRatePct,
        trafficSources,
        trafficSourceCategories,
        landingPages,
        deviceCategories,
      },
      orderStatusBreakdown: orderStatusRows,
      paymentMethodBreakdown: paymentMethodRows.map((pm) => ({
        method: pm.method,
        count: Number(pm.count || 0),
        confirmedKobo: Number(pm.confirmed_kobo || 0),
      })),
      bestsellers,
      slowMovers,
      salesTrend: salesTrendDaily.map((r: any) => ({
        day: r.period,
        orders: Number(r.orders || 0),
        total_kobo: Number(r.total_kobo || 0),
      })),
      salesTrendDaily: salesTrendDaily.map((r: any) => ({
        period: r.period,
        orders: Number(r.orders || 0),
        total_kobo: Number(r.total_kobo || 0),
      })),
      salesTrendWeekly: salesTrendWeekly.map((r: any) => ({
        period: r.period,
        orders: Number(r.orders || 0),
        total_kobo: Number(r.total_kobo || 0),
      })),
      salesTrendMonthly: salesTrendMonthly.map((r: any) => ({
        period: r.period,
        orders: Number(r.orders || 0),
        total_kobo: Number(r.total_kobo || 0),
      })),
    });
  });

  app.get('/expenses', requirePerm('analytics:read'), async (c) => {
    const db = c.get('db');
    const expenses = await db.all(`SELECT * FROM expenses ORDER BY incurred_at DESC, created_at DESC`);
    return c.json({ expenses });
  });

  app.post('/expenses', requirePerm('analytics:read'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      title: z.string().min(2).max(160),
      category: z.string().min(2).max(80),
      amountNaira: z.number().positive(),
      incurredAt: z.string().min(8),
      notes: z.string().max(400).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid expense data' }, 400);

    const id = `exp_${randomUuid()}`;
    await db.run(
      `INSERT INTO expenses (id, title, category, amount_kobo, incurred_at, notes, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.data.title.trim(),
        parsed.data.category.trim(),
        Math.round(parsed.data.amountNaira * 100),
        parsed.data.incurredAt,
        parsed.data.notes || '',
        user.id,
        new Date().toISOString(),
      ]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.delete('/expenses/:id', requirePerm('analytics:read'), async (c) => {
    const db = c.get('db');
    await db.run(`DELETE FROM expenses WHERE id = ?`, [c.req.param('id')]);
    return c.json({ ok: true });
  });

  // ==========================================
  // ORDERS & FULFILMENT
  // ==========================================
  app.get('/orders', requirePerm('orders:read'), async (c) => {
    const db = c.get('db');
    const q = (c.req.query('q') || '').trim().toLowerCase();
    const orderStatus = c.req.query('orderStatus') || '';
    const paymentStatus = c.req.query('paymentStatus') || '';
    const deliveryStatus = c.req.query('deliveryStatus') || '';

    let sql = `SELECT * FROM orders WHERE 1=1`;
    const params: unknown[] = [];

    if (q) {
      sql += ` AND (LOWER(order_number) LIKE ? OR LOWER(order_id) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(customer_email) LIKE ? OR LOWER(customer_phone) LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    if (orderStatus) {
      sql += ` AND order_status = ?`;
      params.push(orderStatus);
    }
    if (paymentStatus) {
      sql += ` AND payment_status = ?`;
      params.push(paymentStatus);
    }
    if (deliveryStatus) {
      sql += ` AND delivery_status = ?`;
      params.push(deliveryStatus);
    }

    sql += ` ORDER BY created_at DESC LIMIT 200`;
    const orders = await db.all<Record<string, unknown>>(sql, params);
    return c.json({
      orders: orders.map((o) => ({
        ...o,
        deliveryAddress: JSON.parse(String(o.delivery_address_snapshot_json || '{}')),
      })),
    });
  });

  app.get('/orders/export', requirePerm('orders:read'), async (c) => {
    const db = c.get('db');
    const orders = await db.all<Record<string, unknown>>(
      `SELECT order_number, order_id, customer_name, customer_email, customer_phone, subtotal_kobo, discount_kobo, delivery_fee_kobo, total_kobo, order_status, payment_status, delivery_status, created_at
       FROM orders ORDER BY created_at DESC`
    );
    const header = 'OrderNumber,OrderID,CustomerName,Email,Phone,SubtotalNGN,DiscountNGN,DeliveryNGN,TotalNGN,OrderStatus,PaymentStatus,DeliveryStatus,CreatedAt\n';
    const lines = orders
      .map((o) =>
        [
          o.order_number,
          o.order_id,
          `"${String(o.customer_name).replace(/"/g, '""')}"`,
          o.customer_email,
          o.customer_phone,
          (Number(o.subtotal_kobo) / 100).toFixed(2),
          (Number(o.discount_kobo) / 100).toFixed(2),
          (Number(o.delivery_fee_kobo) / 100).toFixed(2),
          (Number(o.total_kobo) / 100).toFixed(2),
          o.order_status,
          o.payment_status,
          o.delivery_status,
          o.created_at,
        ].join(',')
      )
      .join('\n');
    return new Response(header + lines, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="sellora-orders.csv"',
      },
    });
  });

  app.get('/orders/:orderId', requirePerm('orders:read'), async (c) => {
    const db = c.get('db');
    const orderId = c.req.param('orderId');
    const order = await db.get<Record<string, unknown>>(
      `SELECT * FROM orders WHERE order_id = ? OR order_number = ?`,
      [orderId, orderId]
    );
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const items = await db.all(`SELECT * FROM order_items WHERE order_id = ?`, [order.order_id]);
    const history = await db.all(
      `SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at ASC`,
      [order.order_id]
    );
    const payment = await db.get(`SELECT * FROM payments WHERE order_id = ?`, [order.order_id]);
    const evidence = await db.all(
      `SELECT * FROM payment_evidence WHERE order_id = ? ORDER BY created_at DESC`,
      [order.order_id]
    );

    return c.json({
      order: {
        ...order,
        deliveryAddress: JSON.parse(String(order.delivery_address_snapshot_json || '{}')),
      },
      items,
      history,
      payment,
      evidence,
    });
  });

  app.post('/orders/:orderId/acknowledge', requirePerm('orders:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const orderId = c.req.param('orderId');

    const order = await db.get<Record<string, unknown>>(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE orders SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?), needs_attention = 0, updated_at = ? WHERE order_id = ?`,
        [now, user.id, now, orderId]
      );
      await tx.run(
        `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
         VALUES (?, ?, 'order', ?, ?, ?, ?, 'Order acknowledged as received by store administration (note: separate from payment confirmation).', ?)`,
        [
          `hist_${randomUuid()}`,
          orderId,
          order.order_status,
          order.order_status,
          user.id,
          user.name,
          now,
        ]
      );
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'ORDER_ACKNOWLEDGED',
      targetType: 'order',
      targetId: orderId,
    });

    const addr = JSON.parse(String(order.delivery_address_snapshot_json || '{}'));
    triggerOrderNotifications(db, env, {
      eventKey: 'order_received',
      orderId: String(order.order_id),
      orderNumber: String(order.order_number),
      customerName: String(order.customer_name),
      customerEmail: String(order.customer_email),
      statusLabel: 'Order Received (Acknowledged)',
      totalFormatted: formatNgn(Number(order.total_kobo)),
      deliveryLocation: `${addr.lga || ''}, ${addr.state || ''}`,
      customerTitle: 'Your Order Has Been Received',
      customerIntro:
        'Our store team has acknowledged your order. If you have not yet uploaded your bank transfer receipt, please do so from your Track Order page.',
      adminTitle: 'Order Acknowledgement Recorded',
      adminIntro: `Order ${order.order_number} was acknowledged as received by ${user.name}.`,
    }).catch(() => {});

    return c.json({ ok: true });
  });

  app.patch('/orders/:orderId/status', requirePerm('orders:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const orderId = c.req.param('orderId');

    const order = await db.get<Record<string, unknown>>(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      orderStatus: z.string().optional(),
      deliveryStatus: z.string().optional(),
      courierName: z.string().max(120).optional(),
      trackingReference: z.string().max(120).optional(),
      estimatedDeliveryDate: z.string().max(40).optional(),
      internalNotes: z.string().max(1000).optional(),
      deliveryNotes: z.string().max(1000).optional(),
      cancellationReason: z.string().max(400).optional(),
      note: z.string().max(400).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid status update payload' }, 400);

    const nextOrderStatus = (parsed.data.orderStatus || order.order_status) as OrderStatus;
    const nextDeliveryStatus = parsed.data.deliveryStatus || order.delivery_status;
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE orders SET
          order_status = ?,
          delivery_status = ?,
          courier_name = COALESCE(?, courier_name),
          tracking_reference = COALESCE(?, tracking_reference),
          estimated_delivery_date = COALESCE(?, estimated_delivery_date),
          internal_notes = COALESCE(?, internal_notes),
          delivery_notes = COALESCE(?, delivery_notes),
          cancellation_reason = COALESCE(?, cancellation_reason),
          needs_attention = 0,
          updated_at = ?
        WHERE order_id = ?`,
        [
          nextOrderStatus,
          nextDeliveryStatus,
          parsed.data.courierName ?? null,
          parsed.data.trackingReference ?? null,
          parsed.data.estimatedDeliveryDate ?? null,
          parsed.data.internalNotes ?? null,
          parsed.data.deliveryNotes ?? null,
          parsed.data.cancellationReason ?? null,
          now,
          orderId,
        ]
      );

      if (nextOrderStatus !== order.order_status) {
        await tx.run(
          `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
           VALUES (?, ?, 'order', ?, ?, ?, ?, ?, ?)`,
          [
            `hist_${randomUuid()}`,
            orderId,
            order.order_status,
            nextOrderStatus,
            user.id,
            user.name,
            parsed.data.note || parsed.data.cancellationReason || `Updated by ${user.name}`,
            now,
          ]
        );
      }

      if (nextDeliveryStatus !== order.delivery_status) {
        await tx.run(
          `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
           VALUES (?, ?, 'delivery', ?, ?, ?, ?, ?, ?)`,
          [
            `hist_${randomUuid()}`,
            orderId,
            order.delivery_status,
            nextDeliveryStatus,
            user.id,
            user.name,
            parsed.data.deliveryNotes || parsed.data.note || `Delivery updated by ${user.name}`,
            now,
          ]
        );
      }
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'ORDER_STATUS_UPDATED',
      targetType: 'order',
      targetId: orderId,
      details: {
        previousOrderStatus: order.order_status,
        nextOrderStatus,
        nextDeliveryStatus,
      },
    });

    const eventMap: Partial<Record<OrderStatus, string>> = {
      processing: 'order_processing',
      ready_for_dispatch: 'order_ready_for_dispatch',
      out_for_delivery: 'order_out_for_delivery',
      delivered: 'order_delivered',
      cancelled: 'order_cancelled',
    };

    const eventKey = eventMap[nextOrderStatus];
    if (eventKey && nextOrderStatus !== order.order_status) {
      const addr = JSON.parse(String(order.delivery_address_snapshot_json || '{}'));
      const label = ORDER_STATUS_LABELS[nextOrderStatus] || nextOrderStatus;
      triggerOrderNotifications(db, env, {
        eventKey,
        orderId: String(order.order_id),
        orderNumber: String(order.order_number),
        customerName: String(order.customer_name),
        customerEmail: String(order.customer_email),
        statusLabel: label,
        totalFormatted: formatNgn(Number(order.total_kobo)),
        deliveryLocation: `${addr.lga || ''}, ${addr.state || ''}`,
        extraRows: parsed.data.trackingReference
          ? [{ label: 'Tracking Ref', value: parsed.data.trackingReference }]
          : [],
        customerTitle: `Order Update: ${label}`,
        customerIntro:
          parsed.data.note ||
          `Your SELLORA order ${order.order_number} has moved to ${label}.`,
        adminTitle: `Order ${label}`,
        adminIntro: `Order ${order.order_number} status updated to ${label} by ${user.name}.`,
      }).catch(() => {});
    }

    return c.json({ ok: true });
  });

  app.post('/orders/:orderId/refund', requirePerm('orders:refund'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const orderId = c.req.param('orderId');
    const body = await c.req.json().catch(() => ({}));
    const status = body.status === 'refunded' ? 'refunded' : 'refund_pending';
    const note = String(body.note || '').trim() || `Refund status set to ${status}`;

    const order = await db.get<Record<string, unknown>>(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return c.json({ error: 'Order not found' }, 404);

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE orders SET order_status = ?, payment_status = ?, updated_at = ? WHERE order_id = ?`,
        [status, status, now, orderId]
      );
      await tx.run(`UPDATE payments SET status = ?, updated_at = ? WHERE order_id = ?`, [status, now, orderId]);
      await tx.run(
        `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
         VALUES (?, ?, 'order', ?, ?, ?, ?, ?, ?)`,
        [`hist_${randomUuid()}`, orderId, order.order_status, status, user.id, user.name, note, now]
      );
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'ORDER_REFUND_UPDATED',
      targetType: 'order',
      targetId: orderId,
      details: { status, note },
    });

    if (status === 'refunded') {
      triggerOrderNotifications(db, env, {
        eventKey: 'refund_confirmed',
        orderId: String(order.order_id),
        orderNumber: String(order.order_number),
        customerName: String(order.customer_name),
        customerEmail: String(order.customer_email),
        statusLabel: 'Refunded',
        totalFormatted: formatNgn(Number(order.total_kobo)),
        customerTitle: 'Refund Confirmed',
        customerIntro: `Your refund for order ${order.order_number} has been confirmed. ${note}`,
        adminTitle: 'Refund Confirmed',
        adminIntro: `Refund for order ${order.order_number} confirmed by ${user.name}.`,
      }).catch(() => {});
    }

    return c.json({ ok: true });
  });

  app.post('/orders/bulk', requirePerm('orders:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      orderIds: z.array(z.string()).min(1).max(50),
      action: z.enum(['acknowledge', 'mark_processing', 'mark_ready_for_dispatch']),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid bulk request' }, 400);

    const now = new Date().toISOString();
    let updated = 0;
    for (const id of parsed.data.orderIds) {
      if (parsed.data.action === 'acknowledge') {
        const res = await db.run(
          `UPDATE orders SET acknowledged_at = COALESCE(acknowledged_at, ?), acknowledged_by = COALESCE(acknowledged_by, ?), needs_attention = 0, updated_at = ? WHERE order_id = ?`,
          [now, user.id, now, id]
        );
        updated += res.changes;
      } else if (parsed.data.action === 'mark_processing') {
        const res = await db.run(
          `UPDATE orders SET order_status = 'processing', delivery_status = 'preparing', needs_attention = 0, updated_at = ? WHERE order_id = ? AND payment_status = 'payment_confirmed'`,
          [now, id]
        );
        updated += res.changes;
      } else if (parsed.data.action === 'mark_ready_for_dispatch') {
        const res = await db.run(
          `UPDATE orders SET order_status = 'ready_for_dispatch', delivery_status = 'ready_for_dispatch', needs_attention = 0, updated_at = ? WHERE order_id = ? AND payment_status = 'payment_confirmed'`,
          [now, id]
        );
        updated += res.changes;
      }
    }
    return c.json({ ok: true, updated });
  });

  // ==========================================
  // PAYMENT REVIEW (MANUAL BANK TRANSFER)
  // ==========================================
  app.get('/payments', requirePerm('payments:review'), async (c) => {
    const db = c.get('db');
    const rows = await db.all<Record<string, unknown>>(
      `SELECT p.*, o.order_number, o.customer_name, o.customer_email, o.total_kobo, o.order_status
       FROM payments p
       JOIN orders o ON o.order_id = p.order_id
       ORDER BY CASE WHEN p.status = 'payment_under_review' THEN 0 ELSE 1 END, p.updated_at DESC`
    );
    const evidence = await db.all(
      `SELECT * FROM payment_evidence ORDER BY created_at DESC`
    );
    const evMap = new Map<string, Record<string, unknown>[]>();
    for (const ev of evidence) {
      const oid = String(ev.order_id);
      if (!evMap.has(oid)) evMap.set(oid, []);
      evMap.get(oid)!.push(ev);
    }

    return c.json({
      payments: rows.map((r) => ({
        ...r,
        evidence: evMap.get(String(r.order_id)) || [],
      })),
    });
  });

  app.post('/payments/:orderId/verify', requirePerm('payments:review'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const orderId = c.req.param('orderId');

    const order = await db.get<Record<string, unknown>>(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return c.json({ error: 'Order not found' }, 404);
    const payment = await db.get<Record<string, unknown>>(`SELECT * FROM payments WHERE order_id = ?`, [orderId]);
    if (!payment) return c.json({ error: 'Payment record not found' }, 404);

    if (payment.status === 'payment_confirmed') {
      return c.json({ ok: true, idempotent: true });
    }

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE payments SET status = 'payment_confirmed', verified_by = ?, verified_at = ?, rejection_reason = '', updated_at = ? WHERE order_id = ?`,
        [user.id, now, now, orderId]
      );
      const nextOrderStatus = ['pending_payment', 'payment_under_review'].includes(String(order.order_status))
        ? 'payment_confirmed'
        : order.order_status;
      await tx.run(
        `UPDATE orders SET payment_status = 'payment_confirmed', order_status = ?, needs_attention = 0, updated_at = ? WHERE order_id = ?`,
        [nextOrderStatus, now, orderId]
      );
      await tx.run(
        `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
         VALUES (?, ?, 'payment', ?, 'payment_confirmed', ?, ?, 'Manual bank transfer verified and confirmed by administrator.', ?)`,
        [`hist_${randomUuid()}`, orderId, payment.status, user.id, user.name, now]
      );
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'PAYMENT_VERIFIED',
      targetType: 'order',
      targetId: orderId,
    });

    triggerOrderNotifications(db, env, {
      eventKey: 'payment_verified',
      orderId: String(order.order_id),
      orderNumber: String(order.order_number),
      customerName: String(order.customer_name),
      customerEmail: String(order.customer_email),
      statusLabel: 'Payment Confirmed',
      totalFormatted: formatNgn(Number(order.total_kobo)),
      customerTitle: 'Payment Confirmed',
      customerIntro:
        'Your manual bank transfer has been verified by our team. Your order is now queued for processing and dispatch.',
      adminTitle: 'Payment Verified',
      adminIntro: `Payment for order ${order.order_number} was verified by ${user.name}.`,
    }).catch(() => {});

    return c.json({ ok: true });
  });

  app.post('/payments/:orderId/reject', requirePerm('payments:review'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const orderId = c.req.param('orderId');
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim();
    if (reason.length < 3) return c.json({ error: 'Rejection reason is required.' }, 400);

    const order = await db.get<Record<string, unknown>>(`SELECT * FROM orders WHERE order_id = ?`, [orderId]);
    if (!order) return c.json({ error: 'Order not found' }, 404);
    const payment = await db.get<Record<string, unknown>>(`SELECT * FROM payments WHERE order_id = ?`, [orderId]);
    if (!payment) return c.json({ error: 'Payment record not found' }, 404);

    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx.run(
        `UPDATE payments SET status = 'payment_rejected', rejection_reason = ?, updated_at = ? WHERE order_id = ?`,
        [reason, now, orderId]
      );
      await tx.run(
        `UPDATE orders SET payment_status = 'payment_rejected', order_status = 'pending_payment', needs_attention = 1, updated_at = ? WHERE order_id = ?`,
        [now, orderId]
      );
      await tx.run(
        `INSERT INTO order_status_history (id, order_id, status_field, previous_status, new_status, actor_id, actor_name, note, created_at)
         VALUES (?, ?, 'payment', ?, 'payment_rejected', ?, ?, ?, ?)`,
        [`hist_${randomUuid()}`, orderId, payment.status, user.id, user.name, reason, now]
      );
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'PAYMENT_REJECTED',
      targetType: 'order',
      targetId: orderId,
      details: { reason },
    });

    triggerOrderNotifications(db, env, {
      eventKey: 'payment_rejected',
      orderId: String(order.order_id),
      orderNumber: String(order.order_number),
      customerName: String(order.customer_name),
      customerEmail: String(order.customer_email),
      statusLabel: 'Payment Rejected',
      totalFormatted: formatNgn(Number(order.total_kobo)),
      extraRows: [{ label: 'Reason', value: reason }],
      customerTitle: 'Payment Verification Issue',
      customerIntro: `We could not verify your payment evidence for order ${order.order_number}. Reason: ${reason}. Please upload a valid transfer receipt from the Track Order page.`,
      adminTitle: 'Payment Rejected',
      adminIntro: `Payment proof for order ${order.order_number} was rejected by ${user.name}. Reason: ${reason}`,
    }).catch(() => {});

    return c.json({ ok: true });
  });

  // ==========================================
  // PRODUCTS, CATEGORIES, COLLECTIONS & MEDIA
  // ==========================================
  app.get('/products', requirePerm('products:read'), async (c) => {
    const db = c.get('db');
    const products = await db.all<Record<string, unknown>>(
      `SELECT p.*, c.name as category_name, col.name as collection_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN collections col ON col.id = p.collection_id
       ORDER BY p.created_at DESC`
    );
    const variants = await db.all<Record<string, unknown>>(
      `SELECT * FROM product_variants ORDER BY created_at ASC`
    );
    const varMap = new Map<string, Record<string, unknown>[]>();
    for (const v of variants) {
      const pid = String(v.product_id);
      if (!varMap.has(pid)) varMap.set(pid, []);
      varMap.get(pid)!.push(v);
    }
    return c.json({
      products: products.map((p) => ({
        ...p,
        media: JSON.parse(String(p.media_json || '[]')),
        specifications: JSON.parse(String(p.specifications_json || '[]')),
        variants: varMap.get(String(p.id)) || [],
      })),
    });
  });

  app.post('/media/upload', requirePerm('products:write'), async (c) => {
    const storage = c.get('storage');
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) return c.json({ error: 'File required' }, 400);
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(file.type)) {
      return c.json({ error: 'Unsupported media format' }, 400);
    }
    if (file.size > 8 * 1024 * 1024) return c.json({ error: 'File exceeds 8MB limit' }, 400);

    const ext = file.type.split('/')[1] || 'bin';
    const fileName = `prod_${randomUuid()}.${ext}`;
    const key = `products/${fileName}`;
    await storage.put(key, new Uint8Array(await file.arrayBuffer()), file.type);
    return c.json({ ok: true, url: `/api/media/products/${fileName}` }, 201);
  });

  app.post('/products', requirePerm('products:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      name: z.string().min(2).max(160),
      sku: z.string().min(2).max(60),
      barcode: z.string().max(60).optional(),
      brand: z.string().max(80).optional(),
      shortDescription: z.string().max(300).optional(),
      description: z.string().max(8000).optional(),
      categoryId: z.string().nullable().optional(),
      collectionId: z.string().nullable().optional(),
      priceNaira: z.number().nonnegative(),
      salePriceNaira: z.number().nonnegative().nullable().optional(),
      costPriceNaira: z.number().nonnegative().nullable().optional(),
      stockQuantity: z.number().int().min(0).default(0),
      lowStockThreshold: z.number().int().min(0).default(5),
      status: z.enum(['draft', 'active', 'archived']).default('active'),
      isFeatured: z.boolean().default(false),
      media: z.array(z.string()).default([]),
      specifications: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
      variantName: z.string().default('Standard'),
      seoTitle: z.string().max(120).optional(),
      seoDescription: z.string().max(240).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message || 'Invalid product payload' }, 400);
    }

    const d = parsed.data;
    const productId = `prod_${randomUuid()}`;
    const variantId = `var_${randomUuid()}`;
    const slug = `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${randomHex(2)}`;
    const now = new Date().toISOString();

    const priceKobo = Math.round(d.priceNaira * 100);
    const salePriceKobo = d.salePriceNaira !== null && d.salePriceNaira !== undefined ? Math.round(d.salePriceNaira * 100) : null;
    const costPriceKobo = d.costPriceNaira !== null && d.costPriceNaira !== undefined ? Math.round(d.costPriceNaira * 100) : null;

    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO products (
          id, name, slug, sku, barcode, brand, short_description, description, specifications_json,
          category_id, collection_id, price_kobo, sale_price_kobo, cost_price_kobo,
          track_inventory, low_stock_threshold, status, is_featured, seo_title, seo_description,
          media_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          d.name.trim(),
          slug,
          d.sku.trim(),
          d.barcode || null,
          d.brand || 'SELLORA',
          d.shortDescription || '',
          d.description || '',
          JSON.stringify(d.specifications),
          d.categoryId || null,
          d.collectionId || null,
          priceKobo,
          salePriceKobo,
          costPriceKobo,
          d.lowStockThreshold,
          d.status,
          d.isFeatured ? 1 : 0,
          d.seoTitle || null,
          d.seoDescription || null,
          JSON.stringify(d.media),
          now,
          now,
        ]
      );

      await tx.run(
        `INSERT INTO product_variants (
          id, product_id, name, sku, barcode, attributes_json, price_kobo, sale_price_kobo, cost_price_kobo,
          stock_quantity, reserved_quantity, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
        [
          variantId,
          productId,
          d.variantName,
          d.sku.trim(),
          d.barcode || null,
          JSON.stringify({ Variant: d.variantName }),
          priceKobo,
          salePriceKobo,
          costPriceKobo,
          d.stockQuantity,
          now,
        ]
      );
    });

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'PRODUCT_CREATED',
      targetType: 'product',
      targetId: productId,
      details: { name: d.name, sku: d.sku },
    });

    return c.json({ ok: true, id: productId }, 201);
  });

  app.patch('/products/:id', requirePerm('products:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const now = new Date().toISOString();

    const priceKobo = body.priceNaira !== undefined ? Math.round(Number(body.priceNaira) * 100) : null;
    const salePriceKobo =
      body.salePriceNaira === null
        ? null
        : body.salePriceNaira !== undefined
          ? Math.round(Number(body.salePriceNaira) * 100)
          : undefined;
    const costPriceKobo =
      body.costPriceNaira === null
        ? null
        : body.costPriceNaira !== undefined
          ? Math.round(Number(body.costPriceNaira) * 100)
          : undefined;

    await db.run(
      `UPDATE products SET
        name = COALESCE(?, name),
        short_description = COALESCE(?, short_description),
        description = COALESCE(?, description),
        category_id = COALESCE(?, category_id),
        collection_id = COALESCE(?, collection_id),
        price_kobo = COALESCE(?, price_kobo),
        low_stock_threshold = COALESCE(?, low_stock_threshold),
        status = COALESCE(?, status),
        is_featured = COALESCE(?, is_featured),
        seo_title = COALESCE(?, seo_title),
        seo_description = COALESCE(?, seo_description),
        seo_canonical_url = COALESCE(?, seo_canonical_url),
        seo_image_url = COALESCE(?, seo_image_url),
        image_alt = COALESCE(?, image_alt),
        media_json = COALESCE(?, media_json),
        updated_at = ?
      WHERE id = ?`,
      [
        body.name ?? null,
        body.shortDescription ?? null,
        body.description ?? null,
        body.categoryId !== undefined ? body.categoryId : null,
        body.collectionId !== undefined ? body.collectionId : null,
        priceKobo,
        body.lowStockThreshold ?? null,
        body.status ?? null,
        body.isFeatured !== undefined ? (body.isFeatured ? 1 : 0) : null,
        body.seoTitle !== undefined ? body.seoTitle : null,
        body.seoDescription !== undefined ? body.seoDescription : null,
        body.seoCanonicalUrl !== undefined ? body.seoCanonicalUrl : null,
        body.seoImageUrl !== undefined ? body.seoImageUrl : null,
        body.imageAlt !== undefined ? body.imageAlt : null,
        body.media ? JSON.stringify(body.media) : null,
        now,
        id,
      ]
    );

    if (salePriceKobo !== undefined) {
      await db.run(`UPDATE products SET sale_price_kobo = ? WHERE id = ?`, [salePriceKobo, id]);
    }
    if (costPriceKobo !== undefined) {
      await db.run(`UPDATE products SET cost_price_kobo = ? WHERE id = ?`, [costPriceKobo, id]);
    }
    if (priceKobo !== null) {
      await db.run(`UPDATE product_variants SET price_kobo = ? WHERE product_id = ?`, [priceKobo, id]);
    }

    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: 'PRODUCT_UPDATED',
      targetType: 'product',
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.post('/products/:id/duplicate', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const id = c.req.param('id');
    const orig = await db.get<Record<string, unknown>>(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!orig) return c.json({ error: 'Product not found' }, 404);

    const newId = `prod_${randomUuid()}`;
    const suffix = randomHex(2).toUpperCase();
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO products (
        id, name, slug, sku, brand, short_description, description, specifications_json,
        category_id, collection_id, price_kobo, sale_price_kobo, cost_price_kobo,
        track_inventory, low_stock_threshold, status, is_featured, media_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?)`,
      [
        newId,
        `${orig.name} (Copy)`,
        `${orig.slug}-${suffix.toLowerCase()}`,
        `${orig.sku}-${suffix}`,
        orig.brand,
        orig.short_description,
        orig.description,
        orig.specifications_json,
        orig.category_id,
        orig.collection_id,
        orig.price_kobo,
        orig.sale_price_kobo,
        orig.cost_price_kobo,
        orig.track_inventory,
        orig.low_stock_threshold,
        orig.media_json,
        now,
        now,
      ]
    );
    await db.run(
      `INSERT INTO product_variants (id, product_id, name, sku, attributes_json, price_kobo, sale_price_kobo, cost_price_kobo, stock_quantity, reserved_quantity, is_active, created_at)
       VALUES (?, ?, 'Default', ?, '{}', ?, ?, ?, 0, 0, 1, ?)`,
      [
        `var_${randomUuid()}`,
        newId,
        `${orig.sku}-${suffix}-V1`,
        orig.price_kobo,
        orig.sale_price_kobo,
        orig.cost_price_kobo,
        now,
      ]
    );
    return c.json({ ok: true, id: newId }, 201);
  });

  app.delete('/products/:id', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const id = c.req.param('id');
    const ordered = await db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM order_items WHERE product_id = ?`,
      [id]
    );
    if ((ordered?.cnt ?? 0) > 0) {
      await db.run(`UPDATE products SET status = 'archived', updated_at = ? WHERE id = ?`, [
        new Date().toISOString(),
        id,
      ]);
      return c.json({ ok: true, archived: true });
    }
    await db.run(`DELETE FROM products WHERE id = ?`, [id]);
    return c.json({ ok: true, deleted: true });
  });

  app.get('/categories', requirePerm('products:read'), async (c) => {
    const db = c.get('db');
    return c.json({ categories: await db.all(`SELECT * FROM categories ORDER BY sort_order ASC`) });
  });

  app.post('/categories', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ error: 'Name required' }, 400);
    const id = `cat_${randomUuid()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await db.run(
      `INSERT INTO categories (id, name, slug, description, sort_order, is_active, seo_title, seo_description, created_at) VALUES (?, ?, ?, ?, 10, 1, ?, ?, ?)`,
      [
        id,
        name,
        slug,
        String(body.description || ''),
        body.seoTitle ? String(body.seoTitle) : null,
        body.seoDescription ? String(body.seoDescription) : null,
        new Date().toISOString(),
      ]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.patch('/categories/:id', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    await db.run(
      `UPDATE categories SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        seo_title = COALESCE(?, seo_title),
        seo_description = COALESCE(?, seo_description)
       WHERE id = ?`,
      [
        body.name ?? null,
        body.description ?? null,
        body.seoTitle ?? null,
        body.seoDescription ?? null,
        id,
      ]
    );
    return c.json({ ok: true });
  });

  app.get('/collections', requirePerm('products:read'), async (c) => {
    const db = c.get('db');
    return c.json({ collections: await db.all(`SELECT * FROM collections ORDER BY name ASC`) });
  });

  app.post('/collections', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    if (!name) return c.json({ error: 'Name required' }, 400);
    const id = `col_${randomUuid()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await db.run(
      `INSERT INTO collections (id, name, slug, description, is_featured, is_active, created_at) VALUES (?, ?, ?, ?, 1, 1, ?)`,
      [id, name, slug, String(body.description || ''), new Date().toISOString()]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.get('/reviews', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const reviews = await db.all(
      `SELECT r.*, p.name as product_name FROM reviews r JOIN products p ON p.id = r.product_id ORDER BY r.created_at DESC`
    );
    return c.json({ reviews });
  });

  app.patch('/reviews/:id', requirePerm('products:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(`UPDATE reviews SET status = COALESCE(?, status), admin_reply = COALESCE(?, admin_reply) WHERE id = ?`, [
      body.status ?? null,
      body.adminReply ?? null,
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  });

  // ==========================================
  // INVENTORY MANAGEMENT
  // ==========================================
  app.get('/inventory', requirePerm('products:read'), async (c) => {
    const db = c.get('db');
    const items = await db.all(
      `SELECT pv.*, p.name as product_name, p.low_stock_threshold, p.status as product_status
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       ORDER BY pv.stock_quantity ASC`
    );
    const movements = await db.all(
      `SELECT im.*, p.name as product_name, pv.name as variant_name, pv.sku
       FROM inventory_movements im
       JOIN products p ON p.id = im.product_id
       JOIN product_variants pv ON pv.id = im.variant_id
       ORDER BY im.created_at DESC LIMIT 100`
    );
    return c.json({ items, movements });
  });

  app.post('/inventory/adjust', requirePerm('inventory:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      variantId: z.string().min(1),
      changeAmount: z.number().int().refine((n) => n !== 0),
      reason: z.string().min(2).max(200),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid stock adjustment' }, 400);

    try {
      await db.transaction(async (tx) => {
        const v = await tx.get<{ id: string; product_id: string; stock_quantity: number }>(
          `SELECT id, product_id, stock_quantity FROM product_variants WHERE id = ?`,
          [parsed.data.variantId]
        );
        if (!v) throw new Error('Variant not found');
        const newQty = v.stock_quantity + parsed.data.changeAmount;
        if (newQty < 0) throw new Error('Stock cannot drop below zero');

        await tx.run(`UPDATE product_variants SET stock_quantity = ? WHERE id = ?`, [newQty, v.id]);
        await tx.run(
          `INSERT INTO inventory_movements (id, product_id, variant_id, change_amount, previous_qty, new_qty, reason, reference_type, actor_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'manual_adjustment', ?, ?)`,
          [
            `mov_${randomUuid()}`,
            v.product_id,
            v.id,
            parsed.data.changeAmount,
            v.stock_quantity,
            newQty,
            parsed.data.reason.trim(),
            user.id,
            new Date().toISOString(),
          ]
        );
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Stock adjustment failed' }, 400);
    }
  });

  // ==========================================
  // CUSTOMERS, SUPPORT & PRIVACY
  // ==========================================
  app.get('/customers', requirePerm('customers:read'), async (c) => {
    const db = c.get('db');
    const customers = await db.all(
      `SELECT u.id, u.name, u.email, u.phone, u.emailVerified, u.isActive, u.customerNotes, u.createdAt,
              COUNT(o.order_id) as order_count,
              COALESCE(SUM(CASE WHEN o.order_status != 'cancelled' THEN o.total_kobo ELSE 0 END), 0) as total_spent_kobo
       FROM user u
       LEFT JOIN orders o ON o.customer_id = u.id
       WHERE u.role = 'customer'
       GROUP BY u.id
       ORDER BY u.createdAt DESC`
    );
    return c.json({ customers });
  });

  app.patch('/customers/:id/notes', requirePerm('customers:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(`UPDATE user SET customerNotes = ?, updatedAt = ? WHERE id = ? AND role = 'customer'`, [
      String(body.notes || ''),
      new Date().toISOString(),
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  });

  app.get('/support', requirePerm('customers:read'), async (c) => {
    const db = c.get('db');
    return c.json({
      tickets: await db.all(`SELECT * FROM support_tickets ORDER BY created_at DESC`),
      privacyRequests: await db.all(
        `SELECT pr.*, u.name, u.email FROM privacy_requests pr JOIN user u ON u.id = pr.customer_id ORDER BY pr.created_at DESC`
      ),
    });
  });

  app.patch('/support/:id', requirePerm('customers:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(
      `UPDATE support_tickets SET status = COALESCE(?, status), admin_reply = COALESCE(?, admin_reply), updated_at = ? WHERE id = ?`,
      [body.status ?? null, body.adminReply ?? null, new Date().toISOString(), c.req.param('id')]
    );
    return c.json({ ok: true });
  });

  app.patch('/privacy-requests/:id', requirePerm('customers:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(`UPDATE privacy_requests SET status = ?, updated_at = ? WHERE id = ?`, [
      String(body.status || 'completed'),
      new Date().toISOString(),
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  });

  // ==========================================
  // DELIVERY ZONES (NIGERIA)
  // ==========================================
  app.get('/delivery-zones', requirePerm('delivery:write'), async (c) => {
    const db = c.get('db');
    const zones = await db.all(`SELECT * FROM delivery_zones ORDER BY state ASC, lga ASC`);
    return c.json({ zones });
  });

  app.post('/delivery-zones', requirePerm('delivery:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      state: z.string().min(2),
      lga: z.string().min(1).default('*'),
      locationName: z.string().default(''),
      feeNaira: z.number().min(0),
      freeThresholdNaira: z.number().min(0).nullable().optional(),
      estimatedDaysMin: z.number().int().min(1).default(1),
      estimatedDaysMax: z.number().int().min(1).default(3),
      isEnabled: z.boolean().default(true),
      instructions: z.string().default(''),
      courierName: z.string().default(''),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid delivery zone data' }, 400);

    const d = parsed.data;
    const id = `dz_${randomUuid()}`;
    await db.run(
      `INSERT INTO delivery_zones (
        id, state, lga, location_name, fee_kobo, free_threshold_kobo,
        estimated_days_min, estimated_days_max, is_enabled, instructions, courier_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        d.state.trim(),
        d.lga.trim() || '*',
        d.locationName.trim(),
        Math.round(d.feeNaira * 100),
        d.freeThresholdNaira !== null && d.freeThresholdNaira !== undefined
          ? Math.round(d.freeThresholdNaira * 100)
          : null,
        d.estimatedDaysMin,
        d.estimatedDaysMax,
        d.isEnabled ? 1 : 0,
        d.instructions.trim(),
        d.courierName.trim(),
        new Date().toISOString(),
      ]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.patch('/delivery-zones/:id', requirePerm('delivery:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(
      `UPDATE delivery_zones SET
        fee_kobo = COALESCE(?, fee_kobo),
        free_threshold_kobo = ?,
        estimated_days_min = COALESCE(?, estimated_days_min),
        estimated_days_max = COALESCE(?, estimated_days_max),
        is_enabled = COALESCE(?, is_enabled),
        instructions = COALESCE(?, instructions),
        courier_name = COALESCE(?, courier_name),
        updated_at = ?
      WHERE id = ?`,
      [
        body.feeNaira !== undefined ? Math.round(Number(body.feeNaira) * 100) : null,
        body.freeThresholdNaira === null
          ? null
          : body.freeThresholdNaira !== undefined
            ? Math.round(Number(body.freeThresholdNaira) * 100)
            : null,
        body.estimatedDaysMin ?? null,
        body.estimatedDaysMax ?? null,
        body.isEnabled !== undefined ? (body.isEnabled ? 1 : 0) : null,
        body.instructions ?? null,
        body.courierName ?? null,
        new Date().toISOString(),
        c.req.param('id'),
      ]
    );
    return c.json({ ok: true });
  });

  app.delete('/delivery-zones/:id', requirePerm('delivery:write'), async (c) => {
    const db = c.get('db');
    await db.run(`DELETE FROM delivery_zones WHERE id = ?`, [c.req.param('id')]);
    return c.json({ ok: true });
  });

  // ==========================================
  // MARKETING & COUPONS
  // ==========================================
  app.get('/coupons', requirePerm('marketing:write'), async (c) => {
    const db = c.get('db');
    return c.json({
      coupons: await db.all(`SELECT * FROM coupons ORDER BY created_at DESC`),
      subscribers: await db.all(`SELECT * FROM newsletter_subscribers ORDER BY created_at DESC`),
    });
  });

  app.post('/coupons', requirePerm('marketing:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      code: z.string().min(3).max(40),
      description: z.string().max(200).default(''),
      discountType: z.enum(['percentage', 'fixed']),
      discountValue: z.number().positive(),
      minSpendNaira: z.number().min(0).default(0),
      maxUses: z.number().int().positive().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid coupon data' }, 400);

    const d = parsed.data;
    const val = d.discountType === 'percentage' ? Math.min(100, Math.round(d.discountValue)) : Math.round(d.discountValue * 100);
    const id = `cpn_${randomUuid()}`;
    await db.run(
      `INSERT INTO coupons (id, code, description, discount_type, discount_value, min_spend_kobo, max_uses, expires_at, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        id,
        d.code.trim().toUpperCase(),
        d.description,
        d.discountType,
        val,
        Math.round(d.minSpendNaira * 100),
        d.maxUses ?? null,
        d.expiresAt ?? null,
        new Date().toISOString(),
      ]
    );
    return c.json({ ok: true, id }, 201);
  });

  app.patch('/coupons/:id', requirePerm('marketing:write'), async (c) => {
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    await db.run(`UPDATE coupons SET is_active = ? WHERE id = ?`, [
      body.isActive ? 1 : 0,
      c.req.param('id'),
    ]);
    return c.json({ ok: true });
  });

  app.delete('/coupons/:id', requirePerm('marketing:write'), async (c) => {
    const db = c.get('db');
    await db.run(`DELETE FROM coupons WHERE id = ?`, [c.req.param('id')]);
    return c.json({ ok: true });
  });

  // ==========================================
  // POINT OF SALE (POS)
  // ==========================================
  app.post('/pos/order', requirePerm('pos:use'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      items: z.array(z.object({ productId: z.string(), variantId: z.string(), quantity: z.number().int().min(1) })).min(1),
      customerName: z.string().min(2).default('Walk-in Customer'),
      customerEmail: z.string().email().optional(),
      customerPhone: z.string().default(''),
      discountNaira: z.number().min(0).default(0),
      markPaid: z.boolean().default(false),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid POS order' }, 400);

    try {
      const created = await db.transaction(async (tx) => {
        let subtotalKobo = 0;
        const orderId = `ord_${randomUuid()}`;
        const orderNumber = `POS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomHex(2).toUpperCase()}`;
        const now = new Date().toISOString();
        const itemsResolved: any[] = [];

        for (const reqItem of parsed.data.items) {
          const prod = await tx.get<Record<string, unknown>>(`SELECT * FROM products WHERE id = ?`, [reqItem.productId]);
          const variant = await tx.get<Record<string, unknown>>(`SELECT * FROM product_variants WHERE id = ?`, [reqItem.variantId]);
          if (!prod || !variant) throw new Error('Product or variant not found');

          const dec = await tx.run(
            `UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?`,
            [reqItem.quantity, variant.id, reqItem.quantity]
          );
          if (dec.changes === 0) throw new Error(`Insufficient stock for ${prod.name}`);

          const unitPriceKobo = Number(variant.sale_price_kobo ?? variant.price_kobo);
          const lineTotal = unitPriceKobo * reqItem.quantity;
          subtotalKobo += lineTotal;
          itemsResolved.push({
            orderItemId: `oi_${randomUuid()}`,
            productId: prod.id,
            variantId: variant.id,
            productName: prod.name,
            variantName: variant.name,
            sku: variant.sku,
            quantity: reqItem.quantity,
            unitPriceKobo,
            costPriceKobo: variant.cost_price_kobo ?? prod.cost_price_kobo ?? null,
            lineTotal,
            prevStock: Number(variant.stock_quantity),
          });
        }

        const discountKobo = Math.min(subtotalKobo, Math.round(parsed.data.discountNaira * 100));
        const totalKobo = subtotalKobo - discountKobo;
        const payStatus = parsed.data.markPaid ? 'payment_confirmed' : 'pending_payment';
        const ordStatus = parsed.data.markPaid ? 'delivered' : 'pending_payment';

        await tx.run(
          `INSERT INTO orders (
            order_id, order_number, customer_name, customer_email, customer_phone,
            delivery_address_snapshot_json, delivery_fee_kobo, subtotal_kobo, discount_kobo, total_kobo,
            order_status, payment_status, delivery_status, acknowledged_at, acknowledged_by, needs_attention, source, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pos', ?, ?)`,
          [
            orderId,
            orderNumber,
            parsed.data.customerName,
            parsed.data.customerEmail || 'walkin@sellora.local',
            parsed.data.customerPhone,
            JSON.stringify({ state: 'In-Store POS', lga: 'In-Store', city: 'In-Store', streetAddress: 'Point of Sale Counter' }),
            subtotalKobo,
            discountKobo,
            totalKobo,
            ordStatus,
            payStatus,
            parsed.data.markPaid ? 'delivered' : 'awaiting_fulfilment',
            now,
            user.id,
            now,
            now,
          ]
        );

        for (const it of itemsResolved) {
          await tx.run(
            `INSERT INTO order_items (order_item_id, order_id, product_id, variant_id, product_name, variant_name, sku, quantity, unit_price_kobo, cost_price_kobo, line_total_kobo)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [it.orderItemId, orderId, it.productId, it.variantId, it.productName, it.variantName, it.sku, it.quantity, it.unitPriceKobo, it.costPriceKobo, it.lineTotal]
          );
          await tx.run(
            `INSERT INTO inventory_movements (id, product_id, variant_id, change_amount, previous_qty, new_qty, reason, reference_type, reference_id, actor_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'POS Sale', 'order', ?, ?, ?)`,
            [`mov_${randomUuid()}`, it.productId, it.variantId, -it.quantity, it.prevStock, it.prevStock - it.quantity, orderId, user.id, now]
          );
        }

        await tx.run(
          `INSERT INTO payments (id, order_id, method, expected_amount_kobo, status, verified_by, verified_at, created_at, updated_at)
           VALUES (?, ?, 'pos_manual', ?, ?, ?, ?, ?, ?)`,
          [`pay_${randomUuid()}`, orderId, totalKobo, payStatus, parsed.data.markPaid ? user.id : null, parsed.data.markPaid ? now : null, now, now]
        );

        return { orderId, orderNumber, totalKobo };
      });
      return c.json({ ok: true, ...created }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'POS order failed' }, 400);
    }
  });

  // ==========================================
  // SETTINGS, EMAIL CONFIG, OUTBOX & STAFF
  // ==========================================
  app.get('/settings', requirePerm('settings:write'), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const rows = await db.all<{ key: string; value_json: string }>(`SELECT key, value_json FROM store_settings`);
    const map: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        map[r.key] = JSON.parse(r.value_json);
      } catch {
        map[r.key] = r.value_json;
      }
    }
    const effectiveEmail = await getEffectiveEmailConfig(db, env);
    const effectiveSeo = await getEffectiveSeoConfig(db, env);
    map.seo = effectiveSeo;

    const ownerRecord = await db.get<{
      id: string;
      name: string;
      email: string;
      emailVerified: number;
      isActive: number;
      createdAt: string;
    }>(`SELECT id, name, email, emailVerified, isActive, createdAt FROM user WHERE role = 'owner' LIMIT 1`);

    const zoneSummary = await db.get<{ enabled_count: number; state_count: number }>(
      `SELECT COUNT(*) as enabled_count, COUNT(DISTINCT state) as state_count FROM delivery_zones WHERE is_enabled = 1`
    );
    const prodSeoSummary = await db.get<{ total_active: number; with_seo: number }>(
      `SELECT COUNT(*) as total_active, SUM(CASE WHEN COALESCE(seo_title, '') != '' OR COALESCE(seo_description, '') != '' THEN 1 ELSE 0 END) as with_seo FROM products WHERE status = 'active'`
    );
    const isEdgeD1 = !db.rawSqlite;

    return c.json({
      settings: map,
      emailStatus: {
        hasBrevoApiKey: effectiveEmail.hasApiKey,
        resolvedFromEmail: effectiveEmail.fromEmail,
        resolvedAdminEmail: effectiveEmail.adminNotificationEmail,
      },
      ownerSummary: {
        designatedOwnerEmail: env.ownerEmail || 'olarindevictor3@gmail.com',
        ownerExists: Boolean(ownerRecord),
        ownerRecord,
        googleOAuthConfigured: Boolean(env.googleClientId && env.googleClientSecret),
        authMethods: ['google', 'email_password'],
      },
      deliverySummary: {
        enabledZones: Number(zoneSummary?.enabled_count || 0),
        coveredStates: Number(zoneSummary?.state_count || 0),
      },
      seoSummary: {
        activeProducts: Number(prodSeoSummary?.total_active || 0),
        productsWithSeo: Number(prodSeoSummary?.with_seo || 0),
        indexingEnabled: effectiveSeo.indexingEnabled,
        searchConsoleConfigured: Boolean(effectiveSeo.googleSiteVerification),
        sitemapUrl: '/sitemap.xml',
        robotsUrl: '/robots.txt',
      },
      integrationStatus: [
        {
          id: 'google_oauth',
          name: 'Google OAuth (Better Auth)',
          status:
            env.googleClientId && env.googleClientSecret ? 'connected' : 'awaiting_credentials',
          detail:
            env.googleClientId && env.googleClientSecret
              ? 'Client ID and Secret active on server.'
              : 'Awaiting GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        },
        {
          id: 'google_analytics',
          name: 'Google Analytics 4 (GA4)',
          status: effectiveSeo.gaMeasurementId ? 'connected' : 'not_configured',
          detail: effectiveSeo.gaMeasurementId
            ? `Measurement ID ${effectiveSeo.gaMeasurementId} active.`
            : 'Optional: set VITE_GA_MEASUREMENT_ID or enter a valid Measurement ID in Analytics settings.',
        },
        {
          id: 'google_search_console',
          name: 'Google Search Console',
          status: effectiveSeo.googleSiteVerification ? 'connected' : 'not_configured',
          detail: effectiveSeo.googleSiteVerification
            ? 'HTML meta verification token injected into public <head>.'
            : 'Optional: enter verification meta token in SEO Settings or GOOGLE_SITE_VERIFICATION.',
        },
        {
          id: 'brevo',
          name: 'Brevo Transactional Email',
          status:
            effectiveEmail.hasApiKey && effectiveEmail.fromEmail
              ? 'connected'
              : effectiveEmail.hasApiKey
                ? 'awaiting_credentials'
                : 'not_configured',
          detail: effectiveEmail.hasApiKey
            ? effectiveEmail.fromEmail
              ? `Sender ${effectiveEmail.fromEmail} active.`
              : 'BREVO_API_KEY set; configure BREVO_FROM_EMAIL (verified sender).'
            : 'Awaiting BREVO_API_KEY in server environment.',
        },
        {
          id: 'cloudflare_workers',
          name: 'Cloudflare Workers Runtime',
          status: isEdgeD1 ? 'connected' : 'awaiting_credentials',
          detail: isEdgeD1
            ? 'Running on Cloudflare Workers edge runtime.'
            : 'Edge worker/index.ts ready; currently running on local Node dev server.',
        },
        {
          id: 'cloudflare_d1',
          name: 'Cloudflare D1 Database',
          status: isEdgeD1 ? 'connected' : 'awaiting_credentials',
          detail: isEdgeD1
            ? 'Connected to D1 DB binding.'
            : 'Production D1 binding active in worker/index.ts; local Node preview runs on embedded .data/sellora.db without requiring SQLITE_DB_PATH.',
        },
        {
          id: 'cloudflare_r2',
          name: 'Cloudflare R2 Storage',
          status: isEdgeD1 ? 'connected' : 'awaiting_credentials',
          detail: isEdgeD1
            ? 'Connected to R2_MEDIA bucket.'
            : 'R2 adapter wired for Workers; dev server using local .data/r2 fallback.',
        },
        {
          id: 'turnstile',
          name: 'Cloudflare Turnstile (Optional)',
          status:
            env.turnstileSecretKey?.trim() && env.turnstileSiteKey?.trim()
              ? 'connected'
              : 'not_configured',
          detail:
            env.turnstileSecretKey?.trim() && env.turnstileSiteKey?.trim()
              ? 'Both site key and server secret active; widget and verification enforced.'
              : env.turnstileSecretKey?.trim() && !env.turnstileSiteKey?.trim()
                ? 'TURNSTILE_SECRET_KEY set; disabled gracefully until VITE_TURNSTILE_SITE_KEY is also configured.'
                : !env.turnstileSecretKey?.trim() && env.turnstileSiteKey?.trim()
                  ? 'VITE_TURNSTILE_SITE_KEY set; disabled gracefully until TURNSTILE_SECRET_KEY is also configured.'
                  : 'Optional bot protection disabled (set both TURNSTILE_SECRET_KEY and VITE_TURNSTILE_SITE_KEY before public launch).',
        },
      ],
    });
  });

  app.put('/settings/:key', requirePerm('settings:write'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const key = c.req.param('key');
    if (!['theme', 'bank_transfer', 'email', 'seo'].includes(key)) {
      return c.json({ error: 'Invalid settings key' }, 400);
    }
    if (
      (key === 'bank_transfer' || key === 'email' || key === 'seo') &&
      !user.permissions.includes('owner:settings')
    ) {
      return c.json(
        {
          error:
            'Only the store owner can modify bank transfer, transactional email, or SEO/analytics settings.',
        },
        403
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO store_settings (key, value_json, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key, JSON.stringify(body), now, user.id]
    );
    await writeAuditLog(db, {
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role,
      action: `SETTINGS_UPDATED_${key.toUpperCase()}`,
      targetType: 'settings',
      targetId: key,
    });
    return c.json({ ok: true });
  });

  app.get('/email/history', requirePerm('email:manage'), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const events = await db.all(
      `SELECT event_id, idempotency_key, order_id, order_number, recipient_email, recipient_type,
              notification_type, subject, status, provider_message_id, attempt_count, max_attempts,
              last_error, next_retry_at, created_at, updated_at
       FROM email_notification_events ORDER BY created_at DESC LIMIT 150`
    );
    const effective = await getEffectiveEmailConfig(db, env);
    return c.json({
      events,
      config: effective,
    });
  });

  app.post('/email/test', requirePerm('email:manage'), async (c) => {
    const user = c.get('user')!;
    const db = c.get('db');
    const env = c.get('env');
    const body = await c.req.json().catch(() => ({}));
    const effective = await getEffectiveEmailConfig(db, env);
    const recipient = String(body.recipient || effective.testEmailRecipient || '').trim();
    if (!recipient) {
      return c.json({ error: 'Configure a test email recipient first.' }, 400);
    }

    const html = renderSelloraEmailHtml({
      title: 'SELLORA Test Transactional Email',
      greeting: `Hello ${user.name},`,
      intro:
        'This is a manual test email triggered from Admin Dashboard -> Settings -> Email & Notifications to verify Brevo API connectivity.',
      detailsRows: [
        { label: 'Triggered By', value: user.email },
        { label: 'Sender Name', value: effective.fromName },
        { label: 'Sender Email', value: effective.fromEmail || 'Not configured' },
      ],
    });

    const queued = await queueEmailEvent(db, {
      idempotencyKey: `test:${user.id}:${Date.now()}`,
      recipientEmail: recipient,
      recipientType: 'test',
      notificationType: 'admin_test_email',
      subject: '[SELLORA] Transactional Email Configuration Test',
      htmlBody: html,
    });
    if (!queued.eventId) {
      return c.json({ error: 'Invalid test recipient email address.' }, 400);
    }

    const result = await dispatchSingleEmailEvent(db, env, queued.eventId);
    return c.json({ eventId: queued.eventId, ...result }, result.ok ? 200 : 502);
  });

  app.post('/email/retry/:eventId', requirePerm('email:manage'), async (c) => {
    const db = c.get('db');
    const env = c.get('env');
    const eventId = c.req.param('eventId');
    await db.run(
      `UPDATE email_notification_events SET status = 'queued', max_attempts = max_attempts + 1, updated_at = ? WHERE event_id = ?`,
      [new Date().toISOString(), eventId]
    );
    const result = await dispatchSingleEmailEvent(db, env, eventId);
    return c.json(result);
  });

  app.post('/email/process-queue', requirePerm('email:manage'), async (c) => {
    const count = await processEmailOutbox(c.get('db'), c.get('env'), 20);
    return c.json({ ok: true, processed: count });
  });

  // Staff Management (Owner Only)
  app.get('/staff', requirePerm('staff:manage'), async (c) => {
    const actor = c.get('user')!;
    if (actor.role !== 'owner') {
      return c.json({ error: 'Only the store owner can manage staff accounts.' }, 403);
    }
    const db = c.get('db');
    const staff = await db.all(
      `SELECT id, name, email, role, phone, permissionsJson, isActive, createdAt FROM user WHERE role != 'customer' ORDER BY createdAt ASC`
    );
    return c.json({
      staff: staff.map((s) => ({
        ...s,
        permissions: JSON.parse(String(s.permissionsJson || '[]')),
      })),
      availableRoles: STAFF_ROLES,
      allPermissions: ALL_PERMISSIONS,
      roleDefaults: ROLE_DEFAULT_PERMISSIONS,
    });
  });

  app.post('/staff', requirePerm('staff:manage'), async (c) => {
    const actor = c.get('user')!;
    if (actor.role !== 'owner') {
      return c.json({ error: 'Only the store owner can create staff accounts.' }, 403);
    }
    const db = c.get('db');
    const auth = c.get('auth');
    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      name: z.string().min(2).max(100),
      email: z.string().email(),
      password: z.string().min(8).max(128),
      role: z.enum(['admin', 'staff', 'manager', 'order_staff', 'inventory_staff', 'support_staff']),
      permissions: z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid staff input' }, 400);

    const email = parsed.data.email.trim().toLowerCase();
    const existing = await db.get<{ id: string }>(`SELECT id FROM user WHERE email = ?`, [email]);
    if (existing) return c.json({ error: 'A user with this email already exists.' }, 409);

    const signUpRes = await auth.api.signUpEmail({
      body: { name: parsed.data.name.trim(), email, password: parsed.data.password },
      asResponse: true,
    });
    if (!signUpRes.ok) return c.json({ error: 'Failed to create staff credentials.' }, 400);

    const perms = parsed.data.permissions?.length
      ? parsed.data.permissions
      : ROLE_DEFAULT_PERMISSIONS[parsed.data.role];

    await db.run(
      `UPDATE user SET role = ?, permissionsJson = ?, emailVerified = 1, updatedAt = ? WHERE email = ?`,
      [parsed.data.role, JSON.stringify(perms), new Date().toISOString(), email]
    );

    await writeAuditLog(db, {
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: 'STAFF_CREATED',
      targetType: 'user',
      targetId: email,
      details: { role: parsed.data.role, permissions: perms },
    });

    return c.json({ ok: true }, 201);
  });

  app.patch('/staff/:id', requirePerm('staff:manage'), async (c) => {
    const actor = c.get('user')!;
    if (actor.role !== 'owner') {
      return c.json({ error: 'Only the store owner can modify staff accounts.' }, 403);
    }
    const db = c.get('db');
    const targetId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));

    const target = await db.get<{ id: string; role: string }>(`SELECT id, role FROM user WHERE id = ?`, [targetId]);
    if (!target) return c.json({ error: 'Staff user not found' }, 404);
    if (target.role === 'owner') {
      return c.json({ error: 'Owner privileges cannot be modified or deactivated through staff management.' }, 403);
    }
    if (body.role === 'owner') {
      return c.json({ error: 'Cannot promote an account to store owner.' }, 403);
    }

    const allowedRoles = ['admin', 'staff', 'manager', 'order_staff', 'inventory_staff', 'support_staff', 'customer'];
    if (body.role && !allowedRoles.includes(String(body.role))) {
      return c.json({ error: 'Invalid role' }, 400);
    }
    const nextRole = (body.role ? String(body.role) : target.role) as StaffRole;
    const perms = Array.isArray(body.permissions)
      ? body.permissions
      : ROLE_DEFAULT_PERMISSIONS[nextRole];

    await db.run(
      `UPDATE user SET role = ?, permissionsJson = ?, isActive = COALESCE(?, isActive), updatedAt = ? WHERE id = ?`,
      [
        nextRole,
        JSON.stringify(perms),
        body.isActive !== undefined ? (body.isActive ? 1 : 0) : null,
        new Date().toISOString(),
        targetId,
      ]
    );

    await writeAuditLog(db, {
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: 'STAFF_UPDATED',
      targetType: 'user',
      targetId,
      details: { nextRole, isActive: body.isActive },
    });
    return c.json({ ok: true });
  });

  app.get('/sessions', requirePerm('staff:manage'), async (c) => {
    const actor = c.get('user')!;
    if (actor.role !== 'owner') {
      return c.json({ error: 'Only the store owner can view active sessions.' }, 403);
    }
    const db = c.get('db');
    const sessions = await db.all(
      `SELECT s.id, s.userId, s.expiresAt, s.createdAt, s.userAgent, u.name, u.email, u.role
       FROM session s
       JOIN user u ON u.id = s.userId
       ORDER BY s.createdAt DESC LIMIT 50`
    );
    return c.json({ sessions });
  });

  app.delete('/sessions/:id', requirePerm('staff:manage'), async (c) => {
    const actor = c.get('user')!;
    if (actor.role !== 'owner') {
      return c.json({ error: 'Only the store owner can revoke sessions.' }, 403);
    }
    const db = c.get('db');
    const id = c.req.param('id');
    await db.run(`DELETE FROM session WHERE id = ?`, [id]);
    await writeAuditLog(db, {
      actorId: actor.id,
      actorEmail: actor.email,
      actorRole: actor.role,
      action: 'SESSION_REVOKED',
      targetType: 'session',
      targetId: id,
    });
    return c.json({ ok: true });
  });

  app.get('/audit-logs', requirePerm('audit:read'), async (c) => {
    const db = c.get('db');
    const logs = await db.all(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150`);
    return c.json({ logs });
  });

  return app;
}
