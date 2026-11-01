# PrivPay

Prototipe e-wallet berarsitektur microservices untuk skripsi: Privacy-by-Design dengan pseudonimisasi dinamis. Ini artefak penelitian, bukan produk produksi. Dua mode pembanding, `baseline` dan `proposed` (ADR-0003), dijalankan di atas kode yang sama.

## Struktur

| Folder | Isi |
| --- | --- |
| `services/` | Gateway, Auth, Privacy Service, Transaction, Fraud, Notification, Reconciliation, serta simulator bank dan SMS |
| `packages/common` | Tipe, error, logger berredaksi, klien HTTP, dan skema zod bersama |
| `tools/dev-idp` | Penerbit JWT tiruan untuk fase lokal |
| `tests/` | Tes fungsional, keamanan, pemindai PII, dan kinerja |
| `deploy/` | Konfigurasi Compose, Kong, Keycloak, Prometheus |
| `scripts/` | Skrip pengembangan, basis data, dan Docker |
| `docs/` | PRD ringkas, keputusan desain, ADR, spesifikasi, panduan, dan checklist keamanan/QA |

Bacalah `docs/panduan/` untuk peta besar sistem, `SECURITY.md` untuk kebijakan keamanan, dan `docs/adr/` untuk keputusan arsitektur.

## Memulai

Butuh Node 24 (`.nvmrc`), pnpm lewat corepack, dan PostgreSQL lokal. Bila `pnpm` tidak ada di PATH, pakai `corepack pnpm <perintah>`.

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration     # butuh PostgreSQL lokal (scripts/db/bootstrap.ps1 sekali)
pnpm dev:keys             # tiga kunci Privacy ke secrets/
pnpm dev:up               # nyalakan semua proses lokal
```

Rahasia (kunci, kata sandi) hanya dibaca dari berkas lewat variabel `<NAME>_FILE`; lihat `secrets/README.md`. Isi `secrets/` tidak pernah masuk git. Semua data uji fiktif.

## Catatan

- Mode hanya `baseline` dan `proposed`.
- Angka kinerja dari lingkungan lokal tidak dipakai sebagai hasil penelitian.
- Referensi hukum dan makalah di dokumen sumber belum diverifikasi penuh; cek sumber aslinya sebelum dikutip.
