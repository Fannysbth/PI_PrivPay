# Model ancaman ringkas

Dasar: PRD 15 (model ancaman) dan Bab Metodologi v8 (LINDDUN dibatasi pada Linkability, Identifiability, Disclosure of information; Non-repudiation, Unawareness, Non-compliance, Detectability tidak dievaluasi, tercatat sebagai batasan). Dokumen ini menambahkan sudut pandang rekayasa (STRIDE, OWASP) supaya implementasi tidak hanya benar secara privasi tetapi juga aman sebagai perangkat lunak. Verifikasi ke dokumen sumber OWASP sebelum mengutip di naskah; bab ASVS di bawah hanya penunjuk topik, bukan klaim kepatuhan.

## 1. Aset, aktor, batas kepercayaan

Aset: lihat SECURITY.md bagian 1. Aktor: nasabah, fraud analyst, auditor, admin, service account, bank simulator, penyerang eksternal, insider berperan auditor/admin, layanan hilir yang diretas.
Batas kepercayaan (target 3 jaringan, OPEN_QUESTIONS Q-09): internet → Kong (edge) → layanan bisnis → Privacy Service (zona privasi, data asli terenkripsi). Aturan: panggilan searah; Privacy Service tidak memanggil keluar; hanya Kong dan layanan bisnis yang boleh menjangkau Privacy Service; DB hanya dijangkau layanannya sendiri.

## 2. LINDDUN (cakupan skripsi) → kontrol → bukti

| Ancaman | Skenario | Kontrol dalam desain | Bukti uji | Sisa risiko |
| --- | --- | --- | --- | --- |
| L Linkability lintas layanan | Penyerang memegang salinan DB dua layanan, mencocokkan token subjek yang sama | Token berbeda per (layanan, purpose); SERVICE_MISMATCH | Uji penautan (Metodologi D): baseline vs proposed | Sedang: token dipakai ulang dalam TTL |
| L Linkability dalam TTL | Fraud mengaitkan transaksi 30 hari | TTL per purpose sesuai SLA | Dilaporkan sebagai keterbatasan | Sedang pada Fraud |
| I Identifiability | Layanan hilir menyimpulkan identitas dari payload | Gateway membuang NIK/nama/email; token saja | E(s), pemindaian kenari | Tinggi untuk korelasi atribut (di luar cakupan) |
| D Disclosure | Identitas bocor lewat log, audit, error, dump DB | Larangan log, audit tanpa PII, enkripsi field, respons error seragam | Pemindai kenari, TK-10, TK-12, TK-22 | Rendah |
| D Disclosure oleh insider | Auditor membuka identitas sendiri | Pembukaan dua pihak, SELF_APPROVAL, sekali pakai 600 detik, atribut minimal, audit | TK-21, TK-23..TK-28 | Sedang: kolusi dua orang tidak dicegah teknis |

## 3. STRIDE per komponen (ringkas)

| Komponen | S Spoofing | T Tampering | R Repudiation | I Info disclosure | D DoS | E Elevation |
| --- | --- | --- | --- | --- | --- | --- |
| Kong | JWT palsu/kedaluwarsa → validasi jwt, TK-19 | Body diubah antar-hop → TLS Kong→Privacy | Log Kong terbatas | Reason rinci bocor → disamarkan | Rate limit 100/menit | Plugin salah konfigurasi lolos data mentah → mode passthrough hanya baseline; TK-16 |
| Privacy Service | Layanan mengaku layanan lain → `requesting_service` dari JWT | Audit diubah → REVOKE UPDATE/DELETE, rantai hash (opsional) | Operasi tanpa jejak → satu baris audit per operasi | Mapping/brankas terbaca → AES-GCM, tiga kunci | Beban `/pseudonymize` → timeout/retry, indeks | Auditor membaca brankas → `REVOKE ALL`, GATE 1..5 |
| Keycloak | Service account dicuri | Realm diubah | Login dicatat Keycloak | Kredensial bocor | Brute force | Peran admin salah beri |
| Transaction / Fraud / Notification / Reconciliation | Token layanan lain dipakai → SERVICE_MISMATCH | Replay transaksi → Idempotency-Key | Review tanpa jejak → `reviewed_by` | PII di log/DB → pemindai | Fraud mati → HELD (gagal aman) | Tukar token ilegal → Tabel 2 |
| Database | Peran salah | Migrasi tak sah | Audit append-only | Dump → ciphertext | Koneksi habis → pool dibatasi | Peran aplikasi terlalu kuat → hak minimal |
| CI/CD & rantai pasok | Action disusupi → pin SHA | Dependensi berbahaya → audit, lockfile | | Secret di log CI → masking, gitleaks | | Token CI terlalu kuat → `permissions:` minimal |

## 4. OWASP API Security Top 10 (2023) → PrivPay

