# RETRO DK-02b (plugin Kong privacy-tokenizer)

Singkat. Hanya hal yang berulang atau mahal.

## Yang berjalan baik

- Orientasi menemukan tiga bentrokan (urutan A2/A5 di `/register`, validasi sebelum tokenisasi, keaslian Kong ke adapter) sebelum satu baris Lua ditulis; tiga jawaban Fanny menentukan rancangan.
- Inti Lua dibuat murni (tanpa Kong/ngx), sehingga vektor kontrak yang sama dengan `Tokenizer` TypeScript bisa dijalankan di kontainer Kong sekali pakai. Vektor notification ditambahkan dan ikut menguji sisi TypeScript.
- Mutasi diuji pada tumpukan nyata: penjaga fail-closed dihapus (adapter melihat request, tes gagal), penjaga passthrough baseline dihapus (payment 503, tes gagal); kode dipulihkan dan diperiksa ulang.
- Guard ADR-0006 (`mode-folders.spec`) menangkap kode tepi yang menyebut nama mode; diselesaikan dengan aksi netral `tokenize`/`passthrough`, bukan melonggarkan tes.

## Yang mahal

- Spec Docker ikut run unit (`**/*.spec.ts`) dan merah tanpa tumpukan: spec yang butuh Docker harus punya pola nama dan konfigurasi sendiri sejak awal.
- Data tumpukan Docker bertahan antar-run: kanari dan kunci idempotensi literal menghasilkan 422/409 di run kedua; ID permintaan literal membuat tes log lulus/gagal karena log lama. Buat semuanya per run (`randomUUID`, indeks kanari dari waktu).
- Heredoc Bash merusak `\n` dan regex; tiga kali skrip penyunting gagal. Pakai alat Write/Edit untuk teks berisi garis miring terbalik. Perintah dengan `python3 -` menunggu stdin dan membeku.
- Satu edit komentar menambah baris Lua > 120 karakter; luacheck menangkapnya (alat bekerja). Jalankan `pnpm test:edge` setelah tiap edit Lua.

## Disarankan (menunggu persetujuan Fanny; belum masuk CLAUDE.md)

- Spec yang menyentuh tumpukan Docker: nama `*.docker.spec.ts`, data unik per run.
