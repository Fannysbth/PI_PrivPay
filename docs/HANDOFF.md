# HANDOFF (2026-10-22): Gerbang 4 M4 LULUS (dua putaran hijau); berikutnya penutup M4 (belum dimulai), lalu M5

## Status Gerbang 4 M4

Cabang `feat/m4-gerbang-4` (tidak dihapus), commit: `8476b6c` validasi panjang `sub` (64 karakter, 422), `50a86fc` M4-08 (termasuk ADR-0014), `f598537` M4-09, `a1a5801` satu pola HP. `/code-review`: 10 temuan, 1 diperbaiki, 9 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 62 suite, 1227 tes | 62 suite, 1227 tes |
| integrasi | 51 suite, 1046 tes | 51 suite, 1046 tes (lihat catatan) |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat | bersih | bersih |
| pii-scan | 35 + 68 tes | 35 + 68 tes |

Catatan putaran 2: lari integrasi pertama gagal satu tes (`db.integration`, "recreates the database from scratch", batas 30 detik). Stempel waktu log melompat ±2 jam di tengah suite itu (mesin tidur/sleep; durasi suite 6975 detik), jadi batas jam dinding habis oleh tidur mesin, bukan kode. Suite itu sendirian lulus (26 tes) dan seluruh integrasi diulang hijau (51 suite, 1046 tes). Bila gagal lagi tanpa tidur mesin, perlakukan sebagai bug.

### Yang dibangun

- ADR-0014 (E-31): `API_GATEWAY` boleh `revoke_subject` untuk `CUSTOMER` (kompensasi pendaftaran). Dua tes lama diubah dengan alasan di CHANGELOG.
- M4-08: `POST /register` (A2, A5, A3, A4, kompensasi, laju per alamat sumber) dan `POST /notification/register` (AZ-02) di Gateway; env baru wajib `NOTIFICATION_SERVICE_URL`.
- M4-09: tumpukan E2E dengan dev-idp, Privacy, Transaction, Fraud, Notification, simulator SMS, Reconciliation asli di `services/gateway/test/e2e` (`registration` 28 tes, `scenarios` 13 tes); `pnpm pii-scan` menjalankannya. Rute `held` dan `review` kini teruji lewat Gateway (AZ-04, AZ-05).

### Keputusan yang butuh persetujuan Fanny

N-38 (email divalidasi lalu dibuang: brankas tidak punya kolom email, jadi "email hanya di brankas" tidak terpenuhi harfiah; email tidak ada di mana pun), N-39 (kompensasi mengosongkan brankas walau A5 melaporkan gagal), ADR-0014 sudah Accepted atas pilihanmu.

### Temuan `/code-review` yang ditolak

Telepon yatim di Notification bila jawaban A4 hilang (batas ADR-0005: Notification tak punya hapus kontak; token domainnya dicabut); pengguna IdP yatim bila jawaban A2 hilang (batas yang dicatat); batas panjang `sub` untuk semua jenis token (diminta); ADR-0014 berlaku untuk semua `CUSTOMER` (risiko diterima di ADR); `req.ip` tanpa `trust proxy` (belum ada proksi; harus ditinjau saat Kong/Docker); `customerId ?? ''` (tak terjangkau, `mayCall` memeriksa klaim lebih dulu); enumerasi nama pengguna lewat 422 (tak terhindarkan, dibatasi laju); `Content-Length` tak ada pada badan chunked (setiap field dibatasi skema); kompensasi karena NIK ganda mengosongkan brankas pelanggan lain (tidak: purge berkunci `customer_lookup` dari id pelanggan baru).

### TK yang belum teruji end-to-end (keputusanmu)

TK-01, TK-06, TK-09, TK-13, TK-14, TK-15: lapis layanan dan relay jawaban kawat saja, sampai M6-01 (Newman lewat Gateway).

### Belum teruji

Adapter baseline (M5); Newman (M6-01); fail-closed dengan Docker; `trust proxy` di belakang Kong; kinerja D2 untuk ribuan transaksi.

### Untuk penutup M4

