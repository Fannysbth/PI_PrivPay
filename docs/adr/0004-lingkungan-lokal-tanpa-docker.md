# ADR-0004: Fase awal dikerjakan lokal tanpa Docker

- Status: Accepted (prinsip, disetujui Fanny); rincian bertanda "terbuka" dikonfirmasi di Fase 1 (/grill-me)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: D-21, D-22, NFR-19, NFR-22, Q-01, Q-09, Q-10, Q-15, ADR-0002, ADR-0003
- Catatan nomor: ADR-0003 (hanya dua kondisi: baseline dan proposed) berasal dari zip terbaru dan belum ada di repo ini; nomor 0004 dipilih agar tidak bentrok.

## Konteks

Docker belum tersedia di lingkungan kerja. PRD menetapkan Docker Compose, Kong, dan Keycloak sebagai bentuk akhir (PRD 17, D-21, D-22). Fokus proyek adalah keamanan dan bukti, bukan kelengkapan infrastruktur, sehingga fase awal (M0 sampai M4) dikerjakan lokal dan Docker/Kong menyusul setelah M4 stabil. Ini penjadwalan, bukan perubahan stack akhir.

## Keputusan

1. **Basis data.** PostgreSQL 16 terpasang lokal, satu database per layanan, dengan peran DB seperti PRD 11 (`privacy_app`, `auditor_role`, ditambah peran pemilik skema untuk migrasi). Tes integrasi memakai database khusus tes di PostgreSQL lokal, dibuat ulang bersih tiap run; migrasi dijalankan oleh peran pemilik skema; tes terhubung sebagai `privacy_app` / `auditor_role` sungguhan sehingga `REVOKE/GRANT` diuji nyata. Testcontainers dipakai setelah Docker tersedia.
2. **Gateway sementara.** `gateway-adapter` (layanan NestJS tipis) dengan perilaku identik dengan plugin Kong `privacy-tokenizer`: validasi JWT, tokenisasi `customer_id` dan rekening, pembuangan NIK/nama/email, 503 saat Privacy Service mati, rate limit per akun, penyamaran `reason` menjadi `ACCESS_DENIED`. Logika tokenisasi berada di modul terpisah yang dapat dipakai ulang oleh plugin Lua. Plugin Kong dikerjakan setelah Docker tersedia.
3. **JWT.** Java belum terpasang, jadi memakai `tools/dev-idp` (disetujui): penerbit JWT tiruan khusus dev, RS256 dengan JWKS, sehingga `gateway-adapter` dan Privacy Service memvalidasinya lewat JWKS seperti dengan Keycloak. Klaim, peran, dan masa berlaku (access token ≤ 5 menit) sama dengan rancangan Keycloak. Kunci RS256 dibuat saat start dan tidak pernah ditulis ke repo. Menolak start bila `NODE_ENV=production` atau env deploy bukan lokal; setiap token membawa `iss` yang jelas bertuliskan dev. Pengguna dev fiktif di berkas konfigurasi yang jelas palsu, tanpa kata sandi nyata. Keycloak sungguhan masuk di fase Docker bersama Kong. **Utang terjadwal:** pemetaan klaim `dev-idp` ke Keycloak (protocol mapper, atribut pengguna, klien) dicatat di tiket fase Docker.
4. **PostgreSQL (deviasi tercatat, 2026-10-19).** Target akhir tetap PostgreSQL 16 (PRD, D-21). Pada fase lokal dipakai **PostgreSQL 18 di localhost:5432** yang sudah terpasang (Fanny memutuskan tidak memasang 16). Versi, host, dan port tidak dikunci di kode: diambil dari env (`PG_HOST`, `PG_PORT`). Semua objek PrivPay berawalan `privpay_` (database `privpay_privacy`, peran `privpay_privacy_owner`, `privpay_app`, `privpay_auditor`, `privpay_test_admin`), tanpa superuser, dan tidak menyentuh database lain di server itu. Dibuat lewat `scripts/db/bootstrap.ps1` yang dijalankan Fanny; kata sandi admin dibaca skrip dari `.env` lokal (tidak pernah diminta di chat atau dibaca oleh Claude), dan kata sandi peran PrivPay dibangkitkan ke `secrets/` (tidak di-commit). **Keanggotaan admin dicabut setelah bootstrap:** bila akun admin bukan superuser, skrip memberinya keanggotaan `privpay_privacy_owner` hanya selama bootstrap (untuk membuat database milik peran itu dan menjalankan grant skema), lalu mencabutnya di akhir skrip dan mencetak statusnya. `privpay_test_admin` tetap anggota peran pemilik karena harus membuat ulang database uji tiap run. Bila skrip gagal di antara pemberian dan pencabutan, keanggotaan tertinggal sampai skrip dijalankan ulang (idempoten) atau dicabut manual dengan `REVOKE privpay_privacy_owner FROM <admin>`; keanggotaan sisa dari run lama juga dicabut karena peran itu dibuat proyek ini. Perubahan ini belum teruji sampai Fanny menjalankan ulang `scripts/db/bootstrap.ps1` (idempoten) dan hasilnya dilaporkan. **Tes skema** dijalankan di 18 sekarang dan **diulang di 16 saat fase Docker** (utang terjadwal); fitur yang diandalkan (indeks unik parsial, `FOR UPDATE`, `gen_random_uuid()`, enum, `REVOKE/GRANT`) ada di kedua versi.
5. **Zona dan TLS.** Zona kepercayaan (`edge`, `business`, `privacy`) ditulis di spec sebagai aturan siapa boleh memanggil siapa dan ditegakkan di kode lewat allowlist `requesting_service` dari JWT; setiap layanan mengikat ke `127.0.0.1`; database dan peran DB terpisah per layanan. TLS antar-layanan dan tiga jaringan Docker adalah **utang terhadap NFR-06** dan tidak boleh ditulis lulus di laporan mana pun sampai fase Docker.
6. **Plugin Kong (P-1) dan Q-10.** P-1 ditunda ke fase Docker; Q-10 (Lua atau `gateway-adapter` permanen) berstatus DITUNDA. Fase 2 hanya berisi P-2 dan P-3. Modul tokenisasi ditulis bersih dari NestJS agar dapat dipakai plugin Lua atau menjadi cadangan permanen. Pemicu tinjau ulang: Docker tersedia dan P-1 dikerjakan.
7. **Konsol admin dan simulator (Q-05, Q-06).** Konsol admin tidak berupa layanan maupun UI: admin dan auditor adalah klien API berperan `admin` atau `auditor` lewat Gateway (koleksi Postman/Newman dan skrip uji). Bank simulator: layanan NestJS kecil dengan data seed fiktif, mengirim laporan settlement bertoken peran `bank`. SMS simulator: layanan kecil yang merekam pesan di memori; `GET /__test/messages` hanya aktif bila env uji menyalakannya; tidak pernah menulis nomor HP ke log atau disk.
8. **Konfigurasi dan rahasia.** Semua layanan berkonfigurasi lewat env, tanpa asumsi path atau host lokal. Kunci dan kata sandi dibaca dari berkas lewat konvensi `<NAME>_FILE` (path ke berkas di `secrets/`); nilai mentah di env ditolak saat start. Kode pemuatan sama dengan Docker secret nanti. Tidak ada rahasia di git.
9. **Ditunda (utang terjadwal, ditulis di tiket, tidak dianggap lulus):** NFR-19 (`docker compose up` dari mesin bersih), uji fail-closed berbasis compose, plugin Kong, dan seluruh pengukuran performa M7.
10. **Gerbang CI.** lint, typecheck, unit, integrasi, audit dependensi, dan pemindaian secret tetap wajib. Job e2e berbasis compose belum aktif.

