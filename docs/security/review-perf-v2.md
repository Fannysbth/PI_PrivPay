# Tinjauan keamanan: kinerja v2 (tahap A, B, C), 2026-11-12

Lingkup: `/security-review` atas cabang `feat/perf-v2-privacy-hot-path` (batch P1+P2 ADR-0019, cache ADR-0020/0021, token unggahan M7-E di header, CI, Compose). Dilakukan dengan membaca kode; tidak ada perubahan berkas oleh peninjau.

Hasil: tidak ada temuan dengan keyakinan > 80 persen.

Diperiksa:
- Batch Privacy: `requesting_service` hanya dari JWT; badan `strictObject`; tiap elemen lewat kebijakan `GENERATE_FROM_IDENTITY`; semua atau tidak sama sekali; satu baris audit per elemen; ukuran maks 2; `transaction_id` sama (N-65); kunci advisory berparameter; SQL berparameter.
- Gateway dan plugin Kong: badan keluar hanya berisi token dan nilai non-identitas; `customer_id` dari klaim JWT; jawaban pendek atau bentuk salah ditolak (gagal tertutup).
- Cache: kunci memuat token sumber per subjek per layanan, tujuan, purpose (tanpa tabrakan pemisah `|`); nilai hanya pseudonim; umur min(T, sisa umur token), T maks 300 detik; kegagalan dan EXPIRED tidak disimpan.
- `scripts/perf/upload.cjs`: urutan cek (IP, metode, jalur tetap, token, sekali pakai, ukuran); token 192 bit dengan `timingSafeEqual`; berkas keluaran ditentukan runner; terikat satu alamat.
- CI dan Compose: izin `contents: read`, aksi dipin SHA; `e2e` nonaktif; port LAN terikat satu alamat wajib.

Catatan sisa (bukan kerentanan, sudah tercatat): pencabutan terlihat paling lama T detik (ADR-0021); saluran unggahan tanpa TLS di LAN pribadi dengan token sekali pakai; pemeriksaan IP asal dapat dipalsukan di LAN yang sama tetapi token tetap menjaga.
Belum dibuka peninjau: `policy/tables.ts` dan implementasi `AuditedOperation` (dicakup tes TK dan integrasi yang hijau).