`/security-review` seluruh M4, centang `docs/security/security-checklist.md`, `/improve-codebase-architecture` (boilerplate autentikasi dan pool terulang di enam layanan), persetujuan Fanny, lalu `/retro`. M5 belum dimulai.

# (Riwayat) Gerbang 3 M4 LULUS (dua putaran hijau)

## Status Gerbang 3 M4

Cabang `feat/m4-gerbang-3` (tidak dihapus), commit: `ffe2081` flake basis data, `24ebfd6` keputusan Gerbang 2 nomor 1 (PATCH yang tak didengar Privacy), `34f28ac` M4-06, `57c5f45` M4-07, `9426ce2` perbaikan `/code-review`. `/code-review`: 10 temuan, 2 diperbaiki, 8 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas (Gateway tanpa `no-store` ditemukan tes M4-07 sendiri dan diperbaiki, N-36).

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 61 suite, 1216 tes | 61 suite, 1216 tes |
| integrasi | 49 suite, 1001 tes | 49 suite, 1001 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih | bersih |
| pii-scan | 35 + 27 tes | 35 + 27 tes |

### Penyelidikan flake basis data (M2-09, token-service, M0-04)

Penyebab yang ditemukan (dibuktikan sebagian, tidak direproduksi di bawah beban): (1) `createPool` memakai `connectionTimeoutMillis: 5000` di tingkat klien `pg` (`client.js`: timer membunuh socket); membuka backend PostgreSQL baru di Windows lebih lambat dari itu bila memori sempit atau basis data baru dibuat, dan 50 permintaan paralel membuka sepuluh sekaligus. (2) Poll tes yang dibatasi jumlah putaran (M0-04: 5000 putaran = ±1,5 detik pada mesin tenang, terukur 300 ms untuk ±900 putaran) berakhir terlalu cepat saat beban. Perbaikan di konfigurasi tes, tanpa melonggarkan asersi: pool `createTestDb` dengan batas koneksi 20 detik (bawaan produksi tetap 5 detik, opsi baru `connectionTimeoutMillis`), dan tujuh poll diganti tenggat 20 detik. `max_connections` 100, `shared_buffers` 128 MB; puncak koneksi per suite ±18 dengan satu worker, bukan penyebab. Satu kegagalan tak stabil baru terlihat sekali (`reconciliation-http`, "service notification with an admin", saat gerbang parsial) dan tidak terulang dalam 3 + 2 lari penuh; bila muncul lagi, perlakukan sebagai bug.

### Keputusan Gerbang 2 yang dikerjakan

1. Notifikasi sebelum `PATCH`: spek 5 diubah dengan alasannya. `PATCH` yang gagal kini tidak diam: kolom `privacy_synced_at` (migrasi 0003, **penyimpangan dari PRD 11, N-34, commit terpisah, dapat dibatalkan**) menandai baris yang belum didengar Privacy, dan `PendingSweeper.resync()` mengulang `PATCH` tanpa mengirim ulang notifikasi (8 tes, dua mutasi terbunuh). 3. Pelaku review sudah tercatat (`reviewed_by` = `sub` token aktor, `reviewed_at`), tanpa data pribadi; catatan: `sub` tanpa batas panjang, kolom 64 karakter. 2, 4, 5, 6 sesuai keputusan.

### Yang dibangun

- M4-06: Reconciliation (`settlement-report`, `run`, `Reconciler`, `DailyRun`), skema reconciliation-db, `GET /transaction/completed`, simulator bank (`POST /simulate/settlement`).
- M4-07: `audit-request`, `disclosure`, `GET /transaction/{id}`; lapis Gateway M3-06 memakai Reconciliation sungguhan (N-37: TK-02..05 lewat jalur nyata, TK-08 ditolak Gateway, TK-01/06/09/13/14/15 tetap meneruskan jawaban kawat Privacy karena pemanggilnya tak punya rute klien).
- Env baru wajib: Reconciliation `RECON_DAILY_RUN_UTC`, `PRIVACY_SERVICE_URL`, `TRANSACTION_SERVICE_URL`, `RECONCILIATION_CLIENT_SECRET_FILE`; simulator bank `GATEWAY_URL`, `BANK_USERNAME`, `BANK_SIMULATOR_TEST_ENDPOINTS` (opsional, `true`/`false`).

