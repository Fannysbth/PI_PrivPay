# Spesifikasi: Fraud Service

Sumber: PRD 10 ("Penilaian risiko di Fraud"), 11, 13 (FR-18, FR-37), 16, 17; D-14; ADR-0006, 0008. **[K-nn]** diterima Fanny (bawaan, Gerbang 3).

## 1. Tanggung jawab

Menilai risiko transaksi di atas ambang dengan mesin aturan berbobot berkunci pseudonim FRAUD_DETECTION (berumur 30 hari), menyimpan riwayat asesmen, dan mengembalikan skor serta keputusan. Tidak memegang identitas dalam bentuk apa pun dan tidak menyimpan `transaction_id` (fraud-db tidak boleh dapat di-join ke transaction-db). Profil perilaku hanya mencakup transaksi di atas ambang dan terputus (cold start) setiap token berganti atau dicabut (keterbatasan PRD 20 no. 11).

## 2. Modul dan seam

| Modul | Interface | Catatan |
| --- | --- | --- |
| `RiskEngine` (murni) | `evaluate(input, history, rules, config)` mengembalikan `{score, decision, fired, skipped, priorCount}` | tanpa I/O; diuji dengan tabel kasus |
| `AssessmentRepository` | seam **repositori per mode**: `history(subjectRef)`, `insert(assessment)` | adapter proposed (kolom `pseudonym`) dan baseline (kolom `customer_id`) |

## 3. Kontrak

`POST /fraud/assess`: pemanggil `TRANSACTION` (selain itu 403 `POLICY_NOT_ALLOWED`).

Permintaan `{pseudonym, amount, tx_hour, geohash}`: `pseudonym` `Pseudonym`; `amount` bilangan bulat ≥ 1; `tx_hour` bilangan bulat 0..23 (UTC); `geohash` `^[0-9b-hjkmnp-z]{1,12}$`; field lain ditolak (422). Pada mode baseline `pseudonym` diganti `customer_id` (ADR-0006). **[N-57, G3/G6]** Baseline = pilihan B (Tabel IV): permintaan juga memuat `nik`, `nama`, dan `account_number` (opsional, bisa kosong); `fraud_assessments` baseline menyimpannya (migrasi baseline-only 0003, kolom `nik`, `nama`, `account_number`); skor tidak pernah membacanya. Email dan HP tidak diteruskan. Proposed tidak berubah: field itu ditolak 422.

Respons 200: `{risk_score (dua desimal), decision: "ALLOW"|"HOLD_FOR_VERIFICATION"|"BLOCK", rules_fired: string[], rules_skipped: string[], prior_count}`.

`GET /health`, `GET /metrics` sesuai `platform-dan-ci.md`.

## 4. Algoritma (PRD 10)

