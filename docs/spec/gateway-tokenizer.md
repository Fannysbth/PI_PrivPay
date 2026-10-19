# Spesifikasi: Gateway dan tokenizer

Sumber: PRD 5 (mekanisme tokenisasi di Gateway), 9, 10; D-06, D-16; ADR-0004, 0005, 0007, 0008. Pada fase lokal Gateway adalah `gateway-adapter` (layanan NestJS tipis) yang berperilaku identik dengan plugin Kong `privacy-tokenizer`; plugin Lua dikerjakan di fase Docker (DK-02, P-1 ditunda; Q-10 DITUNDA). Angka performa M7 hanya sah pada gateway final yang sama untuk kedua mode (ADR-0004). **[Δ PRD]** dan **[K-nn]** seperti pada spec lain.

## 1. Tanggung jawab

Satu-satunya pintu masuk data asli dari klien: memvalidasi JWT, membatasi laju, mentokenisasi `customer_id` dan nomor rekening lewat Privacy Service, membuang NIK/nama/email dari muatan ke hilir, membangkitkan `transaction_id`, menjalankan alur pendaftaran (ADR-0005), menyamarkan `reason` untuk klien eksternal, dan **menolak 503 bila Privacy Service tidak tersedia tanpa pernah meneruskan data mentah** (invarian 8). Gateway tidak menyimpan dan tidak mencatat body permintaan.

## 2. Modul dan seam

| Modul | Interface | Catatan |
| --- | --- | --- |
| `Tokenizer` (murni, **tanpa NestJS**) | `tokenize(route, {claims, body}, privacy: PrivacyPort)` mengembalikan `{outbound, transactionId}` atau melempar `DomainError` | Seluruh logika pembuangan dan penggantian field; dipakai ulang oleh plugin Lua sebagai spesifikasi perilaku |
| `PrivacyPort` | `pseudonymize(request)` | **Dua adapter nyata**: HTTP ke Privacy Service dan palsu untuk tes (seam nyata) |
| `RouteTable` | `match(method, path)` mengembalikan konfigurasi rute: peran, jenis tokenisasi, tujuan hilir, gaya autentikasi hilir | satu sumber daftar rute |
| `RateLimiter` | `allow(key, clock)` | jendela tetap per menit; `Clock` disuntik |
| `ErrorMasker` | `toClient(downstreamError)` | pemetaan pada `platform-dan-ci.md` bagian 4 |
| `RegistrationFlow` | `register(body)` | A2→A5→A3→A4 dengan kompensasi (bagian 6) |

Vektor kontrak: `tests/security/gateway-contract/*.json` (masukan klaim+body+respons Privacy palsu → keluaran/status yang diharapkan). Adapter sekarang dan plugin Lua nanti lulus vektor yang sama (paritas perilaku).

## 3. Rute

Semua rute (kecuali `/register`) membutuhkan JWT valid (401 `UNAUTHENTICATED` bila tidak ada, kedaluwarsa, atau tanda tangan salah, TK-19). Peran diperiksa di Gateway sebagai pertahanan lapis pertama dan diperiksa ulang oleh layanan tujuan.

| Rute | Siapa | Perilaku | Hilir dan autentikasi hilir |
| --- | --- | --- | --- |
| `POST /register` **[K-14]** | anonim | alur pendaftaran (bagian 6) | Privacy, IdP, Notification |
| `POST /notification/register` | nasabah | `customer_id` dari klaim → token P5 → teruskan `{notification_domain_id, phone, channel}` | Notification, JWT `API_GATEWAY` |
| `POST /transaction` | nasabah; header `Idempotency-Key` UUID wajib | bagian 4 | Transaction, JWT `API_GATEWAY` |
| `GET /transaction/held`, `POST /transaction/{id}/review` | `fraud_analyst` | teruskan | Transaction, `Authorization`=JWT `API_GATEWAY` + `X-Actor-Token`=JWT manusia |
| `POST /reconciliation/audit-request` | `auditor` | teruskan | Reconciliation, JWT `API_GATEWAY` + `X-Actor-Token` |
| `POST /reconciliation/disclosure` **[Δ PRD, K-15]** | `auditor` | teruskan | Reconciliation, JWT `API_GATEWAY` + `X-Actor-Token` |
| `POST /reconciliation/run` | `admin` | teruskan | Reconciliation, JWT `API_GATEWAY` + `X-Actor-Token` |
| `POST /settlement/report` | `bank` | bagian 5 | Reconciliation, JWT `API_GATEWAY` |
| `POST /disclosure-requests`, `/{id}/approve`, `/{id}/reject`; `GET /audit-log*`; `POST /pseudonym/{p}/revoke`; `POST /subject/revoke` | manusia (`auditor`/`admin` menurut rute) | JWT manusia diteruskan apa adanya | Privacy, `Authorization`=JWT manusia (`azp=admin-console`, ADR-0007) |
| `GET /health`, `GET /metrics` | internal | sesuai `platform-dan-ci.md` bagian 8 | — |

