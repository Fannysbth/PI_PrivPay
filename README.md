# privpay-starter

Bahan pemandu untuk membangun PrivPay dari nol bersama Claude Code. Folder ini bisa disalin utuh ke root repo baru. Tidak ada kode aplikasi di sini.

## Cara pakai

1. Salin isi folder ini ke root repo baru, `git init`, commit pertama.
2. `pre-commit install` bila memakai pre-commit (lihat `.pre-commit-config.yaml`), lalu buat secret lokal sesuai `secrets/README.md` dan `cp .env.example .env` (belum perlu sebelum M0).
3. Buka Claude Code di root repo, mulai dengan plan mode, tempel blok prompt dari `PROMPT_AWAL.md`. Claude membaca dokumen, lalu bekerja per fase dan berhenti di setiap gerbang menunggu kata "lanjut" darimu.
4. Jawab pertanyaan `/grill-me` dan `/grill-with-docs` dengan teliti: di situlah daftar di `docs/OPEN_QUESTIONS.md` diselesaikan (termasuk kontradiksi kecil di PRD v2.4 yang sudah kutandai).

## Isi

| Berkas | Fungsi |
| --- | --- |
| `PROMPT_AWAL.md` | Prompt utama, urutan skill, gerbang, tabel kapan memakai tiap skill |
| `CLAUDE.md` | Aturan kerja permanen untuk repo (stack, perintah, konvensi, larangan, definisi selesai) |
| `SECURITY.md` | Kebijakan keamanan: aset, secret, validasi, rate limit, audit tanpa PII, rantai pasok |
| `docs/PRD_RINGKAS.md` | Ringkasan PRD v2.4 untuk kerja harian |
| `docs/DESIGN_DECISIONS.md` | Keputusan FINAL (audit berpseudonim, pembukaan bersyarat dua pihak, sekali pakai 10 menit, atribut minimal, dst.) |
| `docs/CONTEXT.md` | Glosarium; dipelihara oleh `/grill-with-docs` |
| `docs/OPEN_QUESTIONS.md` | Kontradiksi PRD dan keputusan yang belum ada, dengan usulan bawaan |
| `docs/adr/` | Template ADR, ADR-0001 (cara mencatat), ADR-0002 (stack, status Proposed) |
| `docs/security/` | Model ancaman (LINDDUN, STRIDE, OWASP API Top 10, ASVS) dan checklist keamanan |
| `docs/qa/qa-checklist.md` | Checklist QA dan penanganan error |
| `docs/reference/` | PRD lengkap v2.4, teks Bab Metodologi v8, gambar arsitektur (bahan rujukan, jangan diubah) |
| `.github/` | Rancangan CI (lint, tes, SAST, audit dependensi, Trivy, hadolint, e2e), Dependabot, template PR |
| `.pre-commit-config.yaml`, `.gitleaks.toml`, `.gitignore`, `.env.example`, `.editorconfig` | Konfigurasi dasar |
| `.claude/settings.json` | Izin: menolak membaca `.env` dan `secrets/`, meminta konfirmasi sebelum `git push` |
| `services/`, `packages/`, `tests/`, `deploy/`, `scripts/`, `prototypes/` | Kerangka folder awal (isinya `.gitkeep`) |

## Catatan

- Yang bertanda "usulan" (monorepo pnpm, tanpa ORM, Jest, dsb.) belum final; dikonfirmasi lewat `/grill-me` dan dicatat di ADR-0002.
- PRD lengkap tidak diubah. Selisih yang ditemukan dicatat di `docs/OPEN_QUESTIONS.md` bagian A; Claude Code akan menulis usulan koreksi di `docs/PRD_ERRATA.md`.
- Versi aksi GitHub, rev pre-commit, dan image perlu dipin ulang saat M0 (tertulis di komentar berkas).
- Referensi hukum dan makalah di dokumen sumber belum diverifikasi penuh; jangan dikutip dari repo ini ke naskah tanpa mengecek sumber aslinya.
