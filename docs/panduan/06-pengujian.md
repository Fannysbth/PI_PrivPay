# 06. Pengujian

Ada banyak tes di repo ini (pada gerbang terakhir: 1.340 tes unit, 1.134 integrasi, 36 smoke, 151 tes pii-scan). Bab ini menjelaskan jenisnya, cara menjalankannya, dua konsep yang sering membingungkan (mutasi dan kontrol positif), dan cara membaca hasil gerbang. Rancangan lengkapnya ada di [`docs/spec/pengujian-dan-pengukuran.md`](../spec/pengujian-dan-pengukuran.md) dan [`docs/qa/qa-checklist.md`](../qa/qa-checklist.md).

## Jenis tes

| Jenis | Apa yang diuji | Berkas | Cara jalan | Butuh |
| --- | --- | --- | --- | --- |
| **Unit** | logika murni: `PolicyEngine`, `RiskEngine`, `match`, `Tokenizer`, `verifyJwt`, `FieldCipher`, validasi konfigurasi | `*.spec.ts` | `corepack pnpm test` | tidak ada |
| **Integrasi** | satu layanan dengan **PostgreSQL asli dan peran asli**: SQL, indeks unik parsial, `FOR UPDATE`, kunci penasihat, `REVOKE/GRANT`, `CHECK`, HTTP lewat Supertest | `*.integration.spec.ts` | `corepack pnpm test:integration` | PostgreSQL + `bootstrap.ps1` + `.env.test` |
| **Keamanan (TK-xx)** | kasus negatif Privacy dalam dua lapis (antar-layanan dan lewat Gateway) | `services/privacy-service/test/security/` | `corepack pnpm test:security` | PostgreSQL |
| **E2E** | seluruh tumpukan (dev-idp, Gateway, Privacy, Transaction, Fraud, Notification, SMS, Reconciliation) dalam satu proses, tanpa jaringan sungguhan | `services/gateway/test/e2e/*.integration.spec.ts` | ikut `test:integration` dan `pii-scan` | PostgreSQL |
| **Kesetaraan mode** | skenario yang sama di proposed dan baseline memberi hasil sama, dan mode benar-benar mengubah apa yang disimpan | `services/gateway/test/e2e/equivalence.integration.spec.ts` | ikut E2E | PostgreSQL |
| **pii-scan** | pemindai nilai kenari atas basis data, log, jawaban, dan pesan | `tests/pii-scan` + spec per layanan | `corepack pnpm pii-scan` | PostgreSQL |
| **Smoke** | hasil build tiap layanan sebagai **proses nyata**: `/health`, mode, penolakan konfigurasi tak konsisten | `tests/smoke/built-service.smoke.spec.ts` | `corepack pnpm test:smoke` (membangun dulu) | hasil build |
| **Arsitektur dan repo** | kode domain tidak mengimpor folder mode; `.gitignore`, lint rule, skeleton layanan, CI | `tests/repo/` | ikut `pnpm test` | tidak ada |
| Newman (TF/TK end-to-end), k6 (kinerja) | **belum ada** (M6, M7) | `tests/functional`, `tests/performance` masih kosong | | |

Penjelasan singkat beberapa istilah di kolom pertama:

- **TF-xx** = kasus fungsional (misalnya TF-04 token kedaluwarsa di tengah transaksi); **TK-xx** = kasus keamanan (misalnya TK-08 aktor `admin` tidak boleh membuka identitas); **AZ-xx** = tes otorisasi negatif per endpoint ([`docs/spec/endpoints.md`](../spec/endpoints.md)): tanpa kredensial 401, pemanggil atau peran salah 403, field tak dikenal 422, `requesting_service` palsu diabaikan.
- Nama tes memuat ID-nya (`TK-07 rejects raw subject_id from TRANSACTION`), supaya kriteria penerimaan bisa dilacak ke tes (aturan proyek, bagian Pengujian).

## Menjalankan

Semua perintah dari akar repo. Pakai `corepack pnpm` (bukan `pnpm` langsung) di mesin ini.

