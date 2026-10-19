# M0-02: `common`: config, Clock, error, logger berredaksi

- Milestone: M0
- Spec: platform-dan-ci.md 3, 4, 5, 9
- Bergantung pada: M0-01
- Ukuran: M
- Cabang: `chore/m0-02-common-core` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Modul dasar bersama: konfigurasi tervalidasi dengan `*_FILE`, `Clock` yang bisa disuntik, kelas error domain dengan delapan kode klien, dan logger yang tidak dapat mencatat PII.

## Kriteria penerimaan

- [ ] `config`: start gagal bila variabel atau berkas rahasia hilang, kosong, atau panjang salah; pesan error tanpa nilai; nilai mentah rahasia di env ditolak; field tak dikenal ditolak (NFR-22, E-09).
- [ ] `clock`: `SystemClock` UTC dan `FakeClock` dengan `advance` (NFR-20); tes tanpa `sleep` nyata.
- [ ] `errors`: `DomainError(code, reason, httpStatus)`, `toClientError` menghasilkan tepat delapan kode klien tanpa `reason`; bentuk `{error:{code,reason,message,request_id}}`; kegagalan tak dikenal menjadi 500 `INTERNAL_ERROR` (NFR-10, NFR-25, ADR-0008).
- [ ] `logger`: hanya field pada tipe `LogFields`; nilai kenari pada field terlarang (`phone`, `nik`, `nama`, `email`, `rekening`, `customer_id`, `subject_id`, `authorization`) tidak muncul pada keluaran (NFR-15, NFR-16).

## Catatan hasil implementasi

- `DomainError(reason)`: kode, status, dan pesan diturunkan dari tabel `REASONS` (lebih ketat daripada `DomainError(code, reason, httpStatus)` di spec awal); `toWireError`/`toClientError` menerima `requestId`. Respons klien tidak memuat `reason`, respons antar-layanan memuatnya.
- `strictPrefixes` bersifat opt-in per layanan; pemeriksaan `TZ=UTC` proses dan penutupan anggun ada di M0-06; pemeriksaan tiga kunci berbeda (FR-30) ada di M2-02 (`readKey` hanya memeriksa panjang dan heks).
- Lapis `redact` pino dibuang (lihat `platform-dan-ci.md` bagian 5).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Seam: interface publik `loadConfig`, `Clock`, `toClientError`, `createLogger`.
- Tes gagal dulu untuk tiap kriteria, mis. `M0-02 loadConfig rejects a secret whose file is empty`, `M0-02 logger never emits a canary NIK`.

## Catatan keamanan

- `logger` menolak kunci di luar daftar putih saat kompilasi; redaksi adalah lapis kedua.
- Pesan validasi env tidak mencetak nilai.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, CLAUDE.md). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
