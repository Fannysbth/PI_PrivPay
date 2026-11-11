# Rencana perbaikan kinerja v2 (tahap A, B, C)

Dibuat 2026-11-11 sebagai pengingat untuk Fanny dan Claude. Ini rencana kerja, bukan keputusan arsitektur: keputusan ada di ADR.

## Tujuan dan batas

- Mengecilkan biaya kinerja pola pseudonimisasi dinamis tanpa keluar dari judul dan deskripsi skripsi: data pribadi tetap disamarkan di Gateway, layanan hilir tidak pernah menerima data asli, Privacy-by-Design tetap.
- Keamanan didahulukan atas kecepatan. Bila satu langkah menurunkan jaminan keamanan, jaminan itu dicatat di ADR dan di naskah, tidak disembunyikan.
- Hasil v1 (tanpa perbaikan) tetap dilaporkan apa adanya. v2 adalah iterasi kedua DSRM, diukur dengan protokol yang sama, dan tidak menggantikan v1. Ambang 20% dan 15% tidak diubah.
- Semua keputusan FINAL (Tabel 1/2/3/5/6, panjang token, tiga kunci, TTL, D-09, D-12) hanya berubah lewat ADR yang disetujui Fanny.

## Keadaan awal (v1, pengukuran resmi 2026-11-05, 100 pengguna, tanpa jeda)

| Metrik | Baseline (n=5) | Usulan (n=4) |
| --- | --- | --- |
| p95 | 627,6 ms | 1.600,4 ms (+155,0%) |
| Throughput | 203,9 req/s | 62,6 req/s (-69,3%) |
| Total CPU | sekitar sama | sekitar sama |
| CPU Privacy Service / DB | - | 0,46 / 0,45 inti (batas 0,5) |

Penyebab: sekitar 5,3 panggilan sinkron ber-TLS ke Privacy Service per pembayaran (2 pseudonymize di Gateway, 1 exchange X2, 1 resolve-domain, 1 PATCH, 0,3 exchange X1), dan sekitar 6 sampai 8 query per panggilan. Kriptografi (sekitar 4 µs) bukan penyebab. Angka 5,3 berasal dari diagnosis M7-B pada 25 pengguna (bukan resmi).

## Tahap A: pangkas query per operasi di Privacy Service

- Apa: `expireStale` dan `findActive` digabung menjadi `expireAndFindActive` (satu statement, satu round trip). Perilaku, otorisasi, dan audit tidak berubah.
- Status (2026-11-11): SELESAI di kode dan di-commit `07b185c` di cabang `feat/perf-v2-privacy-hot-path`. Tes `PERF-01` merah dulu, lalu hijau. Integrasi penuh 70 suite / 1243 tes lulus.
- Sisa: `/code-review`, gerbang yang tersisa (lihat `docs/log/2026-11-11.md`), pengukuran.
- Dampak ke naskah: tidak ada.

## Tahap B: `POST /pseudonymize/batch` untuk P1 dan P2

- Apa: Gateway (adapter dan plugin Kong) meminta token nasabah dan rekening dalam satu panggilan. Panggilan sinkron per pembayaran turun dari sekitar 5,3 menjadi sekitar 4,3 (perkiraan, belum diukur).
- Aturan keamanan (ADR-0019, Proposed): tiap elemen tetap lewat Policy Engine dan menulis tepat satu baris audit; satu elemen ditolak berarti seluruh batch ditolak (all-or-nothing); pemanggil hanya `API_GATEWAY`; `requesting_service` dari JWT; 1 sampai 2 elemen; skema menolak field tak dikenal; Privacy mati tetap 503 tanpa fallback.
- Status (2026-11-11): langkah 1 sampai 6 SELESAI, commit `b52d31a`, ADR-0019 Accepted (dengan penyempitan satu elemen per `subject_type`). Langkah 7 (Newman kedua mode) SELESAI 2026-11-11: proposed 133 asersi, baseline 119 asersi, 0 gagal; payload scan dan fail-closed lulus. Langkah 8: gerbang hijau, `/code-review medium` selesai (perbaikan di `b39d189`).
- Langkah: (1) Fanny menyatakan ADR-0019 Accepted; (2) spec privacy bagian 4 dan PRD_ERRATA; (3) tes dulu (TK untuk rute baru: pemanggil salah, elemen ditolak, ukuran, Privacy mati, dua elemen = dua baris audit); (4) rute di Privacy; (5) klien TS di Gateway; (6) plugin Lua dan vektor kontrak; (7) Newman kedua mode; (8) gerbang, `/code-review`.
- Butuh Docker (Lua, luacheck, Newman, payload scan) dan memori bebas >= 3,5 GB saat Docker menyala.
- Dampak ke naskah: satu kalimat di Metodologi.

## Tahap C: cache token terbatas (diputuskan setelah A dan B diukur)

Fanny menyetujui arah C (2026-11-11) karena tetap pseudonimisasi dinamis, tetap Privacy-by-Design, dan penyamaran tetap terjadi di Gateway. Parameter dan ADR-nya ditetapkan setelah ada angka A+B.

Pembaruan 2026-11-11: Fanny meminta T memakai nilai normal industri. Usulan Claude T = 5 detik (dasar di `docs/OPEN_QUESTIONS.md` N-63 dan `docs/log/2026-11-11.md`); belum disetujui. Tahap C belum dikerjakan; menunggu persetujuan dua ADR.

