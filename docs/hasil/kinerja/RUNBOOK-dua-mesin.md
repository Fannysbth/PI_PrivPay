# Runbook dua mesin: tumpukan di laptop utama (A), k6 di laptop kedua (B)

Keputusan N-61 pilihan A. PERSIAPAN, bukan hasil. Mengikuti Metodologi C.5 ("pembangkit beban dari mesin terpisah"). Yang dibuka ke LAN hanya **Kong (TLS)** dan **Keycloak (HTTP biasa)**, terikat ke SATU alamat LAN laptop A; layanan lain, Grafana, Prometheus, dan cAdvisor tetap loopback atau tanpa port.

## Hasil pemeriksaan issuer (M7-D, 2026-11-03)
- `KC_HOSTNAME=http://keycloak:8080` (alamat penuh) membuat Keycloak selalu menerbitkan `iss=http://keycloak:8080/realms/privpay`, apa pun alamat yang dipakai peminta. Dibuktikan: dokumen discovery diminta lewat IP LAN dan lewat loopback, keduanya `issuer=http://keycloak:8080/realms/privpay`.
- k6 di kontainer tanpa jaringan Compose, memetakan `kong:8443` dan `keycloak:8080` ke IP LAN laptop A (opsi `hosts` k6): 754 pembayaran 201, 0 galat (Kong memverifikasi JWT RS256, adapter memeriksa iss/aud). Tidak ada konfigurasi Keycloak atau ADR-0017 yang diubah.
- TLS tetap diverifikasi: sertifikat Kong memuat `DNS:kong`, jadi k6 memakai nama `kong` (bukan IP) dengan CA proyek; tanpa CA k6 gagal `x509: unknown authority`. Tidak ada `insecureSkipTLSVerify`.

## Sebelum mulai (sekali)
- Kedua laptop satu jaringan, kabel Ethernet lebih baik daripada Wi-Fi; catat jenisnya. Alamat LAN A harus tetap selama sesi (DHCP dapat mengubahnya: periksa ulang).
- Laptop A: `pnpm docker:secrets` sudah pernah dijalankan.
- Salin ke laptop B secara manual (USB atau folder bersama, JANGAN lewat chat atau repositori): `secrets/docker/tls_ca.crt` (sertifikat publik CA dev) dan `secrets/docker/keycloak_password_customer` (kata sandi uji pengguna fiktif; perlakukan sebagai rahasia karena Keycloak terbuka ke LAN). Salin juga `tests/performance/mixed.k6.js`.

## Langkah laptop utama (A)
1. Alamat LAN A (PowerShell): `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' }`. Pilih satu alamat; sebut `<IP-A>`. Alamat laptop B sebut `<IP-B>` (`ipconfig` di B).
2. Firewall (PowerShell **sebagai Administrator**, kamu jalankan sendiri). Satu aturan, hanya dari `<IP-B>`, hanya ke dua port itu:
   ```
   New-NetFirewallRule -DisplayName "privpay-m7-lan" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress <IP-A> -LocalPort 4443,8080 -RemoteAddress <IP-B> -Profile Any
   ```
   Periksa aturan Docker bawaan yang mungkin membuka port ke semua alamat: `Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow | Where-Object { $_.DisplayName -like '*Docker*' }`. Bila ada aturan Docker Desktop untuk `com.docker.backend.exe` pada profil jaringan yang dipakai, port itu terbuka ke seluruh LAN walau aturan di atas ada: nonaktifkan sementara aturan itu (`Disable-NetFirewallRule -DisplayName '<nama>'`), dan aktifkan lagi di langkah pencabutan.
3. Nyalakan tumpukan dengan override LAN (satu mode sekaligus). Percobaan kecil dan run resmi memakai runner: `PRIVPAY_LAN_IP=<IP-A> pnpm perf:run --remote-k6 --only proposed --vus 10 --duration 60s` (opsi lain seperti biasa; `--official --remote-k6` untuk resmi). Runner menolak alamat selain IPv4 privat (bukan `0.0.0.0`, bukan loopback), menyalakan tumpukan segar, **mencetak perintah k6 untuk laptop B**, lalu menunggu `k6-summary.json` disalin ke folder yang dicetak. Port bawaan: Kong 4443, Keycloak 8080 (ubah dengan `KONG_LAN_PORT`, `IDP_LAN_PORT`; aturan firewall harus sama).
4. Setelah `k6-summary.json` disalin ke folder yang dicetak runner, runner membaca CPU dan memori dari Prometheus (dievaluasi saat berkas tiba: salin segera) dan menulis berkas hasil. Mode dan pengulangan berikutnya mengulang dari langkah 3.

