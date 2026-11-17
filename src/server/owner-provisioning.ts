import { hashPassword } from 'better-auth/crypto';
import { randomUuid } from './crypto';
import type { SelloraDb } from './db';
import { writeAuditLog } from './security';
import { ROLE_DEFAULT_PERMISSIONS } from '../shared/types';

export interface ProvisionOwnerInput {
  name: string;
  email: string;
  password?: string;
  phone?: string | null;
  addPasswordIfMissing?: boolean;
}

export interface ProvisionOwnerResult {
  status: 'created' | 'password_added' | 'already_exists';
  userId: string;
  email: string;
  role: 'owner';
}

/**
 * Server-side store owner provisioning helper.
 * Never alters existing user passwords silently.
 * Marks emailVerified = 1 so trusted Google OAuth linking and Email+Password
 * resolve cleanly to the exact same owner user record.
 */
export async function provisionOwnerInDb(
  db: SelloraDb,
  input: ProvisionOwnerInput
): Promise<ProvisionOwnerResult> {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('A valid owner email address is required.');
  }

  const now = new Date().toISOString();
  const ownerPermsJson = JSON.stringify(ROLE_DEFAULT_PERMISSIONS.owner);

  const existingOwner = await db.get<{ id: string; email: string }>(
    `SELECT id, email FROM user WHERE role = 'owner' LIMIT 1`
  );
  if (existingOwner && existingOwner.email.trim().toLowerCase() !== normalizedEmail) {
    throw new Error(
      `An owner account already exists for ${existingOwner.email}. Refusing to overwrite.`
    );
  }

  const existingByEmail = await db.get<{
    id: string;
    email: string;
    role: string;
  }>(`SELECT id, email, role FROM user WHERE LOWER(email) = ? LIMIT 1`, [normalizedEmail]);

  if (existingByEmail) {
    if (existingByEmail.role !== 'owner') {
      throw new Error(
        `An account with ${normalizedEmail} already exists with role '${existingByEmail.role}'. Refusing to elevate automatically outside verified Google OAuth.`
      );
    }

    if (input.addPasswordIfMissing && input.password) {
      const existingCred = await db.get<{ id: string }>(
        `SELECT id FROM account WHERE userId = ? AND providerId = 'credential' LIMIT 1`,
        [existingByEmail.id]
      );
      if (existingCred) {
        return {
          status: 'already_exists',
          userId: existingByEmail.id,
          email: existingByEmail.email,
          role: 'owner',
        };
      }
      const hashed = await hashPassword(input.password);
      await db.run(
        `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
        [`acc_${randomUuid()}`, existingByEmail.id, existingByEmail.id, hashed, now, now]
      );
      await writeAuditLog(db, {
        actorId: existingByEmail.id,
        actorEmail: existingByEmail.email,
        actorRole: 'owner',
        action: 'OWNER_PASSWORD_PROVISIONED',
        targetType: 'user',
        targetId: existingByEmail.id,
        details: { method: 'server_cli_add_password' },
      });
      return {
        status: 'password_added',
        userId: existingByEmail.id,
        email: existingByEmail.email,
        role: 'owner',
      };
    }

    return {
      status: 'already_exists',
      userId: existingByEmail.id,
      email: existingByEmail.email,
      role: 'owner',
    };
  }

  if (!input.password || input.password.length < 8) {
    throw new Error('A password of at least 8 characters is required to provision the owner account.');
  }

  const userId = `usr_${randomUuid()}`;
  const hashed = await hashPassword(input.password);

  await db.batch([
    {
      sql: `INSERT INTO user (id, name, email, emailVerified, role, phone, permissionsJson, isActive, notifyOrderUpdates, notifyPromotions, createdAt, updatedAt)
            VALUES (?, ?, ?, 1, 'owner', ?, ?, 1, 1, 0, ?, ?)`,
      params: [userId, input.name.trim(), normalizedEmail, input.phone || null, ownerPermsJson, now, now],
    },
    {
      sql: `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
            VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      params: [`acc_${randomUuid()}`, userId, userId, hashed, now, now],
    },
  ]);

  await writeAuditLog(db, {
    actorId: userId,
    actorEmail: normalizedEmail,
    actorRole: 'owner',
    action: 'OWNER_SERVER_PROVISIONED',
    targetType: 'user',
    targetId: userId,
    details: { method: 'server_provisioning' },
  });

  return {
    status: 'created',
    userId,
    email: normalizedEmail,
    role: 'owner',
  };
}
