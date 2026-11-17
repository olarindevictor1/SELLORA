#!/usr/bin/env tsx
import path from 'node:path';
import { createSqliteDb } from '../src/server/db-node';
import { hashAdminSecurityPassword, randomUuid, sha256Hex } from '../src/server/crypto';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main() {
  const email = (getArg('--email') || '').trim().toLowerCase();
  const dbPath = getArg('--db') || './.data/sellora.db';
  const resetPassword = getArg('--reset-password');
  const trustIp = getArg('--trust-ip');
  const d1SqlMode = hasFlag('--d1-sql');

  if (!email) {
    console.error(
      'Usage: npx tsx scripts/recover-admin-security.ts --email <admin-email> [--reset-password <new-pwd>] [--trust-ip <ip>] [--db <sqlite-path>] [--d1-sql]'
    );
    process.exit(1);
  }

  if (d1SqlMode) {
    console.log('-- SELLORA Admin Security Break-Glass SQL (review before executing against D1)');
    if (resetPassword) {
      if (resetPassword.length < 8) {
        console.error('Error: --reset-password must be at least 8 characters.');
        process.exit(1);
      }
      const { encodedHash, algorithmId } = await hashAdminSecurityPassword(resetPassword);
      const recoveryCode = `SLR-REC-${randomUuid().slice(0, 8).toUpperCase()}`;
      const recoveryHash = await sha256Hex(recoveryCode);
      const now = new Date().toISOString();
      console.log(`-- Backup recovery code (save safely): ${recoveryCode}`);
      console.log(
        `UPDATE admin_security_credentials SET password_hash = '${encodedHash}', hash_algorithm = '${algorithmId}', failed_attempts = 0, lockout_cycles = 0, locked_until_ms = 0, recovery_code_hash = '${recoveryHash}', password_updated_at = '${now}' WHERE user_id = (SELECT id FROM user WHERE LOWER(email) = '${email.replace(/'/g, "''")}');`
      );
    }
    if (hasFlag('--clear-approvals')) {
      console.log(
        `UPDATE admin_login_approvals SET status = 'expired' WHERE user_id = (SELECT id FROM user WHERE LOWER(email) = '${email.replace(/'/g, "''")}') AND status = 'pending';`
      );
    }
    if (!resetPassword && !hasFlag('--clear-approvals')) {
      console.log(
        `SELECT id, email, role FROM user WHERE LOWER(email) = '${email.replace(/'/g, "''")}';`
      );
    }
    return;
  }

  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  const db = createSqliteDb(dbPath, migrationsDir);
  const user = await db.get<{ id: string; email: string; role: string }>(
    `SELECT id, email, role FROM user WHERE LOWER(email) = ?`,
    [email]
  );

  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  console.log(`Found account: ${user.email} (id=${user.id}, role=${user.role})`);

  if (resetPassword) {
    if (resetPassword.length < 8) {
      console.error('Error: --reset-password must be at least 8 characters.');
      process.exit(1);
    }
    const { encodedHash, algorithmId } = await hashAdminSecurityPassword(resetPassword);
    const recoveryCode = `SLR-REC-${randomUuid().slice(0, 8).toUpperCase()}`;
    const recoveryHash = await sha256Hex(recoveryCode);
    const now = new Date().toISOString();

    await db.run(
      `INSERT INTO admin_security_credentials (
         user_id, password_hash, hash_algorithm, failed_attempts, lockout_cycles, locked_until_ms,
         recovery_code_hash, password_updated_at, created_at
       ) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         password_hash = excluded.password_hash,
         hash_algorithm = excluded.hash_algorithm,
         failed_attempts = 0,
         lockout_cycles = 0,
         locked_until_ms = 0,
         recovery_code_hash = excluded.recovery_code_hash,
         password_updated_at = excluded.password_updated_at`,
      [user.id, encodedHash, algorithmId, recoveryHash, now, now]
    );
    console.log(`Admin Security Password updated (${algorithmId}).`);
    console.log(`New backup recovery code: ${recoveryCode}`);
  }

  if (trustIp) {
    const res = await db.run(
      `UPDATE admin_login_approvals SET status = 'expired' WHERE user_id = ? AND status = 'pending'`,
      [user.id]
    );
    console.log(
      `Expired ${res.changes} stale pending approval(s). Next sign-in from IP ${trustIp} will generate a fresh approval request bound to the caller's device cookie.`
    );
  } else {
    const expired = await db.run(
      `UPDATE admin_login_approvals SET status = 'expired' WHERE user_id = ? AND status = 'pending'`,
      [user.id]
    );
    console.log(`Cleared ${expired.changes} pending approval request(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
