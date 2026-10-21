# Tinjauan keamanan penutup milestone M3 (M2 dan M3)

Tanggal: 2026-10-21. Cakupan: seluruh kode produksi M2 dan M3 (`git diff 7cbc6ab..main`; `7cbc6ab` adalah akhir M1): `services/privacy-service/src`, migrasi, `services/gateway/src/tokenizer`, `packages/common/src`.

Cara: `/security-review` oleh agen terpisah yang hanya membaca, ambang keyakinan 8 dari 10. Hasil: **tidak ada temuan dengan keyakinan 8 atau lebih**. Gerbang penuh dua putaran hijau pada Gerbang 3 sebelum tinjauan ini (unit 1035, integrasi 501 termasuk 23 tes keamanan, smoke 20, audit dan gitleaks bersih).

## Yang diperiksa dan mengapa tidak dapat dieksploitasi (ringkas)

- JWT: hanya RS256, `crit` ditolak, tanda tangan diverifikasi sebelum isi dibaca, `iss`/`aud`/`exp`/`iat` ditegakkan (umur maksimum 300 detik); pemanggil layanan hanya dari `azp` lewat daftar tetap; token orang plus token aktor ditolak; `requestingService`, `actorId`, `actorRole` hanya dari `authenticate()`, tidak pernah dari body.
- Pembukaan identitas: tidak ada jalan tanpa persetujuan. Urutan pemanggil, peran, lima gerbang, lalu syarat tambahan; permintaan terikat pada token (`mapping_id`); sekali pakai dijaga kunci baris dan penanda `status = 'APPROVED'`; empat mata di kode dan `chk_four_eyes`; HP dan rekening tidak pernah dibaca; `Cache-Control: no-store`.
- Lintas layanan: pertukaran dan re-issue menuntut pemilik token; bentuk 3 hanya membaca `transaction_link` konteks TRANSACTION/PAYMENT_PROCESSING; hanya Gateway yang menerbitkan dari identitas.
- SQL: semuanya berparameter; nama peran dan basis data dibatasi `^privpay_[a-z0-9_]{1,50}$`.
- Kripto: IV acak 12 byte per penulisan, tag 16 byte, AAD terikat baris dan kolom, versi kunci dari blob, galat dekripsi diseragamkan; tiga kunci berbeda; kunci tidak dapat diserialisasi.
- Gagal tertutup dan galat: galat basis data menjadi 503, tidak ada teks galat ke klien, kegagalan menulis audit menjadi 500.
- Hak basis data: `privpay_app` hanya INSERT pada `audit_log`; `privpay_auditor` hanya SELECT; `REVOKE ... FROM PUBLIC`.

## Pengamatan di bawah ambang (bukan temuan)

- `Tokenizer` mengambil `source_account` dari body nasabah dan tidak memeriksa kepemilikannya terhadap `customer_id` JWT (keyakinan 4/10). `docs/spec/transaction.md` menyatakan "verifikasi kepemilikan rekening" di luar lingkup prototipe, jadi ini batasan yang diketahui, bukan cacat. Dicatat agar tidak hilang.

## Checklist

