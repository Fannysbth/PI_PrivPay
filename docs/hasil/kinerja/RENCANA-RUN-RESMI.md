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
1. WSL diatur **7 GB / 8 prosesor** di `.wslconfig` (diubah sendiri; bukan 10 GB), lalu `wsl --shutdown` dan Docker Desktop dinyalakan ulang. Catat nilainya di catatan run (jangan klaim pengukuran sebelum nilai ini tercatat).
2. Tutup aplikasi lain (peramban, IDE, pgAdmin, Postman); tidak ada klien lain ke PostgreSQL lokal.
3. Daya tersambung; mode kinerja Windows (Pengaturan > Daya > Mode daya: Performa terbaik); layar dan tidur dinonaktifkan selama sesi (lompatan jam = mesin tidur; lihat RETRO_M3 butir terakhir).
4. Pohon kerja bersih pada commit yang sama selama sesi (`treeClean` dicek runner), tidak ada `git pull`/checkout selama sesi.
5. `pnpm docker:secrets` sudah pernah dijalankan. **Aturan memori (diperjelas M7-D):** diukur SETELAH Docker Desktop menyala, tepat sebelum build atau menyalakan tumpukan: bebas ≥ 3,5 GB (catat angkanya); berhenti bila < 0,5 GB atau sistem menghentikan proses (runner menulis `aborted-low-memory`). Putaran gerbang penuh tetap dengan Docker mati dan ≥ 5 GB.
6. Mikrobenchmark penerbitan token diulang di pohon bersih (`treeClean: true`) sebelum run resmi; `token-microbench-20261103T011647.json` (`treeClean: false`) ditandai tidak resmi dan tidak dikutip.
7. k6 di laptop kedua (N-61 pilihan A): ikuti `RUNBOOK-dua-mesin.md`; **percobaan kecil dua mesin (10 pengguna, 60 detik, kedua mode, `--remote-k6`) wajib lulus sebelum run resmi.** Run resmi di laptop kedua memakai `PRIVPAY_LAN_IP=<IP-A> pnpm perf:run --official --remote-k6 --peer-ip <IP-B>`; ringkasan k6 kembali lewat unggahan sekali pakai (M7-E; aturan firewall `privpay-m7-upload`, dicabut di pembersihan), salin manual hanya cadangan. Nonaktifkan sementara aturan Docker Desktop (`com.docker.backend.exe`) selama sesi dan aktifkan lagi di pembersihan.
   - **Closed-loop dan RTT:** throughput closed-loop dipengaruhi RTT (tiap pengguna menunggu jawaban). Bandingkan baseline dan usulan hanya dari sesi dan jaringan yang sama; pakai **kabel LAN di laptop B** untuk run resmi; ukur RTT (ping 100 paket, opsional di runbook) dan catat jenis jaringan.
   - Jendela CPU/memori dihitung pada `k6.endedAt`; run dengan `resourcesWindowReliable=false` (selang > 30 detik) tidak dipakai untuk angka sumber daya.
8. Keputusan terbuka sebelum run dianggap resmi: lingkungan ukur akhir (Q-16/N-59) dan tempat k6 (N-61). Run di laptop dengan k6 di VM yang sama melanggar "pembangkit beban dari mesin terpisah" (Metodologi C.5) dan harus dilaporkan sebagai batasan.

## Setelah sesi
Hitung per pengulangan p95 dan throughput, lalu rerata, simpangan baku, dan selang kepercayaan 95% (t, 4 derajat bebas) per Metodologi; kriteria p95 ≤ +20%, throughput ≥ -15%, galat < 1%. Hasil analisis sensitivitas (`deploy/measure/compose.sensitivity*.yml`, CPU 1,00) dilaporkan terpisah dan berlabel, tidak digabung.
