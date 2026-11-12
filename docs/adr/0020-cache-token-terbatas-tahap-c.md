# ADR-0020: Cache token terbatas di Transaction dan Notification (kinerja v2 tahap C)

- Status: Accepted (disetujui Fanny, 2026-11-12); dipersempit atas pilihan Fanny pada N-68 (2026-11-12, "Opsi 1"): Gateway TIDAK di-cache. Diimplementasikan untuk Transaction (X1/X2) dan Notification (P4 ke P5).
- Tanggal: 2026-11-12
- Pengambil keputusan: Fanny
- Terkait: NFR-02, NFR-11, NFR-12, D-09, D-26, TK-16, K-28, N-68, ADR-0014, ADR-0019, ADR-0021, N-63, PLAN_PERFORMA_V2 (tahap C)

## Konteks

Setelah tahap A (satu statement per operasi) dan tahap B (batch P1+P2), pembayaran masih membutuhkan sekitar 4,3 panggilan sinkron ber-TLS ke Privacy Service (perkiraan, belum diukur). Pembayaran berulang dari nasabah yang sama meminta pemetaan yang sama, yang masih berlaku menurut TTL token. Arah cache sudah disetujui Fanny pada 2026-11-11; yang diputuskan di sini adalah bentuk dan batasnya.

## Opsi yang dipertimbangkan

1. Tanpa cache: jaminan gagal-tertutup dan audit paling kuat, kinerja pola tetap mahal.
2. Cache terbatas waktu pendek (dipilih): memangkas panggilan berulang, dengan harga yang ditulis di ADR-0021.
3. Cache berumur panjang (mengikuti TTL token): kinerja terbaik, tetapi pencabutan dan gagal-tertutup praktis tidak berlaku. Ditolak.

## Keputusan

Gateway TIDAK menyimpan apa pun: tiap pembayaran tetap satu panggilan batch ke Privacy (ADR-0019), karena penerbitan atau pemakaian token menulis `transaction_link` (K-28, ADR-0013) yang dibutuhkan Reconciliation dan penjaga `IDEMPOTENCY_CONFLICT`, serta satu baris audit per elemen (N-68). Transaction menyimpan hasil exchange X2 (dan X1) per token sumber; Notification menyimpan hasil resolve-domain per token P4. Aturan:

1. **Jendela T dari env, bukan literal.** `TOKEN_CACHE_TTL_SECONDS`, bawaan **5**; varian sensitivitas 30. Divalidasi saat start (bilangan bulat, batas atas 300; `0` mematikan cache). Umur efektif entri = min(T, sisa masa berlaku token). Fanny mengganti nilainya dari env tanpa mengubah kode. Dasar nilai bawaan: N-63.
2. **Gateway tanpa cache** (N-68). Dengan begitu tidak ada keadaan turunan identitas yang tinggal di titik masuk, dan tidak ada kunci cache baru yang harus dijaga.
3. **Kunci cache hilir:** token sumber. Setelah pencabutan, token baru terbit dan entri lama tidak pernah dipakai lagi. Entri satu layanan tidak dipakai layanan lain (invarian 5).
4. **Batas:** `TOKEN_CACHE_MAX_ENTRIES` dari env (bawaan terbatas, dibuang yang tertua); entri dibuang saat kedaluwarsa; tidak ada tulis ke disk, log, atau metrik berlabel nilai.
5. **Pencabutan** (oleh Gateway lewat kompensasi pendaftaran ADR-0014, atau oleh admin) tidak diketahui cache hilir dan tertunda paling lama T (ADR-0021). Kunci cache adalah token sumber; setelah pencabutan, token baru terbit, jadi entri lama tidak pernah dicari lagi.
6. **Cache dingin tetap gagal tertutup:** tanpa entri, Privacy mati menjawab 503 langsung.
7. Waktu lewat `Clock` yang bisa disuntik (tes tanpa `sleep`).

## Keselarasan dengan judul skripsi dan keamanan

Judul: *Implementasi Pola Arsitektur Privacy-by-Design Menggunakan Teknik Pseudonimisasi Dinamis pada Ekosistem Microservices*.

- **Pseudonimisasi dinamis tetap utuh.** Token tetap dibuat per layanan, per tujuan, dengan TTL, dan berputar bila kedaluwarsa atau dicabut. Cache hanya mengingat jawaban Privacy selama T detik (5 detik; TTL token jam-jaman) dan tidak menciptakan, memperpanjang, atau menggabungkan token.
- **Penyamaran tetap terjadi di Gateway pada setiap pembayaran** (opsi 1): tidak ada jalan pintas yang membuat identitas mentah lolos atau tinggal di titik masuk.
- **Minimisasi data:** cache hanya berisi token (pseudonim) dan hasil tukarnya, di memori proses, tanpa tulis disk, log, atau metrik berlabel nilai. Tidak ada `customer_id`, rekening, NIK, atau nama.
- **Pemisahan tujuan (invarian 5):** kunci memuat token sumber, tujuan, dan purpose; entri satu layanan tidak dapat dibaca layanan lain karena cache hidup di dalam proses masing-masing.
- **Akuntabilitas (jejak):** jejak per pembayaran di Privacy (`transaction_link`, audit penerbitan) tetap lengkap; yang tidak tercatat hanya pemakaian ulang jawaban yang sama di Transaction dan Notification dalam jendela T (ADR-0021).
- **Gagal tertutup:** cache dingin tetap 503 langsung bila Privacy mati; tidak ada fallback ke data mentah.
- **Harga yang diakui:** pencabutan atau kedaluwarsa token sumber terlihat paling lama T detik kemudian; ini ditulis sebagai keterbatasan di naskah.

## Konsekuensi

- Positif: panggilan ke Privacy per pembayaran berulang turun; beban Privacy dan basis datanya (batas 0,5 inti) turun.
- Negatif / utang: jaminan berubah menjadi "tertutup setelah jendela T" untuk token yang tersimpan (ADR-0021); pemakaian dari cache tidak menulis baris audit di Privacy.
- Dampak pada keamanan dan privasi: tidak ada data mentah di memori cache (hanya digest dan token); pencabutan admin tertunda paling lama T; cache tidak boleh dipakai lintas layanan atau tujuan.
- Dampak pada pengujian dan pengukuran: varian TK-16 (dingin 503; hangat lolos sampai T; sesudah T 503), tes jendela pencabutan, tes lintas layanan dan tujuan, tes tidak ada ID mentah di memori dan log, pemindai kenari kedua mode, pengukuran T = 5 dan T = 30.
- Yang harus diubah: kode tiga layanan, env, spec, `DOKUMENTASI_SISTEM.md`, naskah (Metodologi dan keterbatasan).

## Bukti

Belum ada; implementasi dan tes menyusul. Rujukan nilai T: RFC 7662, Zanzibar (USENIX ATC 2019), SpiceDB, Ory Talos, Amazon API Gateway (rincian di N-63 dan log 2026-11-11).

## Kapan ditinjau ulang

Bila pengukuran v2 menunjukkan cache tidak menurunkan p95 secara berarti, atau bila dosen menolak jendela pencabutan tertunda.
