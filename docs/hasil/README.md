# Hasil pengukuran resmi M6 (M6-02, M6-03, M6-04)

- Commit: `b5a4f2f191537898598877a9bac4c27e318057c9` (cabang `feat/m6`).
- Pohon kerja bersih: **ya** (`git status` kosong sebelum tiap run; `workingTreeDirty: false` di `meta` tiap berkas; yang tidak dihitung hanya `docs/hasil` sendiri, lihat `tests/measure/commit-info.ts`).
- Tanggal: 2026-11-02 (waktu tepat di `meta` tiap berkas).
- Tumpukan: Docker Compose, Kong 3.9.4 di depan gateway-adapter, Keycloak 26.4.0, overlay `deploy/measure/compose.measure.yml`, batas laju mati di adapter dan Kong pada kedua mode. Satu mode sekaligus; `down -v` di antara mode.
- Perintah: `PRIVPAY_STACK_MODE=<mode> pnpm measure:exposure | measure:linkage | measure:fail-closed`.

| Berkas | Isi |
| --- | --- |
| `e-s-<mode>.md` / `.json` | M6-02: E(s) per layanan, teramati dibanding Tabel IV (1000 nasabah, 2.500 pembayaran, `FRAUD_HISTORY_DAYS=30`), pembukaan identitas dilaporkan terpisah |
| `tautan-<mode>.json` | M6-03: uji penautan pada salinan basis data (200 subjek bernilai-diketahui, bawaan `MEASURE_LINK_SUBJECTS`), skor terhadap kebenaran evaluator |
| `tutup-<mode>.json` | M6-04: fail-closed (hanya usulan; baseline tercatat "tidak berlaku") |

## Cara membaca (batas klaim)

1. Nilai Tabel IV adalah **harapan yang diukur**, tidak disetel. Baseline dikonfigurasi menurut tabel itu (pilihan B, N-57), jadi kecocokan baseline dengan Tabel IV **bukan bukti independen**; bukti yang berarti adalah kontrol positif pemindai dan kecocokan mode usulan.
2. E(s) adalah paparan struktural pengenal langsung, bukan risiko identifikasi ulang. Penautan lewat kuasi-pengenal (nominal, jam, geohash) dan kedaluwarsa token 30 hari tidak diukur.
3. Uji penautan bersifat empiris pada data run ini; bukan bukti ketaktertautan, dan penyerang tidak memegang kunci atau Privacy Service.
4. Tidak ada klaim kinerja. Durasi run rekonsiliasi (temuan N-58) dan waktu pemulihan adalah waktu dinding laptop ini (ADR-0004).
5. Pembukaan identitas (usulan) dilaporkan terpisah dari E(s) utama: paparan terkontrol, lima percobaan, lima berhasil hanya atribut disetujui.
6. Setiap run resmi butuh tumpukan segar (`down -v` sebelum menyalakan): data kenari penghubung (`linkage`) tetap dari rentang tetap dan data tumpukan bertahan antar-run, jadi run ulang di tumpukan yang sama gagal 409 atau mencampur baris lama. Berkas hasil ditulis `afterAll` bahkan bila ada tes gagal; periksa kode keluar (0) dan `git diff` sebelum mengomit.
