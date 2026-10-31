# RETRO DK-02a (Kong OSS di depan gateway-adapter)

Singkat. Hanya hal yang berulang atau mahal.

## Yang berjalan baik

- Spike kecil (Kong dengan upstream palsu) sebelum merancang membuktikan dalam beberapa menit bahwa `post-function` berjalan untuk galat plugin lain dan galat hulu. Itu menentukan pertanyaan ke Fanny dengan fakta, bukan dugaan.
- Bukti penolakan di tepi memakai id permintaan: log adapter tidak memuat id permintaan yang ditolak Kong. "Ditolak" saja tidak membedakan Kong dari adapter, karena bentuk galatnya sengaja sama.
- `/code-review` dan tinjauan keamanan menemukan celah yang sama: Express tidak ketat dan tidak peka huruf besar, jadi `/Metrics` dan `/metrics/` lolos dari rute blokir `~/metrics$`. Perbaikan didahului tes merah.

## Yang mahal

- Dua kali fase `limits` gagal oleh sebab di luar Kong: adapter menyimpan JWKS kunci IdP lama (cooldown 30 detik) setelah `idp` dibuat ulang; lalu token layanan adapter ikut berumur 2 detik saat TTL dipendekkan. Pelajaran: bila `idp` dibuat ulang, buat ulang `gateway`, `kong-config`, `kong` bersama; TTL pendek hanya untuk satu cek (`expiry`).
- Berkas kerja di Windows berakhir baris CRLF sementara skrip penyunting saya memakai LF; tiga penyuntingan gagal "pola tidak ditemukan". Skrip penyunting kini menormalkan EOL dan menulis kembali EOL asli. Heredoc Bash dengan tanda kutip dan `\n` merusak skrip dua kali (sudah ada di retro M4): tulis skrip dengan alat Write.
- Memetakan `/usr/local/kong` ke tmpfs menutupi pustaka citra (`libada`), Kong gagal start. Prefiks cukup dipindah ke `/tmp` via `KONG_PREFIX`.
- Lint mengeluh tentang `number` di template literal dan cast tak perlu; typecheck tentang tipe `ComposeService` yang kurang `depends_on`. Gerbang lint/typecheck dijalankan terakhir dan menunda commit; jalankan `pnpm lint` setelah tiap berkas baru, bukan di akhir.

## Disarankan (menunggu persetujuan Fanny; tidak ditambahkan ke CLAUDE.md)

- Setelah `idp` dibuat ulang di Compose, buat ulang `gateway kong-config kong` bersama (sudah ada di README Postman dan CLAUDE.md).
