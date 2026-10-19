# Keterlacakan: kebutuhan → spec → tiket → tes

Dasar: PRD 18.5 dan spesifikasi di folder ini. Nomor tiket di bawah adalah **rencana** dan difinalkan di Fase 4 (`docs/tickets/`); satu tiket = satu branch = satu PR kecil. Kolom "Tes" memuat ID kasus (TF/TK/FR/NFR/C/S) yang menjadi bagian nama tes, atau pengukuran/inspeksi bila bukan tes. Fase Docker memakai awalan `DK-`.

Spesifikasi: `platform-dan-ci.md` (PL), `data-dan-migrasi.md` (DM), `privacy-service.md` (PV), `gateway-tokenizer.md` (GW), `transaction.md` (TX), `fraud.md` (FR), `notification.md` (NT), `reconciliation.md` (RC), `pengujian-dan-pengukuran.md` (PP). Perubahan terhadap PRD: `01-perubahan-prd.md`.

## 1. Rencana tiket

| Tiket | Judul | Spec |
| --- | --- | --- |
| M0-01 | Workspace, tooling, skeleton (`pnpm`, TS strict, ESLint/Prettier, Jest, `.nvmrc`) | PL |
| M0-02 | `common`: config + `*_FILE`, `Clock`, logger berredaksi, error | PL |
| M0-03 | `common`: `HttpClient` (timeout, retry idempoten, `X-Request-Id`) | PL |
| M0-04 | Runner migrasi maju-saja | PL, DM |
| M0-05 | Bootstrap DB multi-layanan + harness DB tes + pencabutan keanggotaan admin | PL, DM |
| M0-06 | Skeleton layanan (health, metrics, shutdown, env) termasuk simulator | PL |
| M0-07 | CI: lint, typecheck, unit, integrasi, audit, gitleaks bersama | PL |
| M1-01 | `dev-idp` | PL |
| M1-02 | `common`: `authenticate` (dua token), `safeEqual` | PL |
| M1-03 | `gateway-adapter` inti: JWT, laju, rute, `ErrorMasker` | GW |
| M2-01 | Migrasi privacy-db dan hak akses per peran | DM, PV |
| M2-02 | Modul `Crypto` (AES-GCM + AAD baris, blind index, token, kunci) | PV |
| M2-03 | `PolicyEngine` (Tabel 1, 2, 3, 5, 6) | PV |
| M2-04 | `AuditWriter`/`AuditReader` + dua pool koneksi | PV |
| M2-05 | `buat_token` + `/pseudonymize` bentuk 1 | PV |
| M2-06 | `/pseudonymize` bentuk 2 (pertukaran) dan 3 (dari transaksi) | PV |
| M2-07 | `/re-issue` + `PATCH /transaction-status` | PV |
| M2-08 | `/identity` + brankas | PV |
| M2-09 | Job retensi | PV |
| M2-10 | Pemindai kenari v1 | PP |
| M2-11 | Modul `Tokenizer` + rute tokenisasi (transaksi, settlement) | GW |
| M3-01 | `/resolve-domain` | PV |
| M3-02 | Pencabutan token dan subjek | PV |
| M3-03 | `GET /audit-log*` | PV |
| M3-04 | Alur permintaan pembukaan identitas | PV |
| M3-05 | `/de-pseudonymize` (lima gerbang) | PV |
| M3-06 | Suite keamanan sisi Privacy (dua lapis) | PV, PP |
| M4-01 | Transaction inti + idempotensi (termasuk `ON CONFLICT` paralel) | TX, DM |
| M4-02 | Orkestrasi Transaction (Fraud, Notification, re-issue, status) | TX |
| M4-03 | Review, daftar `HELD`, pembersih `PENDING` | TX |
| M4-04 | Fraud Service | FR |
| M4-05 | Notification + SMS simulator | NT |
| M4-06 | Reconciliation inti + bank simulator | RC |
| M4-07 | Audit-request dan pemicu pembukaan | RC |
| M4-08 | Alur pendaftaran di Gateway | GW |
| M4-09 | Skenario ujung ke ujung (TX-10001..10003) | PP |
| M5-01 | Skema dan repositori baseline semua layanan | DM, TX, FR, NT, RC |
| M5-02 | Pengalih mode + tes kesetaraan + tes arsitektur | PP, TX |
| M5-03 | Gateway mode baseline | GW |
| M6-01 | Koleksi Newman (kedua mode) | PP |
| M6-02 | E(s), kelas data, presisi/recall | PP |
| M6-03 | Uji penautan | PP |
| M6-04 | Uji gagal tertutup (proses Privacy dimatikan) | PP |
| M7-01 | k6 (ditunda sampai konfigurasi final) | PP |
| DK-01 | Docker Compose + secret | PL |
| DK-02 | Plugin Kong `privacy-tokenizer` (P-1) | GW |
| DK-03 | Tiga jaringan Docker + TLS (NFR-06) | PL |
| DK-04 | Keycloak: realm, klien, pemetaan klaim | PL |
| DK-05 | Ulang tes skema di PostgreSQL 16 | DM |
| DK-06 | NFR-19 mesin bersih + fail-closed dengan replika | PP |

