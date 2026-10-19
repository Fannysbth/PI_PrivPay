# PROMPT_TAMBAHAN.md — tempel SETELAH prompt utama

Tempel blok ini sebagai pesan kedua (atau gabungkan ke bawah prompt utama sebelum dikirim). Isinya keputusan Fanny per 19 Oktober 2026 yang sudah dicatat di `docs/DESIGN_DECISIONS.md` (D-25 sampai D-28), `docs/adr/0003-hanya-dua-kondisi-pembanding.md`, dan `docs/OPEN_QUESTIONS.md` bagian C.

~~~~text
Tambahan keputusan dari Fanny (menang atas teks lain bila bertabrakan; catat sebagai ADR bila belum):

1. LINGKUNGAN. Tahap awal dikerjakan LOKAL TANPA DOCKER. Docker dan Kong menyusul setelah M4 stabil. Konsekuensinya, di Fase 1 usulkan dan catat lewat ADR:
   - PostgreSQL 16 terpasang lokal, satu database per layanan, dengan peran DB yang sama seperti PRD (privacy_app, auditor_role) supaya hak akses tetap diuji nyata. Tes integrasi memakai database khusus tes di PostgreSQL lokal, bukan Testcontainers.
   - Gateway sementara berupa gateway-adapter (layanan NestJS tipis) dengan perilaku tokenisasi identik dengan plugin Kong: JWT divalidasi, customer_id dan rekening ditokenkan, NIK/nama/email dibuang, 503 saat Privacy Service mati, rate limit per akun. Plugin Kong (Lua) dikerjakan setelah Docker tersedia; jaga agar logika tokenisasi berada di modul yang bisa dipakai ulang.
   - Keycloak dijalankan standalone bila bisa; bila tidak, penerbit JWT tiruan khusus dev (ditandai jelas, tidak boleh terbawa ke mode lain) dengan klaim, peran, dan masa berlaku yang sama.
   - Semua layanan berkonfigurasi lewat env dan tanpa asumsi path/host lokal, supaya mudah dikontainerisasi nanti. Kunci dan kata sandi dev tetap lewat berkas di secrets/ atau env runtime, tidak pernah di-commit.
   - Kriteria yang butuh Docker (NFR-19 docker compose bersih, uji fail-closed dengan mematikan replika, dan seluruh pengukuran performa M7) DITUNDA, tercatat sebagai utang terjadwal di tiket, bukan dianggap selesai. Jangan menyatakan kriteria itu lulus selama belum diuji.
   - Sesuaikan milestone M0 dan M1 dan gerbang CI: e2e berbasis compose belum aktif; lint, typecheck, unit, integrasi, audit dependensi, dan pemindaian secret tetap wajib.

2. DUA KONDISI SAJA. Mode hanya baseline dan proposed. Jangan implementasikan mode static dan jangan bahas varian statis di kode atau tes. Uji penautan membandingkan baseline vs proposed. (ADR-0003)

3. AUDIT DI DALAM PRIVACY SERVICE. Tetap sebagai modul, bukan layanan terpisah.

4. RANTAI HASH AUDIT: hanya dirancang. Pertahankan kolom prev_hash dan row_hash (nullable) di skema, tulis rancangan singkat di spec (rujukan: Schneier dan Kelsey 1999; Crosby dan Wallach 2009, belum diverifikasi), jangan implementasikan.

5. TABEL 1 (7 konteks) DAN TABEL 2 (2 pertukaran) FINAL. Jangan menambah layanan, purpose, atau pertukaran. Fokus proyek adalah keamanan, bukan kelengkapan fitur microservices: bila ada godaan menambah fitur, tolak dan catat sebagai di luar cakupan.

6. PENGUKURAN PAPARAN. Metrik utama E(s) per layanan. Rincian per kelas data (umum, spesifik) dihitung juga sebagai bukti pendukung dan dilaporkan terpisah.

7. RETENSI 90 hari dan JENDELA 30 hari di Fraud diterima; tetap parameter lewat env, bukan literal.

8. Daftar E-01 sampai E-09 dan Q-01 sampai Q-15 di docs/OPEN_QUESTIONS.md: pakai "usulan bawaan" sebagai titik awal, tetapi tetap tanyakan padaku saat /grill-me dan /grill-with-docs sebelum menjadikannya Accepted. Q-03 sudah terjawab (tidak berlaku).

Tetap berlaku semua gerbang dan aturan di prompt utama. Konfirmasi dengan satu paragraf bagaimana kamu menerapkan butir 1 sampai 8, lalu lanjutkan Fase 0.
~~~~
