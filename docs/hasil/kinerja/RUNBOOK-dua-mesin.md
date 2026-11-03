# Runbook dua mesin: tumpukan di laptop utama (A), k6 di laptop kedua (B)

Keputusan N-61 pilihan A. PERSIAPAN, bukan hasil. Mengikuti Metodologi C.5 ("pembangkit beban dari mesin terpisah"). Yang dibuka ke LAN hanya **Kong (TLS)** dan **Keycloak (HTTP biasa)**, terikat ke SATU alamat LAN laptop A, ditambah **satu pendengar unggahan sementara** milik runner (M7-E, bagian di bawah); layanan lain, Grafana, Prometheus, dan cAdvisor tetap loopback atau tanpa port.

## Hasil pemeriksaan issuer (M7-D, 2026-11-03)
- `KC_HOSTNAME=http://keycloak:8080` (alamat penuh) membuat Keycloak selalu menerbitkan `iss=http://keycloak:8080/realms/privpay`, apa pun alamat yang dipakai peminta. Dibuktikan: dokumen discovery diminta lewat IP LAN dan lewat loopback, keduanya `issuer=http://keycloak:8080/realms/privpay`.
- k6 di kontainer tanpa jaringan Compose, memetakan `kong:8443` dan `keycloak:8080` ke IP LAN laptop A (opsi `hosts` k6): 754 pembayaran 201, 0 galat (Kong memverifikasi JWT RS256, adapter memeriksa iss/aud). Tidak ada konfigurasi Keycloak atau ADR-0017 yang diubah.
- TLS tetap diverifikasi: sertifikat Kong memuat `DNS:kong`, jadi k6 memakai nama `kong` (bukan IP) dengan CA proyek; tanpa CA k6 gagal `x509: unknown authority`. Tidak ada `insecureSkipTLSVerify`.

## Sebelum mulai (sekali)
- Kedua laptop satu jaringan, kabel Ethernet lebih baik daripada Wi-Fi; catat jenisnya. Alamat LAN A harus tetap selama sesi (DHCP dapat mengubahnya: periksa ulang).
- Laptop A: `pnpm docker:secrets` sudah pernah dijalankan.
- Salin ke laptop B sekali, secara manual (USB; tanpa folder bersama Windows; JANGAN lewat chat atau repositori), ke satu folder (bawaan `C:\k6test`): `secrets/docker/tls_ca.crt` sebagai `ca.crt`, `secrets/docker/keycloak_password_customer` sebagai `password` (kata sandi uji pengguna fiktif; perlakukan sebagai rahasia karena Keycloak terbuka ke LAN), `tests/performance/mixed.k6.js` sebagai `script\mixed.k6.js`, dan folder kosong `out\`. Folder lain: parameter `--b-dir`.
- Hasil k6 kembali ke A **otomatis lewat unggahan** (bagian "Unggahan ringkasan"); salin manual tetap cadangan.

## Langkah laptop utama (A)
1. Alamat LAN A (PowerShell): `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' }`. Pilih satu alamat; sebut `<IP-A>`. Alamat laptop B sebut `<IP-B>` (`ipconfig` di B).
2. Firewall (PowerShell **sebagai Administrator**, kamu jalankan sendiri). Satu aturan, hanya dari `<IP-B>`, hanya ke dua port itu:
   ```
   New-NetFirewallRule -DisplayName "privpay-m7-lan" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress <IP-A> -LocalPort 4443,8080 -RemoteAddress <IP-B> -Profile Any
   ```
   **Pengingat (wajib selama sesi):** aturan bawaan Docker Desktop untuk `com.docker.backend.exe` dapat membuka port ke seluruh LAN walau aturan di atas ada. Periksa: `Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow | Where-Object { $_.DisplayName -like '*Docker*' }`. Nonaktifkan sementara aturan itu selama sesi (`Disable-NetFirewallRule -DisplayName '<nama>'`) dan aktifkan lagi di pembersihan (`Enable-NetFirewallRule`). Catat bahwa ini dilakukan.
   Aturan unggahan (Administrator, kamu jalankan sendiri), satu lagi, TCP saja, hanya dari B ke A, port `SUMMARY_UPLOAD_PORT` (bawaan 4444):
   ```
   New-NetFirewallRule -DisplayName "privpay-m7-upload" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress <IP-A> -LocalPort 4444 -RemoteAddress <IP-B> -Profile Any
   ```
   (Opsional, ukur RTT) aturan sementara agar B dapat mem-ping A, ICMPv4 echo hanya dari B:
   ```
   New-NetFirewallRule -DisplayName "privpay-m7-ping" -Direction Inbound -Action Allow -Protocol ICMPv4 -IcmpType 8 -LocalAddress <IP-A> -RemoteAddress <IP-B> -Profile Any
   ```
