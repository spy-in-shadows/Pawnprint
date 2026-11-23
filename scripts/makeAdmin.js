// Usage: npm run make-admin -- <email>
// Gives an existing user the admin role. Exits with status 1 if the user does not exist.
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma, closeDb } from '../src/config/db.js';
import { normalizeEmail } from '../src/services/auth.service.js';

export async function makeAdmin(rawEmail, client = prisma) {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return { ok: false, message: 'Usage: npm run make-admin -- <email>' };
  }
  const result = await client.user.updateMany({ where: { email }, data: { role: 'admin' } });
  if (result.count === 0) {
    return { ok: false, message: `No user with email ${email}. Register the account first, then run this again.` };
  }
  return { ok: true, message: `${email} is now an admin. The role applies to access tokens issued from now on.` };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  const result = await makeAdmin(process.argv[2]);
  (result.ok ? console.log : console.error)(result.message);
  await closeDb();
  process.exit(result.ok ? 0 : 1);
}
