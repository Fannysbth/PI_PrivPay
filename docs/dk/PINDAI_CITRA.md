# Pindai citra DK (hadolint dan Trivy)

Tanggal: 2026-10-24. Alat dijalankan sebagai kontainer sekali pakai dengan tag tertentu (`hadolint/hadolint:v2.12.0`, `aquasec/trivy:0.58.1`, DB kerentanan unduhan hari itu), citra dipindai dari berkas `docker save` (tanpa memasang soket Docker), lalu citra alat dan cache dihapus.

## hadolint (`deploy/docker/Dockerfile`)

Dua peringatan DL3006 ("tag citra tidak eksplisit") adalah positif palsu: tag dan digest dipin di `ARG NODE_IMAGE`, yang tidak bisa di-resolve hadolint. Ditandai `# hadolint ignore=DL3006` dengan alasan di atasnya. Hasil akhir: kode keluar 0.

## Trivy (HIGH dan CRITICAL, kerentanan)

Sembilan citra layanan (`privpay-*:dk01a`) memberi hasil identik karena semuanya berbasis `node:24.22.1-bookworm-slim`:

| Temuan | Jumlah | Tindakan |
| --- | --- | --- |
| Paket npm bawaan citra dasar (`/usr/local/lib/node_modules/npm`: brace-expansion, undici, http-cache-semantics) | 5 HIGH (4 punya versi perbaikan) | **Diperbaiki**: tahap runtime menghapus npm dan npx (tidak dipakai; perintah jalan adalah `node dist/main.js`). Dipindai ulang pada `privacy-service`: 0 temuan lang-pkgs |
| Paket OS Debian 12.15 (util-linux, libsystemd0, ncurses, gzip, perl-base, dan lain-lain) | 56 HIGH + 1 CRITICAL (zlib1g CVE-2023-45853) | **Dicatat, tidak diperbaiki**: tak satu pun punya versi perbaikan di Debian 12 (`FixedVersion` kosong). Tidak ada tag patch yang lebih baru untuk dipin |

`postgres:16.15` (digest di Compose; 16.15 adalah tag 16.x terbaru di Docker Hub per 2026-10-24): 62 temuan OS tanpa perbaikan (1 CRITICAL libxml2 CVE-2026-6653) dan 26 temuan pada pustaka standar Go biner `gosu` bawaan citra resmi (1 CRITICAL, semua punya perbaikan hanya dengan membangun ulang `gosu`). **Dicatat, tidak dapat diperbaiki di sisi proyek**: perbaikannya menunggu citra resmi berikutnya. Konteks: lingkungan lokal tertutup, `gosu` hanya dipakai entrypoint saat start untuk melepas hak root, PostgreSQL tidak dipublikasikan keluar jaringan `internal`.

Pindai ulang dilakukan lagi pada tiket yang mengubah citra (DK-03, DK-02).