- Apa: Gateway menyimpan token P1/P2 yang baru diterima; Transaction menyimpan hasil exchange X2 (dan X1) per token sumber; Notification menyimpan hasil resolve-domain per token P4. Pembayaran berikutnya dari nasabah yang sama tidak perlu ke Privacy.
- Pengaman wajib:
  1. Umur entri <= min(sisa masa berlaku token, T detik). T ditetapkan lewat env dan dibahas dengan dosen (usulan awal 30 sampai 60 detik).
  2. Gateway menyimpan hanya digest berkunci acak per proses sebagai kunci, tidak pernah ID mentah. Kunci itu bukan `K_token`, `K_index`, atau `K_field`.
  3. Kunci cache layanan hilir adalah token sumber, jadi setelah pencabutan (token baru) entri lama tidak pernah terpakai. Token satu layanan tidak dipakai di layanan lain (invarian 5).
  4. Jumlah entri dibatasi; entri dibuang saat kedaluwarsa; tidak ada tulis ke disk atau log.
  5. Gateway membuang entri subjek yang ia cabut sendiri (ADR-0014, kompensasi pendaftaran). Pencabutan admin lewat konsol langsung ke Privacy tidak diketahui cache, jadi tertunda sampai T.
- Harga yang harus ditulis di ADR dan naskah:
  1. Gagal-tertutup menjadi "tertutup setelah jendela T detik" untuk nasabah yang tokennya sedang tersimpan. Cache dingin tetap 503 langsung.
  2. Pencabutan oleh admin tertunda paling lama T.
  3. Pemakaian dari cache tidak menulis baris audit di Privacy; KPI audit dipersempit menjadi "100% operasi di Privacy Service tercatat".
- Tes: varian TK-16 (cache dingin 503; hangat lolos sampai T; sesudah T 503), tes jendela pencabutan, tes lintas layanan/tujuan, tes tidak ada ID mentah di memori/log, pemindai kenari kedua mode.
- Butuh dua ADR (cache dan perubahan klaim fail-closed). Bukan keputusan yang boleh diambil Claude sendiri.

## Pengukuran v2

- Protokol sama dengan v1: 100 pengguna, pemanasan 60 detik, ukur 300 detik, 5 pengulangan berselang-seling baseline/usulan, k6 di laptop kedua, commit bersih. Hasil ke folder baru (bukan menimpa `resmi/`).
- Dua set: `saturation` dan `realistic` (jeda 0,5 sampai 1,5 detik). Set `realistic` untuk v1 juga masih harus dijalankan.
- Run ke-10 usulan v1 kosong (0 permintaan); ulangi bila v1 ingin n = 5.
- Memori: Docker menyala butuh bebas >= 3,5 GB (laporkan angkanya); gerbang penuh Docker mati dan >= 5 GB.
- Jangan mengutip angka tahap kesiapan sebagai hasil.

## Dampak ke naskah (`docs/penulisan/`, tidak di-push)

- A dan B: Metodologi (satu kalimat), Hasil (bagian v2).
- C: Abstrak, Hasil, Pembahasan, Kesimpulan dan klaim "seluruh permintaan ditolak saat Privacy mati" harus ditulis ulang sesuai T. Kesimpulan "penelitian selanjutnya" menjadi bagian yang dikerjakan.
- Posisi: v1 = hasil awal, v2 = iterasi perbaikan. Keduanya dilaporkan.

## Pertanyaan untuk dosen (sebelum C dikunci)

1. Apakah laporan jujur v1 yang negatif sudah cukup, atau iterasi perbaikan diharapkan?
2. Apakah "gagal-tertutup setelah jendela T" masih sesuai tujuan penelitian?
3. Berapa T yang dianggap wajar?

## Pekerjaan lain yang masih terbuka (jangan lupa)

- CI GitHub gagal 0 detik: dugaan `hashFiles()` di `if:` tingkat job pada job `lua` dan `containers` di `.github/workflows/ci.yml`. Belum dikonfirmasi; 10 PR Dependabot (termasuk lompatan mayor NestJS 12 dan `@types/node` 26) jangan di-merge sebelum CI diperbaiki.
- Lokal 71 commit di depan `origin/main`; yang ada di GitHub baru sampai 1 November.
- Folder `docs/hasil/kinerja/resmii/` (percobaan 3 November, tidak stabil): putuskan dibuang atau disimpan sebagai catatan.
- Bagian "Status perintah" di `CLAUDE.md` usang (menyebut Keycloak, TLS, k6 belum ada; sebenarnya sudah).
- Verifikasi referensi: Pasal 4 UU PDP, EDPB Guidelines 01/2025 par. 22, Flegel 2005, Petersen 2018, DOI Venable (OPEN_QUESTIONS bagian D).
- Tidak boleh di-push: `docs/penulisan/`, `docs/hasil.zip`, `docs/hasil/kinerja/resmi/`, `docs/hasil/kinerja/resmii/`, `artifacts/` (sudah di `.gitignore`, perubahan `.gitignore` belum di-commit).

## Urutan kerja berikutnya

1. Selesaikan A: gerbang penuh, `/code-review`, CHANGELOG, commit (satu PR kecil).
2. Fanny menyatakan ADR-0019 Accepted; kerjakan B dengan alur tes dulu.
3. Ukur A+B (set `saturation` dulu), bandingkan dengan v1.
4. Bawa angka ke dosen; putuskan C dan T; tulis ADR cache; kerjakan C; ukur ulang.
5. Perbarui naskah.
