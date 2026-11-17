import { betterAuth, APIError } from 'better-auth';
import { randomUuid } from './crypto';
import type { SelloraDb } from './db';
import {
  dispatchSingleEmailEvent,
  getEffectiveEmailConfig,
  notifyCustomerWelcomeEmail,
  queueEmailEvent,
  renderSelloraEmailHtml,
  type EmailEnvConfig,
} from './email';
import {
  clearLoginThrottle,
  extractSessionTokenFromHeaders,
  recordSecurityEvent,
  writeAuditLog,
} from './security';
import { ROLE_DEFAULT_PERMISSIONS, type Permission, type StaffRole } from '../shared/types';

export interface AuthUserSession {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: StaffRole;
  phone: string | null;
  permissions: Permission[];
  isActive: boolean;
  notifyOrderUpdates: boolean;
  notifyPromotions: boolean;
}

export function createSelloraAuth(params: {
  database: unknown;
  db: SelloraDb;
  baseURL: string;
  secret: string;
  emailEnv: EmailEnvConfig;
  ownerEmail?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  corsAllowedOrigins?: string[];
}) {
  const authorizedOwnerEmail = (params.ownerEmail || 'olarindevictor046@gmail.com')
    .trim()
    .toLowerCase();
  const socialProviders: Record<
    string,
    { clientId: string; clientSecret: string; prompt?: 'select_account' }
  > = {};
  if (params.googleClientId && params.googleClientSecret) {
    socialProviders.google = {
      clientId: params.googleClientId,
      clientSecret: params.googleClientSecret,
      prompt: 'select_account',
    };
  }

  const normalizedBaseUrl = params.baseURL.replace(/\/+$/, '');
  const baseOrigin = (() => {
    try {
      return new URL(normalizedBaseUrl).origin;
    } catch {
      return normalizedBaseUrl;
    }
  })();

  const isHttps = normalizedBaseUrl.startsWith('https://');

  return betterAuth({
    database: params.database as any,
    baseURL: normalizedBaseUrl,
    basePath: '/api/auth',
    secret: params.secret,
    trustedOrigins: async (request) => {
      const allowed = new Set<string>([
        baseOrigin,
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'capacitor://localhost',
        'ionic://localhost',
        'http://localhost',
        'https://localhost',
      ]);
      for (const extra of params.corsAllowedOrigins || []) {
        try {
          allowed.add(new URL(extra).origin);
        } catch {
          // ignore malformed origin
        }
      }
      if (request) {
        const host =
          request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
        const proto =
          request.headers.get('x-forwarded-proto') ||
          (isHttps ? 'https' : 'http');
        if (host) {
          allowed.add(`${proto}://${host}`);
          allowed.add(`https://${host}`);
        }
        const origin = request.headers.get('origin');
        if (origin && host) {
          try {
            if (new URL(origin).host === host) {
              allowed.add(origin);
            }
          } catch {
            // ignore malformed origin
          }
        }
      }
      return Array.from(allowed);
    },
    onAPIError: {
      errorURL: '/?auth_error=oauth_failed',
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
        allowDifferentEmails: false,
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      autoSignIn: true,
      async sendResetPassword({ user, url }) {
        const html = renderSelloraEmailHtml({
          title: 'Reset Your SELLORA Password',
          greeting: `Hello ${user.name || 'Customer'},`,
          intro:
            'We received a request to reset your SELLORA account password. Use the secure button below to choose a new password.',
          ctaLabel: 'Reset Password',
          ctaUrl: url,
          footerNote: 'If you did not request a password reset, you can safely ignore this email.',
        });
        const queued = await queueEmailEvent(params.db, {
          idempotencyKey: `pwdreset:${user.id}:${randomUuid()}`,
          recipientEmail: user.email,
          recipientType: 'customer',
          notificationType: 'auth_password_reset',
          subject: '[SELLORA] Password Reset Request',
          htmlBody: html,
        });
        if (queued.eventId) {
          await dispatchSingleEmailEvent(params.db, params.emailEnv, queued.eventId);
        }
      },
      async onPasswordReset({ user }) {
        await clearLoginThrottle(params.db, user.email, '');
        await recordSecurityEvent(params.db, {
          userId: user.id,
          email: user.email,
          eventCategory: 'password_reset_completed',
          severity: (user as { role?: string }).role === 'owner' ? 'high' : 'medium',
          riskLevel: 'low',
          status: 'resolved',
        });
      },
    },
    emailVerification: {
      async sendVerificationEmail({ user, url }) {
        const html = renderSelloraEmailHtml({
          title: 'Verify Your Email Address',
          greeting: `Hello ${user.name || 'Customer'},`,
          intro:
            'Please confirm your email address to complete your SELLORA account verification.',
          ctaLabel: 'Verify Email',
          ctaUrl: url,
        });
        const queued = await queueEmailEvent(params.db, {
          idempotencyKey: `verify:${user.id}:${randomUuid()}`,
          recipientEmail: user.email,
          recipientType: 'customer',
          notificationType: 'auth_verification',
          subject: '[SELLORA] Verify Your Email Address',
          htmlBody: html,
        });
        if (queued.eventId) {
          await dispatchSingleEmailEvent(params.db, params.emailEnv, queued.eventId);
        }
      },
      async afterEmailVerification(updatedUser, request) {
        try {
          const userRow = await params.db.get<{
            id: string;
            email: string;
            name: string;
            role: string;
          }>(`SELECT id, email, name, role FROM user WHERE id = ?`, [updatedUser.id]);
          if (!userRow || userRow.role !== 'owner') return;

          // Clear stale Google OAuth links so the previous email's Google identity can no longer authenticate into the owner account.
          await params.db.run(
            `DELETE FROM account WHERE userId = ? AND providerId = 'google'`,
            [userRow.id]
          );

          const currentToken = request ? extractSessionTokenFromHeaders(request.headers) : null;
          if (currentToken) {
            await params.db.run(
              `DELETE FROM session WHERE userId = ? AND token != ?`,
              [userRow.id, currentToken]
            );
          } else {
            await params.db.run(`DELETE FROM session WHERE userId = ?`, [userRow.id]);
          }

          await writeAuditLog(params.db, {
            actorId: userRow.id,
            actorEmail: userRow.email,
            actorRole: 'owner',
            action: 'OWNER_EMAIL_CHANGED',
            targetType: 'user',
            targetId: userRow.id,
            details: {
              newEmail: userRow.email,
              oauthUnlinked: true,
              otherSessionsRevoked: true,
            },
          });

          await recordSecurityEvent(params.db, {
            userId: userRow.id,
            email: userRow.email,
            eventCategory: 'owner_email_changed',
            severity: 'high',
            riskLevel: 'low',
            status: 'resolved',
            metadata: {
              userId: userRow.id,
              newEmail: userRow.email,
              googleLinkCleared: true,
            },
          });

          const cfg = await getEffectiveEmailConfig(params.db, params.emailEnv);
          if (cfg.adminNotificationEmail) {
            const html = renderSelloraEmailHtml({
              title: 'Administrator Login Email Updated',
              greeting: 'Store Administration Notice,',
              intro: `The primary store owner login email has been verified and updated to ${userRow.email}. Previous external sign-in links have been cleared for security.`,
              detailsRows: [
                { label: 'Account ID', value: userRow.id },
                { label: 'Verified Login Email', value: userRow.email },
              ],
              footerNote:
                'If this change was unauthorized, review active sessions and reset your password immediately.',
            });
            const queued = await queueEmailEvent(params.db, {
              idempotencyKey: `owner_email_changed:${userRow.id}:${userRow.email}:${Date.now()}`,
              recipientEmail: cfg.adminNotificationEmail,
              recipientType: 'admin',
              notificationType: 'security_owner_email_changed',
              subject: '[SELLORA Security] Store Owner Login Email Updated',
              htmlBody: html,
            });
            if (queued.queued && queued.eventId) {
              await dispatchSingleEmailEvent(params.db, params.emailEnv, queued.eventId).catch(() => {});
            }
          }
        } catch {
          // Never abort verification response if post-verification cleanup fails
        }
      },
    },
    socialProviders,
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
        async sendChangeEmailConfirmation({ user, newEmail, url }) {
          const html = renderSelloraEmailHtml({
            title: 'Confirm Your Login Email Change',
            greeting: `Hello ${user.name || 'Store User'},`,
            intro: `We received a request to change your SELLORA login email from ${user.email} to ${newEmail}. Confirm this step first so we can send verification to your new email address.`,
            ctaLabel: 'Confirm Email Change Request',
            ctaUrl: url,
            footerNote:
              'If you did not request this email change, ignore this message and review your active sessions immediately.',
          });
          const queued = await queueEmailEvent(params.db, {
            idempotencyKey: `change_email_confirm:${user.id}:${randomUuid()}`,
            recipientEmail: user.email,
            recipientType: (user as { role?: string }).role === 'owner' ? 'admin' : 'customer',
            notificationType: 'auth_change_email_confirmation',
            subject: '[SELLORA Security] Confirm Login Email Change Request',
            htmlBody: html,
          });
          if (queued.eventId) {
            await dispatchSingleEmailEvent(params.db, params.emailEnv, queued.eventId);
          }
        },
      },
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'customer',
          input: false, // Never allow client to set role on signup
        },
        phone: {
          type: 'string',
          required: false,
        },
        permissionsJson: {
          type: 'string',
          required: false,
          defaultValue: '[]',
          input: false,
        },
        isActive: {
          type: 'number',
          required: false,
          defaultValue: 1,
          input: false,
        },
        notifyOrderUpdates: {
          type: 'number',
          required: false,
          defaultValue: 1,
        },
        notifyPromotions: {
          type: 'number',
          required: false,
          defaultValue: 0,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const emailNorm = String(user.email || '').trim().toLowerCase();
            if (authorizedOwnerEmail && emailNorm === authorizedOwnerEmail) {
              const existingOwner = await params.db.get<{ id: string }>(
                `SELECT id FROM user WHERE role = 'owner' LIMIT 1`
              );
              if (existingOwner) {
                throw new APIError('FORBIDDEN', {
                  message: 'This email is reserved for the store owner account.',
                });
              }
            }
            // Unconditionally force ordinary registrations (email & OAuth) to customer
            return {
              data: {
                ...user,
                role: 'customer',
                permissionsJson: '[]',
                isActive: 1,
              },
            };
          },
          after: async (user) => {
            try {
              await notifyCustomerWelcomeEmail(params.db, params.emailEnv, {
                id: user.id,
                name: user.name,
                email: user.email,
              });
              const cfg = await getEffectiveEmailConfig(params.db, params.emailEnv);
              if (cfg.adminNotificationEmail && cfg.adminEvents.new_customer !== false) {
                const html = renderSelloraEmailHtml({
                  title: 'New Customer Registered',
                  greeting: 'Store Administration Notice,',
                  intro: 'A new customer account has registered on SELLORA.',
                  detailsRows: [
                    { label: 'Name', value: user.name || '—' },
                    { label: 'Email', value: user.email },
                    { label: 'Account ID', value: user.id },
                  ],
                  ctaLabel: 'View Customers',
                  ctaUrl: `${cfg.resolvedAppUrl}/?view=admin&tab=customers`,
                });
                const queued = await queueEmailEvent(params.db, {
                  idempotencyKey: `new_cust:${user.id}`,
                  recipientEmail: cfg.adminNotificationEmail,
                  recipientType: 'admin',
                  notificationType: 'new_customer',
                  subject: `[SELLORA Admin] New Customer: ${user.email}`,
                  htmlBody: html,
                });
                if (queued.queued && queued.eventId) {
                  await dispatchSingleEmailEvent(params.db, params.emailEnv, queued.eventId);
                }
              }
            } catch {
              // Never fail account registration if email dispatch fails
            }
          },
        },
        update: {
          before: async (data) => {
            // Strip privileged fields from self-service Better Auth user updates
            const safe = { ...(data as Record<string, unknown>) };
            delete safe.role;
            delete safe.permissionsJson;
            delete safe.isActive;
            return { data: safe };
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            if (account.providerId === 'google' && authorizedOwnerEmail) {
              const targetUser = await params.db.get<{
                id: string;
                email: string;
                emailVerified: number;
                role: string;
              }>(
                `SELECT id, email, emailVerified, role FROM user WHERE id = ?`,
                [account.userId]
              );
              if (
                targetUser &&
                targetUser.email.trim().toLowerCase() === authorizedOwnerEmail &&
                targetUser.role !== 'owner' &&
                !targetUser.emailVerified
              ) {
                const unverifiedCred = await params.db.get<{ id: string }>(
                  `SELECT id FROM account WHERE userId = ? AND providerId = 'credential' LIMIT 1`,
                  [targetUser.id]
                );
                if (unverifiedCred) {
                  throw new APIError('FORBIDDEN', {
                    message:
                      'Cannot link Google account onto an unverified local credential account for the owner email.',
                  });
                }
              }
            }
          },
          after: async (account) => {
            if (account.providerId !== 'google' || !authorizedOwnerEmail) return;

            const userRow = await params.db.get<{
              id: string;
              email: string;
              emailVerified: number;
              role: string;
              isActive: number;
            }>(
              `SELECT id, email, emailVerified, role, isActive FROM user WHERE id = ?`,
              [account.userId]
            );

            // Strict server-side verification: must be active, emailVerified by Google, and exact OWNER_EMAIL match
            if (
              !userRow ||
              userRow.isActive === 0 ||
              !userRow.emailVerified ||
              userRow.email.trim().toLowerCase() !== authorizedOwnerEmail
            ) {
              return;
            }

            if (userRow.role === 'owner') return;

            const now = new Date().toISOString();
            const res = await params.db.run(
              `UPDATE user SET role = 'owner', permissionsJson = ?, updatedAt = ?
               WHERE id = ? AND emailVerified = 1 AND isActive = 1
                 AND NOT EXISTS (SELECT 1 FROM user WHERE role = 'owner' AND id != ?)`,
              [
                JSON.stringify(ROLE_DEFAULT_PERMISSIONS.owner),
                now,
                userRow.id,
                userRow.id,
              ]
            );

            if (res.changes > 0) {
              await writeAuditLog(params.db, {
                actorId: userRow.id,
                actorEmail: userRow.email,
                actorRole: 'owner',
                action: 'OWNER_GOOGLE_AUTHORIZED',
                targetType: 'user',
                targetId: userRow.id,
                details: { method: 'google_oauth', providerId: 'google' },
              });
            }
          },
        },
        update: {
          after: async (account) => {
            if (account.providerId === 'credential' && account.password) {
              const u = await params.db.get<{ email: string }>(
                `SELECT email FROM user WHERE id = ?`,
                [account.userId]
              );
              if (u?.email) {
                await clearLoginThrottle(params.db, u.email, '');
              }
            }
          },
        },
      },
    },
    advanced: {
      cookiePrefix: 'sellora',
      useSecureCookies: isHttps,
      defaultCookieAttributes: isHttps
        ? { sameSite: 'none', secure: true, httpOnly: true, path: '/' }
        : { sameSite: 'lax', secure: false, httpOnly: true, path: '/' },
    },
  });
}

