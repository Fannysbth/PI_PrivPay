# Retro M3 (2026-10-21)

Dasar: kejadian nyata sepanjang Gerbang 1 sampai 3 (HANDOFF, CHANGELOG, riwayat commit). Bagian "yang kuhentikan" milik Fanny dan sengaja dikosongkan.

## 1. Yang lancar

- Tes dulu dengan basis data asli (PostgreSQL lokal, peran sungguhan) menangkap hal yang tidak akan tertangkap mock: kunci baris, `FOR SHARE`, `REVOKE/GRANT`, `CHECK`.
- Gerbang dua putaran berturut-turut menemukan kegagalan yang lolos di putaran pertama (pool habis saat memori sempit, Gerbang 2).
- Mutasi cepat pada pengaman konkurensi M3-05 membuktikan tes yang tampak benar ternyata tidak menjaga apa pun.
- Review terpisah (`/code-review`, `/security-review`) menghasilkan penolakan yang beralasan, bukan perubahan kode yang tidak perlu.

## 2. Yang menghambat

- Memori sempit: proses dihentikan sistem, lari tumpang tindih, kegagalan pool yang tidak bisa dibedakan dari bug.
- Sisa database tes menumpuk (44 pada akhir Gerbang 2). `pnpm db:test-databases drop` sengaja menolak konfirmasi bukan-TTY, sehingga hanya pengguna yang dapat menjalankannya.
- Database layanan asli kosong sampai ada `pnpm db:migrate`, karena migrasi hanya berjalan di database tes sementara.
- `gitleaks --all` ikut memindai branch cadangan berisi fixture lama; hasilnya bukan masalah di riwayat yang dipakai.
- Spesifikasi yang tidak bisa dipenuhi apa adanya (N-29: peran sesudah gerbang 5 membuat TK-08 mustahil dicapai) baru ketahuan saat menulis tes.

## 3. Kesalahan AI yang berulang

- Menebak API alih-alih membacanya: `FakeClock.advance` memakai detik (bukan milidetik), Gateway tidak menerbitkan P3 dan P6 butuh subjek ACCOUNT, `'PSEU-ZZZZZZZZ'` bukan format token. Semuanya muncul sebagai tes merah karena fixture, bukan kode.
- Tes konkurensi yang lolos tanpa menjaga: tumpang tindih "diharapkan" terjadi sendiri. Baru ketahuan setelah pengaman dihapus dan tes tetap lulus.
- Mengerjakan sebelum membaca satu lintasan penuh: memasukkan commit saat lint masih gagal karena perintah dirangkai dengan `;` (diperbaiki dengan `--amend`, belum di-push).
- Argumen CLI salah (`--` terbaca sebagai pola tes jest) menghabiskan satu putaran gerbang.

## 4. Usulan perubahan CLAUDE.md (diterapkan seperlunya, lihat bagian "Pelajaran berulang")

1. Periksa memori bebas sebelum gerbang; satu proses pada satu waktu; bila proses dihentikan sistem dua kali, berhenti dan laporkan.
2. Tes konkurensi memaksa tumpang tindih tanpa `sleep` (kunci yang ditahan sesi lain) dan dibuktikan dengan mutasi: pengaman dihapus, tes harus gagal, lalu kode dikembalikan.
3. Commit hanya setelah lint dan typecheck hijau; rangkai dengan `&&`, bukan `;`.
4. Baca tanda tangan API dan satuan (detik atau milidetik) sebelum menulis fixture; fixture yang salah bukan alasan mengubah kode.
5. Sisa database tes dibersihkan pengguna dengan `! corepack pnpm db:test-databases drop` (butuh terminal interaktif); jangan simpan branch cadangan berisi fixture lama, agar `gitleaks --all` bersih tanpa allowlist.

## 5. Yang kuhentikan

(diisi Fanny)
