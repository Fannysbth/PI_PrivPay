# Tinjauan keamanan M5 (2026-10-23)

Cakupan: seluruh kode M5, sesi 1 dan sesi 2 (`7cde929..HEAD`, terutama `345c6e7..c286dc8`): adaptor dan skema baseline per layanan, pengalih `PRIVACY_MODE`, aturan env, `GET /transaction/{id}` dengan `account_number` pada baseline (N-46), port Gateway baseline, `FRAUD_HISTORY_DAYS` (N-45), suite kesetaraan E2E. `/security-review` dijalankan atas `345c6e7..HEAD`; `/code-review` atas `main..HEAD`.

## Hasil

`/security-review`: tidak ada temuan dengan keyakinan 8 atau lebih, jadi tidak ada perubahan kode dari tinjauan ini. Satu catatan berkeyakinan 3, tidak diperbaiki: `DomainError(..., 'subject')` di port Gateway baseline hanya ada di baseline dan tetap di belakang `ErrorMasker`.

`/code-review` (9 temuan): 3 diperbaiki (commit `c286dc8`): detail baseline dibaca dalam satu kueri atomik (`findDetailWithAccount`); `FRAUD_HISTORY_DAYS` berbatas atas 3650; port Gateway baseline menolak identitas berbentuk salah di tepi. Smoke test yang menolak konfigurasi baru ditemukan dan diperbaiki (`9024b0f`). Ditolak dengan alasan: N+1 panggilan Reconciliation baseline ke Transaction (volume prototipe, dicatat di N-46); jendela proposed vs umur token (ancaman validitas N-45, terdokumentasi); nama kawat `customer_token`/`account_token`/`pseudonym` yang berisi identitas di baseline (kontrak antar-layanan tidak diubah tanpa ADR; dicatat); ternary pemilihan adaptor yang berulang di akar komposisi (diizinkan ADR-0006, helper `byMode` hanya menambah lapisan); `PRIVACY_SERVICE_URL=` kosong dilaporkan "empty" oleh `loadConfig` (perilaku bersama).

## Yang dilacak

Pabrik baseline selalu memanggil `assertBaselineMode`; ternary akar komposisi memilih baseline hanya bila `PRIVACY_MODE === 'baseline'`; `PRIVACY_MODE` wajib `z.enum`; `privacyUrlMatchesMode` pada empat layanan dan penolakan baseline di Privacy Service; di proposed tepi HTTP hanya menerima `PSEU-XXXXXXXX`; `account_number` hanya untuk pemanggil `RECONCILIATION` dan hanya bila `discloseAccount` (diatur dari mode di akar komposisi); semua SQL baru berparameter; urutan pemanggil sebelum badan tidak berubah; alasan error baru adalah konstanta.

## Bukti butir baru

| Butir | Status | Bukti |
| --- | --- | --- |
| <a id="s-75"></a>S-75 | ✔ lulus | `mode.integration.spec.ts` di Fraud, Notification, Transaction, Reconciliation; `gateway-baseline.spec.ts`; `config.spec.ts` Privacy; `packages/common/test/mode.spec.ts`; smoke proses nyata (`built-service.smoke.spec.ts`: baseline + `PRIVACY_SERVICE_URL`, proposed tanpa itu, dan Privacy di baseline keluar dengan kode 1 dan hanya menyebut nama variabel). Mutasi: penolakan env dan pemilihan mode dihapus, tes gagal (Fraud 3, Notification 3, Transaction 4, Reconciliation 4, Gateway 7, Privacy 1). |
| <a id="s-76"></a>S-76 | ✔ lulus | `services/gateway/test/e2e/equivalence.integration.spec.ts`: setelah skenario yang sama, proposed hanya menyisakan `hp@notification-db` dan `hp@sms`; baseline menyisakan juga `customer_id@transaction-db`, `rekening@transaction-db`, `customer_id@fraud-db`, `customer_id@notification-db` (kontrol positif pemindai); `stack.attempted` membuktikan Privacy tidak pernah dicoba di baseline. Mutasi: Gateway proposed memakai port baseline, tiga tes gagal. |
| <a id="s-77"></a>S-77 | ✔ lulus | tes yang sama: jawaban, baris (status, keputusan, skor, pemeriksa), dan pesan SMS identik di kedua mode (TF-02, TF-03, TF-04, TF-05, TF-09, TF-11). Mutasi: klien Privacy baseline mengembalikan `null`, tes perbandingan gagal. |

## Yang belum diperiksa

- Isi log aplikasi pada mode baseline tidak diasersi (hanya kontras pemindai atas basis data, pesan SMS, dan jawaban); invarian 6 berlaku untuk proposed.
- Ketidakcocokan mode antar-layanan yang berjalan (mis. Gateway proposed dengan Transaction baseline) tidak dicegah saat start (tiap layanan hanya tahu modenya sendiri); hasilnya gagal tertutup lewat validasi bentuk, tetapi tidak ada pemeriksaan lintas proses (N-47).
- Fail-closed dengan Docker (M7), Semgrep/CI (S-41).
