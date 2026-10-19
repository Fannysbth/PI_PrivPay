# ADR-0003: Hanya dua kondisi pembanding (baseline dan proposed)

- Status: Accepted
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: PRD 8, 17, 20 (pertanyaan 4); Metodologi v8 C.3 dan D; D-25

## Konteks

PRD dan Metodologi v8 merencanakan varian ketiga `PRIVACY_MODE=static` (HMAC atas `subject_id`, dipakai bersama semua layanan) khusus uji penautan.

## Keputusan

Varian `static` tidak diimplementasikan. Mode hanya `baseline` dan `proposed`.

## Konsekuensi

- Positif: satu cabang logika lebih sedikit, M5 dan M6 lebih ringan.
- Negatif: pembuktian bahwa pengikatan konteks lebih baik daripada pseudonim statis biasa tidak lagi ditunjukkan secara eksperimental; hanya dapat dibahas secara teoretis (PRD 8, tabel tiga kondisi).
- Keamanan/privasi: tidak ada perubahan pada sistem.
- Pengujian: uji penautan membandingkan baseline dan proposed. Naskah Metodologi v8 perlu disesuaikan.
- Yang diubah: PROMPT_AWAL, DESIGN_DECISIONS, CONTEXT, `.env.example`, OPEN_QUESTIONS.
