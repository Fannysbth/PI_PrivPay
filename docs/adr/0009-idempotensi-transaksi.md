# ADR-0009: Idempotensi POST /transaction tanpa sidik jari rahasia

- Status: Accepted (disetujui Fanny, Fase 1b, 2026-10-19)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: FR-36, NFR-23, TF-08, T-13, Q-14, D-13 (tiga kunci terpisah), D-12

## Konteks

`POST /transaction` wajib idempoten terhadap `Idempotency-Key`. Sidik jari isi permintaan tidak boleh berupa hash polos dari nomor rekening mentah (dapat di-brute-force dan menjadi turunan PII di transaction-db). Menambah kunci HMAC baru melanggar "tiga kunci terpisah" (D-13), dan meminta Privacy menghasilkan digest berarti menyebarkan pseudonim statis ke hilir. Permintaan paralel yang identik juga harus menghasilkan nol transaksi ganda.

## Keputusan

1. Kunci unik pada `transactions.idempotency_key`; tidak ada kolom atau kunci baru.
2. Saat replay, Transaction membandingkan `customer_pseudonym`, `account_pseudonym`, `merchant_id`, `amount`, dan `geohash` dengan baris tersimpan. Token dipakai ulang selama TTL (`TTL_PAYMENT_PROCESSING`, 900 detik), sehingga replay dalam jendela itu membawa token yang sama dan perbandingan akurat.
3. Sama persis: `200` dengan isi yang sama, tanpa transaksi baru. Berbeda: `409 IDEMPOTENCY_CONFLICT`. Replay setelah token berganti (di luar jendela TTL) juga `409`; ini gagal aman dan tidak pernah membuat transaksi ganda.
4. Paralel: `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Yang kalah membaca baris pemenang dan menunggu singkat (maksimum `HTTP_TIMEOUT_MS`) sampai statusnya terminal, lalu mengembalikan `200`. Bila belum terminal, kembalikan `409 IDEMPOTENCY_CONFLICT` yang aman diulang.

## Bukti prototipe Fase 2 (sekali pakai, `node --test`, 9 tes lulus)

Pada model dalam memori (bukan database; token dan TTL disimulasikan, Transaction memakai `Map`), tanpa sidik jari rahasia, TF-08 tetap dapat menguji "isi beda menghasilkan 409": kunci sama dengan `amount`, `merchant_id`, `geohash`, rekening sumber berbeda, atau pelanggan berbeda semuanya `409 IDEMPOTENCY_CONFLICT` tanpa mengembalikan data transaksi pertama. Isi sama menghasilkan `200` dengan `transaction_id` asli dan satu baris. Replay setelah re-issue di tengah proses dalam jendela TTL tetap `200` (re-issue memakai ulang token aktif). Replay di luar jendela tanpa re-issue `409` dan tidak membuat transaksi ganda. Tidak ada rekening mentah atau `customer_id` yang tersimpan. Mutasi manual satu kali (tidak dikomit): perbandingan dipaksa selalu "sama", dan tes 409 gagal. Unique key sungguhan di PostgreSQL belum diuji. Perilaku paralel (`ON CONFLICT`) belum diuji di prototipe ini dan menjadi tes integrasi M4.

## Konsekuensi

- Keterbatasan (dicatat): jendela idempotensi efektif sama dengan TTL P1; klien yang mengulang setelah itu menerima 409 meski isinya identik.
- Dampak pada keamanan dan privasi: tidak ada turunan rekening mentah di transaction-db; tidak ada kunci baru.
- Dampak pada pengujian: TF-08 (sekuensial dan paralel, NFR-23), kasus replay di luar jendela (Clock palsu), dan kasus kunci sama dengan isi beda.
- Yang harus diubah: spec `transaction`, bagian keterbatasan (PRD 20 / README akhir).

## Kapan ditinjau ulang

Bila jendela idempotensi harus lebih panjang dari TTL P1.
