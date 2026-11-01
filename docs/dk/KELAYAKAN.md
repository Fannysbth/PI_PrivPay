# Kelayakan fase Docker (DK-01 sampai DK-06)

Tanggal: 2026-10-24. Sifat: pengukuran dan rencana. Tidak ada berkas Docker, Compose, atau konfigurasi Kong yang di-commit, dan DK-01 belum dimulai. Dasar: `docs/tickets/DK-01..06`, `docs/spec/platform-dan-ci.md` (bagian 12, 14, 16), `docs/spec/gateway-tokenizer.md` 11, `docs/spec/pengujian-dan-pengukuran.md` 7 dan 8, `docs/spec/data-dan-migrasi.md` 11, ADR-0004, `docs/reference/Bab_Metodologi_v8_teks.txt`.

**Catatan sumber:** yang ada di repo adalah Bab Metodologi **v8**; berkas v9 yang disebut dalam permintaan tidak ada di `docs/reference/`. Butir Docker pada v8 (Kong plugin Lua, Keycloak, Docker Compose, `PRIVACY_MODE` di Compose, batas CPU dan memori sama untuk kedua konfigurasi, satu VPS) sudah dipakai di sini; bila v9 berbeda, laporan ini perlu dibaca ulang terhadapnya.

**Lingkungan pengukuran laptop (keputusan Fanny, 2026-11-01):** WSL 2 dibatasi 6 GB (`memory=6GB`, `processors=4`, `swap=2GB` di `.wslconfig`). Semua angka memori di dokumen ini dan di HANDOFF diambil dengan batas itu; dengan 4 GB tumpukan penuh bersama Keycloak hanya menyisakan 0,59 GB bebas dan berhenti.

**Batas klaim:** semua angka di bawah adalah memori mesin pengembangan ini. Tidak ada angka latensi atau throughput, dan tidak boleh dikutip ke laporan skripsi (ADR-0004, aturan proyek).

## 1. Lingkungan terukur

| Butir | Nilai |
| --- | --- |
| Mesin | AMD Ryzen 7 8845HS, 16 prosesor logis, RAM 14141 MB, Windows 11 Home 10.0.26200, disk D: bebas 208,8 GB |
| Docker Desktop | 4.96.3; engine 29.9.2; Compose v5.6.1; Buildx v0.38.1; konteks `desktop-linux`, backend WSL2 |
| Batas WSL2 (`%USERPROFILE%\.wslconfig`) | `memory=4GB`, `processors=4`, `swap=2GB`; engine melaporkan `MemTotal` 4107522048 byte, 4 CPU |
| Citra Kong | `kong:3.9.4` (resmi Docker Hub `library/kong`), digest `sha256:aa4a4687b1330e427ad0d3b27a0606b833894297c78abf1a212edc9ba73c8620`, lisensi **Apache-2.0** (repo `Kong/kong`, berkas `LICENSE`), 528 MB terurai (120 MB terkompresi di Docker Hub). Tag terbaru yang tampak di Docker Hub dan rilis GitHub adalah 3.9.4; tidak ada 3.10 di antara 40 tag terbaru |
| Citra PostgreSQL | `postgres:16.15` (Debian 16.15-1.pgdg13+2), lisensi PostgreSQL License, 636 MB terurai |
| PostgreSQL lokal | 18.6 di localhost:5432 (server yang sama juga memuat basis data lain di luar PrivPay: terlihat dua basis data dengan ekstensi TimescaleDB milik proyek lain; tidak disentuh) |
| Sisa Docker sebelum sesi | hanya citra `hello-world:latest`; tidak ada kontainer, volume, atau jaringan buatan |

Docker Desktop **sudah menyala** saat sesi dimulai, jadi angka "sebelum Docker" tidak dapat diambil begitu saja. Karena tidak ada kontainer yang berjalan dan kedua distro WSL berstatus Stopped, Docker Desktop dihentikan dengan `docker desktop stop`, mesin virtual WSL dimatikan dengan `wsl --shutdown`, M1 diukur, lalu Docker Desktop dinyalakan lagi (dibiarkan menyala di akhir sesi, seperti keadaan awal).