## 2. Functional requirements

| FR | Spec | Tiket | Tes |
| --- | --- | --- | --- |
| FR-01 | GW 3, 11 | M1-03 | TK-19 |
| FR-02 | GW 4 | M2-11 | TF-02, inspeksi muatan keluar (kenari) |
| FR-03 | GW 4 | M2-11 | inspeksi muatan keluar (kenari NIK/nama/email) |
| FR-04 | PV 6, 7.3 | M2-03, M2-05 | TK-06 |
| FR-05 | PV 7.2 | M2-05 | FR-05 (satu subjek, token berbeda per konteks) |
| FR-06 | PV 7.2 | M2-05 | TF-07 |
| FR-07 | PV 4.1, 7.5 | M2-06 | TK-07 |
| FR-08 | PV 4.2, 7.6 | M3-01, M4-05 | TF-01, TF-02 |
| FR-09 | PV 4.3, 7.8 | M3-05, M4-07 | TK-08, TK-15, TK-23..TK-28, TF-06 |
| FR-10 | PV 7.7; TX 5 | M2-07, M4-02 | TF-04 |
| FR-11 | PV 7.7 | M2-07 | TK-09 |
| FR-12 | PV 4.5 | M3-02 | TK-04 |
| FR-13 | PV 9 | M2-04 dan tiap tiket operasi (M2-05..M3-05) | tes `FR-13 writes exactly one audit row per operation` (SUCCESS dan DENIED) di tiap operasi; jumlah baris audit = jumlah panggilan pada skenario TF |
| FR-14 | PV 4.8 | M3-03 | FR-14 (kueri gabungan) |
| FR-15 | PV 9.2; DM 4 | M2-01, M2-10 | `chk_attribute_names`; pindai `audit_log` |
| FR-16 | TX 6; DM 5 | M4-01 | inspeksi skema (S-38) |
| FR-17 | PV 4.7; TX 5 | M2-07, M4-02 | TF-02 (baris `transaction_status`) |
| FR-18 | FR 5; DM 6 | M4-04 | E(s), kueri join (S-71) |
| FR-19 | NT 3.1 | M4-05, M4-08 | TF-01 |
| FR-20 | NT 3.2 | M4-05 | TF-02, muatan masuk hanya token |
| FR-21 | RC 5; DM 8 | M4-06 | E(s), kueri join |
| FR-22 | RC 3.3 | M4-07 | TK-22, TF-06 |
| FR-23 | DM 9; TX 2; PP | M5-01, M5-02, M5-03 | tes kesetaraan perilaku kedua mode |
| FR-24 | PP 6 | M6-02 | skrip pengukuran E(s) |
| FR-25 | PV 5; DM 4 | M2-02, M2-05 | dump tanpa plaintext |
| FR-26 | GW 7 | M1-03 | TK-11 |
| FR-27 | PV 6 | M2-03 | TK-14 |
| FR-28 | PV 7.5 | M2-06 | TK-13 |
| FR-29 | PV 4.6 | M3-02 | TK-17 |
| FR-30 | PV 3, 5 | M0-02, M2-02 | tes konfigurasi tiga kunci |
| FR-31 | PV 7.11 | M2-09 | TF-14 |
| FR-32 | GW 5; RC 3.1 | M2-11, M4-06 | TF-13 |
| FR-33 | PV 7.2 butir 3 | M2-05 | TF-15 khusus (gagal sendirian tanpa penandaan) |
| FR-34 | TX 3.2 | M4-03 | TF-09 |
| FR-35 | TX 3.3 | M4-03 | TF-09, TF-10 |
| FR-36 | TX 5 | M4-01 | TF-08 |
| FR-37 | FR 4 | M4-04 | TF-03, TF-12 |
| FR-38 | GW 4 | M2-11 | TK-16 |
| FR-39 | TX 5 | M4-03 | TF-17 |
| FR-40 | TX 5 | M4-02 | TF-11 |
| FR-41 | RC 3.2 | M4-06 | TF-16 |
| FR-42 | PV 4.9 | M2-08, M4-08 | TK-20, inspeksi dump brankas |
| FR-43 | PV 4.3, 7.8 | M3-05 | TK-21, TK-22 |
| FR-44 | PV 4.6 | M3-02 | TK-17 (brankas kosong) |

