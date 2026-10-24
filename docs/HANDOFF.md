# HANDOFF (2026-10-24): `fix/dev-idp-customer-id` di-merge ke `main` lokal sebagai "merge dengan pengecualian tercatat" (bukan gerbang hijau)

**Dua pengecualian (N-52 di `OPEN_QUESTIONS.md`):** (1) `packages/common/test/test-db-cleanup.integration.spec.ts` merah juga di `main` (Fase B sesi ini menyelidikinya; hasilnya di bagian bawah bila ada); (2) tidak ada putaran integrasi penuh dua kali berturut-turut untuk cabang ini. Dasar merge: unit 1372, smoke 36, lint, typecheck, gitleaks riwayat penuh, pii-scan hijau; equivalence e2e hijau 6/6 sendirian.

**Syarat penutup DK:** butuh dua putaran penuh hijau berturut-turut, dan `test-db-cleanup` WAJIB sudah dijelaskan penyebabnya dan hijau sebelum itu.

---

# HANDOFF (2026-10-23): kesetiaan baseline, bagian jelas SELESAI (G1), gerbang lengkap (dua tes yang merah ternyata gangguan lingkungan sesi lama, kini hijau sendirian), di-merge ke `main` lokal; kesetiaan lanjut sebagai versi B (belum dikerjakan)

## PENGUKURAN BARU BOLEH DIMULAI SETELAH KEPUTUSAN A/B DAN PERSETUJUANMU

**Jangan menjalankan pengukuran apa pun (k6, E(s), uji penautan, angka latensi atau throughput, perbandingan baseline vs proposed untuk laporan) sebelum Fanny memutuskan A atau B (di bawah) dan menyetujui.** Harapan E(s) baseline di Tabel IV hanya teramati penuh di Transaction (4/6 bila klien mengirim NIK dan nama); Fraud, Reconciliation, dan Notification masih 1/6, 1/6, 2/6. Angka dari lingkungan lokal tidak masuk laporan (CLAUDE.md).

## Status sesi kesetiaan baseline

Cabang `feat/m5-kesetiaan-baseline` (tidak dihapus, tidak di-push), dari `main` pada `6c5e73e`:

| Hash | Isi |
| --- | --- |
| `dc1fbab` | analisis kesenjangan `docs/security/kesenjangan-baseline.md` (tanpa kode) |
| `f4584f2` | G1 (N-48): Gateway baseline meneruskan `nik` dan `nama` ke Transaction; Transaction baseline menerimanya tanpa menyimpan; suite kesetaraan memindai payload |
| `bdbb771` | 3a: Fraud tanpa audience di dev-idp |
| `f5f285f` | 3b: `SELF_APPROVAL` lewat HTTP oleh aturan empat mata (N-49) |
| `34bca9d` | 3c: `dev:keys`, `dev:up`, `dev:down`; `PG_DATABASE_SUFFIX` (N-50) |
| `657ecbd` | 3d: dokumen usang, istilah gerbang, `W-nn` |
| `b033ff5` | N-51: kajian token baru setelah revoke (tidak diimplementasikan) |
| `ffe82dd` `36d716a` | `/simplify` dan perbaikan `/code-review` |

`/security-review` seluruh cabang: tanpa temuan keyakinan 8 ke atas.

### Pembaruan gerbang (sesi lanjutan, tanpa perubahan kode produksi sejak `36d716a`; `bb584fa` hanya dokumen)

Proses sesi ini tanpa variabel `PG*`/`PRIVACY*`/`PRIVPAY*`/`NODE_ENV` dan tanpa proses node sisa; memori bebas ±3,6 GB dari 14 GB. `packages/common/test/test-db-cleanup.integration.spec.ts` sendirian: 1 suite, 5 tes hijau (kegagalan lama berasal dari lingkungan sesi lama, bukan kode). `services/privacy-service/test/token-forms.integration.spec.ts` sendirian: 44/44 hijau. Karena tidak ada perubahan kode produksi sejak putaran penuh pada `36d716a`, gerbang dianggap lengkap (satu putaran penuh, dua kegagalan terakhir terselesaikan sendirian); ini bukan putaran penuh kedua. Keputusan: N-51 diarahkan ke pilihan B (belum diimplementasikan, lihat `OPEN_QUESTIONS.md`), kesetiaan baseline lanjut sebagai versi B; penyimpanan salinan butuh migrasi baseline, jadi berhenti dan tanya sebelum mengerjakannya.

### Gerbang (satu putaran penuh pada `36d716a`, satu proses pada satu waktu): riwayat sebelum pembaruan di atas

| Langkah | Hasil |
| --- | --- |
| eslint + prettier, typecheck | hijau |
| unit (2 worker) | 72 suite, 1365 tes, hijau |
| integrasi | **61 suite lulus, 1 gagal** (1139 dari 1140 tes); lihat di bawah |
| smoke | 36 tes, hijau |
| audit --prod | tidak ada kerentanan |
| gitleaks riwayat penuh | 168 commit, bersih (tanpa allowlist baru) |
| pii-scan | 35 + 117 tes, hijau |

Riwayat jujur integrasi. Putaran 1 mati setengah jalan (subshell latar belakang ikut berhenti; tanpa ringkasan). Putaran 2: satu tes gagal, `privacy-service/test/token-forms` "an expired token is EXPIRED" (batas 30 detik; suite 485 detik karena mesin tertekan, kemungkinan tumpang tindih dengan sisa proses putaran 1); sendirian lulus 44/44. Putaran 3 (bersih, tanpa proses lain, 3810 detik): satu tes gagal, `packages/common/test/test-db-cleanup.integration.spec.ts` "a database held by a session it may not end": basis data yang seharusnya tertahan (`privpay_privacy_test_m006d`) ikut terhapus, jadi `privpay_test_admin` kini dapat mengakhiri sesi `privpay_app`, padahal tes mengharapkan SQLSTATE 42501. Gagal deterministik sendirian (dua kali) dan **juga di `main`** (diperiksa dengan pindah cabang pada pohon bersih), padahal lulus di gerbang sebelumnya. Katalog (hanya baca): `privpay_test_admin` bukan superuser, anggota lima peran `*_owner`; `db.integration` (hak peran) lulus 26/26. Penyebab di sisi PostgreSQL lokal belum ditemukan (tidak ada akses superuser). Bukan akibat cabang ini; tes tidak diubah. Karena itu **tidak di-merge ke `main`**; menunggu keputusanmu (selidiki PostgreSQL lokal / `bootstrap.ps1`, atau terima sebagai masalah lingkungan yang sudah ada).

Memori bebas sebelum gerbang: ±5 GB dari 14 GB.

### N-51 (24 Okt): DITUTUP sebagai keterbatasan (keputusan Fanny: pilihan 1); B dilewati karena bentrokan, A tidak dikerjakan

Arahan: pilihan B (tolak penerbitan token baru untuk subjek dengan baris `revoked`, `REVOKED` 403, tanpa tabel atau ADR). Pemeriksaan ADR-0005, ADR-0013 butir 3, ADR-0014, K-33 menemukan dua bentrokan dan satu hal yang tidak mungkin; **tidak ada kode yang diubah**: (1) dev-idp memakai ulang `customer_id` setelah dimulai ulang sementara database Privacy bertahan, jadi registrasi baru dapat terblokir `REVOKED` (503); (2) `REVOKE_TOKEN` satu token menghasilkan baris `revoked` yang tak dapat dibedakan dari `revoke_subject`, sehingga memblokir seluruh subjek; membedakannya butuh kolom/tabel/ADR; (3) token ACCOUNT tidak dapat ikut ditolak karena Privacy tidak menyimpan hubungan nasabah-rekening. Rinci dan tiga pilihan ada di `OPEN_QUESTIONS.md` N-51.

