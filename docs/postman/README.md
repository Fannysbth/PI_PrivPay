# Mencoba PrivPay lewat Postman (hanya Docker Compose)

Koleksi ini untuk **mencoba sistem sendiri**: mendaftar nasabah, membayar, melihat transaksi ditahan, rekonsiliasi, sampai pembukaan identitas empat-mata. Semua lewat Gateway di Docker Compose. Tidak ada kode layanan yang diubah. Semua data fiktif dan dibangun saat dijalankan; tidak ada rahasia di berkas ini.

| Berkas | Isi |
| --- | --- |
| `privpay-manual.postman_collection.json` | koleksi: 10 folder, 47 request, tiap request punya Tests yang mencetak yang diharapkan |
| `privpay-proposed.postman_environment.json` | environment mode usulan (Kong di `https://127.0.0.1:4010`) |
| `privpay-baseline.postman_environment.json` | environment mode baseline (Kong di `https://127.0.0.1:4011`) |
| `compose.postman.yml` | override Compose agar Postman (di host) bisa menjangkau Keycloak dan sms-simulator |

## 1. Prasyarat

- Docker Desktop menyala (`docker info` menjawab). Tumpukan penuh (dengan Keycloak, DK-04) butuh batas memori WSL sekitar 6 GB (`.wslconfig`, `memory=6GB`, lalu `wsl --shutdown`); tutup aplikasi berat lain. Dengan batas 4 GB memori bebas laptop turun di bawah 0,6 GB.
- Node 24 (`.nvmrc`) dengan corepack: semua perintah di bawah ditulis `corepack pnpm <perintah>`. `corepack enable` tidak perlu (di Windows butuh hak admin); `corepack pnpm` mengunduh pnpm sekali (butuh internet) dan memasang dependensi otomatis saat skrip pertama dijalankan (±30 detik; langkah `install` terpisah tidak perlu).
- Disk C: dan tempat Docker punya ruang beberapa GB (disk penuh pernah merusak volume PostgreSQL, lihat `docs/HANDOFF.md`).
- Sekali saja, dari akar repo: `corepack pnpm docker:secrets` (membuat rahasia Compose di `secrets/docker/`, tidak menimpa; butuh `openssl`, yang ikut terpasang dengan Git for Windows). Jika folder itu sudah ada, lewati. Isinya fiktif dan tidak pernah masuk git.
- Waktu yang wajar dari klon baru sampai request pertama berhasil: sekitar 5 menit bila lapisan Docker sudah ada di cache (rahasia ±30 detik, `up --wait` ±3 menit, Newman ±30 detik); build pertama di mesin yang belum pernah membangun citra memakan lebih lama (mengunduh citra dasar dan memasang dependensi di dalam citra).
- Hanya bila akan melakukan commit: `corepack pnpm hooks:install` memasang hook pre-commit gitleaks (butuh gitleaks, `winget install Gitleaks.Gitleaks`; tanpa gitleaks commit ditolak).
- Postman (aplikasi desktop atau web dengan agen lokal; **Postman web murni tidak bisa menjangkau 127.0.0.1**).

### Percaya CA dev di Postman (sekali)

Kong melayani TLS dengan sertifikat dari CA pengembangan. Jangan mematikan "SSL certificate verification". Sebagai gantinya:

1. Jalankan `corepack pnpm docker:secrets` sekali lagi bila `secrets/docker/tls_kong.crt` belum ada (hanya menambah pasangan Kong, tidak menimpa yang ada).
2. Postman: **Settings > Certificates > CA certificates**, nyalakan, pilih `secrets/docker/tls_ca.crt`.
3. Sertifikat Kong sah untuk `127.0.0.1`, `localhost`, dan `kong`.

Bila Keycloak dibuat ulang (mis. `--force-recreate keycloak`, atau Compose menilai konfigurasinya berubah karena dijalankan dengan set berkas `-f` yang berbeda), ia mengimpor realm lagi dan membuat kunci baru. Ulangi juga tiga layanan di depannya: `up -d --force-recreate keycloak gateway kong-config kong`. Selalu pakai set `-f` yang sama untuk satu tumpukan.