## 3. Non-functional requirements

| NFR | Spec | Tiket | Bukti |
| --- | --- | --- | --- |
| NFR-01 | PP 8 | M7-01 | k6 (**ditunda**, konfigurasi final) |
| NFR-02 | PP 8 | M7-01 | k6 (**ditunda**) |
| NFR-03 | PP 8 | M7-01 | ukur langsung `/pseudonymize` (**ditunda**) |
| NFR-04 | DM 4; PV 12 | M2-01, M2-05 | `EXPLAIN` ≥ 20.000 baris tanpa `Seq Scan` |
| NFR-05 | PV 5 | M2-02 | inspeksi dump |
| NFR-06 | PL 16 | DK-03 | **ditunda** (utang NFR-06, ADR-0004) |
| NFR-07 | PV 5 | M2-02, M2-10 | pencarian pola pada log dan konfigurasi |
| NFR-08 | GW 7 | M1-03 | TK-11 |
| NFR-09 | DM 4 | M2-01 | TK-10 |
| NFR-10 | PL 4; GW 3 | M0-02, M1-03 | TK-05, TK-12 |
| NFR-11 | GW 4 | M2-11, M6-04 | TK-16 |
| NFR-12 | PL 6 | M0-03 | uji injeksi keterlambatan |
| NFR-13 | PV 7.2 | M2-05 | TF-07 |
| NFR-14 | PL 8 | M0-06 | scrape `/metrics`, `/health` |
| NFR-15 | PL 5 | M0-02, M2-10 | pemindai log |
| NFR-16 | PL 6 | M0-02, M0-03 | inspeksi log (`transaction_id`) |
| NFR-17 | DM 4..8 | M6-02 | inventaris skema |
| NFR-18 | PV 7.11 | M2-09 | TF-14 |
| NFR-19 | PL 14 | DK-06 | **ditunda** (utang, ADR-0004) |
| NFR-20 | PL 3, 9 | M0-02, M0-06 | pemeriksaan zona waktu proses; `FakeClock` UTC |
| NFR-21 | PL 7, 12 | M1-01, M1-02 | uji token kedaluwarsa, masa ≤ 300 detik |
| NFR-22 | PL 3, 9 | M0-02, M0-07 | gitleaks; `docker history` (DK-01, **ditunda**) |
| NFR-23 | TX 5 | M4-01 | TF-08 sekuensial dan paralel |
| NFR-24 | TX 5 | M4-02 | TF-11 |
| NFR-25 | PL 4 | M0-02, M6-01 | validasi skema JSON pada Newman |

## 4. TF

| TF | Spec | Tiket |
| --- | --- | --- |
| TF-01 | GW 6; NT 3.1 | M4-08 |
| TF-02 | TX 5; NT 3.2 | M4-09 (M4-02, M4-05) |
| TF-03 | TX 5; FR 4 | M4-09 (M4-02, M4-04) |
| TF-04 | TX 5; PV 7.7 | M4-09 (M2-07) |
| TF-05 | RC 3.2 | M4-06 |
| TF-06 (ditulis ulang) | RC 3.3 | M4-07 |
| TF-07 | PV 7.2 | M2-05 |
| TF-08 | TX 5 | M4-01 |
| TF-09 | TX 3.3 | M4-03 |
| TF-10 | TX 3.3 | M4-03 |
| TF-11 | TX 5 | M4-02 |
| TF-12 | FR 4 | M4-04 |
| TF-13 | GW 5; RC 3.1 | M2-11, M4-06 |
| TF-14 | PV 7.11 | M2-09 |
| TF-15 | PV 7.2 | M2-05 |
| TF-16 | RC 3.2 | M4-06 |
| TF-17 | TX 5 | M4-03 |

## 5. TK

Skenario dan harapan per lapis (layanan dan Gateway): `pengujian-dan-pengukuran.md` bagian 4. Dua lapis: lapis layanan (Jest + Supertest, reason rinci, tepat satu baris audit `DENIED`) dan lapis Gateway (Newman, delapan kode klien).

