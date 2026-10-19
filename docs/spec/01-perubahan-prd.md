# Bagian PRD yang berubah atau diusulkan berubah

PRD lengkap (`docs/reference/`) tidak diubah dan sedang diperbarui Fanny terpisah. Daftar ini menandai setiap bagian PRD yang implementasinya berbeda dari teks PRD v2.4, dasar keputusannya, dan spec yang memuat rinciannya. Yang berlaku untuk kode: `DESIGN_DECISIONS.md`, ADR Accepted, lalu spec ini. **Tabel 1, 2, 3, 5, 6, panjang token, tiga kunci terpisah, dan TTL tidak berubah.**

## A. Diterima (ADR Accepted atau keputusan Fanny)

| # | Bagian PRD | Teks PRD | Yang berlaku | Dasar | Spec |
| --- | --- | --- | --- | --- | --- |
| 1 | 7.1 `buat_token` STEP 1 dan STEP 4 | `SELECT ... FOR UPDATE` lalu INSERT; ulang bila `pseudonym` bentrok | kunci advisory transaksi per (lookup, layanan, purpose) + `INSERT ... ON CONFLICT (pseudonym) DO NOTHING`; `FOR UPDATE` tidak cukup (456 dari 1000 permintaan paralel ditolak di prototipe) | ADR-0010, E-19 | `privacy-service.md` 7.2 |
| 2 | 6, 6.2 rumus token dan `subject_lookup` | "`\|\|`" tanpa penyandian | awalan panjang 4 byte per bagian | ADR-0011, E-20 | `privacy-service.md` 5 |
| 3 | 6.2 AAD | `AAD = subject_type` (mapping), nama kolom (brankas) | AAD terikat baris: `'mapping'/'vault'` + jenis atau kolom + `id` baris (UUID dibangkitkan aplikasi, bukan `DEFAULT`); `key_version` uint16 | ADR-0011, E-21 | `privacy-service.md` 5; `data-dan-migrasi.md` 2 |
| 4 | 9 alur A | A2, A3, A4, A5 | A2, A5, A3, A4 dengan kompensasi `revoke_subject` + hapus pengguna | ADR-0005, E-16 | `gateway-tokenizer.md` 6 |
| 5 | 5, 10 (`requesting_service` dari klaim JWT), 6.1 Tabel 3 (`ADMIN_CONSOLE`) | satu JWT | pola dua token: `requesting_service` dari `azp` token layanan; `actor_id` dan peran dari `X-Actor-Token`; token manusia sebagai `Authorization` menghasilkan `ADMIN_CONSOLE` dan menolak `X-Actor-Token`; JWT nasabah tidak diteruskan | ADR-0007 | `platform-dan-ci.md` 7 |
| 6 | 10 format error | klien hanya enam `code` | delapan `code` (+ `IDEMPOTENCY_CONFLICT`, `NOT_HELD`); tujuh reason baru antar-layanan | ADR-0008, E-07, E-17 | `platform-dan-ci.md` 4 |
| 7 | 10 kontrak transaksi, FR-36 | sidik jari isi tidak ditetapkan | bandingkan token + atribut; jendela efektif = TTL P1; replay di luar jendela 409 | ADR-0009, E-18 | `transaction.md` 5 |
| 8 | 7.4 dan 10 `/de-pseudonymize` | contoh tanpa `disclosure_id`, respons berisi `subject_id`+NIK+nama | `{pseudonym, purpose, disclosure_id}` wajib; respons `{mapping_id, attributes}` | E-03 | `privacy-service.md` 4.3 |
| 9 | 11 `audit_log` | tanpa `disclosure_id`/nama atribut | `disclosure_id` FK + `attribute_names TEXT[]` dengan `CHECK` {customer_id,nik,nama} | E-06 | `data-dan-migrasi.md` 4 |
| 10 | 12 katalog action | tanpa `DISCLOSURE_*` | tiga action baru; reason GATE 5 pada `DE_PSEUDONYMIZE` | E-05 | `privacy-service.md` 9.1 |
| 11 | 7.4, 6, 1 (KPI), 3 (US-06) | "4 gate" pada beberapa tempat | lima gerbang + `boleh_dibuka` + peran auditor | E-01 | `privacy-service.md` 7.8 |
| 12 | 18.1 TF-06, 18.3 | TF-06 mengembalikan `subject_id`; "dua puluh satu kasus" | TF-06 ditulis ulang (tanpa identitas); 28 kasus TK | E-02, E-04 | `pengujian-dan-pengukuran.md` 4, 5 |
| 13 | 18.3 | reason rinci diharapkan, Gateway menyamarkan | uji dua lapis | E-09 | `pengujian-dan-pengukuran.md` 4 |
| 14 | 11 dan 17 nama peran | `privacy_app`, `auditor_role` | `privpay_app`, `privpay_auditor` (+ `privpay_privacy_owner`, `privpay_test_admin`); semua objek berawalan `privpay_` | E-22, ADR-0004 | `data-dan-migrasi.md` 3 |
| 15 | 17 `PRIVACY_MODE` dan Bab Metodologi | `static` | hanya `baseline` dan `proposed` | ADR-0003, E-10 | semua spec |
| 16 | 5, 17, 19 (M0, M1) | Docker Compose, Kong, Keycloak sejak awal | fase lokal tanpa Docker: `gateway-adapter`, `dev-idp`, PostgreSQL 18 lokal; Docker, Kong, Keycloak, TLS, NFR-19, M7 ditunda | ADR-0004, E-15 | `platform-dan-ci.md` 12, 14 |
| 17 | 20 no. 2, 12 | rantai hash opsional | hanya dirancang; kolom nullable tidak diisi | D-19, Q-12 | `privacy-service.md` 9.3 |