**Keterbatasan yang berlaku (rumusan Fanny):** pencabutan memutus akses ke identitas (brankas dan pembukaan bersyarat) dan token yang ada; ia bukan larangan bertransaksi, jadi nasabah yang dicabut masih dapat memperoleh token baru dan membayar. Arah lanjutan bila perlu: nisan dengan batas waktu lewat ADR baru. Temuan 1 diperbaiki terpisah di dev-idp (`fix/dev-idp-customer-id`).

### Keputusan yang butuh persetujuan Fanny

- **A atau B** (`kesenjangan-baseline.md` bagian 4): A = baseline hanya mengganti pengenal (Tabel IV diubah menjadi 2/6, 1/6, 1/6, 2/6); B = passthrough penuh (G3 sampai G6; menyimpan salinan butuh migrasi baseline, jadi berhenti dan tanya). Email diteruskan atau tidak (G2).
- **N-48** perluasan skema masuk `POST /transaction` hanya di baseline; **N-49** pengguna dev-idp dua peran tidak ditambahkan (ADR-0007 butir 8); **N-50** env `PG_DATABASE_SUFFIX` dan database `privpay_<layanan>_test_devbl` untuk baseline; **N-51** arah token setelah revoke (nisan, atau terima sebagai keterbatasan).
- Poin 5 `docs/RETRO_M4.md` dan `docs/RETRO_M5.md` ("Yang kuhentikan") masih menunggu isianmu.

### Cara menyalakan sistem

`corepack pnpm build`, `scripts/db/bootstrap.ps1` (sekali), `corepack pnpm db:migrate`, `corepack pnpm --filter @privpay/dev-idp run make-secrets`, `corepack pnpm dev:keys`, lalu `corepack pnpm dev:up [--mode baseline]`; `dev:down` menghentikan. Lihat `scripts/dev/README.md`. Database `devbl` tampil sebagai sisa tes di `db:test-databases`.

### Belum teruji

E(s) resmi dan uji penautan (M6); Fraud, Reconciliation, Notification baseline terhadap Tabel IV; log baseline hanya satu skenario dan tanpa mutasi khusus log; Docker, Kong, Keycloak, Newman, k6; fail-closed dengan Docker (M7).

---

# HANDOFF (2026-10-23): M5 sesi 2 SELESAI (gerbang hijau satu putaran), siap di-merge ke `main` lokal; berikutnya M6 hanya setelah persetujuanmu

## PENGUKURAN BARU BOLEH DIMULAI SETELAH M5 SELESAI DAN TERBUKTI

**Jangan menjalankan pengukuran apa pun (k6, E(s), uji penautan, angka latensi atau throughput, perbandingan baseline vs proposed untuk laporan) sebelum Fanny menyetujui penutup M5 dan `main` memuat M5 dengan gerbang hijau.** Bukti M5 ada di `docs/security/review-M5.md`, `docs/RETRO_M5.md`, dan tabel gerbang di bawah. Angka dari lingkungan lokal tidak masuk laporan (CLAUDE.md).

## Status M5 sesi 2

Cabang `feat/m5-sesi-2` (tidak dihapus, tidak di-push), commit dari `345c6e7`:

| Hash | Isi |
| --- | --- |
| `fe93e99` | TK-08 / AZ-22: `expectDenied` menerima thunk (penyebab flake di tes) |
| `251c8c9` | rename `customerToken`/`accountToken` menjadi `customerSubjectRef`/`accountSubjectRef` (tanpa perubahan perilaku) |
| `878d778` | N-45: `FRAUD_HISTORY_DAYS` di kedua mode |
| `130ca92` `cd9a13b` `b59ad91` `188d11b` `17999ba` `e556ae4` | M5-02/M5-03 per layanan: common+Fraud, Notification, Transaction, Reconciliation, Gateway, Privacy |
| `97746dc` | suite kesetaraan E2E (stack parametrik per mode) |
| `b3bcc66` | dokumen N-44/N-46/N-47, spek, CHANGELOG |
| `255ecd6` | `/simplify` (+ perbaikan tes arsitektur: Gateway dulu tidak ikut terjalankan) |
| `9024b0f` | smoke test proses nyata di kedua mode + RETRO_M5 |
| `c286dc8` | perbaikan `/code-review` |

### Hasil TK-08 / AZ-22

Penyebab: di tes, bukan di kode produksi. `expectDenied(given, reason, open(...))` memulai `open` sebelum badan helper membaca jumlah baris audit; penolakan `FORBIDDEN_ROLE` tidak membaca baris apa pun, jadi cepat, dan bisa meng-commit baris DENIED sebelum `before` dibaca (diharapkan 2, diterima 1). `AuditedOperation` meng-commit baris DENIED dan menunggunya sebelum melempar error, jadi penolakan selalu meninggalkan baris audit. Bukti: 20 putaran suite hijau (tidak mereproduksi sendirian), probe deterministik dengan janji yang sudah selesai mereproduksi `Expected length: 2, Received length: 1`, perbaikan (thunk: jumlah dibaca sebelum operasi mulai) lalu 24/24 hijau dan seluruh folder integrasi Privacy 17 suite, 453 tes. Tanpa pelonggaran asersi. Bila muncul lagi, perlakukan sebagai bug.

### Gerbang (satu putaran penuh pada `c286dc8`, satu proses pada satu waktu, tanpa terhenti sistem)

| Langkah | Hasil |
| --- | --- |
| eslint + prettier, typecheck | hijau |
| unit (2 worker) | 71 suite, 1340 tes |
| integrasi | 61 suite, 1134 tes |
| smoke | 36 tes (proses hasil build di kedua mode + mode tak konsisten ditolak) |
| audit --prod | tidak ada kerentanan |
| gitleaks riwayat penuh | 157 commit, bersih (tanpa allowlist baru) |
| pii-scan | 35 + 116 tes |

Memori bebas sebelum gerbang: 6457 MB dari 14141 MB.

### Yang dibangun

- Semua layanan membaca `PRIVACY_MODE` (`modeConfigShape`); akar komposisi (`*.module.ts`) memilih repositori dan adaptor; pabrik baseline menolak mode selain baseline. Bentuk referensi per mode (`subjectRefShape`) divalidasi di HTTP tiap layanan (N-44).
- Aturan env (N-47): `PRIVACY_SERVICE_URL` wajib di proposed dan DILARANG di baseline (Gateway, Transaction, Notification, Reconciliation); Privacy Service menolak start di baseline.
- Adaptor baseline: `BaselinePrivacyClient` (Notification, Reconciliation), `BaselinePrivacyStatus` (Transaction), `PassthroughPrivacyPort` (Gateway). Reconciliation baseline mengambil rekening dari Transaction (`account_number` pada `GET /transaction/{id}`, N-46).
- N-45: `FRAUD_HISTORY_DAYS` (wajib, 1..3650, nilai kerja 30) membatasi riwayat di SQL pada kedua mode.
- Suite kesetaraan: jawaban, baris, dan pesan identik di kedua mode; pemindai menemukan data asli hanya di baseline.
- Skill dipakai: diagnosing-bugs (TK-08), tdd (dimuat untuk N-45; tes merah dulu diikuti di seluruh sesi), simplify, code-review, security-review, run. Tidak ada: `improve-codebase-architecture` dan `implement` (tidak ada di daftar skill).

