# M0-03: `common`: klien HTTP antar-layanan (timeout, retry, request id)

- Milestone: M0
- Spec: platform-dan-ci.md 6
- Bergantung pada: M0-02
- Ukuran: M
- Cabang: `chore/m0-03-common-http-client` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Klien HTTP bersama dengan timeout, retry berbackoff dan jitter hanya untuk operasi idempoten, dan penerusan `X-Request-Id`.

## Kriteria penerimaan

- [ ] Timeout `HTTP_TIMEOUT_MS` (3000) dan maksimum `HTTP_MAX_RETRY` (2) dengan backoff eksponensial + jitter (NFR-12, qa E-03).
- [ ] Retry hanya bila `idempotent: true` dan hanya untuk kegagalan jaringan, timeout, 502/503/504; 4xx tidak diulang; tidak mengikuti redirect.
- [ ] `X-Request-Id` diteruskan atau dibangkitkan; URL hanya dari konfigurasi (NFR-16, API7).
- [ ] Cache token layanan sampai `exp − 30 detik` dengan penguncian (NFR-21).

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Seam: `HttpClient.request` terhadap server uji lokal dengan injeksi keterlambatan dan kegagalan; `FakeClock` dan `FakeDelay`, tanpa `sleep` nyata.

## Catatan keamanan

- Header `Authorization` dan `X-Actor-Token` tidak pernah dicatat; kegagalan tidak membocorkan isi body ke log.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