```powershell
corepack pnpm lint                 # ESLint + Prettier --check
corepack pnpm typecheck            # tsc --noEmit
corepack pnpm test                 # unit; sekitar 40 detik pada gerbang terakhir (2 worker)
corepack pnpm test:integration     # seluruhnya sekitar 47 menit pada gerbang terakhir
corepack pnpm test:security        # TK-xx Privacy
corepack pnpm test:smoke           # build, lalu proses nyata; sekitar 1 menit
corepack pnpm pii-scan             # sekitar 6 menit
corepack pnpm audit --prod --audit-level high
```

Satu berkas atau satu folder saja (inilah yang paling sering kamu pakai saat belajar):

```powershell
# unit
corepack pnpm exec jest --config jest.config.cjs packages/common/test/mode.spec.ts
# integrasi, satu berkas, hanya tes yang namanya memuat "TK-08"
node --env-file-if-exists=.env.test node_modules/jest/bin/jest.js --config jest.integration.config.cjs services/privacy-service/test/de-pseudonymize.integration.spec.ts -t "TK-08"
# integrasi, satu layanan
node --env-file-if-exists=.env.test node_modules/jest/bin/jest.js --config jest.integration.config.cjs services/fraud-service
```

Keduanya terverifikasi. Konfigurasi: unit di [`jest.config.cjs`](../../jest.config.cjs), integrasi di [`jest.integration.config.cjs`](../../jest.integration.config.cjs) (satu worker, batas waktu 30 detik), smoke di [`jest.smoke.config.cjs`](../../jest.smoke.config.cjs).

Aturan etiket saat menjalankan tes yang berat:

- **Satu proses pada satu waktu.** Jangan menjalankan dua rangkaian integrasi bersamaan; database tes bertabrakan dan memori habis.
- **Periksa memori bebas lebih dulu.** Beberapa kegagalan "Connection terminated due to connection timeout" di riwayat proyek ternyata karena memori hampir habis; baru dianggap bug bila terulang saat memori longgar (aturan proyek, pelajaran retro M3).
- **Jangan biarkan klien lain terhubung ke database `privpay_*`** (pgAdmin, psql, IDE) saat tes jalan: `createTestDb` gagal dengan `TestDatabaseBusyError` karena sesi superuser tidak bisa diakhiri `privpay_test_admin`.
- Tes tidak pernah memakai nama database layanan asli. Mereka membuat `privpay_<layanan>_test_<sufiks>` lewat `createTestDb` ([`packages/common/src/testing/test-db.ts`](../../packages/common/src/testing/test-db.ts)), yang **membuat ulang** database itu di awal tiap tes dan **tidak menghapusnya** sesudahnya (supaya tes yang gagal bisa diperiksa). Sisa tes dilihat dengan `corepack pnpm db:test-databases` dan dihapus dengan `corepack pnpm db:test-databases drop` (meminta ketikan `DROP <jumlah>`; butuh terminal interaktif).
- Laptop yang tidur di tengah gerbang membuat tes lain habis waktu. Bila gagal tak stabil, **baca stempel waktu log lebih dulu**: lompatan jam berarti mesin tidur, bukan bug.

## Prinsip yang membuat tes ini bermakna

1. **Tes dulu.** Tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, baru kode minimal. Bacalah riwayat git sebuah tiket: komit tes sebelum komit implementasi.
2. **Database asli untuk yang menyangkut database.** Indeks unik parsial, `FOR UPDATE`, `REVOKE/GRANT`, `CHECK` tidak di-mock. Tes terhubung sebagai **peran sungguhan** (`privpay_app`, `privpay_auditor`), sementara migrasi dijalankan peran pemilik skema.
3. **Waktu disuntik.** `FakeClock` dan `FakeDelay`; tidak ada `sleep` nyata. `FakeClock.advance(detik)` memakai **detik**, dan jam palsu satu tumpukan hanya maju (token yang disimpan cache membawa `iat`).
4. **Data hanya fiktif**, nilai kenari dibangkitkan, bukan ditulis tangan.
5. **Tes yang membuka sumber daya nyata** (timer, soket, pool) menutupnya di `finally`; satu asersi gagal tidak boleh meninggalkan handle yang membuat Jest menunggu satu jam.
6. **Tidak ada melonggarkan tes agar hijau.** Tes yang kadang gagal adalah bug (atau tes yang salah, seperti kasus TK-08 di bawah), bukan sesuatu yang di-retry.

