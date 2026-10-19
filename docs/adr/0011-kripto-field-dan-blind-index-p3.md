# ADR-0011: Enkripsi field, blind index, dan pengikatan ciphertext ke baris (hasil prototipe P-3)

- Status: Accepted (disetujui Fanny, 2026-10-19; pengikatan AAD ke `id` baris diterima setelah lulus tes pindah-antar-baris dan antar-kolom)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: PRD 6, 6.2, FR-25, FR-30, NFR-04, NFR-05, S-03, S-31, S-32, T-02, T-16, D-13, ADR-0004

## Konteks

P-3 menguji AES-256-GCM dengan AAD, blind index HMAC, dan pencarian lewat `subject_lookup` di PostgreSQL sungguhan, hanya dengan `node:crypto`, dengan tiga kunci yang berbeda. PRD 6.2 menetapkan `AAD = subject_type` (mapping) dan nama kolom (brankas); prototipe menunjukkan AAD itu belum mengikat ciphertext ke barisnya.

## Keputusan

1. **Format blob:** `key_version(uint16 BE) || IV(12 byte acak per penulisan) || ciphertext || tag(16)`. Lebar `key_version` mengikuti kolom `SMALLINT`.
2. **Penyandian "||":** setiap bagian pada rumus token (`K_token`) dan `subject_lookup` (`K_index`) diberi awalan panjang 4 byte (big-endian). Penggabungan polos ambigu: ("CUST-1","2") dan ("CUST-12","") bertabrakan. Format token `PSEU-` + 8 heks, panjang token, dan tiga kunci tidak berubah.
3. **AAD terikat baris:** `id` baris adalah UUID yang dibangkitkan aplikasi sebelum INSERT. Mapping: AAD = `'mapping'`, `subject_type`, `id`. Brankas: AAD = `'vault'`, nama kolom, `id`; semuanya disandikan dengan awalan panjang. Ini menyimpang dari teks PRD 6.2 (`AAD = subject_type`) dan dicatat di `PRD_ERRATA.md` (E-21).
4. **Pengikatan ke `subject_lookup` tidak dipakai:** nilai itu berubah saat rotasi `K_index` (prosedur tertulis PRD 6.2), sehingga ciphertext akan tak terbaca.
5. **Dua pool koneksi** dan tiga kunci terpisah tidak berubah (FR-30): panjang 32 byte dan saling berbeda, bila tidak pemuatan gagal.

## Hasil (15 dari 15 tes P-3 lulus; PostgreSQL 18, peran `privpay_app`)

- **Integritas:** perubahan satu bit pada versi, IV, ciphertext, atau tag, pemotongan, dan blob terlalu pendek ditolak. 2000 enkripsi bernilai sama menghasilkan 2000 IV berbeda.
- **Pindah antar baris (diuji dengan tes yang gagal dulu):** sebelum pengikatan, empat tes baru gagal dengan `Missing expected exception`; sesudahnya lulus. Ciphertext mapping yang dipindah ke baris lain dengan jenis subjek sama ditolak; ciphertext brankas yang dipindah antar pelanggan atau antar kolom (`nik` ke `nama`) ditolak.
- **Pindah langsung di database:** dengan peran pemilik skema, ciphertext ditukar antar baris `pseudonym_mapping`, antar kolom `identity_vault` dalam satu baris, dan antar pelanggan; pembacaan lewat `privpay_app` lalu ditolak pada semua kasus, sedangkan sebelum penukaran semuanya terbaca.
- **Rotasi `K_index`:** mengganti `subject_lookup` suatu baris tidak mengganggu dekripsi ciphertext yang terikat `id`.
- **Basis data:** dump `subject_id_enc` tidak memuat `customer_id` mentah (FR-25); pencarian lewat `subject_lookup` menemukan dan mendekripsi barisnya; `chk_purged` menolak pengosongan setengah (`23514`); `audit_log.attribute_names` hanya menerima {`customer_id`, `nik`, `nama`} dan menolak `hp` serta teks bebas (`23514`, keputusan E-06).
- **NFR-04:** pada 20.000 baris dengan pengaturan planner bawaan, pencarian lewat `subject_lookup` + layanan + purpose + status aktif dan pencarian lewat `pseudonym` memakai indeks, bukan `Seq Scan`. Ini bukan pengganti `EXPLAIN ANALYZE` pada data M6/M7.
- **Mutasi:** mengosongkan AAD membuat tes pindah-antar-jenis dan antar-kolom gagal.

## Batas bukti

PostgreSQL 18, satu mesin; 2000 sampel IV bukan bukti keacakan; tidak ada pengujian sisi-waktu. **Belum teruji:** perbandingan rahasia konstan-waktu (`timingSafeEqual`); ini menjadi butir spec Fase 3.

## Dampak

- Keamanan: S-31 dan S-32 terpenuhi pada tingkat prototipe; T-16 (swap ciphertext antar baris) tertutup oleh keputusan 3.
- Pengujian: tes unit kripto dan tes integrasi dump DB serta swap menjadi tiket M2 (FR-25, FR-30, S-31).
- Implementasi: `id` baris dibangkitkan aplikasi sebelum INSERT (tidak bergantung `DEFAULT gen_random_uuid()` saat enkripsi).
- Yang harus diubah: spec `privacy-service` dan `data-dan-migrasi`; `PRD_ERRATA.md` (E-20, E-21).

## Kapan ditinjau ulang

Bila rotasi `K_index` diimplementasikan, atau bila kolom `id` diganti jenisnya.
