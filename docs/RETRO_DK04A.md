# RETRO DK-04 sesi A (pengambil token/JWKS bersama, profil Compose Keycloak)

Singkat.

## Yang berjalan baik

- Pengambil token bersama menggantikan lima salinan tanpa mengubah perilaku: default `dev-idp`, unit 1497 hijau, integrasi layanan yang memakai modul (62 + 231) hijau tanpa mengubah satu tes.
- Tes pengambil token dijalankan terhadap dua IdP: fake untuk bentuk permintaan, dan Keycloak asli (spek Docker) untuk jalur nyata (form, JWKS dengan kunci enc, password grant, kata sandi salah).
- Keycloak naik sendiri di Compose lewat profil, tanpa tumpukan penuh: 455 sampai 498 MiB dari 768 MiB.

## Yang mahal

- Skrip dengan literal template berisi `\r\n` dan regex merusak YAML dan TS tiga kali (garis baru sungguhan masuk ke berkas). Pakai alat Edit/Write atau berkas `.js` dengan `String.fromCharCode` untuk teks bertanda garis miring.
- Healthcheck memakai `/dev/tcp` yang hanya ada di bash; `CMD-SHELL` memakai `sh`. Gagal sunyi (keluaran kosong): uji perintahnya dengan `docker exec` sebelum percaya Compose.
- Memori bebas laptop turun ke 0,78 sampai 0,91 GB setelah Keycloak naik di atas VM Docker yang sudah besar. Batas 0,9 GB milik tumpukan penuh (tiket 3) tampaknya tidak akan terpenuhi tanpa mematikan hal lain; ukur ulang sebelum tiket 3.
- Dua node.exe proses sisa di mesin adalah proyek lain (`D:\samar-prototype`), bukan PrivPay.

## Disarankan

- Sebelum tiket 3: restart Docker Desktop/WSL (`wsl --shutdown`) untuk membebaskan memori, lalu ukur tumpukan penuh dengan Keycloak.