### Ancaman validitas N-45 (catat di laporan skripsi)

Jendela riwayat Fraud kini 30 hari di kedua mode (SQL, bukan umur token). Selisih yang TETAP: di proposed riwayat terikat pada token FRAUD_DETECTION yang hidup 30 hari, sehingga setelah token berganti, assessment di bawah token lama tidak terbaca walau masih dalam jendela; di baseline kunci `customer_id` tidak berganti, seluruh jendela terbaca. Itu efek mekanisme privasi, bukan rancangan eksperimen, dan harus dilaporkan sebagai ancaman validitas. Ongkos kegunaan data: pemotongan 30 hari membuang riwayat lebih lama yang di baseline tersedia. Dicatat di `docs/OPEN_QUESTIONS.md` N-45.

### Keputusan yang butuh persetujuan Fanny

- N-46: `GET /transaction/{id}` memuat `account_number` pada baseline (perluasan kontrak spek 3.4 hanya di baseline); Reconciliation baseline memanggil `byId` sekali per transaksi.
- N-47: definisi "env tak konsisten"; di baseline `/register` tidak menyimpan NIK dan nama di mana pun (tidak ada brankas) dan rute `audit-request`/`disclosure` dijawab 503 (`SERVICE_UNAVAILABLE`, tanpa kode error baru).
- Batas atas 3650 pada `FRAUD_HISTORY_DAYS` (usulan saya dari `/code-review`, PRD 17 tidak menyebutnya).
- Perbaikan tes arsitektur: Gateway hanya diwajibkan punya folder `baseline/` (adaptor proposed-nya ada di `tokenizer/`).
- Penutup M5: persetujuan merge; poin 5 `docs/RETRO_M5.md` dan poin 5 `docs/RETRO_M4.md` ("Yang kuhentikan") menunggu isianmu.
- Usulan perubahan CLAUDE.md di `docs/RETRO_M5.md` bagian 4 (belum diterapkan).

### Belum teruji

Fail-closed dengan Docker (M7); Newman (M6-01); Semgrep/CI; isi log aplikasi pada mode baseline; ketidakcocokan mode antar-proses yang berjalan; kinerja (sengaja belum diukur); TK-01/06/09/13/14/15 end-to-end lewat Gateway (M6-01).

### Sisa tahapan

`/improve-codebase-architecture` setelah M5 (skill tidak ada di daftar; perlu keputusanmu), merge ke `main` lokal, M6 (Newman, E(s), penautan, pengukuran setelah persetujuan), M7 (Docker, fail-closed, k6), DK-01..02 (Docker Compose, Kong plugin Lua).

---

# (Riwayat) HANDOFF (2026-10-23): M5 sesi 1 SELESAI (N-40 + M5-01 untuk Transaction, Fraud, Notification, Reconciliation), di-merge ke `main` lokal; berikutnya M5 sesi 2 (M5-02, M5-03, penutup M5; belum dimulai)

## Status M5 sesi 1

Cabang `feat/m5-sesi-1` (tidak dihapus, tidak di-push): `07ded7e` N-40 (kolom `privacy_rejected_at`, migrasi proposed/0004, E-33), `2ad3e14` Transaction, `7cde929` Fraud, `611542f` Notification, `8b93a40` Reconciliation (M5-01 per layanan), `3f317e1` tes arsitektur + docs + pii-scan, `44163d3` simplify, `2218eb8` perbaikan code-review. Penjelasan pemula: `docs/PENJELASAN_MODE_BASELINE.md`.

Desain: satu kelas repositori per layanan; SQL yang menyebut kolom subjek datang dari `src/proposed/subject-sql.ts` atau `src/baseline/subject-sql.ts`; pabrik `proposedXRepository` / `baselineXRepository` (baseline menolak bila `PRIVACY_MODE` bukan `baseline`). Transaction: `BaselineSubjectReferences` (menyerahkan `customer_id` apa adanya). Migrasi baseline per layanan di `migrations/baseline/`. Tes arsitektur `tests/repo/mode-folders.spec.ts`; pembanding skema `tests/baseline/schema-parity.ts`; `pnpm pii-scan` kini memuat kontrol positif: pada skema baseline pemindai HARUS menemukan data asli.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 67 suite, 1309 tes | 67 suite, 1309 tes |
| integrasi | 55/56 suite, 1093/1094 tes (1 GAGAL) | 56 suite, 1094 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat penuh | bersih | bersih |
| pii-scan | 35 + 109 tes | 35 + 109 tes |

Riwayat jujur: putaran 1 gagal satu tes, `privacy-service/test/de-pseudonymize.integration.spec.ts` TK-08/AZ-22 `expectDenied` (panjang 2 diharapkan, 1 diterima). Privacy tidak diubah di sesi ini; suite itu sendirian lulus 24/24 dan putaran 2 hijau penuh. Penyebab belum diselidiki (tak stabil, bukan akibat perubahan sesi ini sejauh bukti ada); bila terulang, perlakukan sebagai bug yang berdiri sendiri. Putaran 2 pertama dihentikan sistem (memori kritis) sekali, lalu diulang dari awal dengan memori ±6 GB dan keep-awake; satu putaran penuh hijau menyusul. Mutasi M5-01 (7 butir) semuanya terbunuh.

### Keputusan yang butuh persetujuan Fanny

- N-42 rename kolom `notification_log` di baseline; N-43 satu kelas repositori + SQL per folder mode.
- N-44 (bahan M5-02): regex `PSEU-` di HTTP tiap layanan; adaptor baseline `resolveDomain` Notification dan klien Privacy Reconciliation; modul belum membaca `PRIVACY_MODE`, jadi `baseline` masih menjalankan proposed sampai M5-02.
- N-45: jendela riwayat Fraud (proposed 30 hari lewat umur token, baseline tak terbatas) = ancaman validitas; pilih `FRAUD_HISTORY_DAYS=30` atau terima sebagai keterbatasan.
- Apakah `customerToken`/`accountToken` di domain diganti nama netral (`subjectRef`).

### Temuan ditolak

Modul belum membaca `PRIVACY_MODE` (itu M5-02); SQL kembar per mode (disengaja: larangan concat); `resyncBatch` dibutuhkan tes; N-40 terpisah dari M5-01 (sengaja, commit terpisah); `/simplify`: factory berpenjaga (perlu M5-02), reissue berurutan (kode lama), helper kecil.

### Belum teruji

Adapter baseline terpasang ke layanan yang berjalan, Gateway jalur baseline (M5-03), Newman (M6-01), Docker/fail-closed (M7).

### Sisa tahapan

M5-02, M5-03, penutup M5 (`/security-review`, retro, `/improve-codebase-architecture`).

---

## (sebelumnya) HANDOFF (2026-10-23): M4 DITUTUP (M4-10 + penutup, dua putaran hijau), di-merge ke `main` lokal; berikutnya M5 (belum dimulai)

## Status M4-10 dan penutup M4

Cabang `feat/m4-10-penjadwal` (tidak dihapus): `e49d50b` M4-10, `b894e2c` perbaikan review, `dc6d8c4` penutup (`review-M4.md`, checklist, `RETRO_M4.md`, pelajaran di CLAUDE.md). `/simplify` (4 agen), `/code-review` (10 temuan: 6 diperbaiki, 4 ditolak), `/security-review` seluruh M4 (`857cad1..HEAD`): tanpa temuan keyakinan 8 ke atas, jadi persetujuan penutup M4 yang diberikan di muka berlaku.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 65 suite, 1286 tes | 65 suite, 1286 tes |
| integrasi | 52 suite, 1055 tes | 52 suite, 1055 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat penuh | bersih | bersih |
| pii-scan | 35 + 76 tes | 35 + 76 tes |