## 2. Angka

Cara ukur (`mem.ps1` sementara, sudah dihapus): tiga sampel berjarak 3 detik, nilai median; "bebas" dari `Win32_OperatingSystem.FreePhysicalMemory`, "tersedia" dari `Win32_PerfFormattedData_PerfOS_Memory.AvailableMBytes`. Tiap titik diambil 60 detik sesudah komponen siap (M2 diulang 2 menit sesudah siap; selisih 46 MB).

| # | Keadaan | Bebas (MB) | Selisih dari titik sebelumnya (MB) | Catatan terukur |
| --- | --- | --- | --- | --- |
| M1 | tanpa Docker, tanpa VM WSL | 6928 | | proses terkait Docker/WSL tersisa 34 MB; PostgreSQL 18 lokal 406 MB |
| M2 | Docker Desktop menganggur | 4695 (4649 pada sampel pertama) | -2233 | proses Docker Desktop dan backend 2431 MB working set, termasuk `vmmemWSL` 1536 MB |
| M3 | + satu kontainer Kong 3.9.4 DB-less | 3786 | -909 | kontainer sendiri 302,8 MiB (CPU 0,6%, 5 proses); sisanya cache VM dan pembongkaran citra |
| M4 | + PostgreSQL 16.15 menganggur | 3049 | -737 | kontainer sendiri 31,5 MiB; `data_checksums=off`, `max_connections=100`, `shared_buffers=128MB`, `scram-sha-256` |
| M5 | + sembilan layanan Node lewat `dev:up` (proposed) di Windows, Kong dan PG16 tetap menyala | 2686 | -363 | sembilan proses layanan 44 sampai 69 MB masing-masing (total node 706 MB bersama peluncur); `vmmemWSL` naik ke 3180 MB; sembilan `/health` 200 |
| akhir | sesudah semua dibersihkan, Docker Desktop tetap menyala | 4283 | | VM WSL tidak mengembalikan cache: 2,6 GB pulih dari ±4,2 GB yang diambil, sisanya baru kembali setelah `wsl --shutdown` |

Bacaan angka:

1. Ongkos tetap Docker Desktop pada mesin ini ±2,2 GB bebas (M1 ke M2), sebelum satu kontainer pun. Dengan Docker menyala, memori bebas **tidak pernah di atas 4,7 GB**, jadi ambang "di bawah 5 GB berhenti dan laporkan" di Langkah 0 permintaan dan di pelajaran retro M3 selalu terpenuhi selama Docker menyala (lihat pertanyaan terbuka 1).
2. Penurunan "bebas" jauh lebih besar daripada pemakaian kontainer (Kong 303 MiB menurunkan bebas 909 MB; PG16 32 MiB menurunkan 737 MB). Penyebabnya VM WSL yang membesar karena cache berkas dan citra sampai mendekati batas 4 GB di `.wslconfig` (`vmmemWSL` 1536 menjadi 3180 MB), bukan kebutuhan proses. Ini batas atas yang nyata: Docker Desktop plus VM bisa menyedot ±4,5 GB dari 14 GB walau isinya kecil.
3. Layanan Node hasil build kecil saat menganggur (44 sampai 69 MB). Ini belum memuat beban k6 dan belum memuat Keycloak, Prometheus, dan Grafana, yang **tidak diukur** di sesi ini (tidak ada citranya dan bukan bagian permintaan); angkanya harus diambil di awal DK-04 dan pada pasang Prometheus/Grafana, sebelum dipercaya muat dalam 4 GB.
4. Kong DB-less berjalan dengan konfigurasi deklaratif minimal (satu service, satu route ke hulu palsu), membalas 502 seperti yang diharapkan; admin API dimatikan; port diikat ke 127.0.0.1. Plugin kustom belum diuji.

