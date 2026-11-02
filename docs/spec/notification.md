# Spesifikasi: Notification Service dan SMS simulator

Sumber: PRD 9 (A4, B7..B10), 10 (kontrak notifikasi), 11, 13 (FR-08, 19, 20); D-08; ADR-0004, 0006. **[K-nn]** diterima Fanny (bawaan, Gerbang 3).

## 1. Tanggung jawab

Menyimpan kontak (nomor HP) terhadap pseudonim domain berumur panjang (P5) dan mengirim SMS notifikasi generik. Notification adalah **satu-satunya layanan di luar Privacy dan IdP yang boleh menyimpan HP** (pengecualian sadar D-08; E(s) Notification = 1/6). Ia tidak pernah menerima `customer_id`, NIK, nama, atau rekening pada mode proposed dan tidak menyimpan isi pesan.

## 2. Modul dan seam

| Modul | Interface | Catatan |
| --- | --- | --- |
| `NotificationService` | `register(req)`, `send(req)` | menyusun teks dari templat tetap; satu-satunya modul yang menyentuh HP |
| `ContactRepository` | seam repositori per mode: `upsert`, `find` | proposed berkunci `pseudonym`, baseline berkunci `customer_id` |
| `SmsGateway` | `send(to, text)` | **dua adapter nyata**: HTTP ke `sms-simulator` dan palsu untuk tes |
| `PrivacyClient` | `resolveDomain(notifToken)` | adapter proposed; adapter baseline (M5-02, N-44) mengembalikan token apa adanya, jadi tidak memanggil Privacy |

## 3. Kontrak

Konvensi umum: `platform-dan-ci.md`.

### 3.1 `POST /notification/register`

Pemanggil `API_GATEWAY`. Permintaan `{notification_domain_id, phone, channel}`: `notification_domain_id` `Pseudonym`; `phone` `^08[0-9]{8,12}$`; `channel` `"SMS"`. Respons 201 `{notification_domain_id, registered_at}`. **Idempoten (upsert berkunci pseudonim domain)** sehingga aman diulang pada pendaftaran (ADR-0005, A4): permintaan ulang memperbarui `phone` dan mengembalikan 200 dengan bentuk yang sama.

**[M4-05]** `registered_at` tetap saat pendaftaran pertama pada pengulangan (hanya `phone` dan `channel` yang berubah); 201 dan 200 dibedakan oleh `xmax = 0` pada upsert yang sama (tanpa pembacaan terpisah).

### 3.2 `POST /notification/send`

Pemanggil `TRANSACTION`. Permintaan `{notif_token, template, amount, transaction_id}`: `template` ∈ `TX_COMPLETED`, `TX_HELD_VERIFY`, `TX_REJECTED`; `amount` bilangan bulat ≥ 1. Respons 200 `{status: "SENT"|"FAILED"}`.

Langkah: (1) `POST /resolve-domain` ke Privacy dengan JWT `NOTIFICATION` → `notification_domain_id` (hasilnya pseudonim domain, bukan identitas); kegagalan Privacy → `FAILED`; (2) cari kontak berkunci pseudonim domain, tidak ada → `FAILED`; (3) kirim SMS lewat `SmsGateway` (HP dari `contact_registry` + teks); (4) tulis satu baris `notification_log (sender_pseudonym=notif_token, recipient_pseudonym=notification_domain_id, template, channel, status)` tanpa isi pesan. **Operasi tidak idempoten** (SMS ganda): tidak ada retry otomatis pada langkah 3 dan tidak ada pengiriman ulang otomatis (PRD 20 no. 12); retry HTTP boleh hanya untuk `resolve-domain` (idempoten).

**[M4-05, N-30, N-31]** Kegagalan `resolve-domain` (langkah 1) tidak menulis baris `notification_log`, karena `recipient_pseudonym` NOT NULL dan penerimanya belum diketahui; Transaction yang mencatatnya dengan `transaction_id`. Hanya kegagalan Privacy dan SMS yang menjadi `FAILED`; galat basis data tetap galat (5xx), bukan notifikasi gagal. Teks dibentuk dari templat tetap tanpa nama atau identitas, hanya nominal: mis. `TX_COMPLETED`: "Transaksi Rp{amount} berhasil."; `TX_HELD_VERIFY`: "Transaksi Rp{amount} sedang diverifikasi."; `TX_REJECTED`: "Transaksi Rp{amount} ditolak." Teks bukan dicatat di basis data maupun log (dapat menjadi profil).

