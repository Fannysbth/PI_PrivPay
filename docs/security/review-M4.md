# Tinjauan keamanan M4 (2026-10-22)

Cakupan: seluruh kode M4, dari akhir M3 (`857cad1`) sampai M4-10: Transaction, Fraud, Notification, simulator SMS, Reconciliation, simulator bank, registrasi dan penjadwal di Gateway/common, perubahan Privacy (ADR-0014). Metode: `/security-review` atas seluruh rentang (agen baca-saja, kode saja, tanpa menjalankan tes), ditambah tinjauan per gerbang (Gerbang 1 sampai 4 dan M4-10, masing-masing `/security-review` atas diff cabangnya).

## Hasil

Tidak ada temuan dengan keyakinan 8 atau lebih, jadi tidak ada perubahan kode dari tinjauan ini. Dua catatan berkeyakinan 3, tidak diperbaiki:

- Endpoint uji tanpa otentikasi bila benderanya menyala (`GET/DELETE /__test/messages` simulator SMS, `POST /simulate/settlement` simulator bank). Bendera hanya menyala bila `*_TEST_ENDPOINTS=true` (variabel lingkungan tepercaya, mati bawaan, nilai selain `true`/`false` menghentikan start). Bila pernah dinyalakan di lingkungan yang dapat dijangkau, ikat ke loopback atau minta token layanan.
- `POST /register` membedakan nama pengguna terpakai (422) dari kegagalan IdP (503). Pendaftaran memang harus menolak nama terpakai; dibatasi laju per alamat sumber (K-14).

Catatan desain yang sudah dicatat sejak M3 (di luar lingkup spek transaction): `source_account` pelanggan tidak diperiksa kepemilikannya terhadap token pelanggan.

## Yang dilacak

Pemeriksa pemanggil per rute (`authenticate`: `azp` dari daftar tetap, `aud` harus layanan itu, peran dari token aktor, token pelanggan hanya di Gateway, `sub` paling 64 karakter); semua SQL berparameter (kursor keyset, `unnest`, `= ANY`); jalur dan URL keluar (basis tetap dari konfigurasi, bagian dinamis dibatasi regex atau di-encode); log, metrik, dan jawaban (hanya token, `transaction_id`, `reason`); pembukaan identitas (hanya permintaan, persetujuan admin lain, lalu `/de-pseudonymize`, tujuan tetap, jawaban divalidasi terhadap Tabel 5, tidak disimpan); penjadwal (log hanya nama job dan `reason`, mulai sesudah `listen`, berhenti sebelum kolam ditutup).

## Bukti butir yang berubah status pada penutup M4

| Butir | Status | Bukti |
| --- | --- | --- |
| <a id="s-20"></a>S-20 | ✔ lulus | `services/reconciliation-service/test/disclosure-flow.integration.spec.ts` (TK-22: jawaban `audit-request` hanya token P7, nominal, status; pemindai kenari nol temuan) dan `audit-http.integration.spec.ts` (satu baris `audit_requests` dan satu audit Privacy per permintaan). |
| <a id="s-27"></a>S-27 | ✔ lulus (diulang di M6) | `disclosure-flow.integration.spec.ts` T-14: atribut yang dibuka tidak ada di reconciliation-db, log, metrik, audit Privacy, maupun brankas yang jelas; kontrol positif: auditor menerimanya. |
| <a id="s-30"></a>S-30 | ✔ lulus | `identity-vault.integration.spec.ts` (FR-25) dan `services/gateway/test/e2e/registration.integration.spec.ts` (FR-42): NIK, nama, rekening dari pendaftaran tidak ada dalam bentuk jelas di tabel mana pun, brankas berisi ciphertext. |
| <a id="s-38"></a>S-38 | ✔ lulus (E(s) di M6) | tes skema `transaction-schema`, `fraud-schema`, `notification-schema`, `reconciliation-schema` (tidak ada kolom yang dapat memuat identitas; `CHECK` menolak nomor rekening di kolom token) dan pemindai E2E atas kelima basis data. |
| <a id="s-43"></a>S-43 | ✔ lulus (M4; diulang di M6) | `scenarios.integration.spec.ts` dan `registration.integration.spec.ts`: pemindai kenari atas log dan metrik delapan layanan, audit, dan jawaban dalam alur pendaftaran, pembayaran, hold, review; HP hanya di Notification dan simulator SMS. |
| <a id="s-52"></a>S-52 | ✔ lulus | `transaction-service/test/clients.spec.ts` dan `orchestration.integration.spec.ts` (Fraud dan Notification satu panggilan walau hilir lambat, 503, atau galat jaringan; Privacy dan Transaction diulang paling dua kali); `reconciliation-service/test/clients.spec.ts` (`/de-pseudonymize` satu panggilan). |
| <a id="s-54"></a>S-54 | ✔ lulus | `transaction-processor.integration.spec.ts` (2 dan 20 permintaan identik serentak, 20 putaran, satu baris; kunci sama isi beda 409) dan `scenarios.integration.spec.ts` (kunci sama dua kali = satu transaksi, satu pesan). |

## Butir yang tetap belum atau sebagian, dengan alasan

- S-41 ◐: SQL berparameter terbukti oleh tinjauan; Semgrep di CI belum berjalan.
- <a id="s-42"></a>S-42 ◐: lapis Gateway TK-02..05, TK-08 kini lewat Reconciliation sungguhan; TK-01, 06, 09, 13, 14, 15 hanya lapis layanan dan relay jawaban kawat sampai Newman (M6-01).
- S-44 ◐: redaksi log Kong menunggu fase Docker.
- <a id="s-50"></a>S-50 ◐: fail-closed teruji di aplikasi lokal (Privacy mati = 503, tidak ada baris dan pesan, M4-09); pengujian dengan compose menunggu Docker (M7), tidak dinyatakan lulus.
- S-07 ◐, S-08 ◐: tidak berubah. S-04..S-06, S-61..S-65, S-70..S-73: menunggu Docker, CI, atau M6.