Pembersihan yang dilakukan: kontainer `privpay-dk-kong` dan `privpay-dk-pg16` (dengan volume anonim), citra `kong:3.9.4` dan `postgres:16.15`, folder rahasia sementara (rahasia klien dev-idp dan tiga kunci Privacy acak, dibuat di folder scratchpad lewat `--secrets-dir`, bukan di `secrets/`), `.dev-run` (log `dev:up` hari ini), skrip ukur dan skrip diagnostik. Tidak dihapus: citra `hello-world:latest` (sudah ada sebelum sesi). `docker ps -a`, `docker volume ls`, dan `docker builder prune` sesudahnya kosong.

## 3. PostgreSQL 16 (DK-05) dibanding 18.6 lokal

Terukur pada `postgres:16.15`: `gen_random_uuid()` ada, `scram-sha-256`, `data_checksums=off`.

| Aspek | Temuan | Dampak pada migrasi dan tes |
| --- | --- | --- |
| Isi migrasi | pencarian di seluruh `*.sql`: satu-satunya fungsi bergantung versi adalah `gen_random_uuid()` (inti sejak PostgreSQL 13); tidak ada `uuidv7`, kolom `VIRTUAL`, `RETURNING OLD/NEW`, `MERGE`, `JSON_TABLE`, atau `WITHOUT OVERLAPS` | migrasi seharusnya jalan di 16 tanpa perubahan; **tidak dibuktikan** sesi ini (migrasi belum dijalankan di 16, itu pekerjaan DK-05) |
| `bootstrap.sql` | memakai `CREATEROLE`, `SET ROLE`, dan keanggotaan dengan opsi `ADMIN`/`INHERIT`/`SET` | semantik peran PostgreSQL 16 dan 17 dan 18 sama pada hal ini (ADR-0004 butir 4 sudah mencatat perilaku 16+); tes `pg_auth_members` memakai kolom `inherit_option`/`set_option` yang ada sejak 16. Perlu dijalankan sebagai bootstrap dua kali di 16 |
| `DROP DATABASE … WITH (FORCE)`, `pg_stat_activity`, `starts_with` | ada di 16 | `test-db-cleanup` tetap berlaku; kerentanannya terhadap kecepatan (pool idle 10 detik) tidak bergantung versi, lihat `docs/HANDOFF.md` |
| Rencana kueri | tes NFR-04 "tanpa `Seq Scan`" pada 20.000 baris (`schema.integration`, `token-service`, `token-forms`) bergantung pada perencana; perencana 18 berbeda dari 16 | tes ini paling mungkin berbeda hasil; periksa lebih dulu di DK-05 |
| `initdb` | `data_checksums=off` di 16.15 terukur; ketentuan bawaan 18 (checksum hidup) dari pengetahuan umum, tidak diukur di server lokal | tidak memengaruhi skema; catat sebagai perbedaan lingkungan |
| Kolasi dan zona waktu | server lokal Windows dan citra Debian tidak diukur kolasinya | **hipotesis, belum diperiksa**: urutan `ORDER BY` teks dan kasus huruf pada kolasi berbeda dapat mengubah tes yang bergantung urutan string; periksa `SHOW lc_collate` kedua sisi di awal DK-05 |
| Port | PostgreSQL lokal memakai 5432 | kontainer 16 dipublikasikan ke 127.0.0.1 pada port lain (mis. 15432) dan diarahkan lewat `PG_PORT` di `.env.test` |

## 4. Rekomendasi: hibrida dulu, penuh untuk gerbang akhir

**Hibrida (Kong, Keycloak, dan satu PostgreSQL 16 di Docker; sembilan layanan Node tetap di host) sebagai cara kerja harian; Compose penuh dibuat di DK-01 tetapi dijalankan hanya di gerbang yang memang menuntutnya, satu proses pada satu waktu dengan aplikasi lain ditutup.**

Alasan dari angka:

