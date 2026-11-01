# 04. Keamanan

Bab ini menjelaskan mekanisme keamanan yang benar-benar ada di kode, memetakannya ke ADR, Tabel PRD, dan butir checklist ([`docs/security/security-checklist.md`](../security/security-checklist.md)), lalu menuliskan apa yang **sengaja tidak dilakukan**. Kebijakan lengkap ada di [`SECURITY.md`](../../SECURITY.md); model ancaman di [`docs/security/threat-model.md`](../security/threat-model.md).

## 1. Tiga kunci terpisah

Privacy Service memakai tiga kunci 32 byte, dibaca dari berkas (heks) lewat variabel `*_FILE`, tidak pernah dari nilai mentah di env ([`services/privacy-service/src/crypto/keys.ts`](../../services/privacy-service/src/crypto/keys.ts), `loadKeys`):

| Kunci | Berkas / variabel | Dipakai untuk | Kode |
| --- | --- | --- | --- |
| `K_token` | `PSEUDONYM_HMAC_SECRET_FILE` | menurunkan nilai token `PSEU-XXXXXXXX` | `TokenMint.mint` di [`crypto/derive.ts`](../../services/privacy-service/src/crypto/derive.ts) |
| `K_index` | `BLIND_INDEX_SECRET_FILE` | blind index `subject_lookup` untuk mencari baris tanpa mendekripsi | `BlindIndex.lookup` |
| `K_field` | `FIELD_ENCRYPTION_KEY_FILE` (+ `PSEUDONYM_KEY_VERSION`) | enkripsi AES-256-GCM kolom subjek dan brankas | `FieldCipher` di [`crypto/field-cipher.ts`](../../services/privacy-service/src/crypto/field-cipher.ts) |

**Mengapa tiga, bukan satu.** Tiga tugas yang berbeda tidak boleh bergantung pada rahasia yang sama (D-13, FR-30). Bocornya `K_field` membuka ciphertext, tetapi tidak memungkinkan membuat atau memetakan token. Bocornya `K_token` memungkinkan membuat token palsu, tetapi tidak membuka data. Bocornya `K_index` memungkinkan menguji tebakan "apakah `CUST-000123` ada di tabel ini" (ruang `customer_id` hanya sejuta nilai, jadi `K_index` harus dijaga seketat `K_field`; ini dicatat sebagai keterbatasan PRD 20).

Penjagaan di kode (`createKeys`):

- tiap kunci harus tepat 32 byte, dan **semua kunci harus berbeda** (perbandingan waktu-tetap dengan `safeEqual`), termasuk antar-versi `K_field`; start gagal bila tidak (S-03);
- material kunci disimpan di `WeakMap`, bukan di properti objek, sehingga `JSON.stringify`, `inspect`, atau logger tidak bisa menjangkaunya; objek `PrivacyKeys` tercetak sebagai `[PrivacyKeys]`;
- pesan galat menyebut aturan yang gagal, tidak pernah kuncinya.

Rotasi: hanya `key_version` (2 byte di awal setiap ciphertext, kolom `key_version` di tabel) dan prosedur tertulis. **Tidak ada rotasi otomatis dan tidak ada job enkripsi ulang** (di luar cakupan, PRD 2).

## 2. Membuat token

`TokenMint.mint`: `PSEU-` ditambah 8 karakter heks pertama dari `HMAC-SHA256(K_token, encodeParts(subject_type, subject_id, service_id, purpose, nonce))`, dengan `nonce` UUID v4 baru tiap penerbitan.

