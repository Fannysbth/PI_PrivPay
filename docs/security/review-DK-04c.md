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

## Tambahan (2026-11-01, diff `4d86c8f..HEAD`, ditinjau langsung karena skill gagal mengambil diff)

| # | Tingkat | Temuan | Status |
| --- | --- | --- | --- |
| 7 | Info | Pengecualian `.gitleaksignore` (izin tertulis Fanny): tiga sidik jari riwayat lama (`PSEU-8F29A7C1` fiktif dua kali, UUID contoh RFC 4122 sekali), tiap entri diberi komentar berkas, baris, commit, alasan | Sempit (commit:berkas:aturan:baris, tanpa jalur/aturan/regex). Bukti: `gitleaks --all` keluar 0; satu temuan sintetis baru pada HEAD terlepas membuatnya keluar 1 (1 temuan); kembali ke cabang: keluar 0. Aturan dicatat di CLAUDE.md |
| 8 | Info | Smoke Compose kini lewat Kong (`https://kong:8443`) dengan CA tumpukan (`NODE_EXTRA_CA_CERTS`), token IdP asli, tanpa mematikan verifikasi TLS; menambah `tls_ca_crt` (sertifikat publik, bukan rahasia) dan `depends_on: kong` | Tidak ada permukaan baru: Kong sudah di jaringan `business`; tes statis melarang `NODE_TLS_REJECT_UNAUTHORIZED` di `smoke.cjs` |
| 9 | Low | Hook pre-commit tidak terpasang di mesin ini (`.git/hooks` hanya berisi contoh): commit sintetis bernilai acak tidak dihalangi | Perlindungan lokal hanya gerbang manual (`secret-scan:tree`, `gitleaks --all`) dan CI; `pre-commit install` tidak dijalankan (mengubah lingkungan pengembang), keputusan Fanny |
| 10 | Info | Commit sintetis `88fbdde` (nilai acak palsu) tertinggal sebagai objek tak terjangkau di basis objek lokal | Tidak ada ref yang menunjuknya, tidak ikut `--all`, tidak ikut push; hilang saat `git gc` |

