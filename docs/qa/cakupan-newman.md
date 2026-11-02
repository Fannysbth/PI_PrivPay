# Cakupan koleksi Newman terhadap TF-01..17, TK-01..28 dan Tabel I (M6-01)

Dibuat 2026-11-02 pada `feat/m6`. Koleksi: `docs/postman/privpay-manual.postman_collection.json`, 54 request di koleksi, 156 request dikirim Newman (skrip ikut mengirim pengambilan token). Hasil: usulan 156 request / 133 asersi / 0 gagal; baseline 156 / 119 / 0 (`pnpm newman <mode>`, lewat Kong).

**Batas yang menentukan cakupan.** Newman hanya dapat memanggil rute klien Gateway (`services/gateway/src/routes.ts`). Operasi internal Privacy Service (`/pseudonymize`, `/de-pseudonymize`, `/identity`, penerbitan ulang, tukar token) tidak punya rute klien, jadi tidak dapat dijangkau lewat Kong. Selain itu Gateway hanya menampilkan delapan `code` ke klien (ADR-0008): alasan rinci (`SERVICE_MISMATCH`, `SELF_APPROVAL`, `REQUESTER_MISMATCH`, dan seterusnya) hanya terlihat di audit dan tes lapis layanan. Kasus yang bergantung pada alasan rinci atau pada operasi internal dicatat di bawah sebagai "lapis layanan" (N-37).

Lapis tes selain Newman: **S** = `services/<layanan>/test` dan `test/security` (PostgreSQL asli, `pnpm test:integration`/`test:security`); **G** = `services/gateway/test` dan `test/e2e` (Gateway ke layanan asli); **M** = `tests/measure` (tumpukan Compose, M6-02..04).

## Kasus fungsional (TF)

| ID | Newman | Lapis lain | Status |
| --- | --- | --- | --- |
| TF-01 | 2.1 | S notification, G e2e | tercakup |
| TF-02 | 3.1 | S transaction, notification; G e2e | tercakup |
| TF-03 | 4.2 | S transaction; G e2e | tercakup |
| TF-04 | tidak | S transaction, G e2e | ditunda: token kedaluwarsa di tengah proses butuh jam yang dimajukan; tidak ada rute klien yang memaksanya |
| TF-05 | 5.2 | S reconciliation, G e2e | tercakup |
| TF-06 | 7.4, 7.6 | S reconciliation | tercakup (jejak audit tepat satu SUCCESS dan dua DENIED) |
| TF-07 | tidak | S privacy | tidak terjangkau: `/pseudonymize` internal |
| TF-08 | 3.2, 3.3 | S transaction | tercakup |
| TF-09 | 4.4 | S transaction, G e2e | tercakup |
| TF-10 | 4.3a, 4.3b | S transaction | tercakup (baru) |
| TF-11 | tidak | S transaction, G e2e | ditunda: butuh Fraud dimatikan; belum diukur di Compose (M6-04 menguji Privacy, bukan Fraud) |
| TF-12 | tidak | S fraud | tidak terjangkau: asesmen Fraud internal |
| TF-13 | 5.1 | S bank-simulator, G | tercakup |
| TF-14 | tidak | S privacy (retensi) | tidak terjangkau: job retensi internal, butuh data berumur 90 hari |
| TF-15 | tidak | S privacy | tidak terjangkau: penerbitan ulang internal |
| TF-16 | 5.2 | S reconciliation | tercakup |
| TF-17 | tidak | S transaction, G e2e | ditunda: job pembersih PENDING butuh jam yang dimajukan |

Di Newman: 10 dari 17 (TF-01, 02, 03, 05, 06, 08, 09, 10, 13, 16; TF-05 dan TF-16 memakai request yang sama). Tidak di Newman: 7 (TF-04, 07, 11, 12, 14, 15, 17), semuanya punya tes lapis S atau G.

## Kasus keamanan (TK)