1. `riwayat` = semua baris `fraud_assessments` dengan `pseudonym` sama, `assessed_at DESC`; `prior_count` = jumlahnya. (Jendela 30 hari muncul dari umur token, bukan dari filter waktu.)
2. `AMOUNT_OVER_THRESHOLD`: `amount ≥ FRAUD_AMOUNT_THRESHOLD` → bobot 10.
3. `ODD_HOUR_OUTSIDE_06_22`: `tx_hour` di luar [`FRAUD_ODD_HOUR_END`, `FRAUD_ODD_HOUR_START`) → bobot 20 (jam 22..23 dan 0..5 terpicu; 6..21 tidak).
4. `prior_count = 0` (cold start): `AMOUNT_OVER_3X_AVG` dan `NEW_LOCATION_VS_LAST_3` masuk `rules_skipped`. Selain itu: `AMOUNT_OVER_3X_AVG` bila `amount > 3,00 × rata-rata amount seluruh riwayat` → bobot 25; `NEW_LOCATION_VS_LAST_3` bila `geohash` tidak ada di tiga geohash asesmen terbaru → bobot 20.
5. Keputusan: `ALLOW` bila skor < `FRAUD_HOLD_THRESHOLD` (50); `HOLD_FOR_VERIFICATION` bila 50..89; `BLOCK` bila ≥ `FRAUD_BLOCK_THRESHOLD` (90). Ambang ini dan ambang uang/jam berasal dari env, bukan literal (aturan proyek); `FRAUD_HOLD_THRESHOLD` dan `FRAUD_BLOCK_THRESHOLD` adalah env baru **[K-20]**. `FRAUD_HISTORY_DAYS` (wajib, bilangan bulat ≥ 1; nilai kerja 30) membatasi riwayat di SQL pada kedua mode (`assessed_at >= now - FRAUD_HISTORY_DAYS`) **[N-45]**.
6. Bobot dan pengali (3,00) dibaca dari tabel `risk_rules` (`rule`, `parameter`, `weight`, `active`); aturan `active=false` dilewati dan dicatat di `rules_skipped`. `FRAUD_AMOUNT_THRESHOLD` dan jam tetap dari env (parameter di `risk_rules` dipakai untuk pengali dan bobot saja, **[K-20]**).
7. `INSERT` satu baris `fraud_assessments (pseudonym, amount, tx_hour, geohash, prior_count, avg_prior_amount, risk_score, decision, rules_fired)` per penilaian; `avg_prior_amount` NULL bila cold start. **[M4-04]** `assessed_at` diisi dari `Clock` yang disuntik (bukan `now()` basis data) agar tes tidak bergantung pada waktu nyata; urutan riwayat `assessed_at DESC, id DESC`.

Skor maksimum dengan bobot sekarang adalah 75 sehingga `BLOCK` tidak dapat tercapai (PRD 20 no. 13): pengujian hanya mencakup `ALLOW` dan `HOLD_FOR_VERIFICATION`; pemetaan `BLOCK` diuji pada unit `RiskEngine` dengan skor yang disuntik.

## 5. Invarian dan kasus gagal

Tidak ada identitas dan tidak ada `transaction_id` di tabel; token milik layanan lain tidak dipercaya (Fraud tidak memvalidasi token ke Privacy; ia hanya menerima pseudonim FRAUD_DETECTION dari Transaction). Dua penilaian paralel pada token yang sama keduanya ditulis (append-only). Basis data tidak tersedia: 503 (Transaction mengubahnya menjadi `HELD` `FRAUD_UNAVAILABLE`).

## 6. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M4-04 | `RiskEngine`: contoh PRD (skor 10, lalu 75 = 10+25+20+20), cold start dengan dua aturan terlewat, batas ambang (tepat 1.000.000), batas jam (05:59, 06:00, 21:59, 22:00), skor maks 75, pemetaan `BLOCK` via unit | FR-37, TF-03, TF-12, C-07 |
| M4-04 | asesmen kedua memakai riwayat dan `prior_count` 1; tabel tanpa kolom identitas dan `transaction_id` (inspeksi skema); fraud-db tidak dapat di-join ke transaction-db lewat pseudonim | FR-18, US-04, S-71 |
| M4-04 | validasi: field tak dikenal, `tx_hour` di luar 0..23, `geohash` tidak valid → 422; pemanggil selain `TRANSACTION` → 403 | S-40 |
| M5-01 | adapter baseline: suite perilaku yang sama lulus | FR-23 |

## 7. Di luar cakupan

Model ML, profil di luar riwayat asesmen, peninjauan analis (ada di Transaction), pembobotan dinamis, aturan tambahan agar `BLOCK` dapat tercapai.

## 8. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-20 env baru `FRAUD_HOLD_THRESHOLD`/`FRAUD_BLOCK_THRESHOLD`, pembagian sumber parameter antara env dan `risk_rules`, dan pembacaan `risk_rules` saat runtime dengan `active=false` dilewati (PRD 11 menyediakan kolom `active` tetapi tidak menetapkan perilakunya).
