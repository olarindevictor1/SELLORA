import 'dotenv/config';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { hashPassword } from 'better-auth/crypto';
import { randomUuid } from '../src/server/crypto';
import { createSqliteDb } from '../src/server/db-node';
import { provisionOwnerInDb } from '../src/server/owner-provisioning';
import { ROLE_DEFAULT_PERMISSIONS } from '../src/shared/types';

function readArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

function sqlLiteral(val: string | null): string {
  if (val === null) return 'NULL';
  return `'${val.replace(/'/g, "''")}'`;
}

async function main() {
  const email = (
    readArg('--email') ||
    process.env.OWNER_EMAIL ||
    'olarindevictor046@gmail.com'
  )
    .trim()
    .toLowerCase();
  const name = (readArg('--name') || 'Victor Olarinde').trim();
  const phone = readArg('--phone') || null;
  const emitD1Sql = process.argv.includes('--d1-sql');
  const addPasswordIfMissing = process.argv.includes('--add-password-if-missing');

  let password = readArg('--password') || process.env.OWNER_INITIAL_PASSWORD || '';
  if (!password) {
    const rl = readline.createInterface({ input, output });
    try {
      password = await rl.question(`Enter initial password for owner (${email}, min 8 chars): `);
    } finally {
      rl.close();
    }
  }

  if (!password || password.length < 8) {
    console.error('Error: Owner password must be at least 8 characters.');
    process.exit(1);
  }

  if (emitD1Sql) {
    const userId = `usr_${randomUuid()}`;
    const accId = `acc_${randomUuid()}`;
    const hashed = await hashPassword(password);
    const now = new Date().toISOString();
    const perms = JSON.stringify(ROLE_DEFAULT_PERMISSIONS.owner);

    const sql = [
      `-- Server-side non-destructive owner provisioning for Cloudflare D1 (${email})`,
      `-- Inserts owner only if no owner or matching email user exists yet.`,
      `INSERT INTO user (id, name, email, emailVerified, role, phone, permissionsJson, isActive, notifyOrderUpdates, notifyPromotions, createdAt, updatedAt)`,
      `SELECT ${sqlLiteral(userId)}, ${sqlLiteral(name)}, ${sqlLiteral(email)}, 1, 'owner', ${sqlLiteral(phone)}, ${sqlLiteral(perms)}, 1, 1, 0, ${sqlLiteral(now)}, ${sqlLiteral(now)}`,
      `WHERE NOT EXISTS (SELECT 1 FROM user WHERE LOWER(email) = ${sqlLiteral(email)} OR role = 'owner');`,
      ``,
      `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)`,
      `SELECT ${sqlLiteral(accId)}, u.id, 'credential', u.id, ${sqlLiteral(hashed)}, ${sqlLiteral(now)}, ${sqlLiteral(now)}`,
      `FROM user u`,
      `WHERE LOWER(u.email) = ${sqlLiteral(email)} AND u.role = 'owner'`,
      `  AND NOT EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'credential');`,
    ].join('\n');

    console.log(sql);
    return;
  }

  const dbPath = process.env.SQLITE_DB_PATH || './.data/sellora.db';
  const db = createSqliteDb(dbPath, path.resolve(process.cwd(), 'migrations'));

  const result = await provisionOwnerInDb(db, {
    name,
    email,
    password,
    phone,
    addPasswordIfMissing,
  });

  console.log(
    `Owner provisioning status: ${result.status} (id=${result.userId}, email=${result.email}, role=${result.role})`
  );
}

main().catch((err) => {
  console.error('Owner provisioning failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