## Mutasi: bukti bahwa tes benar-benar menjaga sesuatu

Tes yang lulus tidak membuktikan ia menjaga apa pun; ia mungkin lulus bahkan jika kode yang dijaganya dihapus. **Mutasi** menjawabnya: sengaja merusak (mutasi) kode produksi di tempat pengaman berada, jalankan tes, dan pastikan tes **gagal**. Lalu kembalikan kodenya.

Contoh nyata dari M5 sesi 2 (`docs/security/review-M5.md`): penolakan env `PRIVACY_SERVICE_URL` dihapus dari konfigurasi Transaction, dan pemilihan adaptor baseline dimatikan; empat tes di `services/transaction-service/test/mode.integration.spec.ts` gagal. Contoh lain: klausa `AND assessed_at >= $2` dihapus dari dua SQL Fraud; empat tes jendela riwayat gagal.

Cara mengerjakannya sendiri (latihan di [09](09-jalur-belajar.md)):

1. Salin berkas yang akan dirusak ke tempat aman (atau pastikan `git status` bersih supaya `git checkout -- <berkas>` memulihkannya).
2. Ubah satu hal di kode produksi (misalnya hapus satu `if` pengaman).
3. Jalankan hanya berkas tes terkait. Harapan: ada tes yang **gagal**, dengan alasan yang masuk akal.
4. Kembalikan, jalankan lagi, pastikan hijau, dan `git diff` bersih.

Peringatan dari retro: skrip mutasi ditulis ke berkas, bukan heredoc Bash dengan tanda kutip tunggal; setelah proses mutasi dihentikan paksa, periksa berkas sudah kembali; dan tes konkurensi dibuktikan dengan mutasi pula (pengaman dihapus, tes harus gagal).

Tidak semua tes bisa "dibunuh" oleh mutasi tertentu. Mutasi yang **tidak** menggagalkan tes adalah informasi: tesnya lemah, atau dua pengaman saling menutup (di M3-05, menghapus salah satu dari kunci baris dan penanda sekali pakai tidak menggagalkan tes karena yang lain menutupinya; keduanya harus dihapus).

## pii-scan dan kontrol positif

**Nilai kenari** ([`tests/pii-scan/canary.ts`](../../tests/pii-scan/canary.ts), `buildCanary(n)`): untuk pelanggan ke-n dibangkitkan enam nilai yang berformat valid tetapi jelas palsu dan unik: `customer_id` `CUST-9nnnnn`, NIK berawalan `99995`, HP berawalan `08999`, rekening berawalan `9999`, email `canary-n@example.test`, nama `Kenari <enam huruf>`. Pemindai mencari nilai **persis** (juga dalam bentuk URL-decoded) di:

1. basis data: setiap kolom setiap tabel, dibaca sebagai peran pemilik (`scanDatabase`; kolom `bytea` dibaca byte per byte, jadi kenari yang tersimpan polos ditemukan dan yang terenkripsi tidak);
2. log tiap layanan, metrik, `audit_log`, dan jawaban API (`scanText`);
3. payload antar-layanan lewat proxy pengamat (`observing-proxy.ts`, hanya di memori).

Keluarannya hanya `{atribut, lokasi, layanan}`, **tidak pernah nilainya**, supaya pemindai sendiri bukan tempat kebocoran.

**Kontrol positif.** "Nol temuan" hanya berarti kalau pemindainya terbukti bisa menemukan. Karena itu ada tes yang menaruh data asli **dengan sengaja** dan menuntut pemindai menemukannya:

- `tests/pii-scan/scan.spec.ts`: tiap atribut, termasuk bentuk URL-encoded, harus terdeteksi.
- Tes E2E `scenarios.integration.spec.ts` menaruh nomor rekening di sebuah string dan menuntut satu temuan.
- Tes kesetaraan menuntut bahwa pada **baseline** pemindai menemukan `customer_id`, rekening, dan HP di basis data layanan, sedangkan pada proposed hanya HP (di Notification dan di simulator SMS).
- `services/*/test/baseline-repository.integration.spec.ts`: pemindai atas skema baseline harus menemukan data asli.

