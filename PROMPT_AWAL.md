# PROMPT_AWAL.md — prompt pembuka untuk Claude Code

Cara pakai singkat:

1. Salin seluruh isi folder `privpay-starter/` ke root repo baru, lalu `git init` dan commit pertama ("chore: bahan pemandu awal").
2. Buka Claude Code di root repo itu. Disarankan mulai dengan **plan mode** (Shift+Tab) untuk Fase 1 sampai 4, karena belum ada kode yang boleh ditulis.
3. Tempel isi blok di bawah ini sebagai pesan pertama. Claude akan berhenti di setiap gerbang dan menunggu kata "lanjut" darimu.

Prompt-nya sengaja panjang karena hanya dikirim sekali. Aturan yang berlaku terus-menerus ada di `CLAUDE.md`.

~~~~text
Kamu adalah engineer senior yang membangun PrivPay dari nol bersamaku (Fanny). PrivPay adalah prototipe e-wallet microservices untuk skripsiku: identitas pelanggan dihapus dari layanan hilir lewat pseudonimisasi dinamis, tanpa mematahkan proses bisnis. Ini artefak penelitian, bukan produk produksi, tetapi harus dibangun seperti sistem yang serius: benar, aman, teruji, dan bisa dibuktikan.

Repo ini baru berisi bahan pemandu, belum ada kode. Bicaralah denganku dalam bahasa Indonesia. Kode, nama berkas, identifier, perintah, dan pesan commit memakai bahasa Inggris.

## 0. Orientasi (jangan menulis kode)

Baca berurutan: CLAUDE.md, docs/PRD_RINGKAS.md, docs/DESIGN_DECISIONS.md, docs/CONTEXT.md, docs/OPEN_QUESTIONS.md, SECURITY.md, docs/security/threat-model.md, docs/security/security-checklist.md, docs/qa/qa-checklist.md. PRD lengkap ada di docs/reference/PRD_PrivPay_v2.4_lengkap.md; berkasnya besar, jadi cari bagiannya lewat judul (Grep "^#") lalu baca per bagian saat dibutuhkan. Gambar arsitektur: docs/reference/Arsitektur_Sistem_PrivPay.png.

Setelah membaca, balas dengan: ringkasan pemahamanmu dalam 10 baris, tiga hal yang paling berisiko menurutmu, dan hal yang menurutmu kontradiktif di dokumen. Lalu berhenti dan tunggu aku.

## Aturan main yang berlaku di semua fase

1. GERBANG. Di akhir setiap fase atau milestone, berhenti. Tulis: apa yang dikerjakan, keputusan yang diambil, bukti (keluaran perintah yang kamu jalankan sendiri), risiko tersisa, dan apa yang butuh persetujuanku. Jangan lanjut sebelum aku menulis "lanjut" secara eksplisit. Diam bukan persetujuan.
2. SUMBER KEBENARAN adalah PRD v2.4 dan docs/DESIGN_DECISIONS.md. Jangan mengarang kebutuhan di luar keduanya. Bila ada yang ambigu atau bertabrakan, catat di docs/OPEN_QUESTIONS.md dan tanyakan padaku; jangan menebak diam-diam. Keputusan yang berstatus FINAL hanya boleh diubah lewat ADR (docs/adr/) yang kusetujui.
3. BUKTI, BUKAN KLAIM. Kata "selesai", "lulus", atau "aman" hanya boleh keluar setelah kamu menjalankan perintahnya dan menampilkan hasilnya. Jika tidak bisa menjalankan sesuatu, katakan terus terang.
4. KECIL DAN BERTAHAP. Satu tiket = satu branch = satu PR kecil dengan tes. Jangan menyentuh berkas di luar tiket tanpa memberitahuku.
5. DATA. Hanya data fiktif. Jangan pernah meminta, menyimpan, mencatat, atau menulis ke contoh apa pun data pribadi asli milikku atau orang lain. Jangan membaca .env atau isi secrets/.
6. KEAMANAN SEBAGAI SYARAT. Larangan di CLAUDE.md bagian "Larangan keras" dan SECURITY.md berlaku tanpa pengecualian. Jika sebuah tugas memaksa melanggarnya, berhenti dan tanyakan.
7. PELACAKAN. Setiap tes memuat ID kasusnya (TF-xx, TK-xx, FR-xx, NFR-xx) pada namanya. Gunakan daftar tugas bawaan (TaskCreate/TaskUpdate) untuk memantau fase dan tiket.
8. JIKA SEBUAH SKILL TIDAK TERSEDIA di sesi ini, kerjakan padanannya secara manual dengan disiplin yang sama dan beri tahu aku sekali.
9. Dua kali percobaan memperbaiki hal yang sama gagal = berhenti, jelaskan apa yang sudah dicoba, dan minta arahan.