## 2. Menyalakan dan mematikan Compose

Jalankan dari akar repo. **Satu mode pada satu waktu** (keduanya memakai port 8080 dan 4007).

Mode usulan (dengan Privacy Service), Kong (tepi, TLS) di `https://127.0.0.1:4010`:

```powershell
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.proposed.yml -f docs/postman/compose.postman.yml up -d --wait --build
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.proposed.yml -f docs/postman/compose.postman.yml down -v
```

Mode baseline (tanpa Privacy Service), Kong (tepi, TLS) di `https://127.0.0.1:4011`:

```powershell
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.baseline.yml -f docs/postman/compose.postman.yml up -d --wait --build
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.baseline.yml -f docs/postman/compose.postman.yml down -v
```

- `up --wait` baru kembali setelah semua kontainer sehat (usulan 14 kontainer, baseline 12, ditambah migrasi yang selesai). Build pertama beberapa menit; selanjutnya memakai cache.
- `down -v` mematikan **dan menghapus data** proyek ini saja (volume `privpay-proposed_*` atau `privpay-baseline_*`). Tanpa `-v` data tetap ada untuk dilanjutkan besok.
- Sebelum berpindah mode, matikan dulu mode yang menyala.
- Cek cepat: `curl.exe --ssl-no-revoke --cacert secrets/docker/tls_ca.crt https://127.0.0.1:4010/health` (usulan) atau `:4011` (baseline; `--ssl-no-revoke` hanya karena Windows menanyakan pencabutan sertifikat CA lokal) harus menjawab `{"status":"ok"}`. Lewat Kong `/health` sengaja tidak menyebut mode (N-54b); mode terlihat di request 1.1 koleksi, atau di `/health` adapter dari dalam jaringan (dipakai smoke).

**Tentang `compose.postman.yml`.** Tumpukan resmi hanya mempublikasikan Gateway; Keycloak (penerbit token, DK-04) dan sms-simulator sengaja tertutup di jaringan internal. Postman berjalan di host, jadi berkas ini membuka keduanya **hanya di loopback host**: Keycloak di `127.0.0.1:8080` (password grant dengan kata sandi uji fiktif, hanya untuk mesin pengembang; konsol administrasi tidak punya akun) dan sms-simulator di `127.0.0.1:4007`. Karena itu keduanya ikut jaringan `edge`. Jangan pakai berkas ini di luar laptop pengembangan.

## 3. Impor dan pilih environment

1. Postman: **Import**, pilih ketiga berkas `.json` di folder ini.
2. Pojok kanan atas, pilih environment **privpay-proposed** atau **privpay-baseline** sesuai mode yang menyala. Salah pilih membuat request 1.1 gagal (mode tidak cocok), itu disengaja.
3. Buka **View > Show Postman Console** (Ctrl+Alt+C). Tests mencetak `[Diharapkan] ...` dan angka penting di sana.

Environment berisi `base_url`, `idp_url`, `sms_url`, `mode`, `compose_project`. **Tambahkan sendiri enam variabel bertipe secret** di environment (DK-04c: satu kata sandi per kelas pengguna): `password_nasabah`, `password_admin`, `password_auditor`, `password_analis`, `password_bank`, dan `admin_console_secret` (rahasia klien `admin-console`, wajib untuk password grant admin, auditor, dan analis). Isinya kata sandi uji fiktif yang dibuat `pnpm docker:secrets` di `secrets/docker/keycloak_password_customer`, `_admin`, `_auditor`, `_analyst`, `_bank`, dan `admin-console_client_secret` (berkas itu tidak pernah di-commit dan tidak disalin ke koleksi). Nasabah yang didaftarkan lewat `/register` memakai kata sandi kelas nasabah yang sama (fixture uji: Gateway hanya memegang kelas itu). Token, nilai uji, dan id disimpan otomatis sebagai variabel koleksi (fiktif; token Keycloak berlaku 300 detik dan diperbarui sendiri). Folder 1 (token pertama) memakai password grant ke `{{idp_url}}/realms/privpay/protocol/openid-connect/token`.

## 4. Urutan klik

