# Tinjauan keamanan M2, gerbang 2 (token, pertukaran, re-issue, retensi)

Cakupan: `git diff fd48030...HEAD` pada `feat/m2-09-retention-job` (`59e4156`): N-24 (CHECK tambahan di `0001_privacy_tables.sql`), M2-03 `PolicyEngine`, M2-04 modul audit, M2-05 `TokenService.generate` dan `effectiveStatus`, M2-06 `exchange` dan `generateFromTransaction`, M2-07 `reIssue` dan `TransactionStatusService`, M2-09 `RetentionJob`; kode di `services/privacy-service/src/{audit,policy,token,retention}`. Tidak diulang: M1 (`review-M1.md`) dan gerbang 1 (`review-M2-gerbang1.md`).

Cara: `/security-review` bawaan dalam dua tahap. Tahap 1: satu agen terpisah yang hanya membaca (tanpa menjalankan tes atau kueri) mengidentifikasi kerentanan, dengan penyerang yang mengendalikan isi permintaan (subjek, pseudonym, purpose, layanan tujuan, transaction id, aktor, status) atau menguasai satu layanan hilir (TRANSACTION, FRAUD, NOTIFICATION, RECONCILIATION). Tahap 2: satu agen penyaring per temuan; temuan dengan kepercayaan di bawah 8 dari 10 dibuang. Lapisan HTTP Privacy belum ada, jadi `requestingService` dan `actorRole` diperlakukan sebagai nilai yang kelak diberikan lapisan itu dari klaim JWT yang sudah diverifikasi; tinjauan ini tidak membuktikan apa pun tentang lapisan itu.

Hasil: **tanpa temuan Critical, High, atau Medium.** Satu kandidat Low dari tahap 1 (kepercayaan 6/10) dinilai penyaring sebagai catatan rancangan, bukan kerentanan (2/10), dan dilipat ke K-28.

## Temuan

| Tingkat | Temuan | Status |
| --- | --- | --- |
| Catatan rancangan (tersaring, 2/10) | `reIssue` menulis `transaction_id` dari permintaan ke baris P1/P2 yang baru, dan `generateFromTransaction` memilih baris terbaru untuk satu `transaction_id`; layanan TRANSACTION yang dibobol dapat menautkan id transaksi korban ke subjeknya sendiri sehingga P6/P7 dari id itu salah subjek (hanya salah atribusi pseudonim: pembukaan identitas tetap butuh peran auditor, dasar sah, dan persetujuan admin lain; seluruh langkah diaudit). Memerlukan layanan yang sudah dipercaya memegang semua token P1/P2 dan menentukan id transaksinya; Gateway pada bentuk 1 sudah dapat menulis id apa pun | dilipat ke **K-28** (menunggu Fanny): apakah re-issue mempertahankan `transaction_id` asli, dan apakah bentuk 3 memilih baris terbaru atau paling awal |
| Catatan untuk lapisan HTTP | `requestingService`, `actorRole`, dan `actorId` harus berasal dari `azp` dan token aktor yang sudah diverifikasi, tidak pernah dari badan permintaan; `AuditReader` dan `VIEW_AUDIT_LOG` belum dijaga; bentuk 3 menerbitkan dari sumber `revoked` | **K-29** (menunggu Fanny) dan tiket lapisan HTTP |

## Yang diperiksa dan aman

- **SQL:** semua pernyataan memakai parameter terikat, termasuk kunci advisory (dirakit dari lookup heksadesimal, `SERVICE_ID` dan `purpose` yang divalidasi bentuknya), daftar status terminal (`$4::text[]`), serta filter dan batas `AuditReader`. Tidak ada penyambungan teks dari masukan.
- **Urutan otorisasi:** pemanggil diperiksa sebelum token dibaca pada exchange (`exchangeTarget`) dan re-issue (`authorizeCaller`, K-31), sehingga layanan lain tidak dapat menebak token mana yang ada; tabel kebijakan berupa larik yang dicari dengan `===`, tanpa kunci prototipe (`__proto__`, `constructor` diuji).
- **Token lintas layanan (invarian 5):** exchange dan re-issue mensyaratkan `source.service_id === requestingService`; exchange mensyaratkan konteks sumber P1 (`exchangeAllowed`); sumber bentuk 3 dikunci ke `TRANSACTION`/`PAYMENT_PROCESSING`, sehingga token FRAUD, NOTIFICATION, atau RECONCILIATION yang membawa `transaction_id` sama tidak pernah menjadi sumber (diuji).
- **Dicabut, kedaluwarsa, dikosongkan:** diperiksa setelah baris dibaca dengan `FOR SHARE` (exchange, bentuk 3) atau `FOR UPDATE` (re-issue) dalam transaksi yang sama, sehingga pencabutan atau retensi yang berjalan serentak tidak terlewat (tes menahan perubahan di `pg_locks` tanpa sleep). Baris `purged` dijawab `TOKEN_NOT_FOUND`.
- **Kripto:** AAD = jenis subjek + `id` baris yang dibangkitkan sebelum `INSERT`; dekripsi memakai baris tersimpan; subjek hasil dekripsi tidak pernah masuk hasil, baris audit, atau galat (`TokenResult` hanya `pseudonym`, `expiresAt`, `reused`).
- **Audit:** `AuditEntry` tanpa field subjek atau teks bebas; `pseudonym`, `purpose`, `transactionId`, `actorId` divalidasi bentuk sebelum `INSERT`; baris SUCCESS di transaksi yang sama dengan hasil, penolakan lewat transaksi pendek sendiri, dan bila baris itu gagal ditulis operasi gagal `INTERNAL_ERROR`; retensi menulis satu `PURGE_IDENTITY` per baris di transaksi batch yang sama; hak `privpay_app` hanya `INSERT` pada `audit_log`, tanpa `DELETE` di tabel mana pun.
- **Galat:** hanya kategori tetap (SQLSTATE, `pseudonym_collision`), tanpa nilai.