| ID | Newman | Lapis lain | Status |
| --- | --- | --- | --- |
| TK-01 | tidak | S privacy, security | lapis layanan (N-37): pemanggil bukan Gateway; belum teruji end-to-end |
| TK-02 | tidak | S, security; G | lapis layanan dan lapis Gateway lewat Reconciliation (N-37) |
| TK-03 | tidak | S security; G | idem; TTL dan masa tenggang butuh jam |
| TK-04 | tidak | S, security; G | lapis layanan dan Gateway (N-37) |
| TK-05 | tidak | S, security; G | idem |
| TK-06 | tidak | S, security | lapis layanan (N-37) |
| TK-07 | tidak | S, security; common | lapis layanan |
| TK-08 | 9.13a | S, security; G | tercakup di tepi (peran analis ditolak `ACCESS_DENIED`); alasan `FORBIDDEN_ROLE` hanya di lapis S |
| TK-09 | tidak | S, security | lapis layanan (N-37) |
| TK-10 | tidak | S, security | hak akses DB, tidak ada rute klien |
| TK-11 | 9.14 | G | tercakup |
| TK-12 | tidak | G, common | lapis Gateway: perbandingan bentuk respons butuh dua keadaan token |
| TK-13 | tidak | S, security | lapis layanan (N-37) |
| TK-14 | tidak | S, security | lapis layanan (N-37) |
| TK-15 | tidak | S, security | lapis layanan (N-37) |
| TK-16 | tidak | G; M (M6-04) | diuji di Compose oleh M6-04, bukan Newman (butuh Privacy dimatikan) |
| TK-17 | 8.2 sebagian | S; G | sebagian: `revoked_count >= 1` terlihat; "pemakaian setelah pencabutan menghasilkan REVOKED" tidak terlihat dari luar (alasan disamarkan) |
| TK-18 | tidak | tests/repo; gitleaks | pemindaian riwayat, bukan HTTP |
| TK-19 | 9.1, 9.2 | G | tercakup |
| TK-20 | tidak | S privacy | tidak terjangkau: `/identity` internal |
| TK-21 | 7.4 | S, reconciliation | tercakup (atribut `nama` saja) |
| TK-22 | 5.3 | S reconciliation | tercakup |
| TK-23 | 7.1a | S privacy | tercakup (baru): `ACCESS_DENIED`; baris DENIED terlihat di 7.6 |
| TK-24 | tidak | S privacy | tidak terjangkau: pemohon hanya auditor dan penyetuju hanya admin (AZ-10, AZ-11); `SELF_APPROVAL` butuh satu pengguna dengan dua peran. Request 7.2 sebelumnya bertanda TK-24; isinya sebenarnya TK-25 dan sudah dikoreksi |
| TK-25 | 7.2 | S privacy, reconciliation | tercakup (peran auditor menyetujui ditolak) |
| TK-26 | 7.5 | S | sebagian: pemakaian kedua (USED) tercakup; kedaluwarsa 600 detik butuh jam |
| TK-27 | 7.1b, 7.1c | S privacy | sebagian (baru): atribut dan dasar di luar tabel ditolak di Gateway (`VALIDATION_ERROR` 422); `INVALID_BASIS`/`ATTRIBUTE_NOT_ALLOWED` di Privacy tidak terlihat dari luar |
| TK-28 | tidak | S privacy | tidak dijangkau: butuh dua pengguna auditor di realm; menambah pengguna realm di luar lingkup tiket ini |

Di Newman: 10 dari 28 (penuh: TK-08, 11, 19, 21, 22, 23, 25; sebagian: TK-17, 26, 27). Tidak di Newman: 18 (TK-01..07, 09, 10, 12..16, 18, 20, 24, 28), hanya di lapis S/G/M atau tidak dijangkau.

**TF/TK yang masih BELUM TERUJI end-to-end lewat Gateway** (N-37): TK-01, 06, 09, 13, 14, 15. Lapis layanan dan relay jawaban kawat teruji; Gateway tidak punya rute klien untuk pemanggilnya.

## Tabel I (prinsip ke kebutuhan)

| Prinsip | Bukti di Newman | Bukti lain |
| --- | --- | --- |
| Minimisasi data | 3.4 (usulan: `nik`/`nama` dibuang di Gateway), folder 10 (isi tabel layanan, perintah pemeriksaan) | payload scan Docker; M6-02 (E(s)) |
| Pembatasan tujuan | tidak | TK-01, 02, 06, 13, 14 (lapis S) |
| Penyimpanan terbatas | tidak | TF-14, TK-03 (lapis S; butuh jam) |
| Akuntabilitas | 7.6 (jejak audit tanpa nilai nama) | TK-10, pemindai kenari atas `audit_log` |
| Keamanan sejak awal | 7.1..7.5, 7.1a..c, 8.x, 9.x (empat-mata, peran, skema) | TK-20..28 lapis S |

## Keterbatasan pengujian (dicatat, bukan disembunyikan)

1. Newman tidak dapat memanggil operasi internal Privacy; 25 dari 45 kasus TF/TK tidak ada di Newman (7 TF dan 18 TK; lihat tabel).
2. Alasan rinci (`reason`) tidak terlihat dari klien; Newman memeriksa `code` dan bentuk error seragam saja.
3. Kasus yang membutuhkan waktu lewat (TTL, 600 detik, retensi 90 hari, PENDING kedaluwarsa) tidak dijalankan di Newman; Clock palsu hanya ada di lapis S.
4. Newman baseline memeriksa lebih sedikit asersi (rute yang butuh Privacy diharapkan gagal, `>= 400`): itu sifat mode, bukan kekurangan koleksi.
5. Data tumpukan dan log bertahan antar-run; koleksi membuat data unik per run (nomor nasabah acak, kunci idempotensi `{{$guid}}`).
