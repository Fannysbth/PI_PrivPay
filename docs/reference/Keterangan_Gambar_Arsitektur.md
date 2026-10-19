# Keterangan Gambar Arsitektur Sistem PrivPay

Gambar: [Arsitektur_Sistem_PrivPay.png](Arsitektur_Sistem_PrivPay.png)

**Gambar 1.** Arsitektur sistem PrivPay: data asli hanya melewati lapisan tepi dan tersimpan terenkripsi di zona privasi, sedangkan layanan bisnis hanya memegang token.

## Keterangan alur bernomor (untuk paragraf di naskah)

1. Klien mengirim data asli (customer_id, rekening, dan saat pendaftaran NIK, nama, email, HP) ke API Gateway.
2. Admin atau auditor mengirim permintaan audit lewat Gateway.
3. Bank mitra mengirim laporan settlement berisi nomor rekening lewat Gateway.
4. Plugin privacy-tokenizer di Gateway meneruskan customer_id dan rekening ke Privacy Service untuk ditokenkan. Saat pendaftaran, identitas juga disimpan terenkripsi di identity_vault.
5. Gateway meneruskan permintaan ke layanan bisnis dengan token saja.
6. Layanan bisnis menukar token atau meminta domain pseudonim ke Privacy Service. Hanya jalur audit yang dapat membuka identitas.
7. Notification mengirim nomor HP dan isi SMS generik ke penyedia SMS. Ini satu-satunya pengecualian operasional.

Auth Service (Keycloak) menerbitkan dan memvalidasi JWT untuk Gateway.

## Cara gambar ini dibuat dan dasarnya

Gaya yang dipakai: diagram berlapis, aktor di atas, kotak komponen dengan nama dan satu baris keterangan, silo basis data berbentuk silinder, zona kepercayaan bergaris putus-putus, aliran bernomor dengan legenda, dan warna dibatasi (abu-abu, biru untuk zona privasi, merah untuk data asli) agar tetap terbaca bila dicetak hitam putih.

Dasar yang bisa kamu kutip ke dosen:
- Antunes dan Guimarães [14] menggambarkan model privasi microservices sebagai diagram dengan zona privat dan publik yang dipisahkan penjaga (Gatekeeper, Fig. 4) dan lapisan layanan di depan zona privat (Service, Fig. 5). Rancanganmu mirip kombinasi keduanya: Gateway sebagai penjaga, Privacy Service sebagai lapisan layanan. Info ini dari teks halaman artikel; aku belum melihat gambarnya sendiri.
- Gaya gambar yang sebenarnya dipakai di artikel tersebut (warna, bentuk kotak) belum bisa kuverifikasi karena PDF-nya tidak bisa diunduh dari lingkungan ini. Buka Fig. 4 dan 5 di artikel [14] dan Mashaly dkk. [15] untuk mencocokkan gaya sebelum menyerahkan ke dosen.
