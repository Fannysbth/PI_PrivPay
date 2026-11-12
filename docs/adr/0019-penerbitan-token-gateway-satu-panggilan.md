# ADR-0019: Gateway meminta token P1 dan P2 dalam satu panggilan `POST /pseudonymize/batch`

- Status: Accepted (disetujui Fanny, 2026-11-11)
- Tanggal: 2026-11-11
- Pengambil keputusan: Fanny
- Terkait: NFR-02, NFR-11, NFR-12, NFR-25, FR-13, D-09, D-10, D-16, D-18, TK-16, PERF-01 (tahap A)

## Konteks

Hasil pengukuran resmi (n = 4 usulan, n = 5 baseline) menunjukkan p95 naik 155,0% dan throughput turun 69,3%. Total CPU kedua mode hampir sama; yang naik adalah biaya per permintaan (sekitar 3,2 kali), karena Privacy Service dan basis datanya terkunci pada batas 0,5 inti. Penyebab dominan adalah jumlah panggilan sinkron ber-TLS ke Privacy Service per pembayaran, sekitar 5,3 (diagnosis M7-B, N-60): dua `POST /pseudonymize` dari Gateway (P1 `CUSTOMER` dan P2 `ACCOUNT`, konteks Tabel 1), satu exchange X2, satu `resolve-domain`, satu `PATCH /transaction-status`, dan 0,3 exchange X1 untuk transaksi mencurigakan. Setiap panggilan membuka satu transaksi basis data (BEGIN, kunci, baca, tulis audit, COMMIT).

Dua panggilan dari Gateway selalu datang berpasangan untuk satu pembayaran, dari pemanggil yang sama (`API_GATEWAY`), pada transaksi bisnis yang sama.

## Opsi yang dipertimbangkan

1. Tidak melakukan apa-apa: nol risiko, tetapi dua panggilan tetap berjalan.
2. Batch P1+P2 dalam satu panggilan (usulan): satu hop TLS, satu verifikasi JWT, satu transaksi basis data, dua baris audit.
3. Cache P1/P2 di Gateway: lebih besar dampaknya, tetapi mengubah makna gagal-tertutup (D-09, TK-16) dan pencabutan; dibahas terpisah setelah angka tahap A dan B diukur.

## Keputusan (usulan)

Tambahkan `POST /pseudonymize/batch` pada Privacy Service dan pakai di Gateway (adapter dan plugin Kong) untuk pembayaran. Aturan yang tidak berubah:

1. Isi batch: daftar 1 sampai 2 permintaan bentuk 1 (identitas), masing-masing divalidasi dengan skema yang sama dengan `/pseudonymize` (menolak field tak dikenal), batas ukuran badan yang sama. Pemanggil hanya `API_GATEWAY` (Tabel 3); `requesting_service` tetap dari klaim JWT (D-16).
2. Tiap elemen tetap melewati Policy Engine STEP 0 dan menulis tepat satu baris audit (FR-13), di transaksi basis data yang sama. Satu elemen ditolak berarti seluruh batch ditolak (all-or-nothing), dengan satu baris DENIED atas elemen yang ditolak dan tanpa baris pemetaan; tidak ada hasil sebagian.
2b. Penyempitan N-65 (usulan Claude dari `/code-review`, disetujui Fanny 2026-11-12): semua elemen memuat `transaction_id` yang sama; beda, atau satu ada satu tidak, ditolak 422 sebelum apa pun dibaca atau ditulis.
2a. Penyempitan (usulan Claude, disetujui Fanny 2026-11-11): paling banyak satu elemen per `subject_type` (dua `CUSTOMER` atau dua `ACCOUNT` ditolak 422), dan kunci advisory diambil menurut urutan `subject_type`, bukan urutan permintaan, agar dua batch dengan urutan terbalik tidak saling menunggu (deadlock). Hasil tetap mengikuti urutan permintaan. Dibuktikan dengan tes yang gagal bila pengurutan dihapus.
3. Respons tidak memuat `subject_id`; urutan hasil sama dengan urutan permintaan.
4. Privacy Service mati tetap 503 pada seluruh batch, tanpa fallback ke data mentah (D-09, TK-16). Tidak ada cache.
5. `POST /pseudonymize` lama tetap ada dan tidak berubah (dipakai exchange, form 3, tes, dan klien lain).
6. Kode galat ke klien tetap delapan (ADR-0008).

## Konsekuensi

- Positif: satu panggilan ber-TLS, satu verifikasi JWT, satu BEGIN/COMMIT, dan satu `pool.connect` per pembayaran dihemat. Panggilan sinkron per pembayaran turun dari sekitar 5,3 menjadi sekitar 4,3. Besarnya dampak belum diukur.
- Negatif / utang: satu rute baru yang harus dipelihara; plugin Lua dan adapter perlu diubah bersama (vektor kontrak Lua, luacheck, dan Newman butuh Docker).
- Dampak pada keamanan dan privasi (wajib diisi): permukaan serangan Privacy Service bertambah satu rute; ia memakai skema, otorisasi, dan jalur audit yang sama dengan rute yang ada. Risiko batch (permintaan besar) dibatasi dua elemen dan batas badan yang sama. Penolakan all-or-nothing menghindari token yang diterbitkan tanpa pasangan. Tidak ada data mentah baru yang disimpan atau dicatat.
- Dampak pada pengujian dan pengukuran: tes keamanan TK untuk rute baru (pemanggil bukan Gateway, elemen ditolak, ukuran melebihi batas, Privacy mati), tes keseimbangan audit (dua elemen sukses = dua baris), Newman kedua mode. Hasil resmi v1 (tanpa batch) dilaporkan apa adanya; v2 diukur dengan protokol yang sama sebagai iterasi kedua DSRM, tidak menggantikan v1.
- Yang harus diubah di dokumen/kode: `docs/spec/privacy-service.md` (bagian 4), PRD_ERRATA (Bagian 10 menambah rute), `services/privacy-service` (rute, skema), `services/gateway` (adapter dan klien Privacy), plugin Lua `privacy.lua` dan `handler.lua`, CHANGELOG, bagian Perintah di CLAUDE.md bila ada perintah baru.

## Bukti

- Hitungan 5,3 panggilan: N-60, HANDOFF M7-B (diukur pada 25 pengguna, tahap kesiapan, bukan resmi).
- Penghematan satu transaksi basis data per pembayaran: dari kode `AuditedOperation.run` (BEGIN, kerja, audit, COMMIT per panggilan). Dampak ke throughput: BELUM diukur.

## Kapan ditinjau ulang

Bila ukuran v2 menunjukkan dampak di bawah 10% terhadap throughput, atau bila uji keamanan menemukan perbedaan perilaku antara batch dan rute tunggal.
