# Katalog endpoint, peran, dan tes otorisasi negatif

Sumber tunggal daftar endpoint (PRD 10) setelah persetujuan E-23..E-27 (Gerbang 3). Endpoint di luar daftar ini tidak boleh ada (API9). Kolom **Pemanggil** adalah `requesting_service` dari klaim `azp` token di `Authorization` (ADR-0007); **Peran** adalah peran manusia dari `X-Actor-Token` atau dari token manusia di `Authorization`. Tanda **[baru]** menandai endpoint yang ditambahkan lewat errata (E-23..E-27) atau yang tidak bernama di PRD.

## Aturan tes otorisasi negatif (berlaku untuk setiap baris)

Setiap endpoint punya tes dengan ID `AZ-nn` yang mencakup, di lapis yang berlaku (ADR-0008: lapis layanan dan lapis Gateway):

1. **N1 tanpa kredensial:** tanpa `Authorization` atau token kedaluwarsa/tanda tangan salah → 401 `UNAUTHENTICATED`.
2. **N2 pemanggil atau peran salah:** token valid milik pemanggil/peran yang tidak berhak (kasus spesifik per baris di bawah) → 403: antar-layanan `POLICY_NOT_ALLOWED` (pemanggil salah) atau `FORBIDDEN_ROLE` (peran salah); ke klien `ACCESS_DENIED`. Penolakan oleh Privacy menghasilkan tepat satu baris audit `DENIED`.
3. **N3 field tak dikenal:** body dengan field tambahan → 422 `VALIDATION_ERROR`; tidak ada efek samping (tidak ada baris dibuat).
4. **N4 `requesting_service` palsu:** body atau header yang mengaku layanan lain tidak mengubah hasil N2 (D-16; ADR-0007).

Nama tes memuat ID: `AZ-22 rejects de-pseudonymize from a service other than RECONCILIATION`. Tes ini ditulis lebih dulu (tdd) dan menjadi bagian kriteria penerimaan tiket yang membangun endpoint.

## 1. Gateway (klien eksternal)

| AZ | Endpoint | Pemanggil/peran sah | Kasus N2 spesifik | Tiket |
| --- | --- | --- | --- | --- |
| AZ-01 | `POST /register` **[baru, E-26]** | anonim | N1 tidak berlaku; uji: laju per alamat sumber (429), field tak dikenal (422), kompensasi bila langkah gagal | M4-08 |
| AZ-02 | `POST /notification/register` | nasabah (`customer-app`) | token manusia dan token layanan → 403 | M4-08 |
| AZ-03 | `POST /transaction` | nasabah | token manusia → 403; tanpa `Idempotency-Key` → 422 | M2-11 |
| AZ-04 | `GET /transaction/held` | `fraud_analyst` | `auditor`, `admin`, nasabah → 403 | M4-03 |
| AZ-05 | `POST /transaction/{id}/review` | `fraud_analyst` | `auditor`, `admin`, nasabah → 403 | M4-03 |
| AZ-06 | `POST /reconciliation/audit-request` | `auditor` | `admin`, `fraud_analyst`, nasabah → 403 | M4-07 |
| AZ-07 | `POST /reconciliation/disclosure` **[baru, E-25]** | `auditor` | `admin`, `fraud_analyst`, nasabah → 403 | M4-07 |
| AZ-08 | `POST /reconciliation/run` | `admin` | `auditor`, `fraud_analyst`, nasabah → 403 | M4-06 |
| AZ-09 | `POST /settlement/report` | `bank` | nasabah, manusia → 403 | M2-11 |
| AZ-10 | `POST /disclosure-requests` | `auditor` | `admin`, `fraud_analyst`, nasabah → 403 | M3-04 |
| AZ-11 | `POST /disclosure-requests/{id}/approve` | `admin` (bukan pemohon) | `auditor` → `FORBIDDEN_ROLE`; pemohon sendiri → `SELF_APPROVAL` | M3-04 |
| AZ-12 | `POST /disclosure-requests/{id}/reject` | `admin` | `auditor`, `fraud_analyst` → 403 | M3-04 |
| AZ-13 | `GET /audit-log` (filter + `action`, `disclosure_id` **[baru, E-27]**) | `auditor` atau `admin` | `fraud_analyst`, nasabah → 403 | M3-03 |
| AZ-14 | `GET /audit-log/timeline/{pseudonym}` | `auditor` | `admin`, nasabah → 403 | M3-03 |
| AZ-15 | `GET /audit-log/summary` | `auditor` | `admin`, nasabah → 403 | M3-03 |
| AZ-16 | `POST /pseudonym/{pseudonym}/revoke` | `admin` | `auditor`, nasabah → 403 | M3-02 |
| AZ-17 | `POST /subject/revoke` | `admin` | `auditor`, nasabah → 403 | M3-02 |