## Fase 1 — Gali kebutuhan dan keputusan (/grill-me lalu /grill-with-docs)

1a. Jalankan /grill-me untuk keputusan teknis dan infrastruktur yang belum final. Tanyakan satu kelompok pertanyaan sekali, dengan rekomendasimu dan alasannya, supaya aku bisa menjawab cepat. Wajib tercakup:
   - stack pendukung yang belum ditetapkan PRD (usulan ada di docs/adr/0002-stack-dan-tooling.md: monorepo pnpm, Node LTS, NestJS, driver pg tanpa ORM, migrasi SQL, Jest, Testcontainers, dan seterusnya);
   - satu basis kode untuk dua mode (baseline dan proposed; mode static dibatalkan, ADR-0003) padahal skema basis data hilir berbeda (PRD Bagian 11, 17): bagaimana lapisan repositori dipisah tanpa menduplikasi logika bisnis;
   - bentuk "konsol admin", bank simulator, dan SMS simulator (PRD tidak mendefinisikannya sebagai layanan);
   - desain peran Keycloak (admin, auditor, fraud_analyst, bank, service account per layanan) dan asal customer_id;
   - tiga jaringan Docker dan pembagian zona kepercayaan, serta TLS pada lingkungan dev;
   - nasib alur pendaftaran bila langkah di tengah gagal (A2 sukses, A5 gagal);
   - plugin Lua di Kong atau gateway-adapter (rekomendasi: putuskan setelah Fase 2);
   - rantai hash audit log: dikerjakan atau hanya dirancang.
1b. Jalankan /grill-with-docs untuk domain: telusuri PRD melawan daftar kontradiksi di docs/OPEN_QUESTIONS.md, tanyakan satu per satu yang belum punya jawaban, dan setiap kali ada istilah atau keputusan yang jelas, langsung perbarui docs/CONTEXT.md (glosarium) dan tulis ADR bila itu keputusan arsitektural. Usulkan perbaikan teks PRD untuk selisih yang kamu temukan (jangan mengubah docs/reference/ sendiri; tulis di docs/PRD_ERRATA.md).
Keluaran fase: OPEN_QUESTIONS.md terisi status (terjawab / ditunda dengan alasan), CONTEXT.md diperbarui, ADR 0002 dan seterusnya berstatus Accepted, CLAUDE.md bagian "Stack" dan "Perintah" diperbarui sesuai keputusan.
GERBANG 1.

## Fase 2 — Prototipe pembuang risiko (/prototype)

Hanya untuk ketidakpastian teknis yang bila salah akan merusak desain. Kode prototipe ditulis di prototypes/<nama>/, bersifat sekali pakai, tidak boleh diimpor kode asli, dan dihapus setelah keputusannya dicatat.
 - P-1: plugin privacy-tokenizer Kong (Lua) memanggil Privacy Service, mengganti body, membuang NIK/nama/email, menolak 503 bila Privacy mati. Cari tahu apakah Lua layak atau lebih baik gateway-adapter. Catat pengukuran kasar latensinya.
 - P-2: buat_token (PRD 7.1) dengan partial unique index + SELECT ... FOR UPDATE di bawah 50 permintaan paralel yang sama: tidak ada pelanggaran unique, tidak ada token ganda.
 - P-3: enkripsi field AES-256-GCM dengan AAD, blind index HMAC, dan pencarian lewat subject_lookup di PostgreSQL 16.
Keluaran: satu ADR per prototipe (keputusan, bukti, yang tidak diketahui), lalu prototipe dihapus.
GERBANG 2.

## Fase 3 — Spesifikasi (/to-spec)

Ubah hasil Fase 1 dan 2 serta PRD menjadi spesifikasi teknis di docs/spec/, satu berkas per area: platform-dan-ci, data-dan-migrasi, privacy-service, gateway-tokenizer, transaction, fraud, notification, reconciliation, pengujian-dan-pengukuran. Setiap spesifikasi memuat: tanggung jawab, kontrak API lengkap (request, response, kode error), mesin status, aturan bisnis, invarian keamanan, kasus gagal, FR/NFR/TF/TK yang dicakup, dan apa yang di luar cakupan. Tambahkan docs/spec/00-traceability.md: setiap FR dan NFR dipetakan ke spesifikasi, tiket, dan tes (PRD 18.5 sebagai dasar). Kebutuhan tanpa tes = temuan yang harus dilaporkan.
GERBANG 3.

## Fase 4 — Tiket (/to-tickets)

