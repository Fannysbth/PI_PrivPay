# Tinjauan keamanan baseline = pilihan B (2026-11-02)

Lingkup: `git diff main..HEAD` pada `feat/baseline-b` (G2 sampai G6, perbaikan `test-db-cleanup`, pelacakan berkas kerja). Ditinjau langsung (skill `/security-review` tidak dapat mengambil diff otomatis). Tidak ada temuan High atau Medium.

| # | Tingkat | Temuan | Status |
| --- | --- | --- | --- |
| 1 | Info (by design) | Mode baseline sengaja menyimpan dan meneruskan NIK, nama, rekening, customer id di Transaction, Fraud, Notification, Reconciliation; ini melanggar invarian 1 dan 6 hanya di baseline, yang adalah pembanding "sistem konvensional" | Keputusan pemilik (pilihan B, ADR-0006 tambahan, N-57). Semua data uji fiktif; kenari dibangun saat tes berjalan |
| 2 | Info | Mode usulan tidak ikut berubah | Tes: skema masuk strict menolak `nik`/`nama`/`account_number` di usulan (422), skema usulan tak punya kolom itu, payload scan e2e dan Docker kosong; Newman 149/115/0 |
| 3 | Low | Salinan hanya lewat migrasi `baseline/`; kode baseline tak boleh jalan di konfigurasi usulan | Env divalidasi saat start (ADR-0006), bendera diturunkan dari mode di bootstrap, tes paritas skema, tes `mode-folders` (domain tak menyebut mode) |
| 4 | Info | Hak DB: kolom baru tercakup hibah tingkat tabel; peran runtime tetap tanpa DELETE, Fraud tetap append-only | Diuji dengan peran sungguhan di tiap layanan |
| 5 | Info | Log: tidak ada nilai atribut di log mana pun | Tes kenari per layanan dan e2e dengan kontrol positif (log tertangkap tidak kosong) |
| 6 | Info | Email tidak diteruskan ke layanan mana pun | Kenari email di payload, DB, log: tidak ada (G2) |
| 7 | Low | Daftar `completed` Transaction baseline kini memuat identitas | Pemanggil tetap hanya `RECONCILIATION` (AZ-29, otorisasi tidak diubah); bentuk jawaban usulan identik |
| 8 | Low | Transportasi antar-layanan di Compose adalah HTTP biasa pada jaringan internal; di baseline nilai asli lewat jaringan itu | Keterbatasan yang sudah tercatat (ADR-0017); baseline memang tanpa lapisan privasi |
| 9 | Info | `docs/HANDOFF.md`, `OPEN_QUESTIONS.md`, `tickets/` kini terlacak | Diperiksa dulu: gitleaks bersih, tanpa email, JWT, PEM, NIK 16 digit, nomor HP, jalur pengguna |
| 10 | Info | Tes `test-db-cleanup` memakai tidur nyata 11 detik | Disengaja dan diminta pemilik (yang diuji adalah kemandirian dari waktu); satu-satunya pengecualian aturan "tanpa sleep nyata" |
| 11 | Terbuka | Ulangan pembayaran dengan kunci sama tetapi NIK/nama berbeda dijawab hasil lama (`sameContent` tak membandingkannya) | Dicatat di N-57 (e) |