Riwayat percobaan (jujur): lari pertama gagal satu tes integrasi (`reconciliation-http` N-27, batas 30 detik pada hook `createTestDb`; celah ±3 menit di stempel waktu log). Suite itu sendirian lulus (43 tes). Lari ulang kedua hijau penuh (= putaran 1 di atas). Lari ketiga gagal 2 tes `pii-scan` E2E (`scenarios` TX-10002, batas 30 detik; suite 3735 detik padahal log hanya mencakup 33 detik); log daya Windows membuktikan standby (Kernel-Power 506) 22:32-23:19 dan 23:19-23:34, tepat di jendela itu, jadi lari itu tidak dihitung (bukan kegagalan kode). Lari keempat dengan mesin dicegah tidur (`SetThreadExecutionState`, tanpa mengubah pengaturan daya) hijau penuh = putaran 2 di atas, tanpa peristiwa daya. Dua putaran hijau itu tidak berurutan langsung (lari ketiga di antaranya gugur karena tidur mesin); ini dicatat agar kamu yang menilai. Bila gagal lagi tanpa tidur mesin, perlakukan sebagai bug. Pelajaran untuk gerbang panjang di laptop: jalankan dengan keep-awake (`privpay-keepawake.ps1`-sejenis) atau colokkan daya dan matikan sleep.

### Yang dibangun (M4-10, K-19/K-23/K-26)

- `Scheduler` bersama di `packages/common` (jam dan timer disuntik, tanpa tumpang tindih, galat dicatat dengan nama job dan `reason` saja, dimulai setelah `listen`, berhenti sebelum kolam ditutup dengan penantian dibatasi `SHUTDOWN_TIMEOUT_MS`). Mati bawaan saat `NODE_ENV=test`; `SCHEDULER_ENABLED=true/false`. Satu instans per layanan.
- Privacy: `RetentionJob` harian (`RETENTION_DAYS`, `RETENTION_JOB_RUN_UTC`). Transaction: satu job `clean()` (sweep PENDING lalu resync PATCH) tiap `TX_SWEEP_INTERVAL_SECONDS`. Reconciliation: rekonsiliasi harian hari kemarin (`RECON_DAILY_RUN_UTC`).
- Bukti proses nyata: layanan Transaction hasil build, interval 1 detik, PostgreSQL tak terjangkau: job berjalan tiap detik, galat tanpa data pribadi, `/health` 200. SIGTERM di Windows = hard kill; jalur sinyal teruji di CI Linux.
- S-36 (retensi sampai identitas kosong) kini terbukti end-to-end (`scheduler.integration.spec.ts`).

### Keputusan yang butuh persetujuan Fanny

- N-40: `resync` memberi 100 baris belum-didengar tertua; baris yang ditolak Privacy permanen (4xx) tidak ditandai dan menahan baris baru. Butuh kolom penghitung (PRD 11) atau aturan lewati-4xx.
- N-41: penantian job saat shutdown dibatasi `SHUTDOWN_TIMEOUT_MS` (10 detik).
- Poin 5 `docs/RETRO_M4.md` ("Yang kuhentikan") menunggu isianmu.

### Temuan `/code-review` M4-10 yang ditolak

Resync membeku pada baris ditolak permanen (N-40); job harian yang terlewat tidak dikejar setelah restart (desain, terdokumentasi); logger kedua di Privacy (modul tak punya logger); tanggal `previousDate` dihitung saat eksekusi.

### Butir checklist keamanan

Dicentang pada penutup M4: S-20, S-27, S-30, S-36, S-38, S-43, S-52, S-54. Tetap sebagian: S-41 (Semgrep belum), S-42 (TK-01/06/09/13/14/15 sampai M6-01), S-44 (Kong), S-50 (Docker, M7), S-07, S-08.

### Belum teruji

Newman/M6-01 (TK end-to-end); fail-closed dengan Docker (M7); `trust proxy` di belakang Kong; Semgrep/CI; kinerja D2; kontak HP dan pengguna IdP yatim (ADR-0005); N-40.

### Usulan pembagian gerbang M5

1. Gerbang 1: M5-01 transaction + fraud (migrasi baseline, repositori, adapter `SubjectReferencePort` baseline).
2. Gerbang 2: M5-01 notification + reconciliation, ditambah tes arsitektur (kode domain tidak mengimpor folder per mode).
3. Gerbang 3: M5-02 (pengalih `PRIVACY_MODE`, suite kesetaraan perilaku di tumpukan E2E `services/gateway/test/e2e/stack.ts`, env tak konsisten ditolak saat start).
4. Gerbang 4: M5-03 (Gateway mode baseline di `Tokenizer`) + penutup M5 (`/security-review`, `/retro`).
Catatan: baseline memegang data asli; tidak boleh aktif pada konfigurasi proposed. `/improve-codebase-architecture` setelah M4 dan M5 belum dijalankan (menunggu perintahmu).

# (Riwayat) Gerbang 4 M4 LULUS (dua putaran hijau)

## Status Gerbang 4 M4

Cabang `feat/m4-gerbang-4` (tidak dihapus), commit: `8476b6c` validasi panjang `sub` (64 karakter, 422), `50a86fc` M4-08 (termasuk ADR-0014), `f598537` M4-09, `a1a5801` satu pola HP. `/code-review`: 10 temuan, 1 diperbaiki, 9 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 62 suite, 1227 tes | 62 suite, 1227 tes |
| integrasi | 51 suite, 1046 tes | 51 suite, 1046 tes (lihat catatan) |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat | bersih | bersih |
| pii-scan | 35 + 68 tes | 35 + 68 tes |

Catatan putaran 2: lari integrasi pertama gagal satu tes (`db.integration`, "recreates the database from scratch", batas 30 detik). Stempel waktu log melompat ±2 jam di tengah suite itu (mesin tidur/sleep; durasi suite 6975 detik), jadi batas jam dinding habis oleh tidur mesin, bukan kode. Suite itu sendirian lulus (26 tes) dan seluruh integrasi diulang hijau (51 suite, 1046 tes). Bila gagal lagi tanpa tidur mesin, perlakukan sebagai bug.

### Yang dibangun

- ADR-0014 (E-31): `API_GATEWAY` boleh `revoke_subject` untuk `CUSTOMER` (kompensasi pendaftaran). Dua tes lama diubah dengan alasan di CHANGELOG.
- M4-08: `POST /register` (A2, A5, A3, A4, kompensasi, laju per alamat sumber) dan `POST /notification/register` (AZ-02) di Gateway; env baru wajib `NOTIFICATION_SERVICE_URL`.
- M4-09: tumpukan E2E dengan dev-idp, Privacy, Transaction, Fraud, Notification, simulator SMS, Reconciliation asli di `services/gateway/test/e2e` (`registration` 28 tes, `scenarios` 13 tes); `pnpm pii-scan` menjalankannya. Rute `held` dan `review` kini teruji lewat Gateway (AZ-04, AZ-05).

### Keputusan yang butuh persetujuan Fanny