- Compose penuh pada akhirnya wajib: DK-01 ("seluruh sistem lewat satu `docker compose up`"), DK-03 (tiga jaringan hanya bermakna bila semua layanan di dalamnya), DK-06 (NFR-19 dari mesin bersih), dan pengukuran M7 hanya sah pada konfigurasi final. Jadi hibrida bukan tujuan akhir.
- Biaya tetap Docker 2,2 GB bebas (M2) dan VM WSL yang melebar sampai batas 4 GB (M5: 3180 MB) membuat bebas tinggal ±2,7 GB dengan sembilan layanan di host, Kong, dan satu PG16. Memindahkan sembilan layanan ke kontainer tidak menghemat memori host: memorinya pindah ke dalam VM yang sudah dibatasi 4 GB, jadi hasilnya serupa, ditambah beban 5 instans PostgreSQL (aturan proyek: satu instans per layanan; 32 MiB menganggur tiap instans, belum di bawah beban) dan Keycloak yang belum diukur.
- Menaikkan `.wslconfig` melewati 4 GB mengorbankan Windows pada mesin 14 GB (bebas M1 hanya 6,9 GB), jadi tidak disarankan.
- Hibrida membuat DK-02 (Lua), DK-05 (PG16), dan sebagian DK-04 dapat dikerjakan tanpa seluruh tumpukan menyala, sehingga siklus uji lebih pendek dan jauh dari ambang memori.
- Pengukuran kinerja (k6) dan klaim NFR-19 tidak diambil di laptop ini (ADR-0004; metodologi: satu VPS, batas sumber daya sama).

Yang menggugurkan rekomendasi bila terukur lain: bila pada awal DK-01 seluruh tumpukan (5 PG16, 9 layanan, Kong, Keycloak, Prometheus, Grafana) menganggur di bawah ±2,5 GB di dalam VM 4 GB, Compose penuh dapat dipakai sehari-hari.

## 5. Rencana pecahan sesi DK

Urutan mengikuti kolom "Bergantung pada" di tiket. Tiap sesi: satu tiket, satu cabang, satu PR kecil, `/tdd` dan `/code-review`, gerbang terarah di bawah, `gitleaks` tanpa allowlist baru, dan pembersihan Docker sesudahnya. Sebelum DK apa pun: `test-db-cleanup` sudah dijelaskan dan hijau tanpa bergantung kecepatan (syarat N-52).

| Sesi | Isi | Gerbang | Putaran penuh |
| --- | --- | --- | --- |
| DK-00 (prasyarat, bukan Docker) | perbaikan tes `test-db-cleanup` (butuh persetujuanmu, lihat HANDOFF); keputusan ambang memori (pertanyaan 1) | lint, typecheck, suite itu sendirian dijalankan berulang di kondisi sisa database ada dan tidak ada | tidak |
| DK-01a | `Dockerfile` per layanan (multi-stage, `pnpm deploy --prod`, non-root, tanpa rahasia di lapisan), Compose dengan rahasia Docker, `cap_drop: [ALL]`, `no-new-privileges`; satu PG16 per layanan; belum Kong | `docker compose config` tanpa peringatan; hadolint; Trivy citra; pemindaian `docker history` tanpa rahasia (NFR-22, TK-18); `docker compose up` sehat 9/9 sekali; pengukuran memori seluruh tumpukan dicatat | tidak (satu `up` penuh) |
| DK-05 | PostgreSQL 16 di kontainer dan bootstrap dua kali; seluruh integrasi dan keamanan di 16; catat hasil di ADR-0004 | **satu putaran penuh integrasi + keamanan di 16**, plus unit, audit, gitleaks, pii-scan | ya, satu (di 16) |
| DK-03 | tiga jaringan `edge`/`business`/`privacy`; CA dev dan TLS Gateway ke Privacy (menyentuh `packages/common`: butuh kepemilikan tiketnya; klien HTTP perlu CA tepercaya dari berkas); uji konektivitas dan sertifikat | tes jaringan (hanya Kong dan layanan bisnis menjangkau Privacy), uji sertifikat, kasus negatif TLS | tidak, tetapi tumpukan penuh menyala |
| DK-02 | plugin Kong `privacy-tokenizer` (Lua), paritas vektor kontrak M2-11, 503 tertutup, `luacheck`; keputusan Q-10 (Lua atau `gateway-adapter` permanen) dicatat; hibrida cukup | vektor kontrak yang sama dengan adapter, `luacheck` bersih, uji gagal tertutup 503 | tidak |
| DK-04 | Keycloak: realm, klien, pemetaan klaim `azp`, `aud`, peran, `customer_id`; masa berlaku ≤ 5 menit; tes `authenticate` (M1-02) tanpa perubahan terhadap Keycloak | tes M1-02 terhadap Keycloak, AZ negatif; ukur memori Keycloak dan basisnya | tidak |
| DK-06 | NFR-19 dari mesin bersih (R-01), fail-closed dengan Privacy dimatikan di Compose, job e2e CI diaktifkan | uji mesin bersih, Newman dan `pii-scan` kedua mode lewat Compose | **ya, dua berturut-turut** (penutup DK) |