- **`encodeParts`** ([`crypto/parts.ts`](../../services/privacy-service/src/crypto/parts.ts)) memberi setiap bagian awalan panjang 4 byte. Alasannya: penyambungan polos membuat `("CUST-1", "2")` dan `("CUST-12", "")` menghasilkan byte yang sama (ADR-0011 butir 2). Teks dengan pasangan pengganti tunggal ditolak karena tak bisa dibulatkan balik.
- Karena ada `nonce`, token **tidak dapat diturunkan ulang dari subjek**; pemetaan token ke subjek hanya ada di tabel `pseudonym_mapping` (kolom `subject_id_enc` terenkripsi).
- Ruang token 32 bit: tabrakan diperkirakan sekitar 65 ribu token (paradoks ulang tahun). Ditangani oleh `UNIQUE` pada `pseudonym` dan ulangan sampai 20 kali dengan nonce baru (`TokenService.issue`). Penebakan token valid secara teoretis mungkin; penghalangnya adalah token terikat layanan + tujuan + TTL, batas laju, dan audit `TOKEN_NOT_FOUND` yang memunculkan peringatan di `/audit-log/summary` (Q-11, `SECURITY.md` 5). Diterima sebagai keputusan FINAL (D-11).
- **Semi-dinamis.** Token aktif untuk kombinasi (subjek, layanan, tujuan) **dipakai ulang** selama masih berlaku (`reused: true`, audit `REUSED_ACTIVE`). Jadi di dalam satu jendela TTL, dua transaksi pelanggan yang sama membawa token yang sama (D-12). Itu sebab linkability dalam TTL diakui, dan token Fraud (30 hari) adalah penghubung terpanjang.
- Satu token aktif per kombinasi dijamin **dua lapis**: kunci penasihat transaksi per kombinasi (`TOKEN_SQL.lock` di `TokenService.issue`, ADR-0010) dan indeks unik parsial `uq_mapping_active ... WHERE status = 'active'` di database.

## 3. Blind index

`subject_lookup = HMAC-SHA256(K_index, encodeParts(subject_type, subject_id))`. Deterministik, jadi baris milik satu subjek bisa dicari (penerbitan, pencabutan, brankas) tanpa dekripsi. Aturannya: **tidak pernah keluar dari database Privacy** (bukan kolom di tabel layanan lain, tidak ada di jawaban atau audit). Ia adalah pseudonim statis internal; kerahasiaan `K_index` krusial. Dipakai di `TokenService.issue` (kunci penasihat dan `findActive`), `RevocationService.revokeSubject`, dan `identity_vault.customer_lookup`.

## 4. AES-GCM dan AAD

`FieldCipher.encrypt`: AES-256-GCM, IV 12 byte acak **baru untuk setiap penulisan**, tag 16 byte. Format blob: `key_version (uint16 big-endian) || IV (12) || ciphertext || tag (16)`. Saat dekripsi, versi di blob memilih kunci; versi tak dikenal tidak dicoba terhadap kunci lain.

**AAD (additional authenticated data)** mengikat ciphertext ke tempatnya:

| Tempat | AAD | Fungsi pembuat |
| --- | --- | --- |
| `pseudonym_mapping.subject_id_enc` | `encodeParts('mapping', subject_type, id baris)` | `mappingBinding` |
| `identity_vault.*_enc` | `encodeParts('vault', nama kolom, id baris)` | `vaultBinding` |

GCM mengautentikasi AAD, sehingga ciphertext yang dipindah ke baris lain, kolom lain, atau jenis subjek lain **gagal didekripsi** (T-16, S-31). Semua kegagalan (kunci salah, baris salah, satu byte berubah) menghasilkan galat yang sama (`integrity`) dan teks asli Node dibuang, sehingga tidak ada oracle. Tipe `RowBinding` bermerek: hanya `mappingBinding` dan `vaultBinding` yang bisa membuatnya, dan `FieldCipher` menolak AAD yang di-cast atau dibuat tangan (`issuedBytes`).

Catatan yang sering salah dibaca: ringkasan PRD menulis "AAD = `subject_type`" atau "nama kolom". Implementasi **lebih ketat**: AAD juga memuat id baris, diputuskan di ADR-0011 setelah lulus tes pindah-antar-baris. Konsekuensinya, id baris dibuat aplikasi (UUID v4) **sebelum** `INSERT`, dan `IdentityVault.store` harus mengambil id baris yang sudah ada (di bawah kunci penasihat) sebelum mengenkripsi ulang (N-25).

## 5. Gerbang, urutan pemeriksaan, dan respons seragam