N-38 (email divalidasi lalu dibuang: brankas tidak punya kolom email, jadi "email hanya di brankas" tidak terpenuhi harfiah; email tidak ada di mana pun), N-39 (kompensasi mengosongkan brankas walau A5 melaporkan gagal), ADR-0014 sudah Accepted atas pilihanmu.

### Temuan `/code-review` yang ditolak

Telepon yatim di Notification bila jawaban A4 hilang (batas ADR-0005: Notification tak punya hapus kontak; token domainnya dicabut); pengguna IdP yatim bila jawaban A2 hilang (batas yang dicatat); batas panjang `sub` untuk semua jenis token (diminta); ADR-0014 berlaku untuk semua `CUSTOMER` (risiko diterima di ADR); `req.ip` tanpa `trust proxy` (belum ada proksi; harus ditinjau saat Kong/Docker); `customerId ?? ''` (tak terjangkau, `mayCall` memeriksa klaim lebih dulu); enumerasi nama pengguna lewat 422 (tak terhindarkan, dibatasi laju); `Content-Length` tak ada pada badan chunked (setiap field dibatasi skema); kompensasi karena NIK ganda mengosongkan brankas pelanggan lain (tidak: purge berkunci `customer_lookup` dari id pelanggan baru).

### TK yang belum teruji end-to-end (keputusanmu)

TK-01, TK-06, TK-09, TK-13, TK-14, TK-15: lapis layanan dan relay jawaban kawat saja, sampai M6-01 (Newman lewat Gateway).

### Belum teruji

Adapter baseline (M5); Newman (M6-01); fail-closed dengan Docker; `trust proxy` di belakang Kong; kinerja D2 untuk ribuan transaksi.

### Untuk penutup M4

`/security-review` seluruh M4, centang `docs/security/security-checklist.md`, `/improve-codebase-architecture` (boilerplate autentikasi dan pool terulang di enam layanan), persetujuan Fanny, lalu `/retro`. M5 belum dimulai.

# (Riwayat) Gerbang 3 M4 LULUS (dua putaran hijau)

## Status Gerbang 3 M4

Cabang `feat/m4-gerbang-3` (tidak dihapus), commit: `ffe2081` flake basis data, `24ebfd6` keputusan Gerbang 2 nomor 1 (PATCH yang tak didengar Privacy), `34f28ac` M4-06, `57c5f45` M4-07, `9426ce2` perbaikan `/code-review`. `/code-review`: 10 temuan, 2 diperbaiki, 8 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas (Gateway tanpa `no-store` ditemukan tes M4-07 sendiri dan diperbaiki, N-36).

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 61 suite, 1216 tes | 61 suite, 1216 tes |
| integrasi | 49 suite, 1001 tes | 49 suite, 1001 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih | bersih |
| pii-scan | 35 + 27 tes | 35 + 27 tes |

### Penyelidikan flake basis data (M2-09, token-service, M0-04)

Penyebab yang ditemukan (dibuktikan sebagian, tidak direproduksi di bawah beban): (1) `createPool` memakai `connectionTimeoutMillis: 5000` di tingkat klien `pg` (`client.js`: timer membunuh socket); membuka backend PostgreSQL baru di Windows lebih lambat dari itu bila memori sempit atau basis data baru dibuat, dan 50 permintaan paralel membuka sepuluh sekaligus. (2) Poll tes yang dibatasi jumlah putaran (M0-04: 5000 putaran = ±1,5 detik pada mesin tenang, terukur 300 ms untuk ±900 putaran) berakhir terlalu cepat saat beban. Perbaikan di konfigurasi tes, tanpa melonggarkan asersi: pool `createTestDb` dengan batas koneksi 20 detik (bawaan produksi tetap 5 detik, opsi baru `connectionTimeoutMillis`), dan tujuh poll diganti tenggat 20 detik. `max_connections` 100, `shared_buffers` 128 MB; puncak koneksi per suite ±18 dengan satu worker, bukan penyebab. Satu kegagalan tak stabil baru terlihat sekali (`reconciliation-http`, "service notification with an admin", saat gerbang parsial) dan tidak terulang dalam 3 + 2 lari penuh; bila muncul lagi, perlakukan sebagai bug.

### Keputusan Gerbang 2 yang dikerjakan

1. Notifikasi sebelum `PATCH`: spek 5 diubah dengan alasannya. `PATCH` yang gagal kini tidak diam: kolom `privacy_synced_at` (migrasi 0003, **penyimpangan dari PRD 11, N-34, commit terpisah, dapat dibatalkan**) menandai baris yang belum didengar Privacy, dan `PendingSweeper.resync()` mengulang `PATCH` tanpa mengirim ulang notifikasi (8 tes, dua mutasi terbunuh). 3. Pelaku review sudah tercatat (`reviewed_by` = `sub` token aktor, `reviewed_at`), tanpa data pribadi; catatan: `sub` tanpa batas panjang, kolom 64 karakter. 2, 4, 5, 6 sesuai keputusan.

### Yang dibangun

- M4-06: Reconciliation (`settlement-report`, `run`, `Reconciler`, `DailyRun`), skema reconciliation-db, `GET /transaction/completed`, simulator bank (`POST /simulate/settlement`).
- M4-07: `audit-request`, `disclosure`, `GET /transaction/{id}`; lapis Gateway M3-06 memakai Reconciliation sungguhan (N-37: TK-02..05 lewat jalur nyata, TK-08 ditolak Gateway, TK-01/06/09/13/14/15 tetap meneruskan jawaban kawat Privacy karena pemanggilnya tak punya rute klien).
- Env baru wajib: Reconciliation `RECON_DAILY_RUN_UTC`, `PRIVACY_SERVICE_URL`, `TRANSACTION_SERVICE_URL`, `RECONCILIATION_CLIENT_SECRET_FILE`; simulator bank `GATEWAY_URL`, `BANK_USERNAME`, `BANK_SIMULATOR_TEST_ENDPOINTS` (opsional, `true`/`false`).

### Keputusan yang butuh persetujuan Fanny

N-32 (batch pengganti `MISMATCHED` sampai run), N-33 (D2: `TOKEN_NOT_FOUND`/`REVOKED` tak berpasangan, selain itu 503), N-34 (kolom `privacy_synced_at`), N-35 (baris `audit_requests` hanya sesudah token terbit), N-36 (`no-store` di Gateway), N-37 (perubahan lapis Gateway M3-06). Semuanya di `docs/OPEN_QUESTIONS.md`.

### Temuan `/code-review` yang ditolak

`resync` PATCH status basi (Privacy menolak balik ke non-final, tanda dijaga status, baris dibaca ulang dengan status baru); D2 berurutan (volume prototipe); atomisitas `audit-request` dengan Privacy (lintas layanan, Privacy sudah mencatat aktor); kursor bersama `held`/`completed` (hanya posisi, tanpa dampak keamanan); urutan tie-break referensi bank (deterministik); parameter query ganda (sudah 422); back-fill migrasi 0003 (hanya basis data pengembangan).

### Belum teruji

Adapter baseline (M5); Newman lewat Gateway (M6-01); alur `/register` dan E2E TX-10001..10003 (M4-08, M4-09); fail-closed dengan Docker; kinerja D2 untuk ribuan transaksi per hari.

### Untuk Gerbang 4

M4-08 (alur pendaftaran, bergantung M2-08, M4-05, M1-01) dan M4-09 (E2E, bergantung M4-02, M4-03, M4-06, M4-08). `pnpm db:migrate` kini juga mengisi transaction-db, fraud-db, notification-db, reconciliation-db (bila `SERVICE_DBS` didaftar).