| TK | Spec | Tiket | Tes (lapis) |
| --- | --- | --- | --- |
| TK-01 | PV 7.5 | M3-06 | `TK-01 rejects Notification using a FRAUD token` (layanan, Gateway) |
| TK-02 | PV 7.8 | M3-06 | `TK-02 rejects a purpose different from issuance` (layanan, Gateway) |
| TK-03 | PV 7.1, 7.8 | M3-06 | `TK-03 rejects a token after TTL and grace` dengan `FakeClock` (layanan, Gateway) |
| TK-04 | PV 4.5 | M3-02, M3-06 | `TK-04 rejects a revoked token` (layanan, Gateway) |
| TK-05 | PV 7.8 | M3-06 | `TK-05 rejects a token that was never issued` (layanan, Gateway) |
| TK-06 | PV 6 | M3-06 | `TK-06 rejects a purpose outside the whitelist` tanpa baris mapping (layanan, Gateway) |
| TK-07 | PV 4.1 | M2-06 | `TK-07 rejects raw subject_id from TRANSACTION` (layanan, Gateway) |
| TK-08 | PV 7.8 | M3-05 | `TK-08 rejects de-pseudonymize without the auditor role` (layanan, Gateway) |
| TK-09 | PV 7.7 | M2-07 | `TK-09 rejects re-issue on a COMPLETED transaction` (layanan, Gateway) |
| TK-10 | DM 4 | M2-01 | `TK-10 audit_log is append-only for privpay_app` pada koneksi peran asli (layanan) |
| TK-11 | GW 7 | M1-03 | `TK-11 returns 429 above the quota` dengan `FakeClock` (Gateway) |
| TK-12 | PL 4 | M1-03, M6-01 | `TK-12 returns identical responses for an existing and an unknown token` (Gateway) |
| TK-13 | PV 7.5 | M3-06 | `TK-13 rejects FRAUD exchanging to NOTIFICATION` (layanan, Gateway) |
| TK-14 | PV 6 | M3-06 | `TK-14 rejects FRAUD requesting an ACCOUNT token` (layanan, Gateway) |
| TK-15 | PV 6, 7.8 | M3-06 | `TK-15 rejects FRAUD opening its own token` (layanan, Gateway) |
| TK-16 | GW 4; PP 7 | M6-04 (+ M2-11) | `TK-16 returns 503 and forwards nothing when Privacy is down` + pemindai kenari (Gateway) |
| TK-17 | PV 4.6 | M3-02 | `TK-17 revokes every token of a subject and purges the vault` (layanan, Gateway) |
| TK-18 | PL 14 | M0-07 (image: DK-01) | gitleaks nol temuan |
| TK-19 | GW 3 | M1-03 | `TK-19 returns 401 for a missing or expired JWT` (Gateway) |
| TK-20 | PV 4.9 | M2-08 | `TK-20 rejects /identity from TRANSACTION and writes no vault row` (layanan, Gateway) |
| TK-21 | PV 7.8 | M3-05 | `TK-21 returns only the approved attribute` (layanan, Gateway) |
| TK-22 | RC 3.3 | M4-07 | `TK-22 audit-request returns no identity` + pemindai kenari (layanan, Gateway) |
| TK-23 | PV 7.8 | M3-05 | `TK-23 rejects de-pseudonymize without an approved disclosure` (layanan, Gateway) |
| TK-24 | PV 4.10 | M3-04 | `TK-24 rejects self approval` dan `chk_four_eyes` (layanan, Gateway) |
| TK-25 | PV 4.10 | M3-04 | `TK-25 rejects approval without the admin role` (layanan, Gateway) |
| TK-26 | PV 7.8 | M3-05 | `TK-26 rejects a second use and a use after 600 seconds` (layanan, Gateway) |
| TK-27 | PV 4.10 | M3-04 | `TK-27 rejects a basis or attribute outside the tables` tanpa baris (layanan, Gateway) |
| TK-28 | PV 7.8 | M3-05 | `TK-28 rejects another auditor using an approved request` (layanan, Gateway) |

## 6. Temuan keterlacakan

- **Tidak ada FR atau NFR tanpa tes atau pengukuran terencana.**
- **Bukti ditunda (bukan tanpa tes):** NFR-01, NFR-02, NFR-03 (M7-01), NFR-06 (DK-03), NFR-19 (DK-06), bagian `docker history` dari NFR-22 dan TK-18 (DK-01). Tidak boleh dinyatakan lulus sebelum diuji (ADR-0004).
- **Bukti bersyarat:** FR-09/FR-22 mengandalkan rute yang menunggu persetujuan (E-23..E-27, `01-perubahan-prd.md` bagian B).
- **Kriteria penerimaan wajib hasil Fase 2** (bukan catatan): TF-15 khusus (M2-05), `timingSafeEqual` (M1-02), `ON CONFLICT` paralel `POST /transaction` (M4-01), dua pool audit (M2-04).
