# Log kerja PrivPay (satu berkas per tanggal)

Catatan **rencana, perubahan, masalah, dan keputusan**, dipecah per tanggal supaya tidak terus memanjang: satu hari satu berkas `YYYY-MM-DD.md` di folder ini. Aturan (permintaan Fanny, 2026-11-11): setiap perencanaan, perubahan, dan masalah dicatat pada hari terjadinya, dengan hash commit bila ada, termasuk kesalahan sendiri. Keputusan arsitektur tetap ditulis sebagai ADR; log menunjuk ke sana. Dokumen sistem yang dirangkum: [../DOKUMENTASI_SISTEM.md](../DOKUMENTASI_SISTEM.md). Serah-terima per tiket: [../HANDOFF.md](../HANDOFF.md).

## Cara menulis

1. Tanggal hari ini sudah punya berkas? Tambahkan ke berkas itu (bagian baru bila topiknya lain). Belum? Buat `YYYY-MM-DD.md` baru.
2. Judul berkas: `# Log kerja YYYY-MM-DD: <topik>`; di bawahnya tautan kembali ke indeks ini.
3. Butir per topik: **Rencana**, **Perubahan**, **Bukti** (perintah dan kode keluar), **Masalah dan penyelesaiannya**, **Keputusan**, **Belum selesai** (hanya yang relevan). Nilai dan angka hanya yang benar-benar diukur.
4. Tambahkan satu baris ke indeks di bawah (terbaru di atas).

## Indeks

| Tanggal | Topik | Berkas |
| --- | --- | --- |
| 2026-11-13 | Gerbang penuh, sisa uji Docker kedua mode, perbaikan tes tak stabil unggah | [2026-11-13.md](2026-11-13.md) |
| 2026-11-12 | Keputusan T, ADR-0020/0021, N-65, gerbang tahap B, pengukuran A+B, utang teknis | [2026-11-12.md](2026-11-12.md) |
| 2026-11-11 | Kinerja v2 tahap A dan B, ADR-0019, dokumentasi hidup, gerbang dan review | [2026-11-11.md](2026-11-11.md) |