## B. Diusulkan dalam spec dan menunggu persetujuan Fanny

PRD 10 menyatakan daftar endpoint adalah sumber tunggal dan endpoint di luar daftar dilarang (API9). Alur PRD sendiri membutuhkan beberapa endpoint yang tidak terdaftar:

| # | Usulan | Alasan | Spec | Errata |
| --- | --- | --- | --- | --- |
| 18 | `GET /transaction/completed?date=` (RECONCILIATION) | alur D1 mengambil transaksi `COMPLETED` per tanggal | `transaction.md` 3.4 | E-23 |
| 19 | `GET /transaction/{transaction_id}` (RECONCILIATION) | alur E1 mengembalikan nominal dan status | `transaction.md` 3.4 | E-24 |
| 20 | `POST /reconciliation/disclosure` (via Gateway, auditor) | alur E3 membutuhkan pemicu bagi Reconciliation untuk memanggil `/de-pseudonymize` | `reconciliation.md` 3.4 | E-25 |
| 21 | `POST /register` di Gateway | alur A1 tidak menamai rute pendaftaran | `gateway-tokenizer.md` 3, 6 | E-26 |
| 22 | filter `action` dan `disclosure_id` pada `GET /audit-log` | admin perlu menemukan `disclosure_id` yang menunggu tanpa endpoint daftar baru | `privacy-service.md` 4.8 | E-27 |
| 23 | env baru: `FRAUD_HOLD_THRESHOLD`, `FRAUD_BLOCK_THRESHOLD`, `TX_SWEEP_INTERVAL_SECONDS`, `RECON_DAILY_RUN_UTC`, `PG_HOST`, `PG_PORT`, `*_FILE`, `SMS_SIMULATOR_*` | nilai ambang dan jadwal harus dari env (CLAUDE.md) | `fraud.md`, `transaction.md`, `reconciliation.md`, `platform-dan-ci.md` | E-28 |
| 24 | pembatasan `aud` token aktor ke layanan di jalur peran | mengurangi pemakaian ulang token aktor oleh layanan hilir yang diretas (T-15) | `platform-dan-ci.md` 7.6 | S-03 |

Tiap butir "keputusan spec" lain (reason baru, pola validasi, aturan status batch, dst.) tercantum sebagai K-01..K-24 di `OPEN_QUESTIONS.md` bagian F dengan nilai bawaan yang dipakai spec sampai Fanny memutuskan.