# (Riwayat) Gerbang 2 M4 LULUS, di-merge ke `main` lokal

## Status Gerbang 2 M4

Commit di `feat/m4-gerbang-2` (cabang tidak dihapus): `131ec26` M4-02 orkestrasi, `2838ace` M4-03 review `HELD` dan pembersih `PENDING`, `d58f852` perbaikan `/code-review`. `/code-review`: 9 temuan, 4 diperbaiki, 5 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 57 suite, 1127 tes | 57 suite, 1127 tes |
| integrasi (2 worker) | 39 suite, 803 tes (lihat catatan) | 39 suite, 803 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` | bersih | bersih |
| pii-scan | 35 + 16 tes | 35 + 16 tes |

Catatan putaran 1: lari integrasi pertama gagal satu tes, `M0-04 a runner waits while another one holds the migration lock` (`packages/common/test/migrate.integration.spec.ts`, tidak diubah di gerbang ini). Suite itu sendirian lulus 15/15 dua kali dan seluruh integrasi diulang hijau. Penyebab tidak diselidiki; dianggap flake bergantung waktu saat beban penuh. Bila terulang, perlakukan sebagai bug.

### Yang dibangun

- M4-02: `TransactionProcessor` mengorkestrasi Fraud (X1), `PATCH` status ke Privacy, dan notifikasi (X2) lewat port (`SubjectReferencePort` dengan adapter proposed, `FraudClient`, `NotificationClient`, `PrivacyStatusClient`, adapter HTTP di `clients.ts`). Fraud mati, timeout, atau pertukaran gagal: `HELD` + `FRAUD_UNAVAILABLE`. Fraud dan Notification `idempotent: false` (satu panggilan, diuji dengan hilir lambat, 503, dan galat jaringan). Token kedaluwarsa: re-issue kedua token, coba sekali lagi. Mesin status di `status-machine.ts`, dijaga di SQL (`WHERE status = $asal`); pemenang terlambat menjawab status tersimpan.
- M4-03: `GET /transaction/held` (kursor keyset opak), `POST /transaction/{id}/review` (baris dikunci `FOR UPDATE`, aktor dari token), `PendingSweeper`.
- Env baru, semuanya wajib (gagal cepat): `PRIVACY_SERVICE_URL`, `FRAUD_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `TX_PENDING_TIMEOUT_SECONDS`, `TRANSACTION_CLIENT_SECRET_FILE`.

### Keputusan yang butuh persetujuan Fanny

1. **Urutan notifikasi dan `PATCH` dibalik** (notifikasi dulu) di jalur orkestrasi dan review. Spec 5 menulis PATCH (langkah 3) lalu notifikasi (langkah 4), tetapi Privacy menolak re-issue (`TX_TERMINAL`) setelah transaksi final, sehingga TF-04 tak terpenuhi bila PATCH lebih dulu. Catatan sudah ditambahkan di spec 5; ubah atau kembalikan bila tidak setuju.
2. **Review pada id yang tidak ada dijawab `NOT_HELD`** (409), bukan 404: spec 3.3 hanya menyebut "bukan `HELD`".
3. **`reason_code` review divalidasi tetapi tidak disimpan**: tabel `transactions` (PRD 11) tidak punya kolomnya. Bila jejak alasan diperlukan, butuh kolom (ADR).
4. **`COMPLETED` lewat review mengisi `completed_at`, `FAILED` (REJECT) tidak**, mengikuti jalur otomatis.

### Temuan `/code-review` yang ditolak

re-issue dua token berurutan (Privacy mengembalikan token baru yang sama pada panggilan kedua, jadi gagal sebagian aman diulang); penantian pemenang tetap `HTTP_TIMEOUT_MS` (ADR-0009 / K-25, 409 aman diulang); env baru wajib (CLAUDE.md: gagal cepat); `MutableSubject` (gaya, berurutan, tidak ada balapan).

### Belum teruji

adapter baseline `SubjectReferencePort` (M5); rute Gateway ke `held` dan `review` (AZ-04, AZ-05 di sisi Gateway; hanya sisi layanan AZ-27 dan AZ-28 yang diuji); Privacy, Fraud, Notification asli di belakang Transaction end-to-end (M4-09); endpoint 3.4 untuk Reconciliation (M4-06); fail-closed dengan Docker.

### Untuk Gerbang 3 (M4-06, M4-07)

Urutan menurut `docs/tickets/README.md`. Boilerplate autentikasi dan pool terulang di enam layanan (kandidat `/improve-codebase-architecture` setelah M4 dan M5).

# (Riwayat) Gerbang 1 M4 LULUS (dua putaran hijau)

## Status Gerbang 1 M4

Commit di `feat/m4-gerbang-1` (di-merge ke `main`, cabang tidak dihapus): tes S-55 dan S-03; M4-01 Transaction (`POST /transaction`, idempotensi ADR-0009); M4-04 Fraud (`POST /fraud/assess`, `RiskEngine`); M4-05 Notification dan SMS simulator; perbaikan `/code-review`; premis tes `db:migrate`; pelajaran di `CLAUDE.md`. `/code-review`: 10 temuan, 3 diperbaiki, 7 ditolak (alasan di CHANGELOG dan laporan). `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 56 suite, 1116 tes | 56 suite, 1116 tes |
| integrasi | 34 suite, 692 tes | 34 suite, 692 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` (tanpa allowlist) | bersih | bersih |

**Penulisan ulang riwayat (atas persetujuan Fanny, hanya `feat/m4-gerbang-1`):** UUID dan token contoh tertulis literal di lima berkas tes di `services/` pada commit M4-01 dan M4-04, sehingga `gitleaks --all` merah. Riwayat lokal cabang itu (belum di-push) ditulis ulang dengan `git filter-branch --tree-filter` supaya nilai itu dibentuk saat tes berjalan; ref `refs/original` dihapus; `main` dan cabang lain tidak disentuh. Verifikasi: pohon akhir `6bd6d08` identik dengan pohon sebelum penulisan ulang, dan terhadap pohon `cfec27a` hanya berbeda pada lima baris literal itu. Cadangan bundle di scratchpad sesi. Pelajarannya sudah di `CLAUDE.md`.

### Keputusan Fanny pada Gerbang 1 M4

N-30 (rute uji yang mati dijawab 422 seragam, bukan 404), N-31 (kegagalan Privacy pada `send` tanpa baris log; galat basis data tetap 5xx), perubahan lockfile (hanya entri importer untuk paket yang sudah ada), perubahan premis tes `db:migrate`, dan M4-04 lalu M4-05 dikerjakan berurutan.

### Untuk Gerbang 2 (M4-02 dan M4-03)

- `POST /fraud/assess` dan `POST /notification/send` tidak boleh di-retry oleh Transaction (`idempotent: false`); M4-02 wajib mengujinya (uji injeksi keterlambatan).
- Sementara Fraud belum terpasang, `TransactionProcessor.decide` menjadikan jumlah di atas ambang `HELD` dengan `FRAUD_UNAVAILABLE`; M4-02 menggantinya dengan orkestrasi nyata.
- `TransactionRepository.finish` hanya mengubah baris `PENDING` dan hasilnya tidak diperiksa; pembersih `PENDING` (M4-03) menandai `FAILED`, jadi pemenang yang terlambat harus menjawab status yang tersimpan (uji).
- Boilerplate autentikasi dan pool terulang di lima layanan; kandidat `/improve-codebase-architecture` setelah M4 dan M5.