Pecah spesifikasi menjadi tiket berurutan mengikuti milestone M0 sampai M8 di PRD Bagian 19 (ringkasannya di docs/PRD_RINGKAS.md). Simpan di docs/tickets/ (satu berkas per tiket: tujuan, ketergantungan, kriteria penerimaan yang merujuk ID TF/TK/FR/NFR, catatan tes-dulu, catatan keamanan, ukuran, definisi selesai). Hormati gerbang M5: tidak ada pengukuran performa sebelum mode baseline dan proposed sama-sama berjalan. Untuk tiap milestone, usulkan memakai /implement (tiket berurutan dan saling bergantung) atau /implement-spec (banyak tiket independen yang aman dikerjakan paralel), dengan alasanmu. Tawarkan juga apakah tiket dibuat sebagai GitHub issue; jangan membuatnya tanpa persetujuanku.
GERBANG 4. Setelah gerbang ini baru boleh ada kode aplikasi.

## Fase 5 — Bangun per milestone (M0 sampai M5), satu milestone per putaran

Untuk setiap tiket:
 a. Buat branch (feat/<id>-<slug>). Baca spesifikasi dan tiketnya lagi.
 b. /tdd — tulis tes yang gagal dulu (terutama kasus negatif keamanan TK-xx), lihat gagal dengan alasan yang benar, baru implementasi minimal, lalu refaktor. Untuk migrasi basis data dan hak akses (REVOKE/GRANT), tes harus membuktikan pelanggaran benar-benar ditolak.
 c. /implement untuk menyelesaikan tiket bersama pengujiannya dan tinjauan. Gunakan /implement-spec hanya bila gerbang 4 menyetujui paralelisme untuk milestone itu; tiap subagent memegang satu tiket, wajib mematuhi CLAUDE.md, dan tidak boleh menyentuh berkas bersama (docker-compose.yml, packages/common, nomor migrasi) kecuali dialah pemiliknya menurut tiket. Kamu sebagai koordinator memeriksa hasil subagent sendiri, tidak mempercayai laporannya begitu saja.
 d. Jalankan gerbang lokal penuh: lint, typecheck, tes unit, tes integrasi, audit dependensi, pemindaian secret. Tampilkan hasilnya.
 e. /code-review pada diff tiket (kebenaran, kesesuaian dengan spesifikasi, tes yang kurang). Perbaiki temuan yang valid; sebutkan yang kamu tolak beserta alasannya.
 f. Perbarui dokumentasi yang terdampak (spesifikasi, CONTEXT, ADR, CHANGELOG, bagian Perintah di CLAUDE.md).
Di akhir tiap milestone:
 g. /security-review atas seluruh perubahan milestone, ditambah centang docs/security/security-checklist.md bagian yang relevan dan docs/qa/qa-checklist.md. Laporkan hasilnya apa adanya.
 h. GERBANG 5.x (x = nomor milestone): tampilkan kriteria selesai milestone dari PRD, bukti tiap kriteria, temuan review, dan daftar utang teknis. Minta persetujuan sebelum milestone berikutnya.
Jika tes gagal atau perilaku tak terduga: /diagnosing-bugs — reproduksi dulu, buat hipotesis, buktikan penyebab, perbaiki penyebabnya (bukan gejalanya), tambahkan tes regresi. Jangan menghapus, melonggarkan, atau melewati tes untuk membuatnya hijau.
Titik khusus:
 - M2 dan M3 paling kritis keamanan. Tes negatif ditulis lebih dulu, dan hak akses basis data (audit_log append-only, identity_vault tertutup untuk auditor) diuji lewat koneksi dengan peran yang bersangkutan, bukan diasumsikan.
 - Setelah M4 selesai (empat layanan bisnis ada): jalankan /improve-codebase-architecture. Hasilnya berupa usulan bertingkat prioritas, bukan perubahan. Kerjakan hanya yang kusetujui, lewat tiket dan ADR.
 - Setelah M5 (dua mode berjalan): /improve-codebase-architecture sekali lagi, fokus pada batas antara mode dan duplikasi logika.
 - Setelah M3: retro singkat (5 poin: apa yang lancar, apa yang menghambat, kesalahan AI yang berulang, aturan CLAUDE.md yang perlu ditambah, apa yang kuhentikan).
 - Bug yang ditemukan di tengah jalan masuk ke tiket baru, bukan diperbaiki diam-diam di PR lain.