### Keputusan yang butuh persetujuan Fanny

N-32 (batch pengganti `MISMATCHED` sampai run), N-33 (D2: `TOKEN_NOT_FOUND`/`REVOKED` tak berpasangan, selain itu 503), N-34 (kolom `privacy_synced_at`), N-35 (baris `audit_requests` hanya sesudah token terbit), N-36 (`no-store` di Gateway), N-37 (perubahan lapis Gateway M3-06). Semuanya di `docs/OPEN_QUESTIONS.md`.

### Temuan `/code-review` yang ditolak

`resync` PATCH status basi (Privacy menolak balik ke non-final, tanda dijaga status, baris dibaca ulang dengan status baru); D2 berurutan (volume prototipe); atomisitas `audit-request` dengan Privacy (lintas layanan, Privacy sudah mencatat aktor); kursor bersama `held`/`completed` (hanya posisi, tanpa dampak keamanan); urutan tie-break referensi bank (deterministik); parameter query ganda (sudah 422); back-fill migrasi 0003 (hanya basis data pengembangan).

### Belum teruji

Adapter baseline (M5); Newman lewat Gateway (M6-01); alur `/register` dan E2E TX-10001..10003 (M4-08, M4-09); fail-closed dengan Docker; kinerja D2 untuk ribuan transaksi per hari.

### Untuk Gerbang 4

M4-08 (alur pendaftaran, bergantung M2-08, M4-05, M1-01) dan M4-09 (E2E, bergantung M4-02, M4-03, M4-06, M4-08). `pnpm db:migrate` kini juga mengisi transaction-db, fraud-db, notification-db, reconciliation-db (bila `SERVICE_DBS` didaftar).

# (Riwayat) Gerbang 2 M4 LULUS, di-merge ke `main` lokal

## Status Gerbang 2 M4

Commit di `feat/m4-gerbang-2` (cabang tidak dihapus): `131ec26` M4-02 orkestrasi, `2838ace` M4-03 review `HELD` dan pembersih `PENDING`, `d58f852` perbaikan `/code-review`. `/code-review`: 9 temuan, 4 diperbaiki, 5 ditolak. `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 57 suite, 1127 tes | 57 suite, 1127 tes |
| integrasi (2 worker) | 39 suite, 803 tes (lihat catatan) | 39 suite, 803 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` | bersih | bersih |
| pii-scan | 35 + 16 tes | 35 + 16 tes |

Catatan putaran 1: lari integrasi pertama gagal satu tes, `M0-04 a runner waits while another one holds the migration lock` (`packages/common/test/migrate.integration.spec.ts`, tidak diubah di gerbang ini). Suite itu sendirian lulus 15/15 dua kali dan seluruh integrasi diulang hijau. Penyebab tidak diselidiki; dianggap flake bergantung waktu saat beban penuh. Bila terulang, perlakukan sebagai bug.

### Yang dibangun

- M4-02: `TransactionProcessor` mengorkestrasi Fraud (X1), `PATCH` status ke Privacy, dan notifikasi (X2) lewat port (`SubjectReferencePort` dengan adapter proposed, `FraudClient`, `NotificationClient`, `PrivacyStatusClient`, adapter HTTP di `clients.ts`). Fraud mati, timeout, atau pertukaran gagal: `HELD` + `FRAUD_UNAVAILABLE`. Fraud dan Notification `idempotent: false` (satu panggilan, diuji dengan hilir lambat, 503, dan galat jaringan). Token kedaluwarsa: re-issue kedua token, coba sekali lagi. Mesin status di `status-machine.ts`, dijaga di SQL (`WHERE status = $asal`); pemenang terlambat menjawab status tersimpan.
- M4-03: `GET /transaction/held` (kursor keyset opak), `POST /transaction/{id}/review` (baris dikunci `FOR UPDATE`, aktor dari token), `PendingSweeper`.
- Env baru, semuanya wajib (gagal cepat): `PRIVACY_SERVICE_URL`, `FRAUD_SERVICE_URL`, `NOTIFICATION_SERVICE_URL`, `TX_PENDING_TIMEOUT_SECONDS`, `TRANSACTION_CLIENT_SECRET_FILE`.

