# SECURITY.md — PrivPay

PrivPay adalah prototipe penelitian dengan data fiktif. Standar keamanannya tetap seperti sistem yang menyimpan data keuangan dan identitas, karena itulah yang dibuktikan skripsi ini. Berkas ini adalah kebijakan; model ancaman ada di `docs/security/threat-model.md` dan daftar periksa di `docs/security/security-checklist.md`.

## 1. Ruang lingkup dan aset

| Aset | Di mana | Perlindungan utama |
| --- | --- | --- |
| Identitas asli (NIK, nama, HP, rekening, customer_id) | `identity_vault`, `pseudonym_mapping.subject_id_enc` (privacy-db); Keycloak; HP di notification-db | Enkripsi field AES-256-GCM, pembukaan bersyarat dua pihak, hak DB per peran |
| Tiga kunci (`K_token`, `K_index`, `K_field`) | Berkas rahasia/Docker secret (`*_FILE`), hanya privacy-service | Tidak di repo/image/log; pemisahan kunci |
| Mapping token ↔ subjek | privacy-db | Enkripsi, indeks buta, akses hanya Privacy Service |
| Audit log | privacy-db | Append-only di tingkat hak akses, tanpa PII |
| JWT dan kredensial service account | Keycloak | Masa berlaku pendek, cache terbatas, tidak dicatat |

Di luar cakupan: keamanan fisik/VPS, DDoS volumetrik, serangan terhadap Keycloak/Kong itu sendiri selain konfigurasi, korelasi atribut (nominal+jam+geohash).

## 2. Prinsip yang tidak boleh dilanggar

1. **Tidak ada data pribadi asli** di repo, fixture, log, tracing, metrik, pesan error, atau percakapan dengan AI. Data uji fiktif dan jelas palsu.
2. **Tidak ada secret di git.** Kunci dan kata sandi hanya lewat berkas rahasia/Docker secret yang dibaca lewat `<NAME>_FILE` (bukan nilai mentah di env). `.env` dan `secrets/*` di-ignore; hanya `*.example` yang di-commit.
3. **Gagal tertutup.** Bila ragu atau komponen privasi mati: tolak (403/503), jangan teruskan data mentah.
4. **Hak seminimal mungkin.** Peran DB, peran Keycloak, dan jaringan Docker hanya memberi yang dibutuhkan (`privacy_app` hanya INSERT di `audit_log`; `auditor_role` tidak punya akses ke `identity_vault`).
5. **Semua operasi sensitif tercatat** (SUCCESS dan DENIED) tanpa nilai identitas.
6. **Pembukaan identitas selalu dua pihak, bersyarat, sekali pakai, atribut minimal** (D-01 sampai D-05).

## 3. Manajemen secret

- Tiga kunci Privacy Service berupa berkas rahasia terpisah, dibaca lewat `*_FILE` dan kelak dipasang sebagai Docker secret (`secrets/pseudonym_hmac_secret`, `secrets/blind_index_secret`, `secrets/field_encryption_key`), masing-masing 32 byte acak (`openssl rand -hex 32` untuk dev). Kunci produksi/VPS dibuat terpisah dan tidak pernah sama dengan kunci dev.
- Kata sandi DB, rahasia klien Keycloak, dan kredensial Grafana juga lewat secret/env runtime, bukan literal di compose yang di-commit.
- Aplikasi gagal start bila secret hilang, kosong, atau panjangnya salah; tiga kunci harus berbeda satu sama lain (FR-30).
- Pemindaian: gitleaks (pre-commit dan CI, seluruh riwayat), `docker history` untuk image (TK-18).
- Bila secret terlanjur ter-commit: anggap bocor. Rotasi segera, laporkan ke Fanny, lalu bersihkan riwayat dengan persetujuan Fanny. Menghapus berkas di commit berikutnya tidak cukup.

## 4. Validasi input dan batas kepercayaan

- Semua input batas divalidasi dengan skema, menolak field tak dikenal, membatasi panjang, tipe, dan rentang (nominal bilangan bulat rupiah ≥ 1 (K-16), `purpose` dari enum, `Idempotency-Key` UUID).
- `requesting_service` dan peran hanya dari JWT yang divalidasi. `target_service` divalidasi terhadap Tabel 1.
- SQL hanya berparameter. Tidak ada SQL dinamis dari input.
- Ukuran body dibatasi; header tak dikenal tidak dipercaya.
- Respons error seragam dan tidak membedakan "token tidak ada" dengan "bukan milik Anda" ke klien (NFR-10); detail hanya di audit.

## 5. Rate limit dan ketahanan

- Kong: 100 permintaan/menit per service account untuk klien eksternal (NFR-08); dimatikan hanya saat pengukuran performa, diaktifkan lagi untuk TK-11.
- Timeout 3 detik, maksimum 2 retry berbackoff untuk operasi idempoten (NFR-12). Tidak ada retry otomatis pada operasi non-idempoten.
- Ukuran token hanya 32 bit: penebakan token valid secara teoretis mungkin. Penghalang: token terikat layanan+purpose+TTL, rate limit, dan audit `TOKEN_NOT_FOUND` dengan peringatan di `/audit-log/summary`.

## 6. Audit log tanpa PII

Boleh: `action`, `status`, `reason`, `requesting_service`, `actor_id` (ID Keycloak), `pseudonym`, `purpose`, `transaction_id`, `mapping_id`, `disclosure_id`, nama atribut yang dibuka. Dilarang: NIK, nama, HP, email, rekening, `subject_id`, nominal, geohash, secret, JWT, nilai atribut hasil pembukaan. Ditegakkan oleh: tipe/DDL (tidak ada kolom untuk itu), pemindai kenari pada `audit_log`, dan tes.

## 7. Dependensi dan rantai pasok

- Dependensi minimal; kripto hanya `node:crypto`. Tambah dependensi = alasan, lisensi, `pnpm audit`.
- Lockfile di-commit; instal dengan `--frozen-lockfile`. Dependabot mingguan (npm, docker, github-actions). `dependency-review` pada PR.
- Image dipin ke versi/digest; image minimal; kontainer berjalan non-root, filesystem baca-saja bila mungkin, tanpa capability tambahan.
- Pemindaian: `pnpm audit`, Trivy (fs dan image), CodeQL, Semgrep, hadolint.

## 8. Pelaporan dan penanganan insiden

Ini proyek perorangan. Temuan keamanan dicatat sebagai issue privat atau dilaporkan ke pemilik repo (Fanny) secara langsung. Setiap temuan punya: ID, keparahan, bukti, perbaikan, tes regresi. Temuan keamanan diperbaiki sebelum fitur baru di milestone yang sama. Temuan yang diterima sebagai risiko sisa ditulis di PRD 20 (keterbatasan) dengan alasan.

## 9. Pemeriksaan wajib per fase

| Kapan | Apa |
| --- | --- |
| Setiap commit | pre-commit: gitleaks, detect-private-key, larangan `console.*` |
| Setiap PR | lint, typecheck, tes, audit dependensi, CodeQL, Semgrep, dependency-review, `/code-review` |
| Akhir milestone | `/security-review`, bagian relevan `security-checklist.md`, `qa-checklist.md` |
| Akhir proyek | `/security-review` seluruh repo, seluruh checklist, pemindaian riwayat git, image, dan uji dari mesin bersih |
