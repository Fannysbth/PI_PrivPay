# Penjelasan untuk pemula: dua mode, satu kode (M5-01)

PrivPay punya dua "kondisi" yang dibandingkan di skripsi: **baseline** (data asli disimpan apa adanya) dan **proposed** (data diganti pseudonim oleh Privacy Service). Kode bisnis sama untuk keduanya; hanya "colokan" yang berbeda (ADR-0006). Status: colokan sudah ada (M5-01), tetapi belum dipasang ke layanan yang berjalan (M5-02) dan Gateway belum punya jalur lurus (M5-03).

## Berkas colokan

| Apa | Berkas |
| --- | --- |
| Port subjek (kontrak: "beri aku rujukan pelanggan untuk Fraud / Notification / terbitkan ulang") | `services/transaction-service/src/transaction/ports.ts` (`SubjectReferencePort`) |
| Adapter **proposed** (menukar token lewat Privacy) | `services/transaction-service/src/proposed/subject-references.ts` |
| Adapter **baseline** (menyerahkan `customer_id` apa adanya, tidak memanggil siapa pun) | `services/transaction-service/src/baseline/subject-references.ts` |
| Repositori (satu kelas untuk kedua mode) | `services/<layanan>/src/<domain>/repository.ts` (Transaction) dan sejenisnya |
| SQL yang menyebut kolom subjek, per mode | `services/<layanan>/src/proposed/subject-sql.ts` dan `src/baseline/subject-sql.ts` |
| Tabel, per mode | `services/<layanan>/migrations/proposed/` dan `migrations/baseline/` |

Kode bisnis tidak boleh mengimpor folder `proposed/` atau `baseline/`; tes `tests/repo/mode-folders.spec.ts` menjaganya. Adapter baseline menolak dibuat bila `PRIVACY_MODE` bukan `baseline` (karena ia memegang data asli).

## Satu panggilan transaksi

**Mode baseline** (rancangan, setelah M5-02 dan M5-03):

1. Gateway memeriksa JWT dan laju seperti biasa, lalu meneruskan `customer_id` dan nomor rekening **apa adanya**; Privacy tidak dipanggil.
2. Transaction menyimpan `customer_id` dan `account_number` di tabelnya.
3. Untuk jumlah besar, Transaction bertanya ke Fraud; port baseline memberi `customer_id` langsung. Fraud menyimpan riwayat per `customer_id`.
4. Notification juga menerima `customer_id` dan mencari nomor HP-nya per `customer_id`.
5. Status tidak dikabarkan ke Privacy (tidak ada Privacy). Hasilnya sama: `COMPLETED`, `HELD`, atau `FAILED`.

**Mode dinamis (proposed)**:

1. Gateway meminta Privacy menerbitkan token pseudonim untuk pelanggan dan rekening; hanya token yang diteruskan.
2. Transaction menyimpan token itu (tidak ada kolom identitas).
3. Untuk Fraud, Transaction meminta Privacy menukar token menjadi token khusus Fraud; Fraud hanya melihat token itu. Begitu pula token khusus Notification.
4. Bila token kedaluwarsa di tengah jalan, Transaction meminta Privacy menerbitkan ulang lalu mencoba sekali lagi.
5. Status akhir dikabarkan ke Privacy. Identitas asli hanya ada di brankas Privacy, terenkripsi.

Perbedaan yang diukur adalah langkah 1, 3, dan 4 (mekanisme privasi); autentikasi, otorisasi, batas laju, validasi, dan logika keputusan sama persis.
