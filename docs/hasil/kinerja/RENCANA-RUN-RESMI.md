# Rencana run resmi M7 (dokumen rencana; BELUM dijalankan, BUKAN hasil)

Dasar: Metodologi v9 (D.4, D.5, bagian Pengujian Performa), `scripts/perf/run.cjs`, `scripts/perf/plan.cjs`. Batas CPU: 0,5 per layanan, SAMA di kedua mode (keputusan M7-C). Perintah: `pnpm perf:run --official` (menolak opsi lain dan pohon kotor).

## Yang dijalankan
- 100 pengguna konkuren, campuran 70% normal / 30% mencurigakan, lewat Kong, closed-loop.
- Per run: pemanasan 60 detik, lalu 300 detik ukur; tumpukan segar (`down -v`, lalu `up`) dan pengguna dibuat sebelum beban.
- Urutan berselang-seling: baseline, usulan, baseline, usulan, ... (5 pengulangan per mode = 10 run per set).
- Dua skenario sebagai dua set terpisah: `saturation` (tanpa jeda) lalu `realistic` (jeda acak 0,5 sampai 1,5 detik). Total 20 run. Satu pace tidak pernah bercampur dalam satu set.
- Hasil di `docs/hasil/kinerja/resmi/vu100-<pace>-run-NN-<mode>.json`; run yang bukan `ok` menghentikan sesi dan sesi ditandai tidak lengkap.

## Perkiraan durasi (PERKIRAAN, bukan pengukuran)
Per run: tumpukan naik ±2 sampai 4 menit, pembuatan 100 pengguna dan login ±0,5 sampai 1 menit, pemanasan 1 menit, ukur 5 menit, turun ±0,5 menit = ±9 sampai 12 menit. 20 run ≈ **3 sampai 4 jam** tanpa gangguan, ditambah ±10 menit pemeriksaan awal. Ukur durasi nyata di run pertama sebelum menjadwalkan sisanya. Bila tumpukan tidak naik, runner mencoba sekali lagi (15 detik); gagal dua kali menghentikan sesi.

## Prasyarat (tindakan Fanny)
1. WSL diatur 10 GB / 8 prosesor di `.wslconfig` (diubah sendiri), lalu `wsl --shutdown` dan Docker Desktop dinyalakan ulang. Catat nilainya di catatan run (jangan klaim pengukuran sebelum nilai ini tercatat).
2. Tutup aplikasi lain (peramban, IDE, pgAdmin, Postman); tidak ada klien lain ke PostgreSQL lokal.
3. Daya tersambung; mode kinerja Windows (Pengaturan > Daya > Mode daya: Performa terbaik); layar dan tidur dinonaktifkan selama sesi (lompatan jam = mesin tidur; lihat RETRO_M3 butir terakhir).
4. Pohon kerja bersih pada commit yang sama selama sesi (`treeClean` dicek runner), tidak ada `git pull`/checkout selama sesi.
5. `pnpm docker:secrets` sudah pernah dijalankan; memori bebas ≥ 5 GB sebelum menyalakan tumpukan pertama; runner berhenti sendiri bila memori bebas ≤ 0,5 GB (run ditulis `aborted-low-memory`).
6. Keputusan terbuka sebelum run dianggap resmi: lingkungan ukur akhir (Q-16/N-59) dan tempat k6 (N-61). Run di laptop dengan k6 di VM yang sama melanggar "pembangkit beban dari mesin terpisah" (Metodologi C.5) dan harus dilaporkan sebagai batasan.

## Setelah sesi
Hitung per pengulangan p95 dan throughput, lalu rerata, simpangan baku, dan selang kepercayaan 95% (t, 4 derajat bebas) per Metodologi; kriteria p95 ≤ +20%, throughput ≥ -15%, galat < 1%. Hasil analisis sensitivitas (`deploy/measure/compose.sensitivity*.yml`, CPU 1,00) dilaporkan terpisah dan berlabel, tidak digabung.