Catatan urutan dan ketergantungan:

- DK-06 bergantung pada **M6-04**, dan DK-02/pengukuran bergantung pada M6 (Newman M6-01). M6 belum dikerjakan. DK-06 tidak dapat ditutup sebelum M6-01 dan M6-04 ada; DK-01 sampai DK-05 tidak bergantung padanya.
- "Dua putaran penuh hijau berturut-turut" dijalankan sesudah semua sesi DK digabung, pada konfigurasi final, bukan per sesi. Tiap putaran sama dengan gerbang lengkap aturan proyek ditambah e2e Compose pada kedua mode. Satu putaran integrasi penuh memakan ±1 jam (3810 detik tercatat), jadi dua putaran berarti dua jendela panjang yang terpisah dari pekerjaan lain, dengan mesin dicegah tidur dan memori diperiksa.
- Putaran penuh pada DK-05 menguji skema di 16 saja; ia tidak menggantikan dua putaran penutup.

## 6. Risiko

| Risiko | Akibat | Mitigasi |
| --- | --- | --- |
| Memori: Docker menyisakan <4,7 GB bebas bahkan menganggur; VM mengambil cache sampai batas | proses dibunuh sistem (pernah tercatat di M5 sesi 1), gerbang gagal palsu | hibrida; satu proses pada satu waktu; `wsl --shutdown` antar sesi; ambang memori diganti untuk sesi Docker |
| Keycloak (JVM), Prometheus, Grafana belum diukur | rencana memori bisa meleset | ukur di awal DK-04 dan DK-01a sebelum bergantung padanya |
| Kong OSS: tag terbaru 3.9.4, tidak ada 3.10 di tag terbaru | tambalan keamanan Kong OSS ke depan tidak pasti | pin ke digest; catat di ADR; tinjau saat DK-02 (Q-10 menyediakan `gateway-adapter` sebagai cadangan permanen) |
| Plugin Lua harus berperilaku sama dengan modul tokenisasi TypeScript (membuang NIK, nama, email; dua panggilan token; 503 tertutup) | selisih perilaku adapter dan plugin (risiko yang sudah dicatat ADR-0004) | paritas lewat vektor kontrak yang sama; tanpa kripto di Lua (kripto tetap hanya `node:crypto` di Privacy) |
| Selisih PostgreSQL 16 vs 18 (rencana kueri, kolasi) | tes yang hijau di 18 merah di 16 | DK-05 lebih awal, sebelum jaringan dan TLS bergantung padanya |
| Windows: akhir baris, mode berkas rahasia diabaikan, jalur `bash` | skrip entrypoint CRLF gagal di Linux; rahasia tampak 0666 | `.gitattributes` LF (sudah), uji dari konteks Linux, rahasia hanya di folder pengguna sendiri |
| Port bentrok (PG lokal 5432, 4000..4010) | kontainer gagal start | publikasi ke 127.0.0.1 pada port lain, dari env |
| Lisensi Docker Desktop | ketentuan penggunaan untuk organisasi berbeda dari penggunaan pribadi/pendidikan | periksa ketentuannya (pertanyaan 4); Docker Engine di VPS tidak terpengaruh |
| Sisa database tes menumpuk (70 sisa setelah satu gerbang) | `createTestDb` melambat, tes `test-db-cleanup` merah | `! corepack pnpm db:test-databases drop` sebelum gerbang |

## 7. Rahasia

