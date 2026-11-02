# ADR-0018: Batas waktu hilir tersendiri untuk satu rute batch (`POST /reconciliation/run`); rute lain tetap 3 detik

- Status: Accepted (keputusan Fanny, 2026-11-02, sesi M6; temuan pengukuran M6-02)
- Tanggal: 2026-11-02
- Pengambil keputusan: Fanny
- Terkait: NFR-12 (spek platform 6), ADR-0015, ADR-0008, M6-02, N-55c

## Konteks

NFR-12 menetapkan timeout 3 detik untuk panggilan antar-layanan (`HTTP_TIMEOUT_MS`). Pengukuran M6-02 dengan 1000 nasabah dan 2.250 transaksi selesai menunjukkan bahwa `POST /reconciliation/run` (operasi admin harian, bukan jalur nasabah) dijawab Reconciliation dengan 200 tetapi memakan waktu lebih dari 3 detik (5,3 detik di baseline, 15,6 detik di usulan pada satu run di laptop; temuan, bukan klaim kinerja). Gateway memutus di 3 detik dan menjawab klien 503 `SERVICE_UNAVAILABLE`, padahal pekerjaan di Reconciliation selesai. Klien admin lalu melihat kegagalan atas operasi yang berhasil.

## Keputusan

1. Satu rute, `POST /reconciliation/run`, mendapat batas waktu hilir sendiri `BATCH_HTTP_TIMEOUT_MS` (bawaan 60000 ms, dari konfigurasi, bilangan bulat positif; env yang sama dibaca adapter dan `kong-config`). **Semua rute lain tetap `HTTP_TIMEOUT_MS` = 3000 ms.** NFR-12 tidak berubah untuk jalur nasabah, jalur tokenisasi, maupun panggilan ke Privacy.
2. Di adapter: rute ditandai `batch: true` di tabel rute; klien HTTP bersama menerima `timeoutMs` per permintaan (hanya diisi rute itu). POST bukan idempoten, jadi tetap tanpa retry.
3. Di Kong: satu service kedua (`gateway-adapter-batch`) dengan upstream yang sama, `read_timeout` dan `write_timeout` sebesar nilai yang sama, berisi hanya rute `~/reconciliation/run$` dengan plugin JWT yang sama. Rute lain tetap pada service semula.
4. Alasan: ini operasi batch admin yang durasinya tumbuh dengan jumlah transaksi sehari, bukan permintaan interaktif. Memanjangkan batas semua rute akan melonggarkan NFR-12 tanpa perlu.

## Konsekuensi dan batas

- Sambungan admin tertahan sampai 60 detik pada satu rute; ini bukan jalur nasabah dan dibatasi oleh peran `admin`.
- Run yang lebih dari 60 detik tetap diputus 503 sementara pekerjaan berlanjut di Reconciliation. Itu batas yang diketahui.
- **Kerja lanjutan (tidak dikerjakan di sini):** menjadikan run asinkron (202 dengan penanda status yang dapat dibaca), sehingga tidak ada sambungan yang menunggu. Itu mengubah kontrak `POST /reconciliation/run` dan butuh keputusan tersendiri.
- Durasi run per mode dicatat sebagai temuan pengukuran di `docs/hasil/`, tidak sebagai klaim kinerja.

## Bukti

Tes adapter (`services/gateway/test/batch-timeout.spec.ts`), tes konfigurasi Kong (`kong-config.spec.ts`, `kong-render.spec.ts`), tes klien (`packages/common/test/http.spec.ts`), dan `tests/docker/batch-timeout.docker.spec.ts` (lewat Kong, kedua mode: rute lain 503 dalam sekitar 3 detik, `run` menunggu lebih dari 6 detik dan menjawab 200). Mutasi: batas rute dikembalikan ke 3 detik membuat tes merah.
