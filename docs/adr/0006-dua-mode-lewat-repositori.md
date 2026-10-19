# ADR-0006: Dua mode dari satu basis kode lewat repositori

- Status: Accepted (disetujui Fanny)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: D-20, US-09, FR-23, PRD 11 (perbedaan skema baseline), PRD 17, Q-02, ADR-0003

## Konteks

Skema layanan hilir berbeda antara `baseline` (kolom identitas) dan `proposed` (kolom pseudonim), tetapi logika bisnis harus identik: itulah dasar sahnya perbandingan baseline vs proposed.

## Keputusan

1. Tiap layanan bisnis memakai antarmuka repositori; logika bisnis (domain/service) hanya bergantung pada antarmuka itu. Tidak ada percabangan `if (mode)` di logika bisnis.
2. Dua implementasi repositori dipilih saat bootstrap lewat `PRIVACY_MODE` (`baseline` atau `proposed`; tidak ada mode lain, ADR-0003).
3. Migrasi dipisah per mode (`migrations/baseline`, `migrations/proposed`); database tes dibuat ulang untuk tiap mode.
4. Tes arsitektur: gagal bila kode domain mengimpor apa pun dari folder per mode. Diimplementasikan sebagai tes Jest sederhana yang membaca impor, tanpa dependensi baru.
5. Tes kesetaraan perilaku: suite perilaku yang sama dijalankan pada kedua repositori, dan skenario bisnis (TF-02, TF-03, dan seterusnya) dijalankan pada kedua mode. Kasus yang khusus lapisan privasi (TK-xx) hanya berlaku pada `proposed`.
6. Mode `baseline` tidak memanggil Privacy Service, tidak memakai Policy Engine, dan tidak memakai audit (PRD 17).

## Konsekuensi

- Positif: perbedaan hasil pengukuran dapat dikaitkan pada lapisan privasi, bukan pada logika bisnis.
- Negatif / utang: dua set migrasi dan dua implementasi repositori per layanan harus dijaga sinkron; tes kesetaraan menjadi syarat tiap tiket yang menyentuh repositori.
- Dampak pada keamanan dan privasi: kode baseline (yang memegang data mentah) tidak boleh dipakai pada konfigurasi `proposed`; env validasi saat start menolak kombinasi yang tidak konsisten.
- Dampak pada pengujian dan pengukuran: tes kesetaraan menjadi bukti validitas internal M5 dan M7.
- Yang harus diubah: spec `data-dan-migrasi` dan `pengujian-dan-pengukuran`, struktur folder tiap layanan.

## Kapan ditinjau ulang

Bila tes kesetaraan menemukan logika yang terpaksa berbeda antara mode.