## Langkah laptop kedua (B): hanya Docker, citra k6 terpin, salinan skrip
1. Docker Desktop menyala; tidak ada yang lain. Siapkan folder dengan `ca.crt` (dari `tls_ca.crt`), `password` (dari `keycloak_password_customer`), `script\mixed.k6.js`, dan `out\` kosong.
2. Uji jaringan: `ping -n 100 <IP-A>` (catat min/rata-rata/maks dan paket hilang) dan `Test-NetConnection <IP-A> -Port 4443` serta `-Port 8080` (`TcpTestSucceeded: True`).
3. Jalankan **perintah yang dicetak runner** di folder itu (isian `<CA>`, `<PASSWORD-FILE>`, `<SCRIPT-DIR>`, `<OUT-DIR>` diganti jalur mutlak di B). Bentuknya `docker run --rm ... grafana/k6@sha256:... run --quiet -e MODE=... -e KONG_ADDR=<IP-A>:4443 -e IDP_ADDR=<IP-A>:8080 ... /script/mixed.k6.js`; tanpa `--network` (B tidak punya jaringan Compose). Citra k6 sama dengan di A (digest terpin).
4. Salin `out\k6-summary.json` ke folder yang dicetak runner di A. Jangan gunakan satu pun alat lain di B selama run.

## Percobaan kecil sebelum run resmi
10 pengguna, 60 detik, kedua mode (satu mode sekaligus), `--remote-k6`. Lulus bila: 0 galat, semua pembayaran 201, `k6-summary.json` memuat `http_req_blocked`, `http_req_connecting`, `http_req_waiting`, dan ping tanpa paket hilang. Berkas hasil bertanda `official: false`.

## Mencabut akses setelah selesai (wajib)
1. Hentikan tumpukan: runner melakukannya sendiri (`down -v`) kecuali `--keep`. Periksa `docker ps` kosong dan `netstat -ano | findstr "4443 8080"` tidak menunjukkan `<IP-A>`.
2. Cabut aturan: `Remove-NetFirewallRule -DisplayName "privpay-m7-lan"` (Administrator). Aktifkan lagi aturan Docker yang tadi dinonaktifkan: `Enable-NetFirewallRule -DisplayName '<nama>'`.
3. Hapus salinan `password` dan `ca.crt` dari laptop B.

## Data yang dicatat per sesi
Spesifikasi A dan B (CPU, RAM, versi Windows, mode daya, `.wslconfig`: memori 7 GB dan 8 prosesor); jenis jaringan (Ethernet atau Wi-Fi, pita, kecepatan tautan), hasil ping 100 paket, `<IP-A>` TIDAK perlu dicatat di laporan; waktu mulai dan selesai; apakah aturan Docker Desktop dinonaktifkan; versi citra k6 (digest).

## Risiko Keycloak terbuka ke LAN dan cara menutupnya
- **Risiko:** Keycloak melayani HTTP biasa tanpa TLS dan menerima grant password. Siapa pun di LAN yang bisa menjangkau port 8080 dapat mencoba menebak kata sandi pengguna uji `uji.kinerja.*` (fiktif, tanpa data pribadi) dan mengamati token lewat jaringan. Dampak: akses ke API uji dengan data fiktif; tidak ada data pribadi nyata, tetapi tumpukan ini menerima pembayaran uji.
- **Pengurangan:** satu alamat terikat, firewall hanya dari `<IP-B>`, sesi pendek, jaringan pribadi yang dipercaya (bukan Wi-Fi umum), kata sandi uji acak dari `pnpm docker:secrets`.
- **Cara menutup:** hentikan tumpukan, cabut aturan firewall, aktifkan lagi aturan Docker, hapus salinan di B (bagian di atas). Tanpa `compose.lan.yml` semua port kembali loopback; berkas ini tidak dimuat oleh perintah lain.
- Tidak dikerjakan: TLS untuk Keycloak (mengubah konfigurasi keamanan Keycloak dan ADR-0017).