Jalankan folder **berurutan** dari atas: klik satu per satu, atau **Run collection** (Runner) untuk semuanya. Request di folder 3 dan seterusnya memakai nasabah yang dibuat di folder 2.

| Folder | Yang dicoba | Hasil yang diharapkan |
| --- | --- | --- |
| 1 Ambil token | cek gateway, token analis, auditor, admin, bank | 200; mode gateway sama dengan environment |
| 2 Daftar nasabah | `POST /register`, lalu masuk sebagai nasabah itu | 201 `REGISTERED`; jawaban tanpa isi formulir |
| 3 Transaksi | bayar 35.000; ulangi kunci sama; kunci sama isi beda | 201 `COMPLETED`; 200 id sama; 409 `IDEMPOTENCY_CONFLICT` |
| 4 Fraud | bayar 2.000.000, lalu 8.000.000 dari lokasi baru; analis melihat, menyetujui, mengulang | `HELD` (skor 55); daftar tanpa identitas; 409 `NOT_HELD` |
| 5 Rekonsiliasi | bank kirim laporan, admin `run`, auditor minta token audit | 202 (atau 409 bila laporan hari ini sudah ada); `matched >= 1`; `PSEU-...` |
| 6 Notifikasi | ubah HP; lihat SMS di simulator | "berhasil" dan "sedang diverifikasi" |
| 7 Pembukaan identitas | auditor ajukan, auditor coba setujui sendiri, admin setujui (600 detik), buka, buka lagi, jejak audit | 201; 403; 200 `expires_at` +600 s; 200 atribut `nama`; 403 (sekali pakai); 1 SUCCESS + 1 DENIED |
| 8 Revoke subject | cabut satu token, cabut seluruh subjek | 200 `revoked` ; `revoked_count >= 1` |
| 9 Skenario negatif | tanpa token, token rusak, peran salah, skema salah, rute tak ada, rate limit | 401 / 403 / 422 / 429, semua dengan bentuk error seragam |
| 10 Lihat apa yang dilihat layanan | mencetak perintah `docker exec psql` dan `docker logs` | lihat bagian 5 |

Catatan:

- Pada folder 7 dan 8, di mode usulan, Tests memeriksa nilai nama yang dibuka **tanpa mencetaknya**.
- **9.14 (rate limit) jalankan paling akhir.** Ia mengirim sampai 130 request dengan nasabah seed 103 hingga 429; nasabah itu terblokir sampai menit berikutnya (batas 100 per menit per pemanggil). Peran dan nasabah lain tidak terpengaruh.
- Menjalankan koleksi dua kali pada hari yang sama aman: laporan bank kedua menjawab 409 dan itu diterima.
- Request yang tampak "gagal" di folder 9 (dan 3.3, 4.5, 7.2, 7.5) justru lulus bila ditolak; judul Tests-nya memakai kata "diharapkan".

### Perbedaan di mode baseline

Baseline tidak punya Privacy Service. Hasil yang diharapkan di folder 1 sampai 4, 6, dan 9 sama dengan usulan. Folder yang butuh Privacy (5.3, 7, 8) **gagal dan itu benar**: Tests baseline menegaskan jawaban `>= 400` dan mencatat kodenya. Saat koleksi ini diuji: 5.3 dan 7.4/7.5 menjawab 503, 7.2 menjawab 403 (auditor memang bukan penyetuju), sisanya 500 `INTERNAL_ERROR` (Gateway baseline tidak punya alamat Privacy; ini perilaku sistem saat ini, bukan kegagalan koleksi, dan tidak sama dengan 503 gagal tertutup). Folder 10 menunjukkan perbedaan intinya.

## 5. Folder 10: apa yang tersimpan di layanan

Postman tidak bisa menjalankan `docker exec`, jadi request di sini hanya memanggil `/health` dan **mencetak perintah siap salin di Postman Console**, sudah terisi nilai uji Anda dan nama kontainer mode yang dipilih. Tempel di PowerShell atau Git Bash. Semua perintah hanya membaca, hanya menyentuh objek `privpay_*`, dan menyamarkan nilai sensitif (dua karakter pertama dan terakhir; token `PSEU-` tampil utuh karena bukan data pribadi). Contoh bentuk keluaran (data fiktif):

