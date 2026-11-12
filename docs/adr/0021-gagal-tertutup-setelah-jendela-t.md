# ADR-0021: Klaim gagal-tertutup menjadi "tertutup setelah jendela T" bagi token yang tersimpan

- Status: Accepted (disetujui Fanny, 2026-11-12). Berlaku bersama ADR-0020; belum ada kode.
- Tanggal: 2026-11-12
- Pengambil keputusan: Fanny
- Terkait: invarian 8, D-09, TK-16, NFR-19, FR-13, ADR-0019, ADR-0020, N-63

## Konteks

Invarian 8: Privacy Service mati berarti gagal tertutup (503), tanpa fallback ke data mentah. Cache token (ADR-0020) membuat sebagian permintaan tidak menyentuh Privacy Service. Klaim "setiap permintaan gagal saat Privacy mati" tidak lagi benar secara harfiah; klaim yang benar harus dituliskan, bukan dibiarkan diam-diam.

## Opsi yang dipertimbangkan

1. Pertahankan klaim lama dan tanpa cache: paling kuat, tidak ada perbaikan kinerja.
2. Klaim baru yang jujur (dipilih): tidak pernah ada fallback ke data mentah; permintaan dengan token tersimpan dapat lolos paling lama T detik setelah Privacy mati; sisanya 503 langsung.
3. Menyembunyikan perbedaan: ditolak, bertentangan dengan standar penelitian.

## Keputusan

1. Invarian 8 dirumuskan ulang: **tidak ada fallback ke data mentah; gagal tertutup langsung untuk cache dingin; untuk token yang sedang tersimpan, tertutup paling lama T detik setelah Privacy tidak dapat dijangkau.** Yang lolos selama jendela itu hanya pemakaian token yang sudah diterbitkan dan belum kedaluwarsa, bukan penerbitan atau pembukaan identitas baru.
2. Pencabutan oleh admin langsung ke Privacy tertunda paling lama T pada cache. T dari env (`TOKEN_CACHE_TTL_SECONDS`, bawaan 5; ADR-0020).
3. Pemakaian dari cache tidak menulis baris audit di Privacy. KPI audit dipersempit: "100% operasi di Privacy Service tercatat", bukan "100% pemakaian token tercatat".
4. Operasi sensitif tidak memakai cache: de-pseudonymize, pembukaan identitas, penerbitan pertama, dan pencabutan selalu ke Privacy.
5. Hal ini ditulis di naskah sebagai keterbatasan, dengan T dan dasar nilainya.

## Konsekuensi

- Positif: klaim keamanan sesuai kenyataan; kinerja dapat diperbaiki tanpa menyembunyikan harganya.
- Negatif / utang: TK-16 perlu varian (dingin 503; hangat lolos sampai T; sesudah T 503); PRD NFR-19 dan teks D-09 perlu erata (PRD_ERRATA) saat tahap C dikerjakan.
- Dampak pada keamanan dan privasi: jendela terbuka paling lama T detik, hanya untuk token yang sudah sah; tidak ada data mentah yang keluar.
- Dampak pada pengujian: lihat ADR-0020; kriteria fail-closed tetap diuji dengan Docker di kedua keadaan (dingin dan hangat).
- Yang harus diubah: CLAUDE.md invarian 8 (butuh persetujuan Fanny saat kode siap), spec, PRD_ERRATA, `DOKUMENTASI_SISTEM.md`, naskah.

## Bukti

Belum ada; menyusul bersama implementasi ADR-0020.

## Kapan ditinjau ulang

Sama dengan ADR-0020, atau bila ada kebutuhan pencabutan seketika yang tidak dapat menunggu T.
