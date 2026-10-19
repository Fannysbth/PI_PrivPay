# Usulan koreksi PRD / Metodologi (errata)

`docs/reference/` tidak diubah. PRD, Metodologi, dan Introduction sedang diperbarui Fanny secara terpisah; berkas ini hanya mencatat selisih dan keputusan yang dipakai kode. Yang berlaku untuk implementasi: `docs/DESIGN_DECISIONS.md` dan ADR Accepted.

## A. Selisih yang sudah tercatat di `docs/OPEN_QUESTIONS.md` bagian A

E-01 sampai E-09 (jumlah gerbang, TF-06, kontrak `/de-pseudonymize`, jumlah kasus TK, katalog action, `audit_log.disclosure_id` dan `detail`, tabel kode error, riwayat revisi, reason vs `ACCESS_DENIED`). Semuanya dijawab Fanny di Fase 1b (2026-10-19), kecuali E-08 yang ditangani Fanny di PRD. Ringkasan keputusan: lima gerbang + dua syarat tambahan (E-01); TF-06 ditulis ulang tanpa identitas (E-02); `/de-pseudonymize` wajib `disclosure_id` dan responsnya `{mapping_id, attributes}` (E-03); 28 kasus TK (E-04); tiga action `DISCLOSURE_*` dan reason GATE 5 di `DE_PSEUDONYMIZE` (E-05); `audit_log.disclosure_id` FK dan `attribute_names TEXT[]` dengan CHECK (E-06); tujuh reason baru dan kode klien menjadi delapan, ADR-0008 (E-07); uji dua lapis (E-09).

## B. Selisih tambahan

| ID | Temuan | Lokasi | Keputusan yang dipakai kode |
| --- | --- | --- | --- |
| E-10 | Mode `static` masih disebut (token HMAC atas `subject_id` untuk uji penautan) | PRD 17, 18; Metodologi C.3, D.3, Tabel V | Dibatalkan, hanya `baseline` dan `proposed` (ADR-0003); uji penautan baseline vs proposed |
| E-11 | Gambar arsitektur menulis "Resolver (4 gerbang)" | `Arsitektur_Sistem_PrivPay.png` | Lima gerbang + syarat `boleh_dibuka` dan peran auditor (PRD 7.4); sumber gambar diperbaiki terpisah, PNG tidak diedit |
| E-12 | Metodologi mensyaratkan Privacy Service berjalan lebih dari satu replika untuk uji fail-closed | Metodologi A.2, D.3 | PRD berlaku: satu VPS tanpa HA; fail-closed diuji dengan mematikan Privacy Service (TK-16); replika tidak wajib |
| E-13 | Metodologi menulis kunci dari "variabel lingkungan"; PRD/NFR-22 mewajibkan Docker secret | Metodologi C.2 | Berkas rahasia/Docker secret, dibaca lewat `*_FILE` (ADR-0004) |
| E-14 | Metodologi Tabel I menyebut `audit_log` "berantai hash" | Metodologi Tabel I | Rantai hash hanya dirancang (kolom `prev_hash`/`row_hash` nullable), tidak diimplementasikan; Fanny memperbaiki Metodologi |
| E-15 | Metodologi dan PRD 18.4 mengandaikan lingkungan Docker/VPS sejak awal | PRD 17, 19 (M0, M1) | Fase lokal tanpa Docker (ADR-0004); NFR-19, fail-closed berbasis compose, dan M7 ditunda; M0/M1 disesuaikan di tiket |
| E-16 | Alur A berurutan A2, A3, A4, A5; kegagalan A5 setelah A4 meninggalkan HP di Notification tanpa jalur kompensasi (tidak ada endpoint hapus kontak) | PRD 9 alur A | Urutan A2, A5, A3, A4 dengan kompensasi `revoke_subject` + hapus pengguna IdP (ADR-0005); A5 tidak bergantung pada A3 |
| E-17 | "Klien hanya melihat enam `code`" bertentangan dengan TF-08 (409 `IDEMPOTENCY_CONFLICT`) dan FR-35 (409 `NOT_HELD`) | PRD 10 | Delapan kode klien (ADR-0008) |
| E-18 | Sidik jari idempotensi tidak ditetapkan; hash rekening mentah berbahaya, kunci baru melanggar tiga kunci | PRD 10, FR-36, NFR-23 | Bandingkan token dan atribut; jendela efektif = TTL P1 (ADR-0009) |
| E-19 | `FOR UPDATE` pada baris yang belum ada tidak mengunci apa pun; INSERT biasa yang melanggar unique membatalkan transaksi, sehingga "ulangi dari STEP 2" tidak berjalan | PRD 7.1 STEP 1 dan STEP 4 | Kunci advisory transaksi per kombinasi + `ON CONFLICT (pseudonym) DO NOTHING` (ADR-0010, Accepted) |
| E-20 | "||" pada rumus token dan `subject_lookup` tidak menyebut penyandian; penggabungan polos ambigu | PRD 6, 6.2 | Awalan panjang 4 byte per bagian (ADR-0011, Accepted) |
| E-21 | AAD = `subject_type` tidak mengikat ciphertext ke baris; swap antar baris sejenis tak terdeteksi | PRD 6.2 | AAD memuat `subject_type`/nama kolom + `id` baris yang dibangkitkan aplikasi (ADR-0011, Accepted) |
| E-22 | PRD 11 menamai peran `privacy_app` dan `auditor_role`; di server lokal bersama, semua objek PrivPay berawalan `privpay_` | PRD 11 | `privpay_app` (= `privacy_app`), `privpay_auditor` (= `auditor_role`), plus `privpay_privacy_owner` dan `privpay_test_admin` (ADR-0004) |
| E-23 | D1 mengambil transaksi `COMPLETED` per tanggal dari Transaction, tetapi tidak ada endpoint terdaftar | PRD 9 D1, PRD 10 | Usulan `GET /transaction/completed?date=` (K-18), menunggu persetujuan |
| E-24 | E1 mengembalikan nominal dan status transaksi, tetapi tidak ada endpoint terdaftar | PRD 9 E1, PRD 10 | Usulan `GET /transaction/{transaction_id}` (K-18), menunggu persetujuan |
| E-25 | E3 menyebut Reconciliation memanggil `/de-pseudonymize`, tetapi tidak ada rute yang memicunya | PRD 9 E3, PRD 10 | Usulan `POST /reconciliation/disclosure` (K-15), menunggu persetujuan |
| E-26 | A1 (pendaftaran) tidak menamai rute di Gateway | PRD 9 A1, PRD 10 | Usulan `POST /register` (K-14), menunggu persetujuan |
| E-27 | admin perlu menemukan `disclosure_id` yang menunggu, tetapi tidak ada endpoint daftar dan filter `GET /audit-log` tidak memuat `action`/`disclosure_id` | PRD 10 | Usulan filter tambahan (K-08), menunggu persetujuan |
| E-28 | nilai ambang dan jadwal yang diperlukan tidak ada di daftar env | PRD 17 | Env baru: `FRAUD_HOLD_THRESHOLD`, `FRAUD_BLOCK_THRESHOLD`, `TX_SWEEP_INTERVAL_SECONDS`, `RECON_DAILY_RUN_UTC`, `RETENTION_JOB_RUN_UTC`, `DEV_IDP_ENABLED`, `PG_HOST`, `PG_PORT`, `*_FILE` (K-19, K-20, K-23) |