Rute manusia ke Privacy (AZ-10..AZ-17) meneruskan token manusia apa adanya sebagai `Authorization` (`azp=admin-console`, ADR-0007); pemanggil layanan mana pun yang mencoba rute ini ditolak sebagai bukan `ADMIN_CONSOLE`.

## 2. Privacy Service

| AZ | Endpoint | Pemanggil sah | Peran | Kasus N2 spesifik | Tiket |
| --- | --- | --- | --- | --- | --- |
| AZ-18 | `POST /pseudonymize` bentuk 1 (identitas) | `API_GATEWAY` | service | `TRANSACTION` mengirim `subject_id` → `POLICY_NOT_ALLOWED` (TK-07) | M2-05 |
| AZ-18b | `POST /pseudonymize/batch` (ADR-0019) | `API_GATEWAY` | service | `TRANSACTION` memanggil → `POLICY_NOT_ALLOWED` untuk seluruh batch; satu elemen ditolak → tidak ada token yang terbit | ADR-0019 |
| AZ-19 | `POST /pseudonymize` bentuk 2 (pertukaran) | `TRANSACTION` | service | `FRAUD`/`NOTIFICATION` menukar → `POLICY_NOT_ALLOWED` (TK-13) | M2-06 |
| AZ-20 | `POST /pseudonymize` bentuk 3 (dari transaksi) | `RECONCILIATION` | service; P7 + `auditor` | P7 tanpa aktor auditor → `FORBIDDEN_ROLE` | M2-06 |
| AZ-21 | `POST /resolve-domain` | `NOTIFICATION` | service | `TRANSACTION` memanggil → `POLICY_NOT_ALLOWED` | M3-01 |
| AZ-22 | `POST /de-pseudonymize` | `RECONCILIATION` | `auditor` (aktor) | layanan lain → `POLICY_NOT_ALLOWED`; aktor `admin` → `FORBIDDEN_ROLE` (TK-08) | M3-05 |
| AZ-23 | `POST /re-issue` | `TRANSACTION` | service | `FRAUD` memanggil → `POLICY_NOT_ALLOWED` | M2-07 |
| AZ-24 | `PATCH /transaction-status` | `TRANSACTION` | service | `NOTIFICATION` memanggil → `POLICY_NOT_ALLOWED` | M2-07 |
| AZ-25 | `POST /identity` | `API_GATEWAY` | service | `TRANSACTION` memanggil → `POLICY_NOT_ALLOWED`, tanpa baris brankas (TK-20) | M2-08 |
| — | `GET /health`, `GET /metrics` | internal | — | AZ-43 | M0-06 |

Endpoint manusia di Privacy (AZ-10..AZ-17) dilayani modul `DisclosureService`/`AuditReader`/`TokenService` (lihat `privacy-service.md` 4.5, 4.6, 4.8, 4.10).

## 3. Transaction Service

| AZ | Endpoint | Pemanggil sah | Peran | Kasus N2 spesifik | Tiket |
| --- | --- | --- | --- | --- | --- |
| AZ-26 | `POST /transaction` | `API_GATEWAY` | service | `FRAUD`/`RECONCILIATION` memanggil → `POLICY_NOT_ALLOWED` | M4-01 |
| AZ-27 | `GET /transaction/held` | `API_GATEWAY` | `fraud_analyst` (aktor) | aktor `auditor`/`admin`, atau tanpa aktor → `FORBIDDEN_ROLE` | M4-03 |
| AZ-28 | `POST /transaction/{id}/review` | `API_GATEWAY` | `fraud_analyst` (aktor) | aktor `auditor`/`admin`, atau tanpa aktor → `FORBIDDEN_ROLE`; bukan `HELD` → `NOT_HELD` | M4-03 |
| AZ-29 | `GET /transaction/completed` **[baru, E-23]** | `RECONCILIATION` | service | `API_GATEWAY`/`NOTIFICATION` memanggil → `POLICY_NOT_ALLOWED` | M4-06 |
| AZ-30 | `GET /transaction/{id}` **[baru, E-24]** | `RECONCILIATION` | service | `API_GATEWAY`/`FRAUD` memanggil → `POLICY_NOT_ALLOWED` | M4-07 |

