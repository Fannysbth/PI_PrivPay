# ADR-0016: Plugin Kong `privacy-tokenizer` menokenisasi tiga rute; pendaftaran tetap di adapter

- Status: Accepted (keputusan Fanny, 2026-10-31, tiga pilihan pada orientasi DK-02b)
- Tanggal: 2026-10-31
- Pengambil keputusan: Fanny
- Terkait: ADR-0015, ADR-0007, ADR-0008, ADR-0005, ADR-0006, ADR-0011, ADR-0014, Metodologi (privacy-tokenizer, Tabel III), gateway spec 4, 5, 6, 8, 9, FR-32, TF-13

## Konteks

Metodologi menempatkan tokenisasi di plugin Lua Kong. Sampai DK-02a tokenisasi ada di `Tokenizer` adapter. Tiga bentrokan muncul saat orientasi: (1) pendaftaran (A2 buat pengguna IdP, A5 simpan identitas butuh `customer_id` dari A2, A3, A4, kompensasi) tidak bisa dipecah di depan adapter; (2) spek mewajibkan otorisasi sebelum body disentuh dan validasi penuh sebelum satu token terbit (FR-32, TF-13); (3) adapter harus tahu bahwa token di body berasal dari Kong, bukan buatan klien.

## Keputusan

1. **Tiga rute** (`POST /transaction`, `/settlement/report`, `/notification/register`) ditokenisasi plugin; **`/register` tetap di adapter** (menyimpang dari kalimat Metodologi "plugin menangani pendaftaran"; alasan: urutan A2 sebelum A5).
2. **Plugin memeriksa ringan, adapter tetap berwenang.** Plugin bertindak hanya bila `azp` dan klaim cocok dengan jenis rute (nasabah: `customer-app` dengan `customer_id`; bank: `bank-simulator`) dan semua field pengenal lolos pola (cermin ringkas skema; settlement diperiksa utuh sebelum token pertama diminta). Bila tidak, request diteruskan apa adanya dan adapter menjawab seperti biasa (403/422). Skema penuh, peran, ukuran, penyamaran galat, dan token layanan tetap di adapter.
3. **Kong tidak membawa `K_token`.** Pseudonim dibuat di dalam Privacy (`POST /pseudonymize`, TLS, CA dev diverifikasi, token layanan klien `api-gateway`, audience `privacy-service`, di-cache sampai `exp` dikurangi 30 detik, timeout 3 detik, maksimum 2 ulang). Kong memegang dua berkas rahasia lewat Docker secret: `api-gateway_client_secret` dan `edge_adapter_secret`, dan bergabung ke jaringan `privacy` (menggeser batas DK-03: proses tepi kini bertetangga dengan Privacy; hanya di kondisi usulan).
4. **Keaslian ke adapter.** Plugin menghapus header `X-Edge-Auth` dari klien pada setiap request, lalu mengisinya dengan `edge_adapter_secret` hanya pada request yang ditokenisasi. Adapter (`EDGE_TOKENIZATION=true`, hanya bersama `PRIVACY_SERVICE_URL`) membandingkannya dengan `timingSafeEqual`. Dengan header sah: body dibaca dengan skema bertoken yang ketat (tanpa pengenal mentah) dan diteruskan; adapter tidak menokenisasi lagi (tanpa tokenisasi ganda). Tanpa header sah: skema mentah diperiksa seperti dulu (422 bila tak valid) dan body mentah yang valid ditolak 503 (gagal tertutup; tidak pernah diteruskan). Jalur lama (`Tokenizer`) tetap dipakai bila `EDGE_TOKENIZATION=false` (baseline, `pnpm dev:up`).
5. **Fail-closed.** Privacy tidak terjangkau, menolak, atau menjawab tak jelas: Kong mengakhiri request (503 atau status penolakan dari tabel yang sama dengan adapter; bentuk galat ADR-0008 oleh `post-function`). Adapter tidak melihat request.
6. **Baseline = passthrough.** Plugin diberi aksi `passthrough` dan tidak membaca atau mengubah apa pun; ia tidak mendapat alamat Privacy.
7. **`SubjectReferencePort`/`PRIVACY_MODE` tidak berubah:** hilir menerima token seperti sebelumnya. Aksi plugin dipilih dari ada-tidaknya alamat Privacy (dijamin cocok dengan mode oleh `privacyUrlMatchesMode`), karena kode domain tidak boleh menyebut mode (ADR-0006).

## Konsekuensi

- Positif: titik tokenisasi pertama sesuai Metodologi; data mentah tidak sampai ke adapter di kondisi usulan; vektor kontrak yang sama dipakai TypeScript dan Lua.
- Negatif / utang: dua sumber pola skema (zod dan Lua; adapter tetap berwenang); Lua tanpa kerangka uji selain vektor dan mutasi HTTP; Kong di jaringan privacy dan memegang dua rahasia; settlement memanggil Privacy berurutan (hingga 500 akun) dan tidak diukur; kunci dev-idp basi membuat Kong menolak sampai dibuat ulang bersama.
- Pengujian: `pnpm test:edge` (vektor Lua + luacheck citra terpin, payload scan hilir, fail-closed Privacy dimatikan), Newman kedua mode, mutasi penjaga fail-closed dan passthrough.
- Belum: DK-02c memutuskan apakah ada Lua lain; tidak ada klaim kinerja.

## Kapan ditinjau ulang

Di DK-02c, dan saat Keycloak menggantikan dev-idp (DK-04).