| Perintah | Mode usulan | Mode baseline |
| --- | --- | --- |
| 10.1 tabel `transactions` | `PSEU-45BBE223`, `PSEU-5B206263` | `CU*******06`, `99******03` (id nasabah dan rekening asli, disamarkan) |
| 10.2 `contact_registry` | kunci `PSEU-...` | kunci `CU*******nn` |
| 10.3 Fraud dan Reconciliation | token berbeda per layanan | `customer_id` dan rekening asli, disamarkan |
| 10.4 `identity_vault` (hanya usulan) | hanya panjang byte dan awal heks (AES-256-GCM); baris kosong = sudah dihapus revoke | basis data ini tidak ada |
| 10.5 log kontainer | 0 kemunculan nilai uji di semua layanan | 0 kemunculan |

Perhatikan bahwa Notification menyimpan nomor HP di kedua mode (ia perlu mengirim SMS); bedanya hanya pada kunci pencariannya (token versus id asli). Perintah 10.5 memakai nilai uji Anda; bentuk umumnya `docker logs privpay-proposed-gateway-1 2>&1 | grep -c -E '<nilai>'`.

## 6. Memantau Grafana dan Prometheus (belum diuji di sesi ini)

Definisinya ada (`deploy/compose/docker-compose.monitoring.yml`, profil `monitoring`) tetapi **belum pernah dijalankan** dan citranya belum diunduh; memorinya belum diukur dan dapat menekan batas WSL 6 GB. Bila ingin mencoba setelah tumpukan menyala:

```powershell
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.proposed.yml -f docs/postman/compose.postman.yml -f deploy/compose/docker-compose.monitoring.yml --profile monitoring up -d
```

- Grafana: `http://127.0.0.1:3000`, pengguna `admin`, kata sandi ada di berkas `secrets/docker/grafana_admin_password` (buka sendiri; jangan ditempel ke chat).
- Prometheus tidak dipublikasikan ke host; ia hanya terjangkau dari Grafana. Tambahkan sumber data Prometheus dengan URL `http://prometheus:9090`. Belum ada dasbor siap pakai; buat panel dari metrik layanan (`/metrics`).
- Mematikannya: tambahkan `--profile monitoring` pada perintah `down` yang sama.

## 7. Bukti otomatis tanpa Postman (Newman, smoke, edge-check)

Semua perintah dijalankan dari akar repo, setelah tumpukan menyala (bagian 2) dengan set berkas `-f` yang sama. Tiap perintah mencetak ringkasan dan keluar dengan kode 0 bila lulus.

| Perintah | Yang dibuktikan | Hasil yang diharapkan |
| --- | --- | --- |
| `corepack pnpm docker:newman proposed` (atau `baseline`) | koleksi Postman dijalankan Newman dalam kontainer sekali pakai di jaringan `edge`, lewat Kong dengan TLS terverifikasi (CA dev) dan kata sandi uji dibaca dari `secrets/docker` | 156 request, 0 gagal; 133 asersi (usulan) atau 119 (baseline). koleksi punya 54 request yang kamu klik; Newman melaporkan 156 karena skrip koleksi ikut mengirim request (mis. pengambilan token) |
| `docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/mode.proposed.yml -f docs/postman/compose.postman.yml run --rm smoke` (ganti `proposed` dengan `baseline`) | daftar, bayar (selesai dan ditahan), daftar ditahan, SMS, dari dalam jaringan, lewat Kong | `9/9 checks passed` |
| `corepack pnpm docker:edge-check proposed base` (fase lain: `claims`, `expiry` ±5 menit, `limits`) | tepi Kong: token rusak atau kedaluwarsa, ukuran, TLS, `/metrics` tertutup | `all checks passed` |
| `PRIVPAY_STACK_MODE=proposed corepack pnpm test:edge tests/docker/fail-closed` | Privacy dimatikan: 503 `SERVICE_UNAVAILABLE`, pulih saat dinyalakan | 1 tes lulus |
| `PRIVPAY_STACK_MODE=proposed corepack pnpm test:edge tests/docker/payload-scan` (`baseline` juga) | tidak ada nilai uji asli di basis data, log, dan payload hilir (usulan); di baseline pemindai wajib menemukannya (kontrol positif) | 3 tes (usulan), 2 tes (baseline) |