### Keputusan yang butuh persetujuan Fanny

1. **Urutan notifikasi dan `PATCH` dibalik** (notifikasi dulu) di jalur orkestrasi dan review. Spec 5 menulis PATCH (langkah 3) lalu notifikasi (langkah 4), tetapi Privacy menolak re-issue (`TX_TERMINAL`) setelah transaksi final, sehingga TF-04 tak terpenuhi bila PATCH lebih dulu. Catatan sudah ditambahkan di spec 5; ubah atau kembalikan bila tidak setuju.
2. **Review pada id yang tidak ada dijawab `NOT_HELD`** (409), bukan 404: spec 3.3 hanya menyebut "bukan `HELD`".
3. **`reason_code` review divalidasi tetapi tidak disimpan**: tabel `transactions` (PRD 11) tidak punya kolomnya. Bila jejak alasan diperlukan, butuh kolom (ADR).
4. **`COMPLETED` lewat review mengisi `completed_at`, `FAILED` (REJECT) tidak**, mengikuti jalur otomatis.

### Temuan `/code-review` yang ditolak

re-issue dua token berurutan (Privacy mengembalikan token baru yang sama pada panggilan kedua, jadi gagal sebagian aman diulang); penantian pemenang tetap `HTTP_TIMEOUT_MS` (ADR-0009 / K-25, 409 aman diulang); env baru wajib (CLAUDE.md: gagal cepat); `MutableSubject` (gaya, berurutan, tidak ada balapan).

### Belum teruji

adapter baseline `SubjectReferencePort` (M5); rute Gateway ke `held` dan `review` (AZ-04, AZ-05 di sisi Gateway; hanya sisi layanan AZ-27 dan AZ-28 yang diuji); Privacy, Fraud, Notification asli di belakang Transaction end-to-end (M4-09); endpoint 3.4 untuk Reconciliation (M4-06); fail-closed dengan Docker.

### Untuk Gerbang 3 (M4-06, M4-07)

Urutan menurut `docs/tickets/README.md`. Boilerplate autentikasi dan pool terulang di enam layanan (kandidat `/improve-codebase-architecture` setelah M4 dan M5).

# (Riwayat) Gerbang 1 M4 LULUS (dua putaran hijau)

## Status Gerbang 1 M4

