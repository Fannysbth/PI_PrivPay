import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderKongConfig } from './render';

// `node dist/edge/render-main.js`: writes the Kong declarative file to KONG_CONFIG_OUT (DK-02a). Run once per start by
// Compose before Kong. A failure stops it with a short message, and Kong then does not start (fail closed).
const out = process.env['KONG_CONFIG_OUT'];
if (out === undefined || out === '') {
  process.stderr.write('KONG_CONFIG_OUT is required\n');
  process.exit(1);
}

renderKongConfig(process.env)
  .then((text) => {
    mkdirSync(dirname(out), { recursive: true });
    // Written beside the target and renamed: Kong never reads a half-written file.
    const temporary = `${out}.tmp`;
    writeFileSync(temporary, `${text}\n`, { mode: 0o644 });
    renameSync(temporary, out);
    process.stdout.write('kong config written\n');
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'render failed'}\n`);
    process.exit(1);
  });
