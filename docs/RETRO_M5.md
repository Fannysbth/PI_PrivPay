# Retro M5 (2026-10-23)

Dasar: kejadian nyata sepanjang M5 sesi 1 dan sesi 2 (HANDOFF, CHANGELOG, riwayat commit). Bagian "yang kuhentikan" milik Fanny dan sengaja dikosongkan.

## 1. Yang lancar

- Penyelidikan TK-08 / AZ-22 selesai dalam satu putaran dengan cara yang benar: membaca jalur kode dulu (baris DENIED di-commit dan di-`await` sebelum error dilempar), lalu satu probe deterministik yang mereproduksi gejala persis (`Expected length: 2, Received length: 1`) tanpa mengandalkan keberuntungan waktu. Dua puluh putaran suite itu hijau semua, jadi tanpa probe, flake ini tidak akan pernah terbukti.
- Setiap penjaga mode punya mutasi yang terbunuh: pemilihan repositori/adaptor, aturan env `PRIVACY_SERVICE_URL`, `discloseAccount`, klausa jendela `assessed_at >= $2`, dan dua mutasi atas suite kesetaraan.
- Suite kesetaraan yang membandingkan seluruh hasil yang bisa diamati antar mode (jawaban, baris, pesan) ditambah kontras pemindai (proposed hanya HP; baseline menemukan `customer_id`, rekening, HP) membuat klaim "perbedaan mode hanyalah lapisan privasi" terukur. Mutasi (i) klien Privacy baseline mengembalikan `null` dan (ii) Gateway proposed memakai port baseline sama-sama terdeteksi.
- Keputusan Fanny di awal sesi (N-45, N-42/43, N-44 wajib tuntas) menghilangkan tanya-jawab di tengah jalan.

## 2. Yang menghambat

- Skrip penyunting multi-berkas tidak atomik antar berkas: dua kali skrip gagal di tengah (teks sudah diformat ulang oleh Prettier) dan sebagian berkas sudah berubah sementara yang lain belum, sehingga skrip tak bisa diulang begitu saja.
- Heredoc Bash berisi tanda kutip dan backtick tetap ditolak parser sekali (`unexpected EOF`), walau aturan retro M4 sudah ada; berkas skrip lewat alat Write yang selalu berhasil.
- Dua skema konfigurasi berbeda untuk mode (`serviceConfigSchema` di bootstrap vs skema tiap layanan) baru ketahuan saat kompilasi: `PRIVACY_MODE` tidak ada di skema layanan walau dibaca bootstrap.
- Gerbang yang panjang (suite integrasi Privacy 17 suite ±10 menit) memaksa menunggu dengan polling; satu proses pada satu waktu mencegah paralelisasi.

## 3. Kesalahan AI yang berulang

- Menulis ekspektasi tes dari ingatan, bukan dari kode: status rekonsiliasi sebagian cocok kutulis `MISMATCHED`, aturan K-22 menyebut `PARTIAL`. Sama dengan poin 3 retro M4.
- Menyimpulkan hijau dari satu baris keluaran: setelah menambah `gateway` ke tes arsitektur, kubaca hanya baris `Tests: 94 passed`; baris `Test Suites: 1 failed` (suite gagal dijalankan karena folder `gateway-service` tidak ada) terlewat sampai pengujian ulang. Tes arsitektur yang diperluas tidak pernah kuperiksa bisa gagal.
- Merangkai gerbang dengan `corepack pnpm lint | tail -1 && ...`: `tail` menelan kode keluar, sehingga lint yang gagal tidak menghentikan commit. Commit itu di-amend (belum di-push) setelah ketahuan.

## 4. Usulan perubahan CLAUDE.md (menunggu persetujuan)

1. Rangkai perintah gerbang dengan `set -o pipefail` atau tanpa `| tail`; baca baris `Test Suites:` dan `Tests:` bersama, bukan salah satunya. Suite yang "failed to run" bukan hijau.
2. Skrip penyunting yang menyentuh banyak berkas memvalidasi semua pola lebih dulu, baru menulis (atau berkas per berkas dengan pemeriksaan git status sebelum diulang).
3. Setiap perluasan tes arsitektur dibuktikan dengan satu pelanggaran yang disengaja (mutasi): tes harus gagal karena alasan yang benar sebelum dianggap menjaga sesuatu.
4. Tiap layanan yang mendeklarasikan variabel env baru menambahkannya ke skemanya sendiri dan ke `.env.example`, `stack.ts` E2E, serta tes smoke dalam satu commit; periksa dengan pencarian nama variabel.

## 5. Yang kuhentikan

(diisi Fanny)
