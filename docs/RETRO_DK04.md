# RETRO DK-04 (irisan pertama: realm dan pemetaan klaim)

Singkat.

## Yang berjalan baik

- Memori diuji lebih dulu (spike): Keycloak 26.4.0 `start-dev` naik 36 detik, 485 MiB di bawah batas 768 MiB, memori bebas laptop 2,6 GB. Batas keras Fanny tidak terlanggar.
- Ketidakpastian terbesar (apakah klaim Keycloak lolos `authenticate()` tanpa mengubah aturan ADR-0007) dibuktikan dengan kontainer sekali pakai dan 13 tes sebelum menyentuh Compose atau layanan.
- Dua keputusan Fanny (customer_id tetap `CUST-nnnnnn`; satu kata sandi uji dari secrets) menghindari perubahan tujuh validator dan sembilan berkas rahasia.

## Yang mahal

- Impor realm gagal dua kali karena aturan profil pengguna Keycloak (`unmanagedAttributePolicy` tidak menerima `DISABLED`; profil wajib memuat `email`). Galat hanya terlihat di log kontainer yang dihapus spek: debug dengan kontainer terpisah yang dibiarkan hidup.
- `GET /roles` perlu `view-realm`; menetapkan peran komposit berklien banyak lewat Admin API ditolak 403 untuk klien `idp-admin`. Fixture peran ganda memakai admin bootstrap kontainer uji; jalur pendaftaran (peran `customer`) tetap bekerja dengan `idp-admin` saja.
- Skala sebenarnya DK-04 (lima pengambil token, jalur JWKS, port registrasi, Compose, Postman, Newman) jauh lebih besar dari satu sesi bila ingin aman; irisan dipotong pada batas yang terbukti dan sisanya dicatat (N-56) alih-alih menyambung setengah.

## Disarankan

- Pecah DK-04 menjadi tiket kecil: (a) pengambil token bersama dan jalur IdP dari konfigurasi (default dev-idp, tes tetap hijau); (b) layanan Keycloak + render realm di Compose; (c) port registrasi Admin API; (d) Postman/Newman/mutasi/payload scan/memori.