Tanpa kontrol itu, pemindai yang buta (misalnya salah kolom) akan menghasilkan "nol temuan" yang tampak seperti kemenangan privasi.

## Kasus TK-08 sebagai contoh membaca kegagalan tak stabil

Pada gerbang M5 sesi 1, `expectDenied` di `services/privacy-service/test/de-pseudonymize.integration.spec.ts` sekali gagal (`Expected length: 2, Received length: 1`). Penyelidikan (HANDOFF) menunjukkan penyebabnya di **tes**: `expectDenied(given, reason, open(...))` sudah memulai `open` sebelum helper membaca jumlah baris audit; penolakan `FORBIDDEN_ROLE` tidak membaca baris apa pun sehingga cepat, dan bisa meng-commit baris `DENIED` sebelum jumlah awal dibaca. Kode produksi benar (`AuditedOperation` meng-commit baris penolakan sebelum melempar error). Perbaikannya: helper menerima fungsi (thunk) supaya `open` baru dimulai sesudah jumlah awal dibaca. Pelajaran: dua puluh putaran hijau tidak membuktikan tidak ada balapan; yang meyakinkan adalah probe deterministik yang mereproduksi gejalanya dengan janji yang sudah selesai.

## Membaca hasil gerbang

"Gerbang" adalah rangkaian pemeriksaan yang harus hijau sebelum sebuah tiket atau milestone dinyatakan selesai (aturan proyek): lint, typecheck, test, test:integration, test:smoke, audit, gitleaks, pii-scan. Contoh keluaran ringkas gerbang M5 sesi 2 (dari [`docs/HANDOFF.md`](../HANDOFF.md)):

| Langkah | Hasil | Cara membaca |
| --- | --- | --- |
| lint dan typecheck | hijau | ESLint, Prettier, dan `tsc` tanpa galat |
| unit (2 worker) | 71 suite, 1340 tes | lihat baris `Test Suites:` dan `Tests:` |
| integrasi | 61 suite, 1134 tes | idem |
| smoke | 36 tes | proses hasil build di kedua mode |
| audit --prod | tidak ada kerentanan | hanya dependensi produksi |
| gitleaks riwayat penuh | 157 commit, bersih | tanpa allowlist untuk `services/` |
| pii-scan | 35 + 116 tes | unit lalu integrasi |

Cara membaca yang benar, dari kesalahan yang pernah terjadi:

- **Baca `Test Suites:` dan `Tests:` bersama.** Satu suite bisa "failed to run" (misalnya folder tidak ada) sementara baris `Tests:` tetap menunjukkan semua tes lulus. Itu bukan hijau.
- **Jangan merangkai perintah dengan `| tail` lalu `&&`**: `tail` menelan kode keluar sehingga kegagalan lint tidak menghentikan rangkaian. Pakai `set -o pipefail` atau jangan di-pipe.
- **Jangan menyimpulkan hijau tanpa bukti.** Tampilkan keluarannya.
- gitleaks dijalankan dua cara: `gitleaks detect --no-git --redact --config .gitleaks.toml` (pohon kerja, sebelum commit yang menyentuh `services/`) dan `gitleaks detect --log-opts="--all" --redact -v --config .gitleaks.toml` (seluruh riwayat). UUID dan token contoh **tidak boleh ditulis literal di `services/`**; tes membentuknya saat berjalan, misalnya dengan `['7c9e6679', '7425', ...].join('-')`. Allowlist hanya untuk `docs/` dan `tests/`.
- Kegagalan yang berulang diperlakukan sebagai bug, bukan sebagai "flake": mulai dari stempel waktu log, lalu memori, lalu baca kodenya.

## Yang belum ada

Newman/Postman (M6-01), laporan E(s) dan uji penautan (M6-02, M6-03), uji gagal tertutup dengan Docker (M6-04, M7), k6 (M7-01), dan pemindaian Semgrep/CodeQL di CI yang pernah dijalankan (workflow belum pernah dijalankan di GitHub, N-07). TK-01, TK-06, TK-09, TK-13, TK-14, TK-15 baru teruji di lapis layanan dan relay jawaban; end-to-end lewat Gateway menunggu M6-01.