Commit di `feat/m4-gerbang-1` (di-merge ke `main`, cabang tidak dihapus): tes S-55 dan S-03; M4-01 Transaction (`POST /transaction`, idempotensi ADR-0009); M4-04 Fraud (`POST /fraud/assess`, `RiskEngine`); M4-05 Notification dan SMS simulator; perbaikan `/code-review`; premis tes `db:migrate`; pelajaran di `CLAUDE.md`. `/code-review`: 10 temuan, 3 diperbaiki, 7 ditolak (alasan di CHANGELOG dan laporan). `/security-review`: tanpa temuan keyakinan 8 ke atas.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 56 suite, 1116 tes | 56 suite, 1116 tes |
| integrasi | 34 suite, 692 tes | 34 suite, 692 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` (tanpa allowlist) | bersih | bersih |

**Penulisan ulang riwayat (atas persetujuan Fanny, hanya `feat/m4-gerbang-1`):** UUID dan token contoh tertulis literal di lima berkas tes di `services/` pada commit M4-01 dan M4-04, sehingga `gitleaks --all` merah. Riwayat lokal cabang itu (belum di-push) ditulis ulang dengan `git filter-branch --tree-filter` supaya nilai itu dibentuk saat tes berjalan; ref `refs/original` dihapus; `main` dan cabang lain tidak disentuh. Verifikasi: pohon akhir `6bd6d08` identik dengan pohon sebelum penulisan ulang, dan terhadap pohon `cfec27a` hanya berbeda pada lima baris literal itu. Cadangan bundle di scratchpad sesi. Pelajarannya sudah di `CLAUDE.md`.

### Keputusan Fanny pada Gerbang 1 M4

N-30 (rute uji yang mati dijawab 422 seragam, bukan 404), N-31 (kegagalan Privacy pada `send` tanpa baris log; galat basis data tetap 5xx), perubahan lockfile (hanya entri importer untuk paket yang sudah ada), perubahan premis tes `db:migrate`, dan M4-04 lalu M4-05 dikerjakan berurutan.

### Untuk Gerbang 2 (M4-02 dan M4-03)

- `POST /fraud/assess` dan `POST /notification/send` tidak boleh di-retry oleh Transaction (`idempotent: false`); M4-02 wajib mengujinya (uji injeksi keterlambatan).
- Sementara Fraud belum terpasang, `TransactionProcessor.decide` menjadikan jumlah di atas ambang `HELD` dengan `FRAUD_UNAVAILABLE`; M4-02 menggantinya dengan orkestrasi nyata.
- `TransactionRepository.finish` hanya mengubah baris `PENDING` dan hasilnya tidak diperiksa; pembersih `PENDING` (M4-03) menandai `FAILED`, jadi pemenang yang terlambat harus menjawab status yang tersimpan (uji).
- Boilerplate autentikasi dan pool terulang di lima layanan; kandidat `/improve-codebase-architecture` setelah M4 dan M5.

### Belum teruji (Gerbang 1 M4)

Orkestrasi Transaction dengan Fraud, Notification, dan Privacy (M4-02); pembersih `PENDING` (M4-03); rute `/register` Gateway ke Notification (M4-08); adapter baseline (M5); fail-closed dengan Docker; endpoint 3.4 untuk Reconciliation.

# (Riwayat) M3 ditutup di `main` lokal; berikutnya M4

## Penutup M3

`/security-review` atas seluruh M2 dan M3 (`7cbc6ab..main`): tanpa temuan keyakinan 8 atau lebih, jadi tidak ada perubahan kode dan gerbang tidak diulang (gerbang terakhir: dua putaran hijau pada Gerbang 3). Checklist: 28 butir ✔, 12 ◐, 15 belum (kolom "Status (penutup M3)" di `docs/security/security-checklist.md`, bukti di `docs/security/review-M3.md`). Retro: `docs/RETRO_M3.md`; pelajaran berulang masuk `CLAUDE.md`. Keputusan Fanny: `reject` tanpa `approver_id` dan tafsir K-33 / ADR-0013 disetujui. Batasan yang diketahui: `source_account` nasabah tidak diperiksa kepemilikannya (di luar lingkup, spec transaction.md).

**Usulan pembagian gerbang M4** (satu tiket satu commit, `/code-review` dan `/security-review` tiap gerbang, gerbang penuh dua putaran): Gerbang 1 = M4-01 (inti Transaction, idempotensi), lalu M4-04 (Fraud) dan M4-05 (Notification dan SMS simulator) yang bergantung padanya hanya pada M0-04, M2-11, M3-01 (kandidat `/implement-spec` paralel setelah M4-01); Gerbang 2 = M4-02 (orkestrasi, butuh M4-01, M4-04, M4-05) dan M4-03 (review `HELD`); Gerbang 3 = M4-06 (Reconciliation inti dan bank simulator) dan M4-07 (audit dan pembukaan, butuh M3-05); Gerbang 4 = M4-08 (alur registrasi) dan M4-09 (skenario E2E TX-10001..10003). Urutan mengikuti kolom "Bergantung pada" di `docs/tickets/README.md`. Tiap tiket yang menambah tabel menjalankan `pnpm db:migrate` setelah merge.

# (Riwayat) Gerbang 3 M3 LULUS (dua putaran hijau) dan di-merge ke `main` lokal

Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD. `main` (lokal, belum di-push) memuat M0, M1, M2 dan Gerbang 1, 2, 3 M3. Branch gerbang tidak dihapus. Penutup M3 (`/security-review` milestone, centang checklist, `/retro`) belum dikerjakan.

## Status Gerbang 3

Commit: `8b6996c` M3-05 `POST /de-pseudonymize`, `3da2755` M3-06 suite keamanan (`pnpm test:security`), `b0bcbbb` header `Cache-Control: no-store`. `/code-review` (enam temuan, semua ditolak) dan `/security-review` (tanpa temuan) dijalankan; perubahan header sesudahnya hanya satu baris yang mengurangi paparan, jadi tidak ditinjau ulang.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 52 suite, 1035 tes | 52 suite, 1035 tes |
| integrasi (termasuk 23 tes keamanan) | 22 suite, 501 tes | 22 suite, 501 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks `--all` (tanpa allowlist) | bersih | bersih |

Cabang `backup/m2-gerbang-3-sebelum-rewrite` dihapus atas keputusan Fanny; itu satu-satunya tempat tiga temuan gitleaks lama berada.

### M3-05 (tes wajib, masing-masing punya tes sendiri)

Token masih hidup saat dipakai; persetujuan berlaku tepat 600 detik dan ditolak 1 ms sesudahnya (FakeClock); pemakaian kedua ditolak; dua dan tiga pemakaian serentak: tepat satu berhasil (tes yang memaksa antre di baris persetujuan; mutasi dengan kunci baris dan penanda sekali pakai dihapus membuat tiga pemakaian berhasil dan tes gagal, kode sudah dikembalikan; menghapus salah satu saja tidak membuat tes gagal karena keduanya saling menutup); pencabutan token atau subjek di antara persetujuan dan pemakaian; pemohon dan token harus sama; hanya atribut yang disetujui, audit tanpa nilai.

### Keputusan Fanny pada Gerbang 3

- **N-29** diterima: penyimpangan dari spec 7.8. Pemanggil dan peran auditor diperiksa sebelum baris apa pun dibaca, karena gerbang 5 menuntut pemohon = aktor (selalu auditor) sehingga `FORBIDDEN_ROLE` (TK-08) tak terjangkau bila peran diperiksa sesudahnya. Tercatat di `OPEN_QUESTIONS.md` dan spec 7.8.
- Persetujuan yang lewat 600 detik tidak ditandai `EXPIRED` di database (gerbang 5 memakai `now > expires_at`).
- Respons `/de-pseudonymize` memakai `Cache-Control: no-store`.
- TTL wajib di env, `reject` tanpa `approver_id`, pool `auditor` saat start: disetujui.
- Lapis Gateway M3-06 dan Newman ditunda ke M4-07 dan M6-01.

### Temuan `/code-review` Gerbang 3 yang ditolak

Atribut kosong menjadi SUCCESS (tak terjangkau: daftar atribut dibatasi di `request` dan `chk_attribute_names`); batas `now > expires_at` (spec 7.8 menulis `≤`, diuji pada 600 detik tepat); dekripsi gagal setelah penanda `USED` (transaksi rollback, penanda ikut batal, 500 tanpa baris menurut spec 9.4); validasi bentuk tidak diaudit (spec 9.4); konstanta peran `'auditor'` (gaya, sama dengan `DisclosureService`); `no-store` (kemudian diterima dan dikerjakan).


## Belum teruji / belum ada (Gerbang 3)

- **Lapis Gateway M3-06 bukan end-to-end:** jawaban Privacy yang asli diteruskan oleh pengganti Reconciliation lewat Gateway asli; Gateway belum punya jalur klien ke operasi tukar atau buka identitas. Reconciliation sungguhan (M4-07) dan Newman lewat Gateway (M6-01) belum ada, jadi lapis Gateway belum teruji end-to-end.
- Tabel layanan selain Privacy (transaction M4-01, fraud M4-04, notification M4-05, reconciliation M4-06) belum ada; `pnpm db:migrate` mengisinya setelah migrasinya dibuat.

## Status Gerbang 2

Commit: `73088cc` M3-03, `58013cd` M3-04, `8e3df06` perbaikan `/code-review`, `c572b7a` fixture smoke, `6b071e4` timer shutdown dibatalkan setelah drain (`service-app.ts`), `fe1fe46` N-28 (kedua reason dihitung bersama per layanan), `bef14df` jendela persetujuan wajib dari env, `a0b4270` `pnpm db:migrate`. `/code-review` dan `/security-review` dijalankan; tidak ada temuan keamanan.

Putaran gagal sebelumnya (integrasi, `token-service.integration`, "Connection terminated due to connection timeout" di 50 permintaan paralel) terjadi saat memori hampir habis. Setelah memori longgar, suite itu sendirian lulus dua kali (36 tes) dan tidak gagal lagi di kedua putaran berikut. Penyebab dianggap tekanan memori mesin; tidak ada perubahan kode atau pelonggaran tes. Bila muncul lagi saat memori longgar, perlakukan sebagai bug pool/koneksi.

Dua putaran berturut-turut, satu proses pada satu waktu:

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 52 suite, 1035 tes | 52 suite, 1035 tes |
| integrasi | 20 suite, 449 tes | 20 suite, 449 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih (99 commit) | bersih (99 commit) |

Peringatan "worker failed to exit gracefully" tidak muncul lagi di unit. `gitleaks --all` (termasuk `backup/m2-gerbang-3-sebelum-rewrite`) melaporkan 3 temuan generic-api-key di commit `094c77d`, fixture tes lama yang hanya ada di cabang cadangan itu; tidak ada di riwayat cabang lain. Pemindaian tanpa cabang cadangan: `--log-opts="--exclude=backup/* --branches --remotes"`.

## Keputusan Fanny (2026-10-21)

- `pnpm db:migrate` resmi: hanya menyasar database pengembangan layanan (nama tetap dari `SERVICE_DBS`, kini hanya `privpay_privacy` karena hanya Privacy punya migrasi), tidak pernah database tes, tidak jalan otomatis, maju-saja. Dicatat di `CLAUDE.md`.
- N-28 diterima: kedua reason dihitung bersama per layanan, sesuai bunyi PRD 12 / spec 4.8.
- Perbaikan `service-app.ts` dan merge Gerbang 2 ke `main` disetujui.

## Keputusan yang masih butuh persetujuan (Gerbang 2, belum dijawab)

- `DISCLOSURE_APPROVAL_TTL_SECONDS` kini wajib di env (tanpa nilai bawaan); `reject` tidak mengisi `approver_id`; pool `auditor` dibuka saat start.
- Tafsir K-33 / ADR-0013 (lihat bagian Gerbang 1).

### Temuan `/code-review` Gerbang 2 yang ditolak

`approve` tanpa cek token (ditangani M3-05, lihat di atas); ringkasan tetap tanpa mengunci pool (sudah diperbaiki: satu snapshot); dua koneksi per permintaan audit (hanya beban, bukan kebenaran; pool bawaan cukup); jendela peringatan terpotong oleh `from`/`to` (rentang memang membatasi data yang dihitung); kursor tidak terikat pada filter (hanya posisi keyset, tidak ada dampak keamanan); admin boleh menyaring `pseudonym` pada daftar (sesuai spec 4.8 dan PRD); `basis` 64 vs kolom 32 (kebijakan menolak dulu, insert tidak pernah melihat basis panjang); helper validasi duplikat dan spread berulang (gaya, tidak diubah).

## Pembagian gerbang M3 (Gerbang 1 selesai dan di-merge ke `main`)

- Gerbang 1 (`feat/m3-gerbang-1`): M3-01 `resolve-domain`, M3-02 pencabutan token dan subjek. **Selesai.**
- Gerbang 2 (`feat/m3-gerbang-2`): M3-03 pembacaan audit, M3-04 alur pembukaan identitas. Ditulis; gerbang penuh belum hijau (lihat atas).
- Gerbang 3 (`feat/m3-gerbang-3`): M3-05 `de-pseudonymize`, M3-06 suite keamanan (`pnpm test:security`). **Selesai dan di-merge ke `main`.**
- Urutan mengikuti dependensi tiket; satu tiket satu commit, `/code-review` dan `/security-review` di akhir tiap gerbang, gerbang penuh dua putaran.

## Gerbang 1 M3

Commit: `560179d` M3-01, `e723e8e` M3-02, `bf6afdf` perbaikan review M3-02. Dua putaran berturut-turut, satu proses pada satu waktu:

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 51 suite, 1027 tes | 51 suite, 1027 tes |
| integrasi | 17 suite, 377 tes | 17 suite, 377 tes |
| smoke | 20 tes | 20 tes |
| audit --prod | bersih | bersih |
| gitleaks riwayat (tanpa cabang cadangan) | bersih | bersih |

Tes M2-09 `step 1 does not wait for a row in use` lulus di kedua putaran. Unit mencetak peringatan "worker failed to exit gracefully" (belum diselidiki; tes lulus semua).

`/code-review`: temuan valid diperbaiki (kelas `NothingToRevoke` menggantikan pencocokan `action`/`reason`; komentar `REVOCATION_SQL`). Ditolak: kunci advisory pada `revoke_subject` (balapan dengan penerbitan, lihat keterbatasan a); audit N baris berurutan (paling banyak 6 token aktif per subjek karena `uq_mapping_active`); urutan kunci identitas vs baris token (jalur `store` tidak menyentuh baris token, tidak ada siklus); `findDomain` tanpa ORDER BY (paling banyak satu P5 aktif per subjek); `actorOf` tidak dipakai di `resolveDomain` (tidak ada perbedaan perilaku); HMAC lookup sebelum cek peran (tanpa log, hanya HMAC). `/security-review`: tidak ada temuan.

### Keterbatasan yang diketahui (dari `/security-review`)

- (a) Token yang terbit bersamaan dengan `revoke_subject` bisa lolos dari pencabutan. Gateway boleh menerbitkan token baru untuk subjek yang sama kapan saja, jadi pencabutan memang bukan blokir penerbitan.
- (b) Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject` (spec 4.6: hanya baris `active`); diserahkan ke retensi (berjalan terjadwal sejak M4-10).

