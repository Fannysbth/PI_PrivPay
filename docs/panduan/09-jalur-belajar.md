# 09. Jalur belajar lima hari

Rencana membaca kode agar kamu bisa menjelaskan dan mempertahankan sistem ini. Tiap hari memuat: **berkas yang dibaca (berurutan)**, **apa yang dicari**, **latihan kecil**, dan **pertanyaan swa-uji**. Anggaran waktu sekitar 3 sampai 4 jam per hari.

Aturan main latihan:

- Latihan mutasi mengubah kode produksi **sementara**. Mulailah dengan `git status` bersih, kerjakan di cabang sementara (`git switch -c latihan/hari-n`), dan akhiri dengan `git restore <berkas>` lalu `git status` bersih. Jangan commit mutasi.
- Jalankan tes **hanya** berkas yang disebut, satu proses pada satu waktu. Tes integrasi butuh PostgreSQL dan `.env.test` ([01](01-menjalankan-sistem.md)).
- Latihan yang saya jalankan sendiri saat menulis panduan ditandai **[terverifikasi]**. Yang lain adalah harapan dari membaca tes; bila hasilmu berbeda, itu temuan yang menarik, bukan kegagalanmu.
- Perintah menjalankan satu tes ada di [06](06-pengujian.md).

---

## Hari 1. Peta, fondasi bersama, dan menyalakan sistem

**Baca, berurutan**