Gateway tidak pernah meneruskan JWT nasabah (membawa `customer_id`) ke hilir. Header yang tidak dikenal tidak dipercaya dan tidak diteruskan.

**Skema masuk:** zod ketat per rute, menolak field tak dikenal, membatasi panjang dan tipe. `POST /transaction` menerima `{source_account, merchant_id, amount, geohash}` dan, **hanya sebagai muatan yang akan dibuang**, `nik`, `nama`, `email` opsional (FR-03: Gateway membuang field itu; klien boleh mengirimkannya). `amount`: bilangan bulat rupiah ≥ 1 (K-16), `geohash` `^[0-9b-hjkmnp-z]{1,12}$`, `merchant_id` `^MRC-[0-9]{3,}$`. Batas ukuran body 64 KiB untuk settlement, 16 KiB selainnya.

**Respons ke klien:** sukses diteruskan; kegagalan melewati `ErrorMasker` (delapan kode, `reason` dibuang; `X-Request-Id` dikembalikan).

## 4. Tokenisasi `POST /transaction` (B1–B4)

1. Validasi JWT, peran nasabah, skema masuk, `Idempotency-Key` UUID (selain itu 422).
2. `customer_id` dari klaim JWT; `source_account` dari body.
3. Dua panggilan ke `POST /pseudonymize` bentuk 1 (boleh paralel): `{CUSTOMER, customer_id, TRANSACTION, PAYMENT_PROCESSING, transaction_id}` dan `{ACCOUNT, source_account, TRANSACTION, PAYMENT_PROCESSING, transaction_id}` dengan JWT `API_GATEWAY` (cache sampai `exp − 30 detik`). Satu permintaan klien menghasilkan satu panggilan per subjek.
4. Bangun muatan keluar **dengan membangun objek baru dari daftar putih** (bukan menghapus dari objek masuk): `{transaction_id, idempotency_key, customer_token, account_token, merchant_id, amount, geohash}`. NIK, nama, email, `customer_id`, dan rekening tidak ada di dalamnya.
5. Teruskan ke Transaction; kembalikan `{transaction_id, status}` (`201`, atau `200` pada replay idempoten).

**Gagal tertutup:** kegagalan, timeout, atau 5xx dari Privacy pada langkah 3 (setelah retry NFR-12) menghasilkan 503 `SERVICE_UNAVAILABLE`; tidak ada pemanggilan ke Transaction. Penolakan 403 dari Privacy menjadi 403 `ACCESS_DENIED`. Kegagalan satu dari dua tokenisasi membatalkan seluruh permintaan.

**`transaction_id`:** `TX-` diikuti bilangan unik tanpa basis data: `epochMillis` (13 digit) dan penghitung 3 digit berputar per proses (K-17); cocok `^TX-[0-9]{1,29}$`. Replay idempoten membangkitkan id baru yang diabaikan Transaction (ADR-0009).

## 5. Laporan settlement bank (D3, FR-32)

`POST /settlement/report` dari `bank-simulator` (JWT `azp=bank-simulator`): `{batch_date, items:[{account_number, amount, bank_reference}]}`. Validasi **sebelum** token apa pun diterbitkan: `batch_date` tanggal ISO sah, `items` 1..5.000, `account_number` per `AccountNumber`, `amount` bilangan bulat ≥ 1, `bank_reference` `^[A-Z0-9-]{1,32}$`; satu item tak valid → 422 `VALIDATION_ERROR`, tidak ada token terbit (TF-13). Lalu tiap `account_number` ditokenkan (bentuk 1: `ACCOUNT`, `RECONCILIATION`, `DAILY_RECONCILIATION`, tanpa `transaction_id`) dan muatan diteruskan sebagai `{batch_date, items:[{account_pseudonym, amount, bank_reference}]}` ke `POST /reconciliation/settlement-report`. Karena kunci pakai-ulang adalah (subjek, layanan, purpose), token sama dengan hasil alur D2.

## 6. Pendaftaran `POST /register` (A1–A5, ADR-0005) **[Δ PRD]**

Body: `{nik, nama, hp, email, rekening, username}` (zod ketat; kata sandi tidak ada pada fase lokal karena `dev-idp` tidak menyimpannya; fase Keycloak menambahkannya, DK-04). Semuanya data asli dan tidak dicatat.

| Langkah | Aksi | Kompensasi bila langkah berikutnya gagal |
| --- | --- | --- |
| A2 | buat pengguna di IdP (`POST /admin/users`) → `customer_id` | hapus pengguna IdP |
| A5 | `POST /identity` ke Privacy `{customer_id, nik, nama, hp, rekening}` | `revoke_subject` (mengosongkan brankas) + hapus pengguna |
| A3 | `POST /pseudonymize` bentuk 1 `NOTIFICATION`/`NOTIFICATION_REGISTRATION`/`CUSTOMER` → `notification_domain_id` (P5) | `revoke_subject` + hapus pengguna, atau coba ulang |
| A4 | `POST /notification/register` `{notification_domain_id, phone, channel:'SMS'}` | coba ulang (upsert idempoten); bila tetap gagal: `revoke_subject` + hapus pengguna |

