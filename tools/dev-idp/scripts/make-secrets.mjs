// Makes the client secrets of the dev IdP's service accounts, one file each in the secrets directory.
// Existing files are never touched, so running it twice changes nothing. Only file names are printed.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep in step with SERVICE_CLIENTS in src/registry.ts (a test compares the two).
const CLIENTS = ['api-gateway', 'transaction', 'fraud', 'notification', 'reconciliation'];
const dir = process.env.DEV_IDP_SECRETS_DIR || './secrets';

mkdirSync(dir, { recursive: true });
for (const client of CLIENTS) {
  const file = join(dir, `${client}_client_secret`);
  try {
    // 'wx' fails when the file exists; 0o600 keeps it to the owner on systems that honour modes.
    writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { flag: 'wx', mode: 0o600 });
    console.log(`created ${file}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`kept    ${file}`);
  }
}
