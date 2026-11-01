# Panduan memahami PrivPay

Panduan ini ditulis untuk pemilik skripsi yang perlu **menjelaskan dan mempertahankan** sistem ini, termasuk bagian yang belum ditulisnya sendiri. Pembaca yang dituju paham dasar pemrograman, tetapi baru di microservices, pseudonimisasi, dan pola ports-and-adapters. Istilah teknis dan nama kode tetap berbahasa Inggris.

Semua klaim tentang perilaku kode dilacak ke berkas nyata (path ditulis dari akar repo). Bila sebuah klaim belum diperiksa langsung ke kode atau belum pernah dijalankan, ia ditandai **belum diverifikasi**. Nilai pada contoh selalu fiktif.

| Berkas                                                           | Isi                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [00-peta-besar.md](00-peta-besar.md)                             | Gambaran sistem, diagram, tanggung jawab layanan, apa yang hanya ada di satu mode    |
| [01-menjalankan-sistem.md](01-menjalankan-sistem.md)             | Jalur lokal tanpa Docker (sudah dijalankan sungguhan); jalur Docker Compose ada di [`docs/postman/README.md`](../postman/README.md) |
| [02-layanan.md](02-layanan.md)                                   | Tiap layanan dan `packages/common`: tugas, endpoint, tabel, port/adapter, urutan baca |
| [03-alur-end-to-end.md](03-alur-end-to-end.md)                   | Registrasi, transaksi, fraud, pembukaan identitas, revocation, retensi, rekonsiliasi  |
| [04-keamanan.md](04-keamanan.md)                                 | Kunci, enkripsi, blind index, gerbang, audit, dan apa yang sengaja tidak dilakukan    |
| [05-mode-baseline-proposed.md](05-mode-baseline-proposed.md)     | Dua mode: apa yang sama, apa yang beda, apa yang diukur                              |
| [06-pengujian.md](06-pengujian.md)                               | Jenis tes, cara menjalankan, mutasi, kontrol positif, membaca hasil gerbang           |
| [07-glosarium.md](07-glosarium.md)                               | Istilah dan singkatan                                                                |
| [08-batasan-dan-pertanyaan-dosen.md](08-batasan-dan-pertanyaan-dosen.md) | Keterbatasan jujur dan 25 pertanyaan dosen beserta jawabannya                |
| [09-jalur-belajar.md](09-jalur-belajar.md)                       | Rencana membaca kode selama lima hari, dengan latihan kecil                           |

Urutan yang disarankan: 00, 07 (sebagai kamus, dibuka kapan saja), 01, 02, 03, 04, 05, 06, lalu 08. Bab 09 dipakai berdampingan dengan 02 sampai 06.

## Sumber kebenaran

Panduan ini merangkum dan tidak menggantikan dokumen berikut. Bila ada selisih, dokumen ini yang menang, lalu panduan diperbarui:

1. [`docs/DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md) dan ADR di [`docs/adr/`](../adr/).
2. [`docs/PRD_RINGKAS.md`](../PRD_RINGKAS.md) (dan PRD lengkap di [`docs/reference/`](../reference/PRD_PrivPay_v2.4_lengkap.md)).
3. [`docs/spec/`](../spec/) dan [`docs/tickets/`](../tickets/).

Catatan: beberapa tautan di dokumen repo ini (`docs/HANDOFF.md`, `docs/OPEN_QUESTIONS.md`, `docs/tickets/`, `docs/RETRO_*.md`, dan berkas aturan kerja) menunjuk ke catatan kerja lokal penulis yang tidak termasuk repo; di klon baru berkas itu tidak ada dan tautannya putus. Isi yang penting sudah dirangkum di ADR (`docs/adr/`), spek (`docs/spec/`), dan panduan ini.

Status panduan: ditulis pada 2026-10-23 terhadap `main` setelah penutup M5 (gerbang hijau satu putaran, lihat [`docs/HANDOFF.md`](../HANDOFF.md)).
