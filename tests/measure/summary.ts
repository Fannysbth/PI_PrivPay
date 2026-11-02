import type { CanaryAttribute } from '../pii-scan/canary';
import type { Comparison, Exposure } from '../pii-scan/exposure';

// M6-02: the Indonesian summary written next to the JSON of a run. It prints what was observed beside what Tabel IV expected
// and states the differences as they are; it has no knob that could bring them closer.
interface Full {
  meta: Record<string, unknown>;
  controls?: { payload: string[]; database: string[]; log: string[] };
  flow?: Record<string, unknown>;
  exposure?: {
    rows: Comparison[];
    detail: Exposure[];
    auth: Exposure;
    averages: { all: number; inZone: number };
    averagesClassGeneral: { all: number; inZone: number };
    averagesClassSpecific: { all: number; inZone: number };
    others: Record<string, Record<string, CanaryAttribute[]>>;
    exchangesObservedByProxy: number;
  };
  disclosure?: Record<string, unknown>;
}

const list = (items: readonly string[]): string => (items.length === 0 ? '-' : items.join(', '));
const sixths = (e: number): string => `${String(Math.round(e * 6))}/6`;
const fixed = (value: number): string => value.toFixed(4);

export function renderSummary(input: Record<string, unknown>): string {
  const full = input as unknown as Full;
  const out: string[] = [];
  const meta = full.meta;
  out.push(`# E(s) mode ${String(meta['mode'])} (M6-02)`, '');
  out.push(
    `Commit \`${String(meta['commit'])}\` (pohon kerja ${meta['workingTreeDirty'] === true ? 'berubah' : 'bersih'}), ${String(meta['date'])}, ${String(meta['customers'])} nasabah sintetis, FRAUD_HISTORY_DAYS=${String(meta['fraudHistoryDays'])}.`,
    `Tepi: ${String(meta['gatewayInFront'])}. Batas laju: ${String(meta['rateLimit'])}.`,
    `Klien mengirim nik dan nama pada pembayaran: ${String(meta['clientSendsNikNamaWithPayment'])}.`,
    '',
    'Ini ukuran paparan struktural pengenal langsung, bukan risiko identifikasi ulang dan bukan pengukuran kinerja.',
    '',
  );
  if (full.controls) {
    out.push(
      '## Kontrol positif pemindai',
      '',
      `Kenari yang sengaja ditanam harus ketemu (enam atribut): payload ${list(full.controls.payload)}; basis data ${list(full.controls.database)}; log ${list(full.controls.log)}.`,
      '',
    );
  }
  const exposure = full.exposure;
  if (exposure) {
    out.push('## E(s) teramati dibanding Tabel IV', '');
    out.push(
      '| Layanan | Harapan Tabel IV | Teramati | E harapan | E teramati | E_umum | E_spesifik | Kurang | Tak terduga | Presisi | Recall | Cocok |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const row of exposure.rows) {
      const detail = exposure.detail.find((d) => d.service === row.service);
      out.push(
        `| ${row.service} | ${list(row.expected)} | ${list(row.observed)} | ${sixths(row.expectedE)} | ${sixths(row.observedE)} | ${fixed(detail?.eUmum ?? 0)} | ${fixed(detail?.eSpesifik ?? 0)} | ${list(row.missing)} | ${list(row.unexpected)} | ${fixed(row.precision)} | ${fixed(row.recall)} | ${row.match ? 'ya' : 'TIDAK'} |`,
      );
    }
    out.push(
      '',
      `Auth (Keycloak, di luar zona perlindungan): teramati ${list(exposure.auth.attributes)} (E = ${sixths(exposure.auth.e)}). Tabel IV tidak memuat Auth, jadi tidak ada harapan untuknya.`,
      '',
    );
    out.push(
      `Rata-rata E(s): seluruh layanan (empat layanan + Auth) ${fixed(exposure.averages.all)}; hanya dalam zona perlindungan (empat layanan) ${fixed(exposure.averages.inZone)}.`,
      `Per kelas: umum seluruh ${fixed(exposure.averagesClassGeneral.all)}, umum dalam zona ${fixed(exposure.averagesClassGeneral.inZone)}; spesifik seluruh ${fixed(exposure.averagesClassSpecific.all)}, spesifik dalam zona ${fixed(exposure.averagesClassSpecific.inZone)}.`,
      '',
    );
    out.push(
      '## Rincian atribut per lokasi',
      '',
      '| Layanan | payload | basis data | log |',
      '| --- | --- | --- | --- |',
    );
    for (const d of exposure.detail)
      out.push(
        `| ${d.service} | ${list(d.byPlace.payload)} | ${list(d.byPlace.database)} | ${list(d.byPlace.log)} |`,
      );
    out.push(
      `| auth | - | ${list(exposure.auth.byPlace.database)} | ${list(exposure.auth.byPlace.log)} |`,
      '',
    );
    out.push('## Komponen di luar Tabel IV (informasi, tidak masuk rata-rata)', '');
    for (const [name, places] of Object.entries(exposure.others)) {
      out.push(
        `- ${name}: ${Object.entries(places)
          .map(([place, found]) => `${place} = ${list(found)}`)
          .join('; ')}`,
      );
    }
    out.push(
      '',
      `Pertukaran HTTP yang diamati proksi: ${String(exposure.exchangesObservedByProxy)}.`,
      '',
    );
  }
  if (full.flow) out.push('## Alur', '', '```json', JSON.stringify(full.flow, null, 2), '```', '');
  if (full.disclosure)
    out.push(
      '## Pembukaan identitas bersyarat (dilaporkan TERPISAH, paparan terkontrol)',
      '',
      '```json',
      JSON.stringify(full.disclosure, null, 2),
      '```',
      '',
    );
  return `${out.join('\n')}\n`;
}
