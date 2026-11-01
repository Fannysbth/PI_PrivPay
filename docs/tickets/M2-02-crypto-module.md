# M2-02: Modul `Crypto`: AES-GCM dengan AAD baris, blind index, token, kunci

- Milestone: M2
- Spec: privacy-service.md 5
- Bergantung pada: M1-02
- Ukuran: M
- Cabang: `feat/m2-02-crypto-module` (satu tiket, satu PR kecil, Conventional Commits)
- Cara kerja: /implement

## Tujuan

Kripto Privacy Service hanya dengan `node:crypto` sesuai ADR-0011.

## Kriteria penerimaan

- [ ] Format `key_version(uint16) || IV(12) || ciphertext || tag(16)`; IV acak per penulisan; round trip; perubahan satu bit pada versi/IV/ciphertext/tag ditolak (S-31, NFR-05).
- [ ] AAD terikat baris (`mapping` + jenis + `id`; `vault` + kolom + `id`): pindah antar baris, jenis, dan kolom ditolak (T-16); `id` dibangkitkan aplikasi.
- [ ] Penyandian dengan awalan panjang untuk `subject_lookup` dan token; token `PSEU-` + 8 heks; blind index deterministik dan berbeda per jenis dan kunci.
- [ ] Tiga kunci 32 byte dan saling berbeda, jika tidak pemuatan gagal (FR-30, S-03); rotasi `subject_lookup` tidak merusak dekripsi.

## Tes dulu (tdd)

Seam yang diuji disepakati sebelum tes ditulis; tiap tes ditulis lebih dulu, terbukti gagal dengan alasan yang benar, lalu implementasi minimal. Nama tes memuat ID kriteria.

- Unit murni; ulang hasil prototipe P-3 sebagai tes tiket dan tes penjaga (AAD dikosongkan → tes gagal).

## Catatan keamanan

- Tidak ada kripto buatan sendiri dan tidak ada pustaka kripto tambahan (S-32); kunci tidak pernah dicatat.

## Definisi selesai

Lihat `README.md` (definisi selesai per tiket, aturan proyek). Tambahan tiket ini: kriteria di atas, dan untuk tiap endpoint yang dibangun, tes otorisasi negatif `AZ-nn` dari `docs/spec/endpoints.md`.