## Temuan dari review per tiket yang sudah diperbaiki (relevan keamanan)

Review dua sumbu (Standards dan Spec) per tiket menemukan enam hal yang kini tertutup dan masing-masing punya tes yang merah lebih dulu:

| Tiket | Temuan | Perbaikan dan bukti |
| --- | --- | --- |
| M2-05 | `now` dibaca sebelum kunci advisory: permintaan yang menunggu kunci menilai token dengan jam usang | jam dibaca setelah kunci; tes menahan kunci, memajukan `FakeClock`, mutan terbunuh |
| M2-05 | penolakan diaudit DENIED untuk semua galat kebijakan selain satu | daftar putih `POLICY_NOT_ALLOWED` dan `FORBIDDEN_ROLE` |
| M2-06 | pencabutan atau purge yang commit di antara STEP 1 dan `INSERT` terlewat (sumber dibaca tanpa kunci) | `FOR SHARE`; dua tes balapan |
| M2-07 | **deadlock** (`40P01`): dua re-issue serentak memegang kunci bersama lalu sama-sama meng-`UPDATE` baris sumber | `FOR UPDATE`; tes lima putaran × sepuluh paralel merah dengan `deadlock detected`, lalu hijau; mutan `FOR SHARE` terbunuh dua kali |
| M2-09 | langkah 1 retensi (`UPDATE` biasa) dapat antre di belakang exchange atau re-issue sambil memegang kunci baris (tunggu melingkar) | `FOR UPDATE SKIP LOCKED` pada kedua langkah |
| M2-04 | `ROLLBACK` yang gagal membocorkan galat driver mentah | `INTERNAL_ERROR` dan koneksi dibuang |

## Butir checklist

| # | Status | Bukti |
| --- | --- | --- |
| S-22 | **lulus** | N-24 menutup arah sebaliknya (`chk_mapping_complete`, `chk_vault_complete`); tujuh tes di `schema.integration.spec.ts`; E-29 |
| S-30 | lulus (tingkat token) | dump `pseudonym_mapping` dan baris audit tidak memuat subjek (`token-service`, `token-forms` integration) |
| S-36 | lulus (tingkat domain) | `retention.integration.spec.ts`: tujuh baris overdue lalu nol menurut oracle SQL sendiri (TF-14) |
| S-53 | lulus (tingkat domain) | 50 paralel × 5 putaran (satu `reused:false`, 49 `reused:true`), tes jaga tanpa kunci (`23505`), campuran dengan penolakan |
| S-03 | **sebagian** | tiga kunci berbeda sudah teruji (gerbang 1); pembacaan dari env/berkas di layanan belum dipasang |
| S-50 | **belum** | fail-closed butuh Docker dan lapisan HTTP (TK-16, M7); tidak dinyatakan lulus |

## Yang belum teruji atau belum ada

- Lapisan HTTP Privacy (`POST /pseudonymize`, `/re-issue`, `PATCH /transaction-status`) beserta tes `AZ-18`, `AZ-19`, `AZ-20`, `AZ-23`, `AZ-24` tingkat HTTP (N1 sampai N4); yang ada: tes penolakan pemanggil di tingkat layanan. Tidak ada klaim apa pun tentang autentikasi token layanan di Privacy.
- Pembacaan `TTL_*`, `RETENTION_DAYS`, `RETENTION_JOB_RUN_UTC`, kunci, dan kata sandi peran dari env/berkas, dan penjadwal job retensi.
- Brankas identitas, alur pembukaan, `revoke_*`, `GET /audit-log`, pemindai kenari, dan tokenizer Gateway (gerbang 3 dan M3).
- Tinjauan ini dilakukan dengan membaca kode, bukan menjalankan serangan.