## Kriteria validitas pengukuran (wajib dicatat di tiket M7)

- Tidak ada angka latensi/throughput dari lingkungan lokal yang boleh masuk laporan; angka performa M5/M7 hanya sah pada konfigurasi akhir.
- Pengukuran M7 hanya sah pada konfigurasi final yang dijalankan sama untuk baseline dan proposed: gateway yang sama dan batas sumber daya yang sama. Gateway yang dipakai (adapter atau Kong) wajib disebut.
- Hasil E(s) dan tes keamanan di lingkungan lokal sah sebagai bukti kebenaran, bukan sebagai bukti performa.

## Konsekuensi

- Positif: kemajuan M0 sampai M4 tidak menunggu Docker; kode pemuatan rahasia dan konfigurasi tidak berubah saat dikontainerisasi.
- Negatif / utang: perilaku Kong dan isolasi jaringan (tiga jaringan, TLS) belum teruji; ada risiko selisih perilaku adapter dan plugin Lua.
- Dampak pada keamanan dan privasi: hak akses DB tetap diuji dengan peran nyata; port DB lokal tidak boleh terbuka ke luar host (S-07 versi lokal); `secrets/` tetap tidak di-commit.
- Dampak pada pengujian dan pengukuran: lihat kriteria validitas di atas.
- Yang harus diubah: `CLAUDE.md` (Stack, Perintah, Pengujian), `.env.example`, `ci.yml`, `qa-checklist.md` (diperbarui bersamaan dengan ADR ini).

## Kapan ditinjau ulang

Saat Docker tersedia, atau bila `gateway-adapter` menyimpang dari perilaku yang dirancang untuk plugin Kong.
