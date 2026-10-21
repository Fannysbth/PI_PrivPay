# M2-12: Lapisan HTTP Privacy (`/pseudonymize`, `/re-issue`, `/transaction-status`)

- Milestone: M2 (tiket inti; ditambahkan di Gerbang 2, disetujui Fanny)
- Spec: privacy-service.md 2, 3, 4.1, 4.4, 4.7; ADR-0007; platform-dan-ci.md 7
- Bergantung pada: M2-05, M2-06, M2-07, M1-02
- Ukuran: M
- Cabang: `feat/m2-12-privacy-http-layer`
- Cara kerja: /tdd, dua review `/code-review`, mutasi pada pengaman utama

## Tujuan

Controller tipis di depan `TokenService` dan `TransactionStatusService`. `requestingService`, `actorId`, dan peran aktor hanya dari klaim JWT yang sudah diverifikasi (invarian 7).

## Kriteria penerimaan

- [ ] Resolver JWKS (`JwksKeys`, `unverifiedKid`) ada di `packages/common`; Gateway dan Privacy memakai satu salinan.
- [ ] Penjaga M0-06 berupa daftar putih per layanan (`@nestjs/common`, `reflect-metadata`, `zod` untuk gateway dan privacy-service), tetap ketat untuk layanan lain.
- [ ] Tanpa token, token kedaluwarsa, `alg=none`, HS256 bertanda kunci publik, tanda tangan kunci asing: 401, tanpa baris audit atau mapping (TK-19).
- [ ] AZ-18, AZ-19, AZ-20, AZ-23, AZ-24 di tingkat HTTP; field `requesting_service` di body ditolak 422.
- [ ] Field tak dikenal, bentuk campuran, body di atas 16 KiB: 422 (K-12), tidak diaudit.
- [ ] Basis data atau IdP tidak tersedia: 503 `SERVICE_UNAVAILABLE`, tanpa keadaan setengah jadi (invarian 8).
- [ ] Log permintaan tidak memuat subjek, token, atau JWT.