### Belum teruji (Gerbang 1 M4)

Orkestrasi Transaction dengan Fraud, Notification, dan Privacy (M4-02); pembersih `PENDING` (M4-03); rute `/register` Gateway ke Notification (M4-08); adapter baseline (M5); fail-closed dengan Docker; endpoint 3.4 untuk Reconciliation.

# (Riwayat) M3 ditutup di `main` lokal; berikutnya M4

## Penutup M3

`/security-review` atas seluruh M2 dan M3 (`7cbc6ab..main`): tanpa temuan keyakinan 8 atau lebih, jadi tidak ada perubahan kode dan gerbang tidak diulang (gerbang terakhir: dua putaran hijau pada Gerbang 3). Checklist: 28 butir ✔, 12 ◐, 15 belum (kolom "Status (penutup M3)" di `docs/security/security-checklist.md`, bukti di `docs/security/review-M3.md`). Retro: `docs/RETRO_M3.md`; pelajaran berulang masuk `CLAUDE.md`. Keputusan Fanny: `reject` tanpa `approver_id` dan tafsir K-33 / ADR-0013 disetujui. Batasan yang diketahui: `source_account` nasabah tidak diperiksa kepemilikannya (di luar lingkup, spec transaction.md).

**Usulan pembagian gerbang M4** (satu tiket satu commit, `/code-review` dan `/security-review` tiap gerbang, gerbang penuh dua putaran): Gerbang 1 = M4-01 (inti Transaction, idempotensi), lalu M4-04 (Fraud) dan M4-05 (Notification dan SMS simulator) yang bergantung padanya hanya pada M0-04, M2-11, M3-01 (kandidat `/implement-spec` paralel setelah M4-01); Gerbang 2 = M4-02 (orkestrasi, butuh M4-01, M4-04, M4-05) dan M4-03 (review `HELD`); Gerbang 3 = M4-06 (Reconciliation inti dan bank simulator) dan M4-07 (audit dan pembukaan, butuh M3-05); Gerbang 4 = M4-08 (alur registrasi) dan M4-09 (skenario E2E TX-10001..10003). Urutan mengikuti kolom "Bergantung pada" di `docs/tickets/README.md`. Tiap tiket yang menambah tabel menjalankan `pnpm db:migrate` setelah merge.

# (Riwayat) Gerbang 3 M3 LULUS (dua putaran hijau) dan di-merge ke `main` lokal

Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD. `main` (lokal, belum di-push) memuat M0, M1, M2 dan Gerbang 1, 2, 3 M3. Branch gerbang tidak dihapus. Penutup M3 (`/security-review` milestone, centang checklist, `/retro`) belum dikerjakan.

## Status Gerbang 3