Gerbang pembukaan identitas diuraikan di [03, bagian D](03-alur-end-to-end.md). Prinsip yang perlu dihafal:

- **Lima gerbang plus STEP 0**, berhenti di kegagalan pertama. STEP 0 (pemanggil `RECONCILIATION` dan peran aktor `auditor`) sengaja dipindah **sebelum** membaca baris apa pun (N-29): bila peran diperiksa belakangan, aktor `admin` akan mendapat `REQUESTER_MISMATCH` dan TK-08 tak pernah terjangkau.
- **Dua lapis jawaban** (ADR-0008): antar-layanan jawaban memuat `reason` rinci (`TOKEN_NOT_FOUND`, `SERVICE_MISMATCH`, ...); ke klien eksternal Gateway hanya memberi salah satu dari **delapan** `code` (`UNAUTHENTICATED`, `ACCESS_DENIED`, `VALIDATION_ERROR`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`, `IDEMPOTENCY_CONFLICT`, `NOT_HELD`). Token yang ada dan yang tidak ada tampak sama bagi klien (NFR-10, TK-12). Kodenya di [`packages/common/src/errors.ts`](../../packages/common/src/errors.ts) (`REASONS`, `toClientError`) dan [`services/gateway/src/error-masker.ts`](../../services/gateway/src/error-masker.ts).
- **Pemanggil dulu, body kemudian** di setiap `*-http.ts`, dan di Privacy pemanggil dan peran diperiksa sebelum membaca token (K-31): layanan yang salah tidak belajar apa pun.
- **`requesting_service` hanya dari `azp` JWT** lewat daftar tetap `SERVICE_AZP` di [`packages/common/src/authenticate.ts`](../../packages/common/src/authenticate.ts); tidak ada field body atau header lain yang bisa menggantinya (D-16, S-12).
- **Pola dua token** (ADR-0007): token layanan di `Authorization` menentukan pemanggil; token manusia di `X-Actor-Token` divalidasi ulang oleh penerima untuk `actor_id` dan peran. Token manusia yang sudah di `Authorization` tidak boleh membawa token aktor (`double_identity`), dan token bank atau nasabah tidak boleh membawa aktor. `aud` kedua token harus memuat layanan penerima, dan peran manusia hanya sah di layanan pada jalurnya (`ROLE_SERVICES`, K-03).
- **JWT** ([`packages/common/src/jwt.ts`](../../packages/common/src/jwt.ts), `verifyJwt`): hanya RS256 (tidak ada `none` atau HS256 dengan kunci publik sebagai rahasia), `kid` harus dikenal, tanda tangan diperiksa sebelum muatan diurai, `iss`, `exp`, `nbf`/`iat`, umur maksimum 300 detik, `aud`, dan penulisan base64url harus kanonik (N-15).

Pemetaan alasan penolakan ke Tabel PRD:

| Tabel PRD | Dalam kode | Penolakan bila dilanggar |
| --- | --- | --- |
| Tabel 1 (tujuh konteks P1..P7 dan TTL) | `TABLE_1` di [`policy/tables.ts`](../../services/privacy-service/src/policy/tables.ts); TTL dari env lewat `PolicyEngine` | `POLICY_NOT_ALLOWED` (tanpa baris mapping) |
| Tabel 2 (hanya P1 ke P3 dan P1 ke P4, oleh `TRANSACTION`) | `TABLE_2`, `exchangeTarget`, `exchangeAllowed` | `POLICY_NOT_ALLOWED` |
| Tabel 3 (operasi dan pemanggil sah) | `TABLE_3`, `ruleOf` | `POLICY_NOT_ALLOWED`, atau `FORBIDDEN_ROLE` bila hanya perannya |
| Tabel 5 (atribut yang boleh dibuka: `customer_id`, `nik`, `nama` untuk P7) | `DISCLOSABLE_ATTRIBUTES`, `attributesFor` | `ATTRIBUTE_NOT_ALLOWED` (422) |
| Tabel 6 (dasar: `DISPUTE`, `FRAUD_CONFIRMED`, `LEGAL_REQUEST`) | `DISCLOSURE_BASES`, `isValidBasis` | `INVALID_BASIS` (422) |

Mengubah baris Tabel 1/2/3/5/6, panjang token, tiga kunci, atau TTL membutuhkan ADR (aturan proyek, larangan keras).

## 6. Persetujuan empat mata

Pemohon (auditor) dan penyetuju (admin) harus orang berbeda; persetujuan sekali pakai dan berlaku 600 detik. Dipaksa di **tiga tempat**: kode (`approve` menolak `SELF_APPROVAL`), database (`CHECK chk_four_eyes (approver_id IS NULL OR approver_id <> requester_id)`), dan gerbang 5 (`requester_id` harus sama dengan aktor yang membuka). Status berpindah `PENDING` ke `APPROVED` ke `USED` (atau `REJECTED`); pemakaian ditandai dengan `UPDATE ... WHERE status = 'APPROVED'` pada baris yang dikunci `FOR UPDATE`, sehingga tiga pemakaian serentak menghasilkan tepat satu keberhasilan (tes M3-05 membuktikannya dengan antrean paksa dan mutasi).

Hal yang perlu jujur diketahui: karena pemohon harus `auditor` dan penyetuju harus `admin`, dan setiap pengguna dev-idp hanya punya **satu** peran, pemeriksaan `SELF_APPROVAL` **hampir tidak terjangkau lewat HTTP**. Pemisahan peran sudah menutupnya; pemeriksaan kode dan `chk_four_eyes` adalah pertahanan berlapis bila kelak satu orang dapat memegang dua peran (Keycloak). Di run bab 01, auditor yang mencoba menyetujui permintaannya sendiri ditolak karena **peran**, bukan karena `SELF_APPROVAL`. Tes TK-24 menguji pemeriksaan itu langsung pada layanan dan SQL.

## 7. Audit

Setiap operasi token menulis **tepat satu** baris audit, `SUCCESS` atau `DENIED` (FR-13), lewat satu jalur: `AuditedOperation.run` ([`audit/audited-operation.ts`](../../services/privacy-service/src/audit/audited-operation.ts)).

- Hasil operasi dan baris `SUCCESS` di-commit **dalam satu transaksi**; penolakan yang merupakan keputusan dilempar sebagai `DeniedOperation`, transaksi operasi di-rollback, lalu baris `DENIED` ditulis di transaksi pendek sendiri **dan di-commit sebelum error dilempar** (penolakan selalu meninggalkan baris; temuan TK-08 sesi M5 membuktikan flake-nya ada di tes, bukan di sini).
- Bila baris audit tidak bisa ditulis, operasi **gagal** dengan `INTERNAL_ERROR`: tidak pernah ada keberhasilan tanpa audit, tidak pernah ada penolakan yang senyap (spek privacy 11).
- Di database: peran aplikasi hanya punya `INSERT` pada `audit_log` (tanpa `SELECT`, jadi `INSERT` tanpa `RETURNING`); pembacaan lewat pool terpisah berperan `privpay_auditor` (`SELECT` saja); tidak ada `UPDATE` atau `DELETE` (S-34, TK-10). Peran auditor tidak punya akses ke `identity_vault` (S-35).
- Isi baris dibatasi oleh **tipe dan DDL**, bukan niat baik: tidak ada kolom `subject_id`; `reason` adalah kode tetap; `pseudonym`, `transaction_id`, `purpose`, `actor_id` divalidasi regex (`AUDIT_FORMATS`; `actor_id` tidak boleh mengandung `@`, `.`, spasi, atau semua digit) yang menutup saluran mudah untuk menyelundupkan email atau NIK; `attribute_names` dibatasi `CHECK` ke tiga nama; **nilai atribut tidak pernah dicatat**. Pemindai kenari memeriksa bahwa tak satu nilai pun muncul (S-27, S-43).
- Rantai hash (`prev_hash`, `row_hash`) hanya **dirancang**; kolomnya ada dan kosong (Q-12).
- Log aplikasi lain: logger hanya menerima field dari daftar (`request_id`, `transaction_id`, `token`, `route`, `status`, `latency_ms`, `reason`), dan tiap field divalidasi bentuknya ([`packages/common/src/logger.ts`](../../packages/common/src/logger.ts)). Sebuah `token` yang bukan `PSEU-XXXXXXXX`, atau `route` berisi deretan digit panjang, diganti `[INVALID]`; field di luar daftar dibuang dan hanya namanya yang dicatat di `dropped_fields`. Itu mekanismenya; log ikut dipindai di kedua mode oleh tes kesetaraan (`whereIsThe` di `services/gateway/test/e2e/equivalence.integration.spec.ts`), tetapi untuk baseline tes hanya menuntut temuan tertentu muncul (`arrayContaining`), tidak menuntut log bersih. Karena daftar izin logger berlaku di kedua mode, log baseline kemungkinan besar tetap bersih, tetapi itu **belum diverifikasi**.

## 8. Mencegah jalur data mentah

| Mekanisme | Di mana | Bukti |
| --- | --- | --- |
| Gateway tidak meneruskan identitas; payload hilir dari daftar izin; `nik`/`nama`/`email` dibuang | `Tokenizer` | tes kontrak gateway, pemindai kenari |
| Privacy mati berarti 503; tidak ada fallback ke data mentah | `HttpPrivacyPort`, `PrivacyHttp.run` (galat koneksi menjadi `SERVICE_UNAVAILABLE`) | tes M4-09 (dengan Privacy dimatikan di tumpukan E2E); dengan Docker belum |
| Skema layanan hilir tak punya kolom identitas (proposed) | migrasi `proposed/` | tes skema tiap layanan, inspeksi (S-38) |
| Kolom `subject_id_enc` dan brankas hanya ciphertext | `FieldCipher` | S-30 |
| Cache-Control `no-store` pada jawaban yang bisa memuat identitas | `privacy.module.ts` (`/de-pseudonymize`), `gateway.module.ts` (semua jawaban hilir, N-36) | tes M4-07 |
| Mode baseline tak bisa aktif di konfigurasi proposed | `assertBaselineMode`, `privacyUrlMatchesMode`, penolakan Privacy di baseline | S-75; mutasi |

## 9. Pemetaan ke ADR dan butir checklist

| Topik | ADR / keputusan | Butir checklist |
| --- | --- | --- |
| Hanya dua kondisi (tanpa mode static) | ADR-0003 | |
| Lingkungan lokal tanpa Docker (dev-idp, gateway-adapter) | ADR-0004 | S-07 sebagian |
| Registrasi A2, A5, A3, A4 dengan kompensasi | ADR-0005, ADR-0014 (Gateway boleh `revoke_subject` pelanggan) | S-16, S-37 |
| Dua mode lewat repositori, tes arsitektur | ADR-0006 | S-75, S-76, S-77 |
| Identitas pemanggil, pola dua token, peran | ADR-0007 | S-10..S-13 |
| Delapan kode error ke klien | ADR-0008 | S-42 (sebagian) |
| Idempotensi transaksi | ADR-0009 | S-54 |
| `buat_token` aman konkurensi | ADR-0010 | S-53 |
| Kripto field, blind index, AAD terikat baris | ADR-0011 | S-30, S-31, S-32 |
| Tabel tautan transaksi (K-28) | ADR-0013 | tidak ada butir khusus (menyangkut token P6/P7 dari transaksi; ditutup lewat tes `transaction-link.integration.spec.ts`) |
| Audit tanpa identitas, append-only | D-17, D-18 | S-20, S-27, S-34, S-43 |
| Pembukaan identitas empat mata | D-01..D-05 | S-21..S-26 |
| Retensi dan pencabutan | D-15, K-33 | S-36, S-37 |
| Kunci berbeda, dari berkas | D-13 | S-01..S-03 |

Status setiap butir (lulus, sebagian, belum) dan buktinya ada di checklist dan `docs/security/review-M*.md`; panduan ini tidak menyalinnya agar tidak basi. Yang **sebagian atau belum** saat panduan ditulis: Semgrep (S-41), seragam error lengkap lewat Kong (S-42, S-44), Docker dan rahasia di image (S-04..S-08, S-50), serta E(s) dan uji penautan (S-70..S-73, milestone M6).

## 10. Yang SENGAJA tidak dilakukan

Ini bukan kelalaian; semuanya tercatat sebagai batas atau keputusan, dan dosen mungkin menanyakannya.

1. **Bukan anonimisasi.** Ini pseudonimisasi *regular* (bukan *blind*): Privacy Service mengetahui identitas asli, jadi ia adalah titik tunggal yang menarik bagi penyerang ("honeypot"). Diakui di PRD 20. Pseudonim tetap data pribadi.
2. **Tidak ada rotasi kunci otomatis, tidak ada job enkripsi ulang.** Hanya `key_version` dan prosedur tertulis. Rotasi `K_index` memerlukan prosedur sendiri (PRD 2).
3. **Tidak ada pustaka kripto tambahan dan tidak ada kripto buatan sendiri.** Hanya `node:crypto` (HMAC-SHA256, AES-256-GCM), larangan keras di aturan proyek, S-32.
4. **Tidak ada ORM.** SQL tulisan tangan dan selalu berparameter; identifier tabel/kolom tetap teks tetap.
5. **Rantai hash audit tidak diimplementasikan** (hanya dirancang, Q-12). Pertanyaan itu juga dikembalikan ke dosen.
6. **Tidak ada TLS antar-layanan dan tidak ada tiga jaringan Docker.** Fase lokal mengandalkan loopback dan daftar izin; TLS adalah utang NFR-06 untuk fase Docker (Q-09).
7. **dev-idp bukan Keycloak.** `dev_login` tanpa kata sandi; aman hanya karena menolak start di luar `development`/`test` dan hanya mengikat loopback. Pemetaan klaim ke Keycloak adalah utang DK-04. Identitas login di IdP dan nomor HP di Notification adalah pengecualian sadar (D-08).
8. **Token 32 bit** dipertahankan walau sempit (D-11, FINAL).
9. **Kebocoran korelasi tidak ditangani.** Kombinasi jumlah, jam, dan geohash dapat menautkan orang; di luar cakupan (SECURITY.md 1).
10. **Gateway boleh menerbitkan token baru setelah pencabutan.** Pencabutan bukan pemblokiran penerbitan; token yang terbit bersamaan dengan `revoke_subject` bisa lolos (batas (a) dari `/security-review` M3). Di run bab 01 terlihat: pembayaran sesudah pencabutan tetap `COMPLETED`.
11. **Retensi tidak menyentuh brankas** (hanya `revoke_subject`) dan **tidak menghapus baris** (supaya referensi audit tetap valid).
12. **Kepemilikan `source_account` tidak diperiksa terhadap token nasabah** (di luar cakupan spek transaksi; model saldo/ledger dan verifikasi kepemilikan rekening ada di daftar "di luar cakupan").
13. **Batas laju hanya di memori satu instans** (`RateLimiter`), kunci laju pendaftaran memakai `req.ip` tanpa `trust proxy`; harus ditinjau saat Kong atau Docker dipakai.
14. **Email pada formulir pendaftaran dibuang**, bukan disimpan, karena brankas tak punya kolomnya (N-38).
15. **Nilai atribut hasil pembukaan tidak disimpan** di Reconciliation, audit, atau log; ia hanya diteruskan dalam jawaban.
16. **Tidak ada pengumpulan persetujuan (consent), portabilitas data, HA, atau DR** (di luar cakupan, PRD 2).
17. **Kutipan hukum dan literatur** (Pasal 4 UU PDP, EDPB Guidelines 01/2025, Flegel 2005, Petersen 2018) **belum diverifikasi** ([`docs/OPEN_QUESTIONS.md`](../OPEN_QUESTIONS.md), bagian D); jangan dikutip sebagai fakta tanpa memeriksa sumbernya.
