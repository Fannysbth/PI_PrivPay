# Tinjauan keamanan DK-06 (2026-11-01)

Lingkup: `git diff main..HEAD` pada `feat/dk-06` (hook pre-commit gitleaks, tes hook, langkah pemasangan gitleaks di CI, dokumen klon bersih). Ditinjau langsung. Tidak ada temuan High atau Medium.

| # | Tingkat | Temuan | Status |
| --- | --- | --- | --- |
| 1 | Low | Hook dapat dilewati (`git commit --no-verify`, tidak menjalankan `hooks:install`, atau mengarahkan `PRIVPAY_GITLEAKS` ke berkas lain) | Hook adalah lapisan lokal, bukan gerbang; gerbang tetap `secret-scan:tree`, `gitleaks --all`, dan CI. `--no-verify` tetap butuh izin pemilik (aturan proyek). `PRIVPAY_GITLEAKS` hanya dibaca dari lingkungan pengguna sendiri |
| 2 | Info | Gagal tertutup: tanpa gitleaks commit ditolak dengan pesan pemasangan | Terbukti oleh tes (PATH tanpa gitleaks) |
| 3 | Info | Terbukti dengan gitleaks asli: temuan sintetis acak (dibuat saat tes, tidak ditulis di repo) ditolak dan berkas bersih diterima; di klon bersih commit sintetis ditolak (exit 1) | Mutasi hook selalu-lolos -> 2 tes gagal |
| 4 | Info | CI `quality` mengunduh gitleaks | Versi dan SHA-256 sama dengan job `secrets` (terpin, checksum diverifikasi); tanpa rahasia; `tests/repo/ci-workflow.spec.ts` hijau |
| 5 | Info | Klon bersih memuat `secrets/docker/` (rahasia Compose fiktif dan kunci CA/TLS dev) di `D:\privpay-clean`, di-ignore git, tidak terlacak, tidak pernah dibaca | Dihapus bersama klon oleh Fanny (perintah di laporan) |
| 6 | Info | Dokumen kini menyarankan `docker:newman` (kata sandi dibaca dari berkas, tidak muncul di baris perintah) dan memperingatkan bahwa `--env-var` menaruh kata sandi di baris perintah | Dokumentasi |
| 7 | Info | Kontainer dan volume klon bersih dihapus (`down -v`); proyek lain (`samar-prototype-db-1`) tidak disentuh | Diperiksa |