- **Tidak ada `.env` di git.** Hanya `.env.example` (nama variabel dan nilai tak rahasia). Berkas `secrets/` tetap di-ignore dan tetap hanya README dan `.gitkeep` di git.
- Konvensi `<NAME>_FILE` yang sudah ada (ADR-0004 butir 8) dipertahankan; di Compose berkas rahasia dipasang sebagai **Docker secret** (`secrets:` tingkat atas dengan `file: ./secrets/<nama>`) pada `/run/secrets/<nama>`, dan env hanya memuat jalurnya (`*_FILE=/run/secrets/<nama>`). Kode pemuatan tidak berubah.
- Pembuatan rahasia lewat skrip yang tidak menimpa dan hanya mencetak nama berkas (perluasan pola `dev:keys` dan `make-secrets`); tidak ada langkah manual yang menyentuh nilai rahasia (DK-06).
- Tidak ada rahasia di citra, `ARG`, `ENV`, atau lapisan: diperiksa dengan `docker history` dan pemindaian citra (TK-18). Rahasia hanya ada pada saat jalan sebagai berkas yang dipasang.
- PostgreSQL: citra resmi mendukung `POSTGRES_PASSWORD_FILE`; kata sandi peran `privpay_*` yang kini dibuat `scripts/db/bootstrap.ps1` perlu padanan di `docker-entrypoint-initdb.d` yang membaca dari rahasia (skema peran dan `REVOKE/GRANT` harus tetap diuji dengan peran asli, DK-05).
- Keycloak: kata sandi admin awal dan rahasia klien dari rahasia Docker; **belum diperiksa** apakah varian `_FILE` didukung versi yang dipilih (pertanyaan 5). Berkas impor realm yang di-commit tidak boleh memuat rahasia klien.
- TLS DK-03: kunci CA dev dan sertifikat dibuat lokal oleh skrip, disimpan di `secrets/`, tidak di-commit.
- Catatan: pada Compose tanpa Swarm, rahasia adalah pemasangan berkas; mode berkas Windows tidak ditegakkan, jadi `secrets/` tetap hanya di folder pengguna sendiri.

## 8. Pertanyaan terbuka (butuh keputusanmu)

1. **Ambang memori.** Aturan "di bawah 5 GB berhenti dan laporkan" tidak mungkin dipenuhi saat Docker menyala (maksimum terukur 4,7 GB). Untuk sesi DK, ambang apa yang berlaku (mis. berhenti di bawah 2,5 GB bebas, ukur ulang sebelum tiap gerbang)?
2. **Hibrida atau penuh sebagai cara kerja harian** (rekomendasi: hibrida; penuh hanya di gerbang yang menuntutnya). Setuju?
3. **Perbaikan tes `test-db-cleanup`** (usulan di HANDOFF: tahan koneksi tidak idle atau `idleTimeoutMillis: 0`). Tes tidak diubah tanpa persetujuanmu.
4. **Lisensi Docker Desktop** untuk penggunaanmu (universitas/pribadi) belum diperiksa; kamu yang paling tahu statusnya.
5. **Versi Keycloak dan `_FILE`.** Versi yang dipilih belum ditetapkan; dukungan `_FILE` untuk kata sandi admin perlu diverifikasi.
6. **Q-10:** Lua atau `gateway-adapter` permanen. Diputuskan di DK-02 sesudah paritas teruji; apakah pengukuran M7 memakai Kong atau adapter harus disebut (ADR-0004).
7. **v9 Metodologi** tidak ada di repo (hanya v8); tolong sediakan bila berbeda dari v8 pada bagian Docker.
8. **VPS:** pengukuran sah hanya di konfigurasi akhir, dan metodologi menyebut satu VPS. Apakah VPS sudah tersedia untuk DK-06 dan M7? Bila tidak, NFR-19 dari "mesin bersih" dilakukan di mesin apa?
9. **Satu PostgreSQL per layanan** (aturan proyek) berarti 5 instans PG16 di Compose; apakah satu instans dengan lima basis data dapat diterima untuk lingkungan Docker, atau tetap lima kontainer?
10. **Syarat penutup DK** (N-52): dua putaran penuh berturut-turut pada konfigurasi final di Compose; konfirmasi bahwa putaran penuh DK-05 (di 16) tidak dihitung salah satunya.