| # | Status | Bukti |
| --- | --- | --- |
| <a id="s-01"></a>S-01 | ✔ lulus | `gitleaks detect --log-opts="--all"` nol temuan pada seluruh riwayat, tanpa allowlist (dijalankan pada `main` setelah merge Gerbang 3). Job CI belum pernah berjalan di GitHub. |
| <a id="s-02"></a>S-02 | ✔ lulus | `git ls-files secrets .env*`: hanya `.env.example`, `.env.test.example`, `secrets/README.md`; `tests/repo/gitignore.spec.ts`. |
| <a id="s-03"></a>S-03 | ✔ lulus | `crypto.spec.ts` FR-30: tiga kunci berbeda dan 32 byte diterima, selain itu ditolak; `startup.spec.ts` (Gerbang 1 M4): berkas tiap kunci yang hilang, atau variabel yang tidak diisi, menghentikan `createServiceApp` dengan nama variabelnya saja (tanpa jalur atau kunci). |
| <a id="s-04"></a>S-04 | — belum | belum ada image (ADR-0004); fase Docker. |
| <a id="s-05"></a>S-05 | — belum | belum ada compose; setara lokal dicatat di review-M1 (`make-secrets`). |
| <a id="s-06"></a>S-06 | — belum | belum ada kontainer (DK-01). |
| <a id="s-07"></a>S-07 | ◐ sebagian | review-M1: `BIND_HOST` hanya loopback (`nest-service.spec.ts`); `pg_hba` PostgreSQL lokal tidak diperiksa. |
| <a id="s-08"></a>S-08 | ◐ sebagian | review-M1: Action dipin SHA, `permissions` minimal (`ci-workflow.spec.ts`); workflow belum berjalan di GitHub. |
| <a id="s-10"></a>S-10 | ✔ lulus | review-M1; `gateway.spec.ts` TK-19. |
| <a id="s-11"></a>S-11 | ✔ lulus | review-M1; `authenticate.ts` umur maksimum 300 detik, token-cache selisih 30 detik. |
| <a id="s-12"></a>S-12 | ✔ lulus | `requestingService` dan aktor hanya dari `authenticate()` di tiap handler `privacy-http.ts`; skema `strictObject` menolak `requesting_service` di body (tes N4 di `http.integration.spec.ts`); TK-07 (M2-06); `/security-review` M2+M3. |
| <a id="s-13"></a>S-13 | ✔ lulus | TK-08 (`de-pseudonymize.integration`, AZ-22), TK-25 (AZ-11), FORBIDDEN_ROLE pada pencabutan dan audit-log di `http.integration.spec.ts`. |
| <a id="s-14"></a>S-14 | ✔ lulus | `pnpm test:security` lapis layanan: TK-06 (tanpa baris mapping), TK-13, TK-14, TK-15 dengan tepat satu baris DENIED; `policy-engine.spec.ts`. |
| <a id="s-15"></a>S-15 | ✔ lulus | `pnpm test:security` TK-01..TK-05 (reason tepat, satu baris DENIED); tes status token di `token-*.spec.ts`. |
| <a id="s-16"></a>S-16 | ✔ lulus | TK-20 / AZ-25 di `http.integration.spec.ts` dan `identity-vault.integration.spec.ts` (tanpa baris brankas). |
| <a id="s-20"></a>S-20 | — belum | TK-22 ada di M4-07 (Reconciliation belum ada). |
| <a id="s-21"></a>S-21 | ✔ lulus | TK-23: PENDING dan REJECTED ditolak `DISCLOSURE_NOT_APPROVED` (`de-pseudonymize.integration.spec.ts`). |
| <a id="s-22"></a>S-22 | ✔ lulus | TK-24 (`disclosure.integration`, AZ-11) dan `chk_four_eyes` lewat SQL langsung (`schema.integration.spec.ts`, review-M2-gerbang2). |
| <a id="s-23"></a>S-23 | ✔ lulus | TK-26: berlaku tepat 600 detik, ditolak 1 ms sesudahnya, pemakaian kedua ditolak, tiga pemakaian serentak tepat satu berhasil; mutasi (kunci baris dan penanda dihapus) membuat tes gagal. |
| <a id="s-24"></a>S-24 | ✔ lulus | TK-27 di `http.integration.spec.ts` dan `disclosure.integration.spec.ts`: 422, tanpa baris `disclosure_request`, satu baris DENIED. |
| <a id="s-25"></a>S-25 | ✔ lulus | TK-28: `REQUESTER_MISMATCH` untuk auditor lain; `disclosure_id` token lain `DISCLOSURE_NOT_FOUND` (`de-pseudonymize.integration.spec.ts`). |
| <a id="s-26"></a>S-26 | ✔ lulus | TK-21: hanya atribut yang disetujui; HP dan rekening tidak di-SELECT dan tidak ada di jawaban. |
| <a id="s-27"></a>S-27 | ◐ sebagian | pemindai kenari atas Privacy lulus (`pii-scan.integration.spec.ts`) dan tes audit/log M3-05; reconciliation-db dan log hilir belum ada (M4, M6). |
| <a id="s-30"></a>S-30 | ◐ sebagian | dump `identity_vault` dan `pseudonym_mapping` hanya ciphertext (`identity-vault.integration.spec.ts` FR-25, `token-*.integration`); DB hilir belum ada. |
| <a id="s-31"></a>S-31 | ✔ lulus | `crypto.spec.ts` (IV 12 byte acak, tag 16 byte, AAD terikat baris dan kolom) dan T-16: ciphertext yang dipindah ditolak (`identity-vault.integration.spec.ts`). |
| <a id="s-32"></a>S-32 | ✔ lulus | tinjauan M2+M3: hanya `node:crypto`; diff `package.json` 7cbc6ab..main tidak menambah pustaka kripto. |
| <a id="s-33"></a>S-33 | ✔ lulus | `safeEqual` (`timingSafeEqual`) dan aturan lint `tests/repo/lint-rules.spec.ts`; tiga kunci dibandingkan dengan `timingSafeEqual`. |
| <a id="s-34"></a>S-34 | ✔ lulus | `audit.integration.spec.ts` dan `schema.integration.spec.ts`: UPDATE/DELETE audit_log oleh `privpay_app` gagal `42501`; `privpay_auditor` hanya SELECT. |
| <a id="s-35"></a>S-35 | ✔ lulus | `schema.integration.spec.ts` S-35: `privpay_auditor` ditolak membaca tabel selain audit_log. |
| <a id="s-36"></a>S-36 | ◐ sebagian | TF-14 di `retention.integration.spec.ts` (tujuh baris overdue lalu nol); `RetentionJob` belum dijadwalkan ke siklus hidup proses. |
| <a id="s-37"></a>S-37 | ✔ lulus | TK-17 di `revocation.integration.spec.ts`: brankas dikosongkan, `PURGE_IDENTITY` tercatat. |
| <a id="s-38"></a>S-38 | ◐ sebagian | `audit_log` tanpa kolom identitas (skema, `chk_attribute_names`); DB hilir belum ada (M4). |
| <a id="s-40"></a>S-40 | ✔ lulus | tiap endpoint Privacy punya tes field tak dikenal 422 (`http.integration.spec.ts`); Gateway di review-M1. |
| <a id="s-41"></a>S-41 | ◐ sebagian | tinjauan M2+M3: semua SQL berparameter (satu-satunya teks yang digabung adalah konstanta `ROW_COLUMNS`); Semgrep di CI belum berjalan. |
| <a id="s-42"></a>S-42 | ◐ sebagian | lapis Gateway `pnpm test:security` (hanya `ACCESS_DENIED`, tanpa `reason`, token ada vs tidak ada identik) memakai pengganti Reconciliation, bukan end-to-end; Newman M6-01. |
| <a id="s-43"></a>S-43 | ◐ sebagian | tes Privacy: log dan baris audit tanpa nilai identitas (`http.integration.spec.ts`, `de-pseudonymize.integration.spec.ts`); pemindai penuh di M4, M6. |
| <a id="s-44"></a>S-44 | ◐ sebagian | review-M1: separuh Gateway lulus; redaksi log Kong menunggu fase Docker. |
| <a id="s-45"></a>S-45 | ✔ lulus | aturan ESLint `no-console` (`pnpm lint` hijau). |
| <a id="s-50"></a>S-50 | — belum | fail-closed butuh Docker (TK-16, M7); tidak dinyatakan lulus. |
| <a id="s-51"></a>S-51 | ✔ lulus | review-M1; `rate-limiter.spec.ts`. |
| <a id="s-52"></a>S-52 | — belum | M4 (uji injeksi keterlambatan belum ada). |
| <a id="s-53"></a>S-53 | ✔ lulus | TF-07: 50 paralel x 5 putaran di `token-service.integration.spec.ts`. |
| <a id="s-54"></a>S-54 | — belum | M4 (Transaction belum ada). |
| <a id="s-55"></a>S-55 | ✔ lulus | `limit` audit-log <= 200 diuji (`audit-log.integration.spec.ts`); `http.integration.spec.ts` (Gerbang 1 M4): badan tepat 16 KiB diterima, satu byte lebih 422 tanpa baris; mutasi `MAX_BODY_BYTES` ke 32 KiB membuat tes gagal. |
| <a id="s-60"></a>S-60 | ✔ lulus | `pnpm audit --prod --audit-level high`: tanpa kerentanan (dua putaran Gerbang 3). |
| <a id="s-61"></a>S-61 | — belum | CodeQL dan Semgrep hanya di CI, belum berjalan. |
| <a id="s-62"></a>S-62 | — belum | Trivy hanya di CI, belum berjalan. |
| <a id="s-63"></a>S-63 | — belum | `dependency-review` hanya pada PR di GitHub. |
| <a id="s-64"></a>S-64 | ✔ lulus | tercatat di CHANGELOG per tiket; M2-M3 tidak menambah paket baru di lockfile selain yang sudah ada di workspace. |
| <a id="s-65"></a>S-65 | — belum | pengaturan repositori tidak dapat diverifikasi dari sini. |
| <a id="s-70"></a>S-70 | — belum | M6. |
| <a id="s-71"></a>S-71 | — belum | M6. |
| <a id="s-72"></a>S-72 | — belum | M6. |
| <a id="s-73"></a>S-73 | — belum | M6. |
| <a id="s-74"></a>S-74 | ✔ lulus | fixture fiktif (`CUST-0001xx`, nama "Tes/Contoh Palsu", NIK `0000...`/`9999...`, kenari dibentuk saat berjalan). |
