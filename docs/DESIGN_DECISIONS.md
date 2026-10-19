# Keputusan desain FINAL

Status FINAL berarti tidak diubah tanpa ADR yang disetujui user (Fanny). Sumber: PRD v2.4, Bab Metodologi v8, dan keputusan Fanny pada 10 dan 13 Oktober 2026. Kolom "Dampak bila diubah" membantu menilai apakah perubahan layak diajukan.

## A. Privasi dan akses

| # | Keputusan | Alasan | Dampak bila diubah |
| --- | --- | --- | --- |
| D-01 | **Audit rutin berbasis pseudonim.** `POST /reconciliation/audit-request` hanya mengembalikan token P7 dan data transaksi; tidak ada `customer_id`, NIK, nama. | Masukan dosen pembimbing (13 Okt 2026): data yang sudah dipseudonimkan jadi percuma bila audit membuka identitas setiap kali. | TK-22, FR-43, kontrak API |
| D-02 | **Pembukaan identitas bersyarat, dua pihak.** Hanya lewat `disclosure_request`: auditor mengajukan (token P7, dasar Tabel 6, nomor kasus, atribut), admin lain menyetujui, baru `/de-pseudonymize` dengan `disclosure_id`. Pemohon tidak boleh menyetujui sendiri (`SELF_APPROVAL`; dipaksa juga oleh `chk_four_eyes` di DB). | Prinsip empat mata (Flegel 2005, Petersen 2018, keduanya belum diverifikasi penuh) | TK-21..TK-28, GATE 5 |
| D-03 | **Persetujuan sekali pakai dan berlaku 10 menit (600 detik).** Status PENDING→APPROVED→USED, atau REJECTED/EXPIRED. Pemakaian kedua: `403 DISCLOSURE_NOT_APPROVED`; setelah 600 detik: `410 DISCLOSURE_EXPIRED`. TTL token P7 juga 600 detik. | Jendela sesempit mungkin untuk satu-satunya jalur pembukaan | TK-26, Tabel 1 P7 |
| D-04 | **Atribut minimal.** Hanya `customer_id`, NIK, nama (P7) dan hanya yang disetujui pada permintaan. HP dan rekening tidak pernah dibuka lewat jalur audit. Audit log mencatat nama atribut, bukan nilai. | Minimisasi data (UU PDP, prinsip PbD) | Tabel 5, TK-21 |
| D-05 | **Dasar pembukaan terbatas** pada DISPUTE, FRAUD_CONFIRMED, LEGAL_REQUEST + nomor kasus. Dasar atau atribut di luar tabel ditolak 422 (`INVALID_BASIS`, `ATTRIBUTE_NOT_ALLOWED`) tanpa baris permintaan. | Tidak ada pembukaan tanpa dasar yang dapat diaudit | Tabel 6, TK-27 |
| D-06 | **Gateway tokenisasi lebih dulu.** `customer_id` dan rekening diganti token per layanan+tujuan; NIK, nama, email dibuang dari payload ke hilir. Privacy Service tidak memanggil keluar. | v1 melanggar aturan "hanya Privacy menerima data mentah" | Seluruh alur |
| D-07 | **Brankas identitas.** NIK, nama, HP, rekening disimpan sekali saat pendaftaran (A5), terenkripsi per kolom (AAD = nama kolom), auditor tidak punya akses SQL ke tabelnya. | Memenuhi "tidak melihat data asli kecuali benar-benar dibutuhkan" tanpa menyebar salinan | FR-42..44 |
| D-08 | **Pengecualian sadar:** HP di Notification, identitas login di Keycloak. Hanya dua; tercatat sebagai keterbatasan. | Fungsi bisnis | E(s) Notification = 1/6 |
| D-09 | **Gagal tertutup.** Privacy Service mati → 503; tidak ada fallback ke data mentah. Fraud mati → transaksi HELD (`FRAUD_UNAVAILABLE`). Notification mati → transaksi tetap COMPLETED. | Privasi tidak boleh turun saat sistem gagal | NFR-11, NFR-24, TK-16 |