## 4. Fraud, Notification, Reconciliation

| AZ | Endpoint | Pemanggil sah | Peran | Kasus N2 spesifik | Tiket |
| --- | --- | --- | --- | --- | --- |
| AZ-31 | `POST /fraud/assess` | `TRANSACTION` | service | `API_GATEWAY`/`RECONCILIATION` memanggil → `POLICY_NOT_ALLOWED` | M4-04 |
| AZ-32 | `POST /notification/register` | `API_GATEWAY` | service | `TRANSACTION` memanggil → `POLICY_NOT_ALLOWED` | M4-05 |
| AZ-33 | `POST /notification/send` | `TRANSACTION` | service | `API_GATEWAY`/`FRAUD` memanggil → `POLICY_NOT_ALLOWED` | M4-05 |
| AZ-34 | `POST /reconciliation/settlement-report` | `API_GATEWAY` | service | `BANK`/`TRANSACTION` memanggil langsung (rekening mentah tidak boleh) → `POLICY_NOT_ALLOWED` | M4-06 |
| AZ-35 | `POST /reconciliation/run` | penjadwal internal, atau `API_GATEWAY` | `admin` (aktor) | aktor `auditor` atau tanpa aktor → `FORBIDDEN_ROLE` | M4-06 |
| AZ-36 | `POST /reconciliation/audit-request` | `API_GATEWAY` | `auditor` (aktor) | aktor `admin`/`fraud_analyst` atau tanpa aktor → `FORBIDDEN_ROLE` | M4-07 |
| AZ-37 | `POST /reconciliation/disclosure` **[baru, E-25]** | `API_GATEWAY` | `auditor` (aktor) | aktor `admin`/`fraud_analyst` atau tanpa aktor → `FORBIDDEN_ROLE` | M4-07 |

## 5. IdP dev dan simulator (fase lokal)

| AZ | Endpoint | Pemanggil sah | Kasus N2 spesifik | Tiket |
| --- | --- | --- | --- | --- |
| AZ-38 | `POST /admin/users` (`dev-idp`) | klien `api-gateway` | klien lain atau manusia → 403 | M1-01 |
| AZ-39 | `DELETE /admin/users/{id}` (`dev-idp`) | klien `api-gateway` | klien lain atau manusia → 403 | M1-01 |
| — | `POST /token`, `GET /.well-known/jwks.json` (`dev-idp`) | publik pada loopback; `POST /token` memeriksa kredensial klien dengan `safeEqual` | kredensial salah → 401 | M1-01 |
| AZ-40 | `POST /simulate/settlement` (`bank-simulator`) | hanya skrip uji/loopback (env uji) | tanpa env uji → 404 | M4-06 |
| AZ-41 | `POST /sms` (`sms-simulator`) | `NOTIFICATION` | layanan lain → `POLICY_NOT_ALLOWED` | M4-05 |
| AZ-42 | `GET`/`DELETE /__test/messages` (`sms-simulator`) | hanya bila `SMS_SIMULATOR_TEST_ENDPOINTS=true` | env mati → 404 | M4-05 |
| AZ-43 | `GET /health`, `GET /metrics` (semua layanan) | hanya `127.0.0.1` (fase lokal) | koneksi dari antarmuka non-loopback ditolak/tidak terikat | M0-06 |

## 6. Catatan

- Daftar ini mengganti tabel endpoint PRD 10 sebagai sumber implementasi; selisihnya: AZ-01, AZ-07, AZ-13 (filter), AZ-29, AZ-30 (E-23..E-27) dan endpoint dev (AZ-38..AZ-42).
- Tiket M0-M1 yang membangun mekanisme umum (`authenticate`, `ErrorMasker`, kerangka layanan) menyediakan pembantu uji `expectUnauthenticated`, `expectForbidden(reason)`, dan `expectValidationError` yang dipakai ulang oleh tes AZ di tiket endpoint.
- Traceability: setiap AZ memetakan ke FR-01, FR-07, FR-09, FR-13, FR-26, FR-42, FR-43, NFR-10, dan D-16 sesuai endpoint; ringkasannya di `00-traceability.md` bagian 7.
