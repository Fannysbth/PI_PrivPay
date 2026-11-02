# Kinerja (M7): hanya uji KESIAPAN, tidak ada hasil resmi

**Berkas di sini BUKAN pengukuran resmi dan tidak boleh dikutip ke laporan skripsi** (ADR-0004: tidak ada angka latensi atau throughput dari lingkungan lokal; lingkungan ukur akhir belum diputuskan, lihat `docs/OPEN_QUESTIONS.md`). Tujuannya hanya menjawab: apakah harness berjalan, apakah tumpukan stabil di bawah beban, dan seberapa jauh laptop ini dapat dibawa.

- `kesiapan/vu<N>-run-<NN>-<mode>.json`: satu run k6 (campuran 70/30 lewat Kong), tanpa pemanasan resmi, 60 detik, `official: false` di `meta`. `meta.treeClean` bernilai `false` bila pohon kerja belum di-commit saat run (benar untuk semua berkas ini: dijalankan sebelum commit harness); run resmi menolak mengklaim sebaliknya (`scripts/perf/run.cjs`).
- `resmi/` (belum ada): hanya diisi `pnpm perf:run --official` (100 pengguna, 60 detik pemanasan, 300 detik, 5 pengulangan berselang-seling, tumpukan segar per run) pada lingkungan ukur yang sudah diputuskan dan pohon bersih.

Isi tiap berkas: `meta` (commit, mode, tanggal, parameter beban, citra k6 terpin, versi citra tiap kontainer, memori bebas host sebelum dan terendah, target Prometheus sebelum/sesudah), `k6` (latensi rata-rata/p50/p90/p95/p99/maks, throughput, galat, hanya fase `measure` dan hanya permintaan ke Kong; penghitung status pembayaran semua fase), dan `resources` (CPU rata-rata dan memori puncak per kontainer dari cAdvisor lewat Prometheus, jendela = fase ukur).

Batas baca: beban closed-loop (pengguna berikutnya menunggu jawaban), pembangkit beban dan 17 kontainer berbagi satu VM WSL 6 GB / 4 prosesor, batas CPU 0,5 per layanan, Keycloak di mesin yang sama. Pengguna dibuat sebelum beban (`setup`), tidak diukur.