## B. Token dan kebijakan

| # | Keputusan | Dampak bila diubah |
| --- | --- | --- |
| D-10 | Tujuh konteks (Tabel 1) dan dua pertukaran (Tabel 2) final. Enam nilai purpose. Penambahan purpose/layanan = ADR. | Policy Engine, tes keamanan, bab pengujian |
| D-11 | Format token `PSEU-` + 8 heks dari HMAC-SHA256 dengan nonce; ruang 32 bit diterima, tabrakan ditangani unique + retry. | Migrasi kolom di semua DB hilir |
| D-12 | Kunci pakai-ulang token = (subjek, layanan, purpose), tanpa `transaction_id` → semi-dinamis; linkability dalam jendela TTL diakui. | Jumlah mapping, hasil pengukuran |
| D-13 | Tiga kunci terpisah (`K_token`, `K_index`, `K_field`), dari berkas rahasia/Docker secret (dibaca lewat `*_FILE`), hanya di privacy-service. Rotasi hanya `key_version` + prosedur tertulis. | Enkripsi ulang seluruh mapping |
| D-14 | TTL per purpose: 900 / 2.592.000 / 900 / 31.536.000 / 86.400 / 600 detik; grace 30 detik; semua dari env. | TF-04, hasil pengukuran |
| D-15 | Retensi: kolom identitas mapping dikosongkan setelah `RETENTION_DAYS`=90 (tetapan sendiri). Brankas dikosongkan hanya lewat `revoke_subject`. | TF-14, klaim minimisasi |
| D-16 | `requesting_service` selalu dari klaim JWT; `target_service` dari body dan wajib ada di Tabel 1. | Seluruh keamanan antar-layanan |

## C. Audit

| # | Keputusan |
| --- | --- |
| D-17 | Audit adalah modul di dalam Privacy Service, bukan layanan kedelapan (menghindari hop dan panggilan keluar). |
| D-18 | `audit_log` append-only di tingkat hak akses DB; tanpa `subject_id`; hanya token, `mapping_id`, `actor_id`, konteks. Log aplikasi: hanya token dan `transaction_id`. |
| D-19 | Rantai hash audit (`prev_hash`, `row_hash`) berstatus opsional; keputusan dikerjakan atau tidak diambil di Fase 1 (OPEN_QUESTIONS Q-12). |

## D. Platform dan evaluasi

| # | Keputusan |
| --- | --- |
| D-20 | Satu basis kode, satu env `PRIVACY_MODE` (`baseline`/`proposed`; hanya dua kondisi, ADR-0003). Logika bisnis identik. |
| D-21 | Stack inti: TypeScript+NestJS, PostgreSQL 16 per layanan, Kong, Keycloak, Docker Compose, Postman/Newman, k6, Prometheus+Grafana. Fase lokal tanpa Docker: lihat ADR-0004 (penjadwalan, bukan perubahan stack akhir). |
| D-22 | `docker compose up` menyalakan seluruh sistem tanpa langkah manual selain menyalin env dan membuat secret (NFR-19). Pengujiannya ditunda sampai Docker tersedia (ADR-0004). |
| D-23 | Evaluasi: fungsional, paparan E(s) (nilai kenari), keamanan (TK), performa (100 VU, 5 pengulangan bergantian, p95 ≤ 20%, throughput ≤ 15%, galat < 1%). Alur C4 (review analis) dan D3 (laporan bank) dirancang dan diuji fungsional, tetapi tidak dievaluasi untuk paparan/penautan/performa. LINDDUN tidak diulang setelah implementasi. |
| D-24 | Seluruh data uji fiktif. NIK/HP/rekening tidak merujuk orang atau rekening nyata. |

## E. Keterbatasan yang tidak boleh disembunyikan

Lihat `docs/PRD_RINGKAS.md` bagian 13. Jangan "memperbaiki" keterbatasan ini secara diam-diam di kode; kalau mau, jadikan ADR.