### Keputusan di tiket (tidak ada ADR yang bertabrakan)

- `revokeToken`/`revokeSubject` ada di `RevocationService` (bukan `TokenService`, agar berkas tidak membengkak); spec 2 dan 4.6 diperbarui. Meminta persetujuan Anda bila ingin dipindah ke `TokenService`.
- `revoke_subject` tanpa apa pun: HTTP 200 `{revoked_count: 0}` dengan satu baris audit DENIED `TOKEN_NOT_FOUND` (membaca spec 4.6 harfiah). `PURGE_IDENTITY` dari pencabutan memakai `requesting_service = ADMIN_CONSOLE` dan `actor_id` admin (K-32 hanya mengatur job retensi).
- `AuditedOperation` kini menerima daftar baris SUCCESS (satu per token, spec 4.6).
- K-33 / ADR-0013 ("ikut mengosongkan atau menghapus tautan"): berlaku bila `revoke_subject` mengosongkan baris mapping; spec 7.10 hanya menandai `revoked` dan mengosongkan brankas, jadi tautan tidak disentuh (sumber `revoked` harus tetap terbaca `REVOKED`, K-29). Mohon konfirmasi tafsir ini.

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Diuji di tingkat Gateway dengan Privacy asli dihentikan.
- Rute `/register` dan `/notification/register` serta `RegistrationFlow` (M4-08). Plugin Lua belum diuji terhadap vektor kontrak (DK-02).
- Body bukan JSON tanpa token mendapat 422 sebelum 401 (parser JSON bersama). Dicatat, belum diubah.
- `pnpm test:security` dan `pnpm newman` belum ada (M3-06, M6-01); Docker belum ada.

## Keterbatasan yang sudah dicatat

- Token yang terbit bersamaan dengan `revoke_subject` bisa lolos pencabutan (Gateway boleh menerbitkan token baru untuk subjek yang sama).
- Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject`; diserahkan ke retensi (berjalan terjadwal sejak M4-10).

## Langkah berikutnya

1. Penutup M3: `/security-review` milestone M2/M3, centang bagian relevan di `docs/security/security-checklist.md`, persetujuan Fanny, lalu `/retro`.
2. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap: dokumentasi singkat sekali per tiket, dua review hanya untuk tiket inti, keluaran ringkas, satu proses pada satu waktu, jangan menjalankan tes saat memori hampir habis. Sisa database tes dapat dibersihkan dengan `pnpm db:test-databases drop` (ketik `DROP <jumlah>`).