| Risiko | Penerapan |
| --- | --- |
| API1 Broken Object Level Authorization | Token terikat (layanan, purpose, subjek); pemeriksaan kepemilikan sebelum operasi (GATE 2/3, SERVICE_MISMATCH); `disclosure_id` terikat pemohon dan token (REQUESTER_MISMATCH) |
| API2 Broken Authentication | JWT Keycloak, masa berlaku ≤ 5 menit, validasi tanda tangan/exp/aud; tanpa kredensial di URL |
| API3 Broken Object Property Level Authorization | Tabel 5: hanya atribut yang disetujui; respons tidak pernah memuat seluruh baris; skema keluaran eksplisit (tidak men-serialisasi entitas DB langsung) |
| API4 Unrestricted Resource Consumption | Rate limit, batas ukuran body, `limit` ≤ 200, timeout |
| API5 Broken Function Level Authorization | Peran per endpoint (Tabel 3, daftar endpoint); TK-08, TK-25 |
| API6 Unrestricted Access to Sensitive Business Flows | Pembukaan identitas dua pihak; pembatasan frekuensi permintaan pembukaan per pemohon (usul di spec) |
| API7 Server-Side Request Forgery | Tidak ada URL dari input; URL layanan dari konfigurasi |
| API8 Security Misconfiguration | Konfigurasi default aman, tidak ada port DB terbuka ke host, header keamanan, tanpa debug di produksi, hadolint/Trivy |
| API9 Improper Inventory Management | Daftar endpoint PRD 10 = sumber tunggal; endpoint di luar daftar tidak boleh ada; `/metrics` hanya jaringan internal |
| API10 Unsafe Consumption of APIs | Validasi respons layanan lain (skema), timeout, tidak mempercayai `reason` antar-layanan untuk keputusan otorisasi |

## 5. OWASP ASVS — bab yang relevan (penunjuk topik)

V1 Arsitektur dan model ancaman (dokumen ini); V2 Autentikasi dan V3 Manajemen sesi (JWT, service account); V4 Kontrol akses (gerbang, peran, hak DB); V5 Validasi dan pengkodean (zod, SQL berparameter); V6 Kriptografi tersimpan (AES-GCM, HMAC, kunci terpisah, IV acak, AAD); V7 Penanganan error dan logging (respons seragam, log tanpa PII); V8 Perlindungan data (klasifikasi, retensi, pengosongan); V9 Komunikasi (TLS pada jalur identitas mentah); V10 Kode berbahaya (dependensi, rantai pasok); V11 Logika bisnis (idempotensi, batas alur, anti-replay persetujuan); V13 API; V14 Konfigurasi (secret, hardening, build).
Target: bukan sertifikasi. Tingkat acuan L2 untuk bab V4, V6, V7, V8; sisanya "sesuai kebutuhan prototipe". Keputusan ini dikonfirmasi di Fase 1.

## 6. Ancaman khusus desain PrivPay

| ID | Ancaman | Mitigasi | Tes |
| --- | --- | --- | --- |
| T-01 | Privacy Service dikuasai (honeypot) | Pemisahan jaringan, hak minimal, tiga kunci, audit; risiko sisa tinggi diakui | Inspeksi konfigurasi, TK-10 |
| T-02 | `K_index` bocor + customer_id berurutan berentropi rendah → brute force `subject_lookup` | Kerahasiaan K_index; secret terpisah; tidak keluar dari service | FR-30 |
| T-03 | Replay persetujuan pembukaan | Sekali pakai (USED), 600 detik, terikat pemohon dan token | TK-26, TK-28 |
| T-04 | Kolusi dua orang (pemohon+penyetuju) | Tidak dicegah teknis; terlihat di audit (`actor_id` dua pihak) | Diakui sebagai batas |
| T-05 | Race penerbitan token ganda | `SELECT ... FOR UPDATE`, indeks unik parsial | TF-07, P-2 |
| T-06 | Token kedaluwarsa memblokir INSERT (indeks unik parsial) | Penandaan malas di awal `buat_token` | TF-15 |
| T-07 | Plugin Gateway meneruskan data mentah saat Privacy mati | Tolak 503 | TK-16 |
| T-08 | PII bocor lewat log/exception/stack trace/metrik | Logger berredaksi, larangan `console.*`, pemindai kenari | NFR-15, US-14 |
| T-09 | Enumerasi token (ruang 32 bit) | Rate limit, audit TOKEN_NOT_FOUND, error seragam | TK-05, TK-12 |
| T-10 | Timing side channel pada perbandingan rahasia | `timingSafeEqual` | tinjauan kode |
| T-11 | Admin mengubah/menghapus audit | REVOKE UPDATE/DELETE | TK-10 |
| T-12 | Rahasia di image/riwayat git | gitleaks, `docker history`, secret runtime | TK-18 |
| T-13 | Idempotency-Key dipakai ulang dengan isi berbeda | 409 IDEMPOTENCY_CONFLICT | TF-08 |
| T-14 | Hasil pembukaan identitas disimpan layanan pemanggil | Tidak disimpan di reconciliation-db; pindai kenari | TK-21 + pemindai |
| T-15 | Layanan hilir yang diretas memakai ulang token aktor manusia (≤ 5 menit) untuk operasi yang dibolehkan layanannya (ADR-0007) | Masa berlaku pendek; usulan spec: batasi `aud` token aktor ke layanan tujuan; audit mencatat `actor_id` dan layanan | Tes `aud` salah ditolak; risiko sisa diakui |
| T-16 | Penulis DB memindahkan ciphertext antar baris sejenis (AAD = `subject_type` tidak mengikat baris) | AAD memuat `id` baris + jenis subjek atau nama kolom (ADR-0011, Accepted); hak akses DB meminimalkan penulis | Tes swap antar baris dan kolom (lulus di prototipe), diulang di tiket M2 |