1. [00-peta-besar.md](00-peta-besar.md), lalu [`docs/DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md) dan ADR [0003](../adr/0003-hanya-dua-kondisi-pembanding.md), [0006](../adr/0006-dua-mode-lewat-repositori.md).
2. [`packages/common/src/mode.ts`](../../packages/common/src/mode.ts): `PRIVACY_MODES`, `assertBaselineMode`, `SUBJECT_REF_SHAPES`, `privacyUrlMatchesMode`.
3. [`packages/common/src/config.ts`](../../packages/common/src/config.ts): `loadConfig` dan `readSecret`.
4. [`packages/common/src/errors.ts`](../../packages/common/src/errors.ts): `REASONS`, delapan kode, `toWireError` vs `toClientError`.
5. [`packages/common/src/nest/service-app.ts`](../../packages/common/src/nest/service-app.ts) dan [`run-service.ts`](../../packages/common/src/nest/run-service.ts): apa yang dilakukan setiap layanan sebelum satu baris kode bisnis jalan.
6. [`services/fraud-service/src/main.ts`](../../services/fraud-service/src/main.ts) lalu [`fraud.module.ts`](../../services/fraud-service/src/fraud.module.ts): layanan terkecil dengan seluruh pola akar komposisi.

**Cari**

- Bagaimana satu variabel env yang salah menghentikan start dan apa yang *tidak* dicetak (nilai).
- Di mana tepatnya mode memilih repositori (satu ternary di `fraud.module.ts`).
- Apa beda `code` dan `reason`.

**Latihan**

1. Ikuti [01](01-menjalankan-sistem.md) sampai sembilan proses sehat, lalu ulangi lima langkah pertama tabel "Mencoba alurnya". Catat nilai `status` setiap jawaban.
2. **[harapan, tidak saya jalankan]** jalankan `corepack pnpm exec jest --config jest.config.cjs packages/common/test/mode.spec.ts` (7 tes). Ubah `customer: /^CUST-[0-9]{6}$/` di `SUBJECT_REF_SHAPES.baseline` menjadi `{7}` dan jalankan lagi: tes "baseline accepts the customer id" harus gagal. Kembalikan.

**Swa-uji.** Mengapa Privacy Service menolak start di baseline? Apa yang terjadi bila `PRIVACY_SERVICE_URL` terisi di mode baseline? (bab 05, bagian "Penjaga").

---

## Hari 2. Pintu masuk: autentikasi, Gateway, tokenizer, registrasi

**Baca, berurutan**

1. [`packages/common/src/jwt.ts`](../../packages/common/src/jwt.ts) (`verifyJwt`) dan [`authenticate.ts`](../../packages/common/src/authenticate.ts) (`principalOf`, `authenticate`). Tabel peran/klien di [`tools/dev-idp/src/registry.ts`](../../tools/dev-idp/src/registry.ts).
2. [`services/gateway/src/gateway.ts`](../../services/gateway/src/gateway.ts): `Gateway.handle` dari atas ke bawah.
3. [`services/gateway/src/routes.ts`](../../services/gateway/src/routes.ts): `ROUTES`, `TOKENIZING_ROUTES`, `RouteTable.match`.
4. [`services/gateway/src/tokenizer/tokenizer.ts`](../../services/gateway/src/tokenizer/tokenizer.ts) dan [`schemas.ts`](../../services/gateway/src/tokenizer/schemas.ts).
5. [`services/gateway/src/registration.ts`](../../services/gateway/src/registration.ts).
6. Dua adaptor: [`tokenizer/http-privacy-port.ts`](../../services/gateway/src/tokenizer/http-privacy-port.ts) dan [`baseline/passthrough-privacy-port.ts`](../../services/gateway/src/baseline/passthrough-privacy-port.ts).

**Cari**

- Urutan 401, 429, 422, 403, 422 dalam `handle`, dan mengapa tidak diubah.
- Dari mana `customer_id` pembayaran berasal (klaim JWT, bukan body).
- Mengapa payload ke hilir dibangun dari daftar izin dan bukan dengan menghapus field.
- Apa yang terjadi bila pemanggilan Privacy gagal di tengah (`Promise.all`).

**Latihan**

1. Jalankan `corepack pnpm exec jest --config jest.config.cjs services/gateway/test/tokenizer.spec.ts services/gateway/test/gateway-baseline.spec.ts`. Baca nama tes seperti spesifikasi.
2. **[terverifikasi]** di `passthrough-privacy-port.ts`, ubah kondisi `if (!form.test(request.subjectId))` menjadi `if (false && !form.test(request.subjectId))`, lalu jalankan `services/gateway/test/passthrough-privacy-port.spec.ts`: 6 dari 8 tes gagal. Kembalikan.
3. Di `packages/common/src/authenticate.ts` ubah `MAX_LIFETIME_SECONDS` 300 menjadi 3000 dan jalankan `packages/common/test/authenticate.spec.ts`; harapan: tes "a token that lives longer than 300 seconds is UNAUTHENTICATED" gagal. Kembalikan.

**Swa-uji.** Tulis urutan langkah `POST /transaction` dari klien sampai Transaction menerima (tanpa melihat bab 03). Mengapa Gateway satu-satunya yang menerima token nasabah?

---

## Hari 3. Jantung privasi: kebijakan, kripto, penerbitan token, audit

**Baca, berurutan**

1. [`services/privacy-service/src/policy/tables.ts`](../../services/privacy-service/src/policy/tables.ts) lalu [`policy-engine.ts`](../../services/privacy-service/src/policy/policy-engine.ts). Cocokkan dengan Tabel 1 sampai 6 di [`docs/PRD_RINGKAS.md`](../PRD_RINGKAS.md).
2. [`crypto/parts.ts`](../../services/privacy-service/src/crypto/parts.ts) (`encodeParts`, `mappingBinding`, `vaultBinding`), [`derive.ts`](../../services/privacy-service/src/crypto/derive.ts), [`field-cipher.ts`](../../services/privacy-service/src/crypto/field-cipher.ts), [`keys.ts`](../../services/privacy-service/src/crypto/keys.ts).
3. [`audit/audited-operation.ts`](../../services/privacy-service/src/audit/audited-operation.ts) dan [`audit-entry.ts`](../../services/privacy-service/src/audit/audit-entry.ts).
4. [`token/token-service.ts`](../../services/privacy-service/src/token/token-service.ts): mulai dari `issue` (paling bawah), lalu `generate`, `exchange`, `generateFromTransaction`, `reIssue`.
5. [`migrations/proposed/0001_privacy_tables.sql`](../../services/privacy-service/migrations/proposed/0001_privacy_tables.sql) dan [`0002_privacy_grants.sql`](../../services/privacy-service/migrations/proposed/0002_privacy_grants.sql).
6. [04-keamanan.md](04-keamanan.md) bagian 1 sampai 4 sebagai rangkuman.

**Cari**

- Di mana nonce, kunci penasihat, dan indeks unik parsial masing-masing bekerja, dan apa yang terjadi bila salah satu dihapus (ADR-0010).
- Mengapa `INSERT` ke `audit_log` tidak memakai `RETURNING`.
- Mengapa `DeniedOperation` menulis baris di transaksi sendiri.
- Apa isi AAD untuk `pseudonym_mapping` vs `identity_vault`.

**Latihan**

1. Jalankan `corepack pnpm exec jest --config jest.config.cjs services/privacy-service/test/crypto.spec.ts services/privacy-service/test/policy-engine.spec.ts` dan baca tes `T-16` (tiga tes tentang AAD) sampai kamu bisa menjelaskan serangan yang dicegahnya.
2. Dengan `git diff` kosong, ubah satu baris di `field-cipher.ts` (mis. IV tetap 12 nol, `Buffer.alloc(12)` menggantikan `randomBytes(IV_BYTES)`) dan jalankan `crypto.spec.ts`; **harapan:** tes "the same value encrypted many times never repeats an IV or a blob" gagal. Kembalikan. Perhatikan bahwa IV tetap tidak merusak fungsi dasar: itulah sebabnya perlu tes khusus.
3. Jalankan integrasi `services/privacy-service/test/token-service.integration.spec.ts` (PostgreSQL) dan temukan tes paralel 50 permintaan.

**Swa-uji.** Jelaskan dalam tiga kalimat mengapa dua panggilan `POST /pseudonymize` untuk pelanggan yang sama dalam satu TTL mengembalikan token yang sama, dan apa harganya bagi privasi.

---

## Hari 4. Alur bisnis: Transaction, Fraud, Notification

**Baca, berurutan**

1. [`transaction/ports.ts`](../../services/transaction-service/src/transaction/ports.ts): baca *komentar* di atas tiap port.
2. [`transaction/processor.ts`](../../services/transaction-service/src/transaction/processor.ts): `process`, `orchestrate`, `decide`, `replay`.
3. [`transaction/followups.ts`](../../services/transaction-service/src/transaction/followups.ts) (`withReissue`, `notify`, `patchPrivacy`), [`status-machine.ts`](../../services/transaction-service/src/transaction/status-machine.ts), [`review.ts`](../../services/transaction-service/src/transaction/review.ts), [`sweeper.ts`](../../services/transaction-service/src/transaction/sweeper.ts).
4. [`proposed/subject-references.ts`](../../services/transaction-service/src/proposed/subject-references.ts) dibanding [`baseline/subject-references.ts`](../../services/transaction-service/src/baseline/subject-references.ts); lalu `proposed/subject-sql.ts` dibanding `baseline/subject-sql.ts`.
5. [`services/fraud-service/src/risk/engine.ts`](../../services/fraud-service/src/risk/engine.ts), [`assessor.ts`](../../services/fraud-service/src/risk/assessor.ts), [`repository.ts`](../../services/fraud-service/src/risk/repository.ts).
6. [`services/notification-service/src/notification/service.ts`](../../services/notification-service/src/notification/service.ts).

**Cari**

- Mengapa Fraud mati berarti `HELD`, bukan `COMPLETED`; di baris mana keputusan itu ditulis.
- Mengapa notifikasi dikirim sebelum PATCH status.
- Dua perbedaan SQL antara proposed dan baseline di Transaction.
- Bagaimana skor 55 terbentuk pada contoh di [01](01-menjalankan-sistem.md).

**Latihan**

1. Jalankan `corepack pnpm exec jest --config jest.config.cjs services/fraud-service/test/risk-engine.spec.ts` (unit). Baca tes "the highest score the rules allow is 75".
2. **[terverifikasi]** di `services/fraud-service/src/proposed/subject-sql.ts` dan `baseline/subject-sql.ts` hapus potongan ` AND assessed_at >= $2` dari kueri `history`, lalu jalankan integrasi `services/fraud-service/test/assessment.integration.spec.ts` dan `baseline-repository.integration.spec.ts` dengan `-t "N-45"`: empat tes gagal (jendela 30 hari). Kembalikan.
3. Jalankan `services/transaction-service/test/orchestration.integration.spec.ts` dan baca tes TF-04 sebagai cerita: token kedaluwarsa, diterbitkan ulang, dicoba sekali lagi.

**Swa-uji.** Bila Notification mati, apa status transaksi? Bila Fraud mati dan jumlahnya di bawah ambang?

---

## Hari 5. Pembukaan identitas, pencabutan, retensi, rekonsiliasi, dan bukti

**Baca, berurutan**

1. [`disclosure/disclosure-service.ts`](../../services/privacy-service/src/disclosure/disclosure-service.ts) lalu [`de-pseudonymize-service.ts`](../../services/privacy-service/src/disclosure/de-pseudonymize-service.ts); sambil membuka [03](03-alur-end-to-end.md) bagian D.
2. [`revocation/revocation-service.ts`](../../services/privacy-service/src/revocation/revocation-service.ts), [`retention/retention-job.ts`](../../services/privacy-service/src/retention/retention-job.ts), [`identity/identity-vault.ts`](../../services/privacy-service/src/identity/identity-vault.ts).
3. [`services/reconciliation-service/src/reconciliation/service.ts`](../../services/reconciliation-service/src/reconciliation/service.ts), [`reconciler.ts`](../../services/reconciliation-service/src/reconciliation/reconciler.ts), [`baseline/privacy-client.ts`](../../services/reconciliation-service/src/baseline/privacy-client.ts).
4. Bukti: [`tests/pii-scan/canary.ts`](../../tests/pii-scan/canary.ts), [`scan.ts`](../../tests/pii-scan/scan.ts), [`scan-database.ts`](../../tests/pii-scan/scan-database.ts), lalu [`services/gateway/test/e2e/equivalence.integration.spec.ts`](../../services/gateway/test/e2e/equivalence.integration.spec.ts) dan [`stack.ts`](../../services/gateway/test/e2e/stack.ts).
5. [06-pengujian.md](06-pengujian.md) dan [08-batasan-dan-pertanyaan-dosen.md](08-batasan-dan-pertanyaan-dosen.md).

**Cari**

- Lima gerbang dan STEP 0, dan mengapa peran diperiksa sebelum gerbang (N-29).
- Bagaimana "sekali pakai" ditegakkan di bawah beban (`FOR UPDATE` dan `UPDATE ... WHERE status = 'APPROVED'`).
- Perbedaan `revokeSubject` dan retensi (siapa memicu, apa yang dikosongkan, apa yang dibiarkan).
- Bagaimana pemindai membedakan "bersih" dari "buta".

**Latihan**

1. Jalankan `services/privacy-service/test/de-pseudonymize.integration.spec.ts` (24 tes) dengan perintah di [06](06-pengujian.md), lalu baca tes "three uses queued behind the row of the approval".
2. **[dari catatan penulis tes, tidak saya jalankan]** hapus *keduanya*: `FOR UPDATE` dari `DE_PSEUDONYMIZE_SQL.findRequest` dan `AND status = 'APPROVED'` dari `DE_PSEUDONYMIZE_SQL.use`; tes tiga pemakaian serentak harus gagal. Menghapus salah satu saja tidak menggagalkan tes karena yang lain menutupinya ([`docs/HANDOFF.md`](../HANDOFF.md), Gerbang 3 M3). Kembalikan.
3. Jalankan `services/gateway/test/e2e/equivalence.integration.spec.ts` (sekitar 35 detik; 5 tes). Baca `observe` dan `leaveATrail`: ini kesetaraan perilaku dan kontras pemindai dalam satu berkas.
4. Buktikan pada diri sendiri bahwa pemindai tidak buta: cari di `services/gateway/test/e2e/scenarios.integration.spec.ts` komentar "The control: the scan does find the account number", dan di `equivalence.integration.spec.ts` tes terakhir yang menuntut baseline menemukan `customer_id`, rekening, dan HP.

**Swa-uji (penutup).** Tanpa melihat catatan, jawab pertanyaan 3, 5, 7, 11, 13, 19, dan 24 di [08](08-batasan-dan-pertanyaan-dosen.md) dengan suara keras, sebut berkas yang menjadi dasarnya, dan sebut apa yang **belum** teruji.

---

## Sesudah lima hari

1. Tulis satu halaman penjelasan sistem dengan kata-katamu sendiri; bandingkan dengan [00](00-peta-besar.md).
2. Pilih satu temuan dari bagian "Temuan baru" di [08](08-batasan-dan-pertanyaan-dosen.md) (mis. harapan E(s) baseline) dan putuskan apakah akan diubah di spek atau di kode. Keputusan FINAL tidak berubah tanpa ADR yang kamu setujui.
3. Bila akan menulis kode, baca dulu [`CLAUDE.md`](../../CLAUDE.md): larangan keras (tidak ada PII di mana pun, tidak ada rahasia di git, tidak melonggarkan tes) dan alur kerja (tes dulu, satu tiket satu PR kecil).
