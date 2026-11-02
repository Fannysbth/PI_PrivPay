# Tinjauan keamanan M6 (2026-11-02)

Cakupan: `git diff main...HEAD` pada `feat/m6`. Skill `/security-review` gagal mengambil diff (tidak ada remote `origin`), jadi tinjauan dilakukan inline atas diff itu. Tidak ada temuan yang perlu diperbaiki; dua catatan keterbatasan.

## Yang diperiksa dan hasilnya

| Area | Hasil |
| --- | --- |
| Rute batch Kong (`gateway-adapter-batch`, ADR-0018) | Memakai `common` yang sama (HTTPS saja) dan plugin `jwt` yang sama; pembatas ukuran body dan korelasi adalah plugin global, tetap berlaku. Peran `admin` diperiksa adapter sebelum panggilan hilir, jadi penolakan 403 tetap cepat; yang diperpanjang hanya tunggu hilir untuk rute itu. Rute lain tetap 3 detik (NFR-12) |
| Batas waktu per permintaan (`HttpRequest.timeoutMs`) | Hanya diisi rute bertanda `batch`; POST tetap tanpa retry (bukan idempoten) |
| `docs/hasil` | Hanya nama atribut dan hitungan; tanpa nilai kenari, token, JWT, atau nomor 16 digit (dipindai, hanya angka desimal yang cocok dengan pola); `gitleaks` hijau |
| Koleksi dan environment Postman | Kata sandi dan rahasia hanya sebagai variabel bertipe secret yang diisi di luar berkas; tanpa JWT atau rahasia literal |
| Overlay pengukuran `deploy/measure` | Bukan bagian tumpukan resmi; port kontrol observer dan 4102 hanya di loopback host; kontainer `read_only`, `cap_drop: ALL`, `no-new-privileges`; hanya menyimpan kenari fiktif di memori |
| Tes statis `pnpm newman` | Tanpa dependensi baru (diuji) |

## Catatan keterbatasan

1. **Observer menjembatani `business` dan `edge`.** Di tumpukan pengukuran, satu kontainer tambahan terhubung ke dua jaringan, sehingga ada jalur dari `edge` ke layanan hilir yang tidak lewat Gateway; observer mendengarkan di `0.0.0.0` di dalam kontainer (perlu untuk publikasi port) dan port kontrolnya tanpa autentikasi. Dapat diterima hanya karena overlay khusus pengukuran di laptop, loopback, dan hanya data fiktif. Topologi jaringan pengukuran karena itu tidak identik dengan tumpukan resmi (tiga jaringan, DK-03); payload yang diamati tidak berubah. Jangan pakai overlay di luar pengukuran.
2. **Waktu tunggu Kong dan adapter sama (60 detik).** Untuk run yang lewat 60 detik, jawaban 503 bisa datang dari Kong atau adapter (balapan); keduanya 503 `SERVICE_UNAVAILABLE` setelah pemetaan galat. Sudah tercatat di ADR-0018 dan N-58.

## Dari `/code-review` (high), tidak diperbaiki

- Presisi/recall tertukar: salah (Metodologi: prediksi terhadap teramati; kode sudah sesuai).
- Kenari `linkage` dari rentang tetap, `afterAll` menulis hasil walau tes gagal, observer mencatat hanya setelah hilir menjawab, asersi hampa di bagian pembukaan identitas, `day()` batch-timeout berulang tiap ±17 menit: keterbatasan alat ukur, dicatat di `docs/hasil/README.md` (tumpukan segar per run, periksa kode keluar dan `git diff`). Spek tidak diubah setelah pengukuran resmi agar kode yang diukur tetap sama dengan `b5a4f2f`.
- Perbaikan yang diterapkan: `commitInfo` melempar galat bila git gagal (`e492605`).