3. Nyalakan tumpukan dengan override LAN (satu mode sekaligus). Percobaan kecil dan run resmi memakai runner: `PRIVPAY_LAN_IP=<IP-A> pnpm perf:run --remote-k6 --peer-ip <IP-B> --only proposed --vus 10 --duration 60s` (opsi lain seperti biasa; `--official --remote-k6 --peer-ip <IP-B>` untuk resmi; `--upload-timeout 30m` dan `--b-dir D:\k6test` opsional). Runner menolak alamat selain IPv4 privat (bukan `0.0.0.0`, bukan loopback), menolak mulai bila memori bebas < 3,5 GB setelah Docker menyala (menunggu paling lama 5 menit; angkanya dicatat di JSON), menyalakan tumpukan segar, membuka pendengar unggahan, lalu **mencetak SATU perintah PowerShell untuk laptop B**. Port bawaan: Kong 4443, Keycloak 8080 (ubah dengan `KONG_LAN_PORT`, `IDP_LAN_PORT`; aturan firewall harus sama).
4. Setelah ringkasan tiba (unggahan atau salinan manual), runner membaca CPU dan memori dari Prometheus **pada waktu `k6.endedAt`** (jam B), bukan saat berkas tiba, dan menulis berkas hasil. Mode dan pengulangan berikutnya mengulang dari langkah 3.

## Langkah laptop kedua (B): hanya Docker, citra k6 terpin, salinan skrip
1. Docker Desktop menyala; tidak ada yang lain. Folder `C:\k6test` (atau `--b-dir`) berisi `ca.crt`, `password`, `script\mixed.k6.js`, dan `out\`.
2. Uji jaringan: `Test-NetConnection <IP-A> -Port 4443`, `-Port 8080` dan `-Port 4444` (`TcpTestSucceeded: True`; port 4444 baru terjawab setelah runner membuka pendengarnya). RTT: lihat "Ukur RTT (opsional)".
3. Tempel **satu perintah yang dicetak runner** ke PowerShell di B, apa adanya (tanpa isian pengganti). Isinya berurutan: hapus `out\k6-summary.json` lama, `docker run --rm ... grafana/k6@sha256:... run --quiet ... /script/mixed.k6.js` (tanpa `--network`; B tidak punya jaringan Compose; citra k6 sama dengan di A), lalu `Invoke-RestMethod -Method Put -InFile ... -Uri http://<IP-A>:4444/upload/<token>`. Titik koma menjalankan unggahan walau k6 keluar dengan kode bukan nol (ambang gagal tetap menghasilkan ringkasan).
4. Jangan gunakan alat lain di B selama run. Bila unggahan gagal (galat `Invoke-RestMethod`, pendengar sudah tutup): salin manual `out\k6-summary.json` ke folder yang dicetak runner di A (baris `fallback`); runner tetap menunggu berkas itu. Tanpa unggahan otomatis, `summaryLagSeconds` biasanya besar dan jendela sumber daya ditandai tidak andal.

## Unggahan ringkasan (M7-E)
Runner membuka pendengar HTTP sementara (hanya `node:http`) di `PRIVPAY_LAN_IP:SUMMARY_UPLOAD_PORT` (bawaan 4444). Ia menerima tepat SATU `PUT` ke `/upload/<token acak>` lalu menutup diri; juga menutup setelah `--upload-timeout` (bawaan 15 menit).
- Ditolak: alamat asal selain `--peer-ip` (403), metode selain PUT (405), token salah (404), badan lebih dari 1 MiB (413), bukan JSON (400), JSON tanpa metrik yang diharapkan atau untuk mode lain (422). Penolakan tidak menghabiskan token; unggahan sah berikutnya tetap diterima.
- **Alasan keamanan:** isi hanya metrik k6 (tanpa data pribadi); saluran tanpa TLS (jaringan pribadi yang dipercaya, sama seperti Keycloak di sini); token sekali pakai 192 bit dari `crypto.randomBytes`, dibandingkan dengan waktu-konstan; terikat ke SATU alamat (tidak pernah 0.0.0.0); aturan firewall hanya dari `<IP-B>` ke satu port; hidup hanya selama run. Token hanya tampil di terminal A, tidak ditulis ke berkas hasil.
- Berkas ditulis ke folder serah-terima yang sama seperti sebelumnya (ke berkas sementara, lalu ganti nama), jadi salinan manual ke folder itu tetap berfungsi sebagai cadangan.
- Jendela sumber daya: dihitung pada `k6.endedAt` (jam B). Hasil mencatat `summaryLagSeconds` (selang dari `endedAt` sampai ringkasan tiba di A), `resourcesWindowReliable` (`false` bila selang > 30 detik, ke arah mana pun), dan `clockOffsetEstimateSeconds` (hanya unggahan; perkiraan kasar selisih jam A dan B, batas atas karena memuat waktu henti k6 dan transfer). Selisih jam yang besar menggeser jendela; samakan jam kedua laptop (sinkronisasi waktu Windows) sebelum sesi.

