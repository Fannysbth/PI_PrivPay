# Checklist keamanan

Cara pakai: salin tabel ke `docs/security/review-<milestone>.md` saat review, isi status (✔ lulus dengan bukti / ✘ gagal / n/a dengan alasan). Butir tanpa bukti dihitung belum lulus. Kolom "Kapan" menunjukkan paling lambat milestone untuk diperiksa.

Kolom "Status (penutup M3)" diisi pada penutup milestone M3 (2026-10-21): ✔ hanya bila ada tes yang dijalankan atau tinjauan yang membuktikannya, ◐ bila sebagian, — bila belum teruji atau jatuh tempo di milestone berikutnya. Bukti per butir ada di `review-M3.md`.

## A. Secret dan konfigurasi

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-01 | Tidak ada secret/kunci/kata sandi di git (termasuk riwayat) | `gitleaks detect --log-opts="--all"` nol temuan; TK-18 | Tiap PR, akhir | ✔ lulus, [bukti](review-M3.md#s-01) |
| S-02 | `.env` dan `secrets/*` ter-ignore; hanya `*.example` | `git ls-files secrets .env*` | M0 | ✔ lulus, [bukti](review-M3.md#s-02) |
| S-03 | Tiga kunci Privacy Service dari berkas rahasia/Docker secret (`*_FILE`), berbeda satu sama lain, panjang 32 byte; start gagal bila hilang/sama | tes unit konfigurasi, FR-30 | M2 | ✔ lulus, [bukti](review-M3.md#s-03) |
| S-04 | Tidak ada secret di image (`docker history`, ENV, ARG) | Trivy secret scan, TK-18 | M0, akhir | — belum, [bukti](review-M3.md#s-04) |
| S-05 | Kata sandi DB/Keycloak/Grafana tidak default; kredensial dev ≠ kredensial VPS | inspeksi compose | M1 | — belum, [bukti](review-M3.md#s-05) |
| S-06 | Kontainer non-root, filesystem baca-saja bila mungkin, `cap_drop: [ALL]`, `no-new-privileges` | inspeksi compose | M0 | — belum, [bukti](review-M3.md#s-06) |
| S-07 | Port DB tidak diekspos ke host; `/metrics` dan `/health` hanya jaringan internal (kecuali dev) | `docker compose config` (fase lokal: konfigurasi `listen_addresses`/`pg_hba` PostgreSQL lokal; ADR-0004) | M0 | ◐ sebagian, [bukti](review-M3.md#s-07) |
| S-08 | Image dan Action dipin (versi, lalu digest/SHA); `permissions:` workflow minimal | tinjauan CI | M0 | ◐ sebagian, [bukti](review-M3.md#s-08) |

## B. Autentikasi dan otorisasi

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-10 | Kong menolak JWT tidak ada/kedaluwarsa/tanda tangan salah | TK-19 | M1 | ✔ lulus, [bukti](review-M3.md#s-10) |
| S-11 | Access token ≤ 5 menit; token service account dicache ≤ (exp − 30 detik) | NFR-21 | M1 | ✔ lulus, [bukti](review-M3.md#s-11) |
| S-12 | `requesting_service` hanya dari klaim JWT; body tidak dipercaya | TK-07, tes unit | M3 | ✔ lulus, [bukti](review-M3.md#s-12) |
| S-13 | Peran per endpoint ditegakkan (admin/auditor/fraud_analyst/bank/service) | TK-08, TK-25 | M3 | ✔ lulus, [bukti](review-M3.md#s-13) |
| S-14 | Setiap kombinasi di luar Tabel 1/2/3 ditolak `POLICY_NOT_ALLOWED` tanpa baris mapping | TK-06, TK-13, TK-14, TK-15 | M3 | ✔ lulus, [bukti](review-M3.md#s-14) |
| S-15 | Token layanan lain/purpose lain/kedaluwarsa/dicabut ditolak dengan reason tepat | TK-01..TK-05 | M3 | ✔ lulus, [bukti](review-M3.md#s-15) |
| S-16 | `/identity` hanya dari API_GATEWAY | TK-20 | M3 | ✔ lulus, [bukti](review-M3.md#s-16) |

## C. Pembukaan identitas

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-20 | Audit rutin tanpa identitas | TK-22 + pemindai kenari | M3 | — belum, [bukti](review-M3.md#s-20) |
| S-21 | Pembukaan tanpa/dengan disclosure PENDING ditolak | TK-23 | M3 | ✔ lulus, [bukti](review-M3.md#s-21) |
| S-22 | Penyetuju = pemohon ditolak; ditegakkan juga `chk_four_eyes` di DB | TK-24 + tes SQL langsung | M3 | ✔ lulus, [bukti](review-M3.md#s-22) |
| S-23 | Persetujuan sekali pakai dan kedaluwarsa 600 detik | TK-26 | M3 | ✔ lulus, [bukti](review-M3.md#s-23) |
| S-24 | Dasar dan atribut di luar Tabel 6/5 ditolak 422 tanpa baris | TK-27 | M3 | ✔ lulus, [bukti](review-M3.md#s-24) |
| S-25 | Pemohon lain tidak dapat memakai persetujuan | TK-28 | M3 | ✔ lulus, [bukti](review-M3.md#s-25) |
| S-26 | Respons hanya memuat atribut yang disetujui; HP dan rekening tidak pernah | TK-21 | M3 | ✔ lulus, [bukti](review-M3.md#s-26) |
| S-27 | Nilai atribut hasil pembukaan tidak ada di audit_log, log, reconciliation-db | pemindai kenari | M4, M6 | ◐ sebagian, [bukti](review-M3.md#s-27) |

## D. Data dan kripto

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-30 | Kolom subjek dan brankas hanya ciphertext di dump DB | FR-25, FR-42 | M2 | ◐ sebagian, [bukti](review-M3.md#s-30) |
| S-31 | AES-256-GCM: IV 12 byte acak per penulisan, tag 16 byte, AAD benar; ciphertext tak dapat dipindah antar kolom/jenis subjek | tes unit | M2 | ✔ lulus, [bukti](review-M3.md#s-31) |
| S-32 | Hanya `node:crypto`; tidak ada kripto buatan sendiri | tinjauan, daftar dependensi | M2 | ✔ lulus, [bukti](review-M3.md#s-32) |
| S-33 | Perbandingan rahasia konstan-waktu | tinjauan | M2 | ✔ lulus, [bukti](review-M3.md#s-33) |
| S-34 | `audit_log` append-only: UPDATE/DELETE oleh `privacy_app` gagal; auditor hanya SELECT | TK-10, koneksi per peran | M3 | ✔ lulus, [bukti](review-M3.md#s-34) |
| S-35 | `auditor_role` tidak punya akses ke `identity_vault` | tes SQL dengan peran itu | M3 | ✔ lulus, [bukti](review-M3.md#s-35) |
| S-36 | Retensi: tidak ada baris tidak berlaku > 90 hari dengan `subject_id_enc` | TF-14, query pemeriksaan | M2 | ◐ sebagian, [bukti](review-M3.md#s-36) |
| S-37 | `revoke_subject` mengosongkan brankas, mencatat `PURGE_IDENTITY` | TK-17 | M3 | ✔ lulus, [bukti](review-M3.md#s-37) |
| S-38 | Tidak ada kolom `subject_id` di `audit_log`; tidak ada kolom identitas di DB hilir (mode proposed) | inspeksi skema, E(s) | M4 | ◐ sebagian, [bukti](review-M3.md#s-38) |

## E. Input, error, logging

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-40 | Semua input divalidasi skema; field tak dikenal ditolak; batas panjang dan rentang | tes tiap endpoint | tiap tiket | ✔ lulus, [bukti](review-M3.md#s-40) |
| S-41 | SQL hanya berparameter (tidak ada penyusunan string dari input) | Semgrep + tinjauan | tiap PR | ◐ sebagian, [bukti](review-M3.md#s-41) |
| S-42 | Respons error seragam; ke klien hanya delapan `code` (ADR-0008); tidak ada stack trace/SQL/nama tabel | NFR-25, TK-12 | M3 | ◐ sebagian, [bukti](review-M3.md#s-42) |
| S-43 | Log hanya token + `transaction_id`; tidak ada PII, JWT, secret | NFR-15, US-14, pemindai | M4, M6 | ◐ sebagian, [bukti](review-M3.md#s-43) |
| S-44 | Header Authorization dan body identitas diredaksi di log Kong/akses | konfigurasi + pemindai | M1 | ◐ sebagian, [bukti](review-M3.md#s-44) |
| S-45 | Tidak ada `console.*` di kode layanan | ESLint + pre-commit | M0 | ✔ lulus, [bukti](review-M3.md#s-45) |

## F. Ketahanan

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-50 | Privacy Service mati → 503 di Gateway, tidak ada data mentah ke hilir | TK-16 + pemindai | M2 | — belum, [bukti](review-M3.md#s-50) |
| S-51 | Rate limit 100/menit/akun | TK-11 | M1 | ✔ lulus, [bukti](review-M3.md#s-51) |
| S-52 | Timeout 3 detik, maks 2 retry, hanya idempoten | NFR-12, uji injeksi keterlambatan | M4 | — belum, [bukti](review-M3.md#s-52) |
| S-53 | Tidak ada race penerbitan token ganda | uji paralel (TF-07) | M2 | ✔ lulus, [bukti](review-M3.md#s-53) |
| S-54 | `Idempotency-Key` mencegah transaksi ganda (sekuensial dan paralel) | TF-08, NFR-23 | M4 | — belum, [bukti](review-M3.md#s-54) |
| S-55 | Batas ukuran body dan `limit` pagination ≤ 200 | tes | M3 | ✔ lulus, [bukti](review-M3.md#s-55) |

## G. Rantai pasok dan CI

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-60 | `pnpm audit --prod --audit-level high` bersih atau pengecualian tertulis | CI | tiap PR | ✔ lulus, [bukti](review-M3.md#s-60) |
| S-61 | CodeQL dan Semgrep tanpa temuan tinggi yang belum ditangani | CI | tiap PR | — belum, [bukti](review-M3.md#s-61) |
| S-62 | Trivy fs/image: tanpa HIGH/CRITICAL yang dapat diperbaiki | CI | M0, akhir | — belum, [bukti](review-M3.md#s-62) |
| S-63 | `dependency-review` pada PR; lisensi dapat diterima | CI | tiap PR | — belum, [bukti](review-M3.md#s-63) |
| S-64 | Setiap dependensi baru punya alasan di PR | tinjauan | tiap PR | ✔ lulus, [bukti](review-M3.md#s-64) |
| S-65 | Dependabot aktif; PR pembaruan ditinjau | pengaturan repo | M0 | — belum, [bukti](review-M3.md#s-65) |

## H. Pengungkapan privasi (khas PrivPay)

| # | Butir | Verifikasi | Kapan | Status (penutup M3) |
| --- | --- | --- | --- | --- |
| S-70 | E(s) mode proposed: Transaction, Fraud, Reconciliation = 0; Notification = 1/6 | skrip E(s), nilai kenari | M6 | — belum, [bukti](review-M3.md#s-70) |
| S-71 | Query join lintas DB lewat pseudonim tidak menghasilkan baris | percobaan join (PRD 18.2) | M6 | — belum, [bukti](review-M3.md#s-71) |
| S-72 | Uji penautan baseline vs proposed berjalan dan dilaporkan jujur, termasuk linkability dalam TTL | skrip penautan | M6 | — belum, [bukti](review-M3.md#s-72) |
| S-73 | Fail-closed diuji dengan replika dimatikan saat beban | skrip | M6 | — belum, [bukti](review-M3.md#s-73) |
| S-74 | Data uji seluruhnya fiktif | tinjauan seed | M0, tiap PR | ✔ lulus, [bukti](review-M3.md#s-74) |
