# ADR-0013: tabel tautan `transaction_link` untuk token yang dipakai ulang (K-28)

- Status: Accepted (disetujui Fanny, 2026-10-21: opsi (b) digabung (d))
- Tanggal: 2026-10-21
- Pengambil keputusan: Fanny
- Terkait: PRD 6.2, 7.2, 7.4, 7.5, 11; K-28, K-29; ADR-0005, ADR-0010; spec privacy 4.1, 7.4, 7.7, 10

## Konteks

Kunci pakai ulang token aktif tidak memuat `transaction_id` (PRD 6.2), jadi baris `pseudonym_mapping` hanya menyimpan transaction id pertama. `generate_from_transaction` (P6/P7) mencari baris sumber lewat `idx_mapping_tx`; transaksi kedua dalam satu TTL tidak menemukan apa pun. Re-issue juga menimpa `transaction_id` dengan nilai permintaan, dan bentuk 3 memilih baris terbaru.

## Keputusan

1. Tabel baru `transaction_link` di Privacy DB, tanpa kolom identitas: `transaction_id`, `subject_type`, `service_id`, `purpose`, `pseudonym` (FK ke `pseudonym_mapping.pseudonym`), `created_at`. Kunci utama `(transaction_id, subject_type, service_id, purpose)`.
   - Kunci tidak hanya `transaction_id`: satu transaksi memiliki P1 (CUSTOMER) dan P2 (ACCOUNT), dan token hasil pertukaran (FRAUD, NOTIFICATION) membawa transaction id yang sama. Satu token per transaksi **per konteks**.
2. Setiap penerbitan atau pemakaian ulang token untuk sebuah transaction id menulis tautannya, di transaksi operasi yang sama: ulangan tidak berbuat apa-apa (aman terhadap permintaan bersamaan, `ON CONFLICT DO NOTHING`); transaction id yang sama dengan pseudonym lain pada konteks yang sama ditolak `IDEMPOTENCY_CONFLICT` (409, diaudit DENIED, seluruh operasi dibatalkan).
3. Bentuk 3 mencari baris sumber lewat tautan, tidak lagi memilih baris terbaru atau terawal. K-29: sumber `revoked` ditolak `REVOKED`; `expired` tetap boleh.
4. Re-issue mempertahankan `transaction_id` asli di baris baru (permintaan hanya mengisi bila kosong). Tautan transaksi permintaan berpindah dari token lama ke penggantinya, dan hanya dari token yang digantikan; tautan lain tidak disentuh.
5. Retensi menghapus tautan baris yang dikosongkan, di transaksi yang sama; baris audit tidak berubah.
6. `privpay_app` mendapat `DELETE` hanya pada `transaction_link` (pengecualian dari "tanpa DELETE pada tabel mana pun"); `privpay_auditor` tidak punya hak apa pun di sana.

## Konsekuensi

- Selisih dari DDL PRD 11 dicatat di `PRD_ERRATA.md` E-30. Tabel 1/2/3/5/6, panjang token, tiga kunci, dan TTL tidak berubah.
- Migrasi `0003_transaction_link.sql` maju-saja; tanpa pengisian awal (belum ada data nyata).
- Permintaan ulang dengan transaction id yang sama setelah token pertamanya kedaluwarsa, lewat `POST /pseudonymize` bentuk 1, ditolak; jalurnya re-issue. Transaction Service (M4) harus memakainya.
- `revoke_subject` (M3-02) wajib ikut mengosongkan atau menghapus tautan baris yang dikosongkannya.