## Ukur RTT (opsional, disarankan sebelum run resmi)
Throughput closed-loop dipengaruhi RTT: tiap pengguna menunggu jawaban sebelum permintaan berikutnya. Dengan aturan `privpay-m7-ping` aktif, di B: `ping -n 100 <IP-A>`. Catat min/rata-rata/maks, paket hilang, dan **jenis jaringan** (kabel Ethernet atau Wi-Fi; untuk Wi-Fi pita 2,4/5 GHz dan kecepatan tautan). Bandingkan baseline dan usulan hanya dari sesi dan jaringan yang sama; untuk run resmi pakai **kabel LAN di laptop B**. Cabut aturan ping di pembersihan.

## Percobaan kecil sebelum run resmi
10 pengguna, 60 detik, kedua mode (satu mode sekaligus), `--remote-k6`. Lulus bila: 0 galat, semua pembayaran 201, `k6-summary.json` memuat `http_req_blocked`, `http_req_connecting`, `http_req_waiting`, dan ping tanpa paket hilang. Berkas hasil bertanda `official: false`.

## Mencabut akses setelah selesai (wajib)
1. Hentikan tumpukan: runner melakukannya sendiri (`down -v`) kecuali `--keep`, dan menutup pendengar unggahan. Periksa `docker ps` kosong dan `netstat -ano | findstr "4443 8080 4444"` tidak menunjukkan `<IP-A>`.
2. Cabut aturan (Administrator): `Remove-NetFirewallRule -DisplayName "privpay-m7-lan"`, `Remove-NetFirewallRule -DisplayName "privpay-m7-upload"`, dan bila dibuat `Remove-NetFirewallRule -DisplayName "privpay-m7-ping"`. Aktifkan lagi aturan Docker yang tadi dinonaktifkan: `Enable-NetFirewallRule -DisplayName '<nama>'`.
3. Hapus salinan `password` dan `ca.crt` dari laptop B.

## Data yang dicatat per sesi
Spesifikasi A dan B (CPU, RAM, versi Windows, mode daya, `.wslconfig`: memori 7 GB dan 8 prosesor); jenis jaringan (Ethernet atau Wi-Fi, pita, kecepatan tautan), hasil ping 100 paket (RTT min/rata-rata/maks, paket hilang), memori bebas sebelum run (dicatat runner di `memoryGate`), `<IP-A>` TIDAK perlu dicatat di laporan; waktu mulai dan selesai; apakah aturan Docker Desktop dinonaktifkan; versi citra k6 (digest).

## Risiko Keycloak terbuka ke LAN dan cara menutupnya
- **Risiko:** Keycloak melayani HTTP biasa tanpa TLS dan menerima grant password. Siapa pun di LAN yang bisa menjangkau port 8080 dapat mencoba menebak kata sandi pengguna uji `uji.kinerja.*` (fiktif, tanpa data pribadi) dan mengamati token lewat jaringan. Dampak: akses ke API uji dengan data fiktif; tidak ada data pribadi nyata, tetapi tumpukan ini menerima pembayaran uji.
- **Pengurangan:** satu alamat terikat, firewall hanya dari `<IP-B>`, sesi pendek, jaringan pribadi yang dipercaya (bukan Wi-Fi umum), kata sandi uji acak dari `pnpm docker:secrets`.
- **Cara menutup:** hentikan tumpukan, cabut aturan firewall, aktifkan lagi aturan Docker, hapus salinan di B (bagian di atas). Tanpa `compose.lan.yml` semua port kembali loopback; berkas ini tidak dimuat oleh perintah lain.
- Tidak dikerjakan: TLS untuk Keycloak (mengubah konfigurasi keamanan Keycloak dan ADR-0017).
