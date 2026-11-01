# Tinjauan keamanan DK-04c (2026-11-01)

Lingkup: `git diff e5f4ce6..HEAD` (token per audiens, kata sandi per kelas, rahasia klien `admin-console`, `KC_LOG_LEVEL`). Ditinjau langsung (skill `/security-review` gagal mengambil diff otomatis karena `origin/HEAD` menunjuk ke remote GitHub yang belum punya referensi). Tidak ada temuan High atau Medium baru.

| # | Tingkat | Temuan | Status |
| --- | --- | --- | --- |
| 1 | Low | Klien dapat meminta dua scope `aud-*` sekaligus dan Keycloak menerbitkan token lebar | Diterima: `authenticate()` menolaknya di semua layanan (tes `DK-04c two audiences asked at once`); mutasi membuktikan tes gagal tanpa pemeriksaan |
| 2 | Low | Satu kata sandi kelas nasabah dipakai semua nasabah (seed dan hasil `/register`) | Fixture uji (ADR-0017 butir 5); pemegangnya (Gateway) hanya dapat masuk di klien `customer-app`, token nasabah hanya diterima Gateway |
| 3 | Low | Kontainer sekali jalan `keycloak-realm` memuat semua kata sandi dan rahasia klien | Pola lama (render lalu keluar, `restart: no`); berkas realm 0644 tercatat di ADR-0017 |
| 4 | Info | Kontainer `smoke` memegang kata sandi analis dan rahasia `admin-console` | Hanya profil `smoke`, sekali jalan, tidak ikut `up` |
| 5 | Terbuka | `idp-admin` dapat mengatur ulang kata sandi admin (tidak dapat dibatasi di Keycloak 26.4) | Keterbatasan diterima Fanny (opsi 3); Gateway tepercaya sebagai asumsi prototipe; ADR-0017 |
| 6 | Info | `customer_id` kandidat di query pencarian Admin API | Diterima Fanny; `KC_LOG_LEVEL=info` + tes membaca log |
