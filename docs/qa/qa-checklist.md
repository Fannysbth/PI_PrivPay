# Checklist QA dan penanganan error

Dipakai di akhir tiket (bagian A, B) dan akhir milestone (semua). Isi dengan bukti, bukan centang kosong.

## A. Per tiket

| # | Butir | Bukti |
| --- | --- | --- |
| Q-01 | Setiap kriteria penerimaan punya tes yang namanya memuat ID (TF/TK/FR/NFR) | daftar tes |
| Q-02 | Tes ditulis lebih dulu dan terbukti gagal dengan alasan yang benar sebelum implementasi | log merah lalu hijau |
| Q-03 | Kasus batas dan negatif ada: kosong, terlalu panjang, tipe salah, nilai di luar enum, field tak dikenal, duplikat, urutan terbalik | tes |
| Q-04 | lint, typecheck, unit, integrasi, audit dependensi, pemindaian secret hijau | keluaran |
| Q-05 | Tidak ada tes yang di-skip, `.only`, atau dilonggarkan; tidak ada `any`/`@ts-ignore` baru tanpa alasan | diff |
| Q-06 | Dokumentasi (spec, ADR, CONTEXT, CHANGELOG, bagian Perintah) diperbarui | diff |
| Q-07 | `/code-review` dijalankan; temuan valid diperbaiki; yang ditolak dijelaskan | catatan PR |
| Q-08 | PR kecil, satu tiket, deskripsi: sebelum/sesudah, cara menguji, risiko | PR |

## B. Penanganan error (berlaku untuk tiap layanan)

| # | Aturan | Tes |
| --- | --- | --- |
| E-01 | Satu bentuk error: `{error:{code,reason,message,request_id}}`; ke klien eksternal hanya 401/403/422/429/503/500 serta 409 (`IDEMPOTENCY_CONFLICT`, `NOT_HELD`) dengan `code` yang ditetapkan (ADR-0008) | NFR-25, validasi skema JSON |
| E-02 | Setiap kegagalan antar-layanan berakhir pada perilaku yang ditetapkan PRD 10 "Kebijakan kegagalan antar-layanan" | satu tes per baris tabel |
| E-03 | Timeout 3 detik dan maks 2 retry berbackoff; retry hanya untuk operasi idempoten; ada jitter | uji injeksi keterlambatan |
| E-04 | Tidak ada fallback ke data mentah di jalur mana pun | TK-16 |
| E-05 | Error tak terduga → 500 `INTERNAL_ERROR` tanpa detail; detail masuk log dengan `request_id` (tanpa PII) | tes filter pengecualian |
| E-06 | Pengecualian tidak pernah menelan error diam-diam (`catch {}` kosong dilarang) | lint |
| E-07 | Operasi DB multi-langkah dalam satu transaksi dengan rollback; audit ditulis konsisten dengan hasil | tes integrasi |
| E-08 | Shutdown anggun: menutup koneksi, menyelesaikan request berjalan | tes |
| E-09 | Validasi env saat start: gagal cepat, pesan error tidak memuat nilai secret | tes |
| E-10 | Respons ditolak dan diterima tidak dapat dibedakan lewat waktu secara mencolok untuk pemeriksaan token (best effort) | tinjauan |

## C. Kebenaran perilaku (kasus yang sering salah)

| # | Butir | Tes |
| --- | --- | --- |
| C-01 | `status_efektif`: active, grace tepat di batas, expired tepat di batas | TF-04 + tes batas dengan Clock palsu |
| C-02 | Penerbitan setelah TTL tidak melanggar indeks unik parsial | TF-15 |
| C-03 | Dua permintaan paralel kombinasi sama: satu `reused:false`, satu `reused:true`, satu baris aktif | TF-07 + uji paralel |
| C-04 | Tabrakan nilai pseudonym di-retry sampai berhasil (paksa lewat penyuntikan HMAC) | tes unit |
| C-05 | `re_issue`: transaksi terminal ditolak; token lama jadi expired; token baru berbeda | TF-04, TK-09 |
| C-06 | Retensi: kolom dikosongkan, `chk_purged` terpenuhi, `mapping_id` audit tetap valid, `generate_from_transaction` mengembalikan TOKEN_NOT_FOUND | TF-14 |
| C-07 | Fraud: cold start (dua aturan dilewati), ambang 1.000.000, jam 06–22, skor maks 75, keputusan ALLOW/HOLD | TF-03, TF-12 |
| C-08 | Transaksi: Idempotency-Key sama dan isi sama → 200 sama; isi beda → 409; PENDING melewati batas → FAILED | TF-08, TF-17 |
| C-09 | Pembukaan identitas: status disclosure berpindah PENDING→APPROVED→USED hanya sesuai urutan; transisi ilegal ditolak | TK-21..TK-28 |
| C-10 | Rekonsiliasi: token D2 sama dengan token D3; item tak berpasangan → batch PARTIAL; laporan tak valid → 422 tanpa token terbit | TF-05, TF-13, TF-16 |
| C-11 | Zona waktu: seluruh kontainer UTC; semua stempel waktu ISO 8601 Z | NFR-20 |
| C-12 | Nominal bilangan bulat rupiah; tidak ada float untuk uang | tes unit, tipe `NUMERIC` |

## D. Piramida dan lingkungan uji

- Unit: logika murni (policy_evaluate, status_efektif, pembentukan token, kripto, aturan fraud), cepat, tanpa I/O.
- Integrasi: per layanan dengan PostgreSQL asli; menguji SQL, indeks, hak akses peran.
- Kontrak: skema permintaan/respons antar-layanan dibagi lewat `packages/common`; perubahan skema memecahkan tes kontrak.
- Ujung ke ujung: `docker compose` penuh + Newman (TF, TK) pada kedua mode; pemindai kenari di akhir. Fase lokal (ADR-0004): Newman dan pemindai kenari dijalankan terhadap layanan lokal + `gateway-adapter`; compose menyusul setelah M4.
- Performa: k6 hanya setelah M5, sesuai PRD 18.4. Hasil mentah disimpan; jangan membulatkan.
- Kestabilan: tes yang kadang gagal dianggap bug (diperbaiki atau dikarantina dengan tiket), bukan di-retry.

## E. Siap rilis / serah terima (akhir proyek)

| # | Butir | Bukti |
| --- | --- | --- |
| R-01 | `docker compose up` dari mesin bersih tanpa langkah manual selain env dan secret (DITUNDA sampai Docker tersedia, ADR-0004) | rekaman uji NFR-19 |
| R-02 | Seluruh TF-01..TF-17 dan TK-01..TK-28 lulus pada mode proposed; TF yang berlaku lulus pada baseline | laporan Newman |
| R-03 | Pemindai kenari: nol temuan di log dan audit_log; E(s) sesuai nilai harapan | laporan |
| R-04 | Seluruh `security-checklist.md` berstatus dengan bukti | berkas review |
| R-05 | Traceability: setiap FR/NFR punya tes atau pengukuran (PRD 18.5) | `docs/spec/00-traceability.md` |
| R-06 | Kesalahan dan batasan yang diketahui tercantum jujur (selaras PRD 20) | README |
| R-07 | Angka performa dilaporkan mentah, ada interval kepercayaan, ancaman validitas ditulis | laporan k6 |
| R-08 | Tidak ada TODO/FIXME tanpa tiket; tidak ada kode mati dan prototipe tersisa | grep |