Respons 201 `{status: "REGISTERED"}` tanpa data asli. Gagal pada langkah mana pun: kompensasi berjalan, respons 503 (Privacy/IdP/Notification tidak tersedia) atau 422 (validasi). Bila kompensasi sendiri gagal, pengguna IdP yatim dapat tersisa: dicatat sebagai keterbatasan, log hanya `request_id` (tanpa PII). Semua langkah idempoten dan memakai klien HTTP bersama (timeout 3 detik, retry hanya untuk operasi idempoten).

## 7. Pembatasan laju (FR-26, NFR-08)

Kunci `azp + sub` (nasabah/manusia/service) dan, untuk `POST /register`, alamat sumber **[K-14]**. `RATE_LIMIT_PER_MINUTE` (100) dalam jendela tetap per menit, dihitung dengan `Clock`; melebihi: 429 `RATE_LIMITED` dengan `Retry-After`. `RATE_LIMIT_ENABLED=false` hanya untuk pengukuran performa (identik di kedua mode) dan diaktifkan kembali untuk TK-11. Dicatat di log Gateway (token tidak ada), bukan audit. Hanya satu instans (pembatas di memori).

## 8. Mode

`PRIVACY_MODE=proposed`: perilaku di atas. `PRIVACY_MODE=baseline` (M5-03): `tokenize` mengembalikan `customer_id`, `account_number`, dan (bila ada) `nik`, `nama`, `email` apa adanya; Privacy Service tidak dipanggil; JWT, laju, `transaction_id`, dan `ErrorMasker` identik (jalur Gateway sama). Logika bisnis Gateway tidak bercabang menurut mode di luar `Tokenizer` (ADR-0006).

## 9. Invarian keamanan

NIK/nama/email tidak pernah sampai ke layanan hilir pada mode proposed (diuji dengan nilai kenari pada muatan keluar); `customer_id` dan rekening mentah tidak pernah masuk log; `reason` tidak pernah dikirim ke klien; tidak ada fallback ke data mentah; peran diperiksa ulang oleh hilir; JWT nasabah tidak diteruskan.

## 10. Kasus gagal

| Kasus | Perilaku |
| --- | --- |
| Privacy mati/timeout | 503; tidak ada pemanggilan hilir (TK-16) |
| Privacy menolak | 403 `ACCESS_DENIED` |
| Transaction mati | 503 `SERVICE_UNAVAILABLE` |
| `Idempotency-Key` hilang atau bukan UUID | 422 |
| JWT tidak ada/kedaluwarsa/salah tanda tangan | 401 |
| Peran tidak sesuai | 403 `ACCESS_DENIED` |
| Melebihi laju | 429 |
| Kompensasi pendaftaran gagal | 503, pengguna yatim dicatat sebagai risiko sisa |

## 11. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M1-03 | 401 untuk JWT tidak ada/kedaluwarsa/tanda tangan salah/`alg=none`; peran per rute; 429 melebihi kuota (jendela dengan `FakeClock`); `ErrorMasker` mengubah setiap reason menjadi delapan kode; bentuk respons identik untuk token ada dan tidak ada | FR-01, FR-26, NFR-08, NFR-10, NFR-25, TK-11, TK-12, TK-19 |
| M2-11 | muatan keluar tanpa nilai kenari NIK/nama/email/`customer_id`/rekening (pembangunan dari daftar putih); dua panggilan tokenisasi; `transaction_id` unik; Privacy mati → 503 dan tidak ada panggilan hilir; vektor kontrak | FR-02, FR-03, FR-38, NFR-11, TK-16 |
| M2-11 | settlement: validasi sebelum tokenisasi (item tak valid → 422, nol token terbit); token sama dengan alur D2 | FR-32, TF-13 |
| M4-08 | pendaftaran: urutan A2, A5, A3, A4; tes gagal per langkah dan kompensasi; HP baru tersimpan hanya setelah A3 berhasil; tidak ada PII di log | TF-01, FR-19, FR-42, ADR-0005 |
| M5-03 | mode baseline: payload identik kecuali identitas diteruskan apa adanya; Privacy tidak dipanggil | FR-23, US-09 |
| DK-02 | plugin Lua lulus vektor kontrak yang sama (ditunda) | ADR-0004 |

## 12. Di luar cakupan

Plugin Lua dan konfigurasi Kong, TLS klien→Gateway dan Gateway→Privacy (utang NFR-06, DK-03), Keycloak, UI, pembatas laju terdistribusi.

## 13. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-14 rute `POST /register` (PRD 10 tidak menamai rute A1) dan pembatasan laju per alamat sumber. K-15 rute `POST /reconciliation/disclosure` (lihat `reconciliation.md`). K-16 `amount` ≥ 1 (SECURITY.md menyebut non-negatif) dan pola `geohash`/`merchant_id`. K-17 skema `transaction_id` tanpa basis data.