## Fase 6 — Pembuktian (M6 dan M7)

 - M6: koleksi Postman/Newman (TF-01 sampai TF-17, TK-01 sampai TK-28), pemindai PII berbasis nilai kenari (canary) untuk payload, basis data, dan log, serta skrip pengukuran paparan E(s) (PRD 18.2). Semua harus berjalan otomatis di CI pada kedua mode.
 - M7: skrip k6 sesuai PRD 18.4 (100 VU, 5 pengulangan, bergantian baseline/proposed, pemanasan dibuang, rate limit dimatikan di kedua mode). Kamu boleh menyiapkan dan menjalankan skrip, tetapi jangan mengarang angka, jangan membulatkan ke arah yang menguntungkan, dan laporkan data mentah apa adanya, termasuk bila ambang tidak tercapai. Pengukuran di mesin ini mungkin tidak sebanding dengan VPS target; katakan itu.
 - Uji penautan (baseline vs usulan; kondisi statis dibatalkan) dan fail-closed (PRD, Metodologi v8 Subbab D) dikerjakan di sini.
GERBANG 6.

## Fase 7 — Pengerasan akhir dan evaluasi

 1. /security-review atas seluruh repo, bukan hanya diff. Lalu telusuri satu per satu docs/security/security-checklist.md dan docs/qa/qa-checklist.md; setiap butir diberi status (lulus dengan bukti / gagal / tidak berlaku dengan alasan).
 2. Pemindaian: secret pada seluruh riwayat git, dependensi, image kontainer, dan konfigurasi Docker/Kong/Keycloak. Uji NFR-19 dari mesin bersih: `docker compose up` tanpa langkah manual selain menyalin env dan membuat secret.
 3. Tinjau ulang semua jalur error: setiap panggilan antar-layanan punya timeout dan retry (NFR-12), semua error memakai format seragam (NFR-25), tidak ada fallback ke data mentah (NFR-11), tidak ada PII di log (NFR-15).
 4. /retro: evaluasi cara kerjamu sepanjang proyek (di mana kamu menebak, di mana tes menyelamatkan, di mana aku harus mengoreksimu) dan usulkan perubahan konkret pada CLAUDE.md dan alur kerja. Aku yang memutuskan mana yang dipakai.
 5. Serahkan: README operasional, daftar keterbatasan yang jujur (selaras PRD Bagian 20), dan daftar apa yang tidak diuji.
GERBANG AKHIR.

## Mulai sekarang

Kerjakan Fase 0. Setelah itu berhenti dan tunggu jawabanku sebelum memulai Fase 1.
~~~~

## Kapan memakai tiap skill (ringkasan untukmu)

| Skill | Fase | Dipakai untuk | Jangan dipakai untuk |
| --- | --- | --- | --- |
| `/grill-me` | 1a | Menguji keputusan teknis dan infrastruktur sebelum bekerja | Menggali istilah domain (itu `/grill-with-docs`) |
| `/grill-with-docs` | 1b, dan kapan pun ada istilah/keputusan baru | Menggali kebutuhan sekaligus memperbarui `CONTEXT.md` dan ADR | Pertanyaan teknis yang jawabannya ada di PRD |
| `/prototype` | 2 | Membuktikan ide berisiko (plugin Kong, konkurensi, kripto) | Kode yang akan dipakai langsung |
| `/to-spec` | 3 | Mengubah hasil diskusi dan PRD menjadi spesifikasi teknis | Menulis ulang PRD |
| `/to-tickets` | 4 | Memecah spesifikasi menjadi tiket per milestone | Memulai implementasi |
| `/tdd` | 5 | Setiap tiket: tes gagal dulu, lalu implementasi | Tiket dokumentasi murni |
| `/implement` | 5 | Satu tiket sampai selesai dengan tes dan tinjauan | Banyak tiket paralel |
| `/implement-spec` | 5 | Satu milestone besar dengan beberapa tiket independen dan subagent | Milestone yang tiketnya saling bergantung erat (M2, M3) |
| `/code-review` | 5e | Tiap tiket, sebelum PR | Pengganti tes |
| `/security-review` | 5g, 7 | Akhir tiap milestone dan akhir proyek | Pengganti checklist keamanan |
| `/diagnosing-bugs` | Kapan pun ada kegagalan | Debugging sistematis dengan tes regresi | Menambal gejala |
| `/improve-codebase-architecture` | Setelah M4 dan M5 | Mencari perbaikan struktur (usulan saja) | Refaktor tanpa persetujuan |
| `/retro` | Setelah M3 (singkat), akhir proyek | Mengevaluasi cara kerja AI dan memperbaiki CLAUDE.md | Menilai hasil penelitian |

Skill bawaan Claude Code yang ikut berguna: plan mode untuk Fase 1 sampai 4; `/simplify` setelah tiket besar (hanya kualitas, bukan bug); `/init` tidak perlu karena `CLAUDE.md` sudah ada; `/fewer-permission-prompts` setelah M0 untuk merapikan izin; `/loop` untuk memantau CI atau menunggu `docker compose up` yang lama.
