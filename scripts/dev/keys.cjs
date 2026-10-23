'use strict';
// `pnpm dev:keys`: makes the three keys of Privacy (K_token, K_index, K_field) as files, 32 random bytes in hex each.
// It never reads a file and never overwrites one ('wx'), so running it twice changes nothing and an existing key
// stays as it is. Only file names are printed. The directory is `secrets/` (git-ignored) or DEV_SECRETS_DIR.
const { randomBytes } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { PRIVACY_KEY_FILES } = require('./services.cjs');

function makeKeys(dir, out) {
  mkdirSync(dir, { recursive: true });
  const created = [];
  for (const name of PRIVACY_KEY_FILES) {
    const file = path.join(dir, name);
    try {
      writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
      created.push(name);
      out(`created ${file}`);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      out(`kept    ${file}`);
    }
  }
  return created;
}

module.exports = { makeKeys };

if (require.main === module) {
  makeKeys(process.env.DEV_SECRETS_DIR || './secrets', (line) => process.stdout.write(`${line}\n`));
}
