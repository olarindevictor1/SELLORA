export type StaffRole =
  | 'owner'
  | 'admin'
  | 'staff'
  | 'manager'
  | 'order_staff'
  | 'inventory_staff'
  | 'support_staff'
  | 'customer';

export const STAFF_ROLES: StaffRole[] = [
  'owner',
  'admin',
  'staff',
  'manager',
  'order_staff',
  'inventory_staff',
  'support_staff',
];

export const ALL_PERMISSIONS = [
  'orders:read',
  'orders:write',
  'orders:refund',
  'payments:review',
  'products:read',
  'products:write',
  'inventory:write',
  'customers:read',
  'customers:write',
  'delivery:write',
  'marketing:write',
  'analytics:read',
  'settings:write',
  'owner:settings',
  'email:manage',
  'staff:manage',
  'audit:read',
  'pos:use',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

export const ROLE_DEFAULT_PERMISSIONS: Record<StaffRole, Permission[]> = {
  owner: [...ALL_PERMISSIONS],
  admin: ALL_PERMISSIONS.filter(
    (p) => p !== 'staff:manage' && p !== 'audit:read' && p !== 'owner:settings'
  ),
  staff: [
    'orders:read',
    'orders:write',
    'payments:review',
    'products:read',
    'products:write',
    'inventory:write',
    'customers:read',
    'pos:use',
  ],
  manager: [
    'orders:read',
    'orders:write',
    'payments:review',
    'products:read',
    'products:write',
    'inventory:write',
    'customers:read',
    'delivery:write',
    'marketing:write',
    'analytics:read',
    'pos:use',
  ],
  order_staff: ['orders:read', 'orders:write', 'payments:review', 'pos:use'],
  inventory_staff: ['products:read', 'products:write', 'inventory:write'],
  support_staff: ['orders:read', 'customers:read', 'customers:write'],
  customer: [],
};

export const ORDER_STATUSES = [
  'pending_payment',
  'payment_under_review',
  'payment_confirmed',
  'processing',
  'ready_for_dispatch',
  'out_for_delivery',
  'delivered',
  'cancellation_requested',
  'cancelled',
  'refund_pending',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: 'Pending Payment',
  payment_under_review: 'Payment Under Review',
  payment_confirmed: 'Payment Confirmed',
  processing: 'Processing',
  ready_for_dispatch: 'Ready for Dispatch',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancellation_requested: 'Cancellation Requested',
  cancelled: 'Cancelled',
  refund_pending: 'Refund Pending',
  refunded: 'Refunded',
};

export const PAYMENT_STATUSES = [
  'pending_payment',
  'payment_under_review',
  'payment_confirmed',
  'payment_rejected',
  'refund_pending',
  'refunded',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending_payment: 'Pending Payment',
  payment_under_review: 'Payment Under Review',
  payment_confirmed: 'Payment Confirmed',
  payment_rejected: 'Payment Rejected',
  refund_pending: 'Refund Pending',
  refunded: 'Refunded',
};

export const DELIVERY_STATUSES = [
  'awaiting_fulfilment',
  'preparing',
  'ready_for_dispatch',
  'out_for_delivery',
  'delivered',
  'cancelled',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  awaiting_fulfilment: 'Awaiting Fulfilment',
  preparing: 'Preparing Package',
  ready_for_dispatch: 'Ready for Dispatch',
  out_for_delivery: 'Out for Delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export function formatNgn(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined || Number.isNaN(kobo)) {
    return '₦0.00';
  }
  const naira = kobo / 100;
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: kobo % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(naira);
}

export function formatLagosDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}