export function resolveEffectivePermissions(
  role: StaffRole,
  permissionsJson?: string | null
): Permission[] {
  const base = ROLE_DEFAULT_PERMISSIONS[role] ?? [];
  if (!permissionsJson) return base;
  try {
    const custom = JSON.parse(permissionsJson);
    if (Array.isArray(custom) && custom.length > 0) {
      return Array.from(new Set([...base, ...custom])) as Permission[];
    }
  } catch {
    // ignore malformed json
  }
  return base;
}

export async function getSessionUser(
  auth: ReturnType<typeof createSelloraAuth>,
  db: SelloraDb,
  headers: Headers
): Promise<AuthUserSession | null> {
  try {
    const session = await auth.api.getSession({ headers });
    if (!session?.user?.id) return null;

    const userRow = await db.get<{
      id: string;
      name: string;
      email: string;
      emailVerified: number;
      role: string;
      phone: string | null;
      permissionsJson: string;
      isActive: number;
      notifyOrderUpdates: number;
      notifyPromotions: number;
    }>(`SELECT * FROM user WHERE id = ?`, [session.user.id]);

    if (!userRow || userRow.isActive === 0) return null;
    const role = (userRow.role || 'customer') as StaffRole;
    return {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      emailVerified: Boolean(userRow.emailVerified),
      role,
      phone: userRow.phone,
      permissions: resolveEffectivePermissions(role, userRow.permissionsJson),
      isActive: Boolean(userRow.isActive),
      notifyOrderUpdates: Boolean(userRow.notifyOrderUpdates),
      notifyPromotions: Boolean(userRow.notifyPromotions),
    };
  } catch {
    return null;
  }
}