Tidak ada dependensi baru: perintah `docker:*` adalah skrip Node biasa di `scripts/docker/` dan Newman berjalan dari citra terpin.

Memakai Newman sendiri dari host (`npx newman`) memang bisa, tetapi butuh dua hal yang tidak ada di perintah polos: sertifikat CA dev (`--ssl-extra-ca-certs secrets/docker/tls_ca.crt`; tanpanya "unable to verify the first certificate") dan enam variabel kata sandi (`--env-var password_nasabah=...` dan seterusnya, bagian 3). Karena kata sandi ikut terlihat di baris perintah, lebih baik pakai `docker:newman`.

## 8. Masalah umum

| Gejala | Penyebab dan jalan keluar |
| --- | --- |
| `Could not send request` / ECONNREFUSED | tumpukan belum menyala atau salah mode; cek `curl.exe --ssl-no-revoke --cacert secrets/docker/tls_ca.crt https://127.0.0.1:4010/health` (usulan) atau `:4011` (baseline) |
| 1.2 gagal 401 atau `Gagal mengambil token ... Keycloak` | salah satu variabel `password_<kelas>` atau `admin_console_secret` kosong atau salah (isi dari `secrets/docker/keycloak_password_*` dan `admin-console_client_secret`), atau Compose dijalankan tanpa `compose.postman.yml` sehingga port 8080 tidak terbuka; matikan lalu naikkan lagi dengan tiga `-f` |
| port 8080 atau 4007 sudah dipakai | mode lain masih menyala, atau proses lokal `pnpm dev:up`; matikan dulu (`dev:down`) |
| 1.1 gagal "mode gateway = environment" | environment yang dipilih tidak sama dengan mode yang menyala |
| "Peran token tidak dikenal atau nasabah belum didaftarkan" | folder 3 atau 4 dijalankan sebelum 2.1 dan 2.2 |
| 5.1 menjawab 409 | normal: satu laporan bank per tanggal; `5.2` tetap memakai laporan yang sudah ada |
| `up --wait` gagal atau `input/output error` saat pull | disk penuh; bebaskan C: dan disk Docker, lihat `docs/HANDOFF.md` (insiden disk) |
| 429 muncul di request biasa | batas 100 per menit per pemanggil terlewati (mis. setelah 9.14 untuk nasabah 103); tunggu menit berikutnya |
| Docker lambat atau kontainer mati sendiri | memori WSL hampir habis (batas 6 GB; tumpukan penuh dengan Keycloak memakai sekitar 3,5 GB); matikan mode lain dan aplikasi berat |
| `docker exec` "No such container" | nama kontainer mengikuti mode (`privpay-proposed-...` atau `privpay-baseline-...`); `docker ps` untuk daftarnya |

## 9. Yang tidak dicakup

- Kinerja (latensi, throughput) tidak diukur dan tidak boleh diklaim dari koleksi ini.
- Fail-closed Privacy Service dengan kontainer dimatikan (NFR-19) tidak ada di koleksi; itu pekerjaan M7.
- Keycloak 26.4.0 mode dev (H2, bukan konfigurasi produksi) adalah IdP tumpukan (ADR-0017). Token akun layanan memuat satu audiens (scope `aud-<layanan>`, DK-04c) dan kata sandi uji terpisah per kelas pengguna; `idp-admin` tidak dapat dibatasi di Keycloak 26.4 (ADR-0017). Kong 3.9.4 sudah di depan `gateway-adapter` (DK-02a): TLS, tanda tangan dan `exp` JWT, batas ukuran, batas laju. Audience, peran, skema, dan tokenisasi tetap di adapter. `/metrics` adapter tidak ditawarkan di Kong; `/health` hanya menjawab status (tanpa mode); pastikan environment sama dengan mode yang dinyalakan.