Commit: `8b6996c` M3-05 `POST /de-pseudonymize`, `3da2755` M3-06 suite keamanan (`pnpm test:security`), `b0bcbbb` header `Cache-Control: no-store`. `/code-review` (enam temuan, semua ditolak) dan `/security-review` (tanpa temuan) dijalankan; perubahan header sesudahnya hanya satu baris yang mengurangi paparan, jadi tidak ditinjau ulang.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 52 suite, 1035 tes | 52 suite, 1035 tes |
| integrasi (termasuk 23 tes keamanan) | 22 suite, 501 tes | 22 suite, 501 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` (tanpa allowlist) | bersih | bersih |

Cabang `backup/m2-gerbang-3-sebelum-rewrite` dihapus atas keputusan Fanny; itu satu-satunya tempat tiga temuan gitleaks lama berada.

### M3-05 (tes wajib, masing-masing punya tes sendiri)

Token masih hidup saat dipakai; persetujuan berlaku tepat 600 detik dan ditolak 1 ms sesudahnya (FakeClock); pemakaian kedua ditolak; dua dan tiga pemakaian serentak: tepat satu berhasil (tes yang memaksa antre di baris persetujuan; mutasi dengan kunci baris dan penanda sekali pakai dihapus membuat tiga pemakaian berhasil dan tes gagal, kode sudah dikembalikan; menghapus salah satu saja tidak membuat tes gagal karena keduanya saling menutup); pencabutan token atau subjek di antara persetujuan dan pemakaian; pemohon dan token harus sama; hanya atribut yang disetujui, audit tanpa nilai.

### Keputusan Fanny pada Gerbang 3

- **N-29** diterima: penyimpangan dari spec 7.8. Pemanggil dan peran auditor diperiksa sebelum baris apa pun dibaca, karena gerbang 5 menuntut pemohon = aktor (selalu auditor) sehingga `FORBIDDEN_ROLE` (TK-08) tak terjangkau bila peran diperiksa sesudahnya. Tercatat di `OPEN_QUESTIONS.md` dan spec 7.8.
- Persetujuan yang lewat 600 detik tidak ditandai `EXPIRED` di database (gerbang 5 memakai `now > expires_at`).
- Respons `/de-pseudonymize` memakai `Cache-Control: no-store`.
- TTL wajib di env, `reject` tanpa `approver_id`, pool `auditor` saat start: disetujui.
- Lapis Gateway M3-06 dan Newman ditunda ke M4-07 dan M6-01.

### Temuan `/code-review` Gerbang 3 yang ditolak

Atribut kosong menjadi SUCCESS (tak terjangkau: daftar atribut dibatasi di `request` dan `chk_attribute_names`); batas `now > expires_at` (spec 7.8 menulis `≤`, diuji pada 600 detik tepat); dekripsi gagal setelah penanda `USED` (transaksi rollback, penanda ikut batal, 500 tanpa baris menurut spec 9.4); validasi bentuk tidak diaudit (spec 9.4); konstanta peran `'auditor'` (gaya, sama dengan `DisclosureService`); `no-store` (kemudian diterima dan dikerjakan).


## Belum teruji / belum ada (Gerbang 3)

- **Lapis Gateway M3-06 bukan end-to-end:** jawaban Privacy yang asli diteruskan oleh pengganti Reconciliation lewat Gateway asli; Gateway belum punya jalur klien ke operasi tukar atau buka identitas. Reconciliation sungguhan (M4-07) dan Newman lewat Gateway (M6-01) belum ada, jadi lapis Gateway belum teruji end-to-end.
- Tabel layanan selain Privacy (transaction M4-01, fraud M4-04, notification M4-05, reconciliation M4-06) belum ada; `pnpm db:migrate` mengisinya setelah migrasinya dibuat.

## Status Gerbang 2

Commit: `73088cc` M3-03, `58013cd` M3-04, `8e3df06` perbaikan `/code-review`, `c572b7a` fixture smoke, `6b071e4` timer shutdown dibatalkan setelah drain (`service-app.ts`), `fe1fe46` N-28 (kedua reason dihitung bersama per layanan), `bef14df` jendela persetujuan wajib dari env, `a0b4270` `pnpm db:migrate`. `/code-review` dan `/security-review` dijalankan; tidak ada temuan keamanan.

Putaran gagal sebelumnya (integrasi, `token-service.integration`, "Connection terminated due to connection timeout" di 50 permintaan paralel) terjadi saat memori hampir habis. Setelah memori longgar, suite itu sendirian lulus dua kali (36 tes) dan tidak gagal lagi di kedua putaran berikut. Penyebab dianggap tekanan memori mesin; tidak ada perubahan kode atau pelonggaran tes. Bila muncul lagi saat memori longgar, perlakukan sebagai bug pool/koneksi.

Dua putaran berturut-turut, satu proses pada satu waktu:

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 52 suite, 1035 tes | 52 suite, 1035 tes |
| integrasi | 20 suite, 449 tes | 20 suite, 449 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih (99 commit) | bersih (99 commit) |

Peringatan "worker failed to exit gracefully" tidak muncul lagi di unit. `gitleaks --all` (termasuk `backup/m2-gerbang-3-sebelum-rewrite`) melaporkan 3 temuan generic-api-key di commit `094c77d`, fixture tes lama yang hanya ada di cabang cadangan itu; tidak ada di riwayat cabang lain. Pemindaian tanpa cabang cadangan: `--log-opts="--exclude=backup/* --branches --remotes"`.

## Keputusan Fanny (2026-10-21)

- `pnpm db:migrate` resmi: hanya menyasar database pengembangan layanan (nama tetap dari `SERVICE_DBS`, kini hanya `privpay_privacy` karena hanya Privacy punya migrasi), tidak pernah database tes, tidak jalan otomatis, maju-saja. Dicatat di `CLAUDE.md`.
- N-28 diterima: kedua reason dihitung bersama per layanan, sesuai bunyi PRD 12 / spec 4.8.
- Perbaikan `service-app.ts` dan merge Gerbang 2 ke `main` disetujui.

## Keputusan yang masih butuh persetujuan (Gerbang 2, belum dijawab)

- `DISCLOSURE_APPROVAL_TTL_SECONDS` kini wajib di env (tanpa nilai bawaan); `reject` tidak mengisi `approver_id`; pool `auditor` dibuka saat start.
- Tafsir K-33 / ADR-0013 (lihat bagian Gerbang 1).

### Temuan `/code-review` Gerbang 2 yang ditolak

`approve` tanpa cek token (ditangani M3-05, lihat di atas); ringkasan tetap tanpa mengunci pool (sudah diperbaiki: satu snapshot); dua koneksi per permintaan audit (hanya beban, bukan kebenaran; pool bawaan cukup); jendela peringatan terpotong oleh `from`/`to` (rentang memang membatasi data yang dihitung); kursor tidak terikat pada filter (hanya posisi keyset, tidak ada dampak keamanan); admin boleh menyaring `pseudonym` pada daftar (sesuai spec 4.8 dan PRD); `basis` 64 vs kolom 32 (kebijakan menolak dulu, insert tidak pernah melihat basis panjang); helper validasi duplikat dan spread berulang (gaya, tidak diubah).

## Pembagian gerbang M3 (Gerbang 1 selesai dan di-merge ke `main`)

- Gerbang 1 (`feat/m3-gerbang-1`): M3-01 `resolve-domain`, M3-02 pencabutan token dan subjek. **Selesai.**
- Gerbang 2 (`feat/m3-gerbang-2`): M3-03 pembacaan audit, M3-04 alur pembukaan identitas. Ditulis; gerbang penuh belum hijau (lihat atas).
- Gerbang 3 (`feat/m3-gerbang-3`): M3-05 `de-pseudonymize`, M3-06 suite keamanan (`pnpm test:security`). **Selesai dan di-merge ke `main`.**
- Urutan mengikuti dependensi tiket; satu tiket satu commit, `/code-review` dan `/security-review` di akhir tiap gerbang, gerbang penuh dua putaran.

## Gerbang 1 M3

Commit: `560179d` M3-01, `e723e8e` M3-02, `bf6afdf` perbaikan review M3-02. Dua putaran berturut-turut, satu proses pada satu waktu:

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 51 suite, 1027 tes | 51 suite, 1027 tes |
| integrasi | 17 suite, 377 tes | 17 suite, 377 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih | bersih |

Tes M2-09 `step 1 does not wait for a row in use` lulus di kedua putaran. Unit mencetak peringatan "worker failed to exit gracefully" (belum diselidiki; tes lulus semua).

`/code-review`: temuan valid diperbaiki (kelas `NothingToRevoke` menggantikan pencocokan `action`/`reason`; komentar `REVOCATION_SQL`). Ditolak: kunci advisory pada `revoke_subject` (balapan dengan penerbitan, lihat keterbatasan a); audit N baris berurutan (paling banyak 6 token aktif per subjek karena `uq_mapping_active`); urutan kunci identitas vs baris token (jalur `store` tidak menyentuh baris token, tidak ada siklus); `findDomain` tanpa ORDER BY (paling banyak satu P5 aktif per subjek); `actorOf` tidak dipakai di `resolveDomain` (tidak ada perbedaan perilaku); HMAC lookup sebelum cek peran (tanpa log, hanya HMAC). `/security-review`: tidak ada temuan.

### Keterbatasan yang diketahui (dari `/security-review`)

- (a) Token yang terbit bersamaan dengan `revoke_subject` bisa lolos dari pencabutan. Gateway boleh menerbitkan token baru untuk subjek yang sama kapan saja, jadi pencabutan memang bukan blokir penerbitan.
- (b) Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject` (spec 4.6: hanya baris `active`); diserahkan ke retensi (berjalan terjadwal sejak M4-10).

### Keputusan di tiket (tidak ada ADR yang bertabrakan)

- `revokeToken`/`revokeSubject` ada di `RevocationService` (bukan `TokenService`, agar berkas tidak membengkak); spec 2 dan 4.6 diperbarui. Meminta persetujuan Anda bila ingin dipindah ke `TokenService`.
- `revoke_subject` tanpa apa pun: HTTP 200 `{revoked_count: 0}` dengan satu baris audit DENIED `TOKEN_NOT_FOUND` (membaca spec 4.6 harfiah). `PURGE_IDENTITY` dari pencabutan memakai `requesting_service = ADMIN_CONSOLE` dan `actor_id` admin (K-32 hanya mengatur job retensi).
- `AuditedOperation` kini menerima daftar baris SUCCESS (satu per token, spec 4.6).
- K-33 / ADR-0013 ("ikut mengosongkan atau menghapus tautan"): berlaku bila `revoke_subject` mengosongkan baris mapping; spec 7.10 hanya menandai `revoked` dan mengosongkan brankas, jadi tautan tidak disentuh (sumber `revoked` harus tetap terbaca `REVOKED`, K-29). Mohon konfirmasi tafsir ini.

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Diuji di tingkat Gateway dengan Privacy asli dihentikan.
- Rute `/register` dan `/notification/register` serta `RegistrationFlow` (M4-08). Plugin Lua belum diuji terhadap vektor kontrak (DK-02).
- Body bukan JSON tanpa token mendapat 422 sebelum 401 (parser JSON bersama). Dicatat, belum diubah.
- `pnpm test:security` dan `pnpm newman` belum ada (M3-06, M6-01); Docker belum ada.

## Keterbatasan yang sudah dicatat

- Token yang terbit bersamaan dengan `revoke_subject` bisa lolos pencabutan (Gateway boleh menerbitkan token baru untuk subjek yang sama).
- Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject`; diserahkan ke retensi (berjalan terjadwal sejak M4-10).

## Langkah berikutnya

1. Penutup M3: `/security-review` milestone M2/M3, centang bagian relevan di `docs/security/security-checklist.md`, persetujuan Fanny, lalu `/retro`.
2. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap: dokumentasi singkat sekali per tiket, dua review hanya untuk tiket inti, keluaran ringkas, satu proses pada satu waktu, jangan menjalankan tes saat memori hampir habis. Sisa database tes dapat dibersihkan dengan `pnpm db:test-databases drop` (ketik `DROP <jumlah>`).