Pada mode baseline: `send` menerima `customer_id` alih-alih `notif_token`, tanpa langkah 1; kontak dicari berkunci `customer_id` (ADR-0006). **[N-57, G4/G6]** Baseline = pilihan B (Tabel IV): pendaftaran (langkah A4) membawa `nik`, `nama`, dan `account_number` selain `customer_id` dan HP, dan `contact_registry` baseline menyimpannya (migrasi baseline-only 0003; kolom nullable). Pesan tidak pernah membacanya. Email tidak diteruskan (G2). Pendaftaran ulang yang hanya membawa HP mengganti HP dan mempertahankan atribut lain (`COALESCE`).

## 4. SMS simulator

Layanan NestJS kecil, hanya `127.0.0.1`: `POST /sms {to, text}` merekam pesan **di memori** dan mengembalikan 202; `GET /__test/messages` hanya aktif bila `SMS_SIMULATOR_TEST_ENDPOINTS=true` (env uji) dan tidak ada di lingkungan lain. **[M4-05, N-30]** Rute yang tidak ada dijawab platform dengan jawaban seragamnya, 422 `VALIDATION_ERROR` (bukan 404: delapan `code` klien tidak memuat 404); yang diuji adalah rute itu tidak ada dan tidak memberi pesan. Nilai selain `true`/`false` pada kedua sakelar menghentikan start (gagal cepat). Tidak menulis nomor HP atau teks ke log atau disk; dapat dikosongkan lewat `DELETE /__test/messages` (juga hanya pada env uji). Mendukung injeksi kegagalan (`SMS_SIMULATOR_FAIL=true`) untuk tes. HP "terkirim" diverifikasi di tes lewat `GET /__test/messages`.

## 5. Invarian dan kasus gagal

HP hanya di `contact_registry` dan di perjalanan ke SMS; tidak di log, metrik, atau pesan error; `notification_log` tanpa isi pesan; Notification tidak dapat membuka identitas (`resolve-domain` hanya menghasilkan pseudonim domain). Kasus: Privacy mati → `FAILED` (Transaction tetap `COMPLETED`); kontak tidak ditemukan → `FAILED`; SMS simulator mati → `FAILED`; token kedaluwarsa/dicabut → penolakan Privacy → `FAILED`; pemanggil salah → 403.

## 6. Kriteria penerimaan

| Tiket | Kriteria | ID |
| --- | --- | --- |
| M4-05 | register idempoten (201 lalu 200), `contact_registry` berkunci pseudonim, validasi `phone`/`channel`; hanya `API_GATEWAY` | FR-19, TF-01 |
| M4-05 | send: alur `resolve-domain`→kontak→SMS→log; tanpa HP/identitas di log dan `notification_log`; muatan masuk hanya token; `FAILED` pada setiap kegagalan dan tidak ada retry pengiriman | FR-08, FR-20, TF-02 (notifikasi terkirim terlihat di simulator) |
| M4-05 | pemindai kenari: HP hanya ditemukan di `contact_registry` dan simulator SMS | S-43, E(s) Notification = 1/6 |
| M4-05 | sms-simulator: endpoint uji hanya aktif dengan env uji; tidak ada HP di log | D-08 |
| M5-01 | adapter baseline | FR-23 |

## 7. Di luar cakupan

Kanal selain SMS, templat bebas, pengiriman ulang otomatis, penyedia SMS nyata, preferensi pengguna.

## 8. Keputusan spec (diterima Fanny, bawaan, Gerbang 3)

K-21 teks templat SMS dan nama env `SMS_SIMULATOR_TEST_ENDPOINTS`/`SMS_SIMULATOR_FAIL`.
