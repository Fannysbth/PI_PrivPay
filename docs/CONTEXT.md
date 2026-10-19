# CONTEXT — glosarium dan bahasa bersama

Dipakai oleh `/grill-with-docs`: tiap istilah baru atau penajaman istilah langsung ditambahkan di sini. Satu istilah satu arti. Nama di kode memakai kolom "Nama di kode".

## Istilah inti

| Istilah | Arti | Nama di kode | Jangan dipakai / rancu dengan |
| --- | --- | --- | --- |
| Subjek (subject) | Yang dipseudonimkan: pelanggan (`CUSTOMER`) atau rekening (`ACCOUNT`) | `subjectType`, `subjectId` | "user" (ambigu: bisa pengguna Keycloak) |
| Pseudonim / token | Pengenal pengganti `PSEU-XXXXXXXX` untuk satu subjek pada satu konteks | `pseudonym` | "ID" polos; token JWT (itu `jwt`/`accessToken`) |
| Konteks | Kombinasi `service_id` + `purpose` + `subject_type` pada Tabel 1 (P1..P7) | `PolicyContext` | |
| Layanan pemilik | Layanan yang kelak boleh memakai token (`service_id` di DB = `target_service` saat terbit) | `serviceId` | `requesting_service` |
| `requesting_service` | Layanan yang memanggil Privacy Service; selalu dari klaim JWT | `requestingService` | `target_service` |
| `target_service` | Layanan yang akan memegang token; dari body; wajib ada di Tabel 1 | `targetService` | |
| Purpose | Tujuan pemrosesan; enam nilai pada whitelist | `Purpose` enum | "tujuan bebas" (tidak boleh dibuat saat runtime) |
| Policy Engine | STEP 0 setiap penerbitan: memeriksa baris Tabel 1, cara terbit, dan pemanggil sah | `policyEvaluate` | |
| Cara terbit | `dari identitas` / `dari transaksi` / `pertukaran` / `re-issue` | `IssueMode` | "mode" (dipakai PRIVACY_MODE) |
| TTL, grace, status efektif | Masa berlaku; toleransi 30 detik; gabungan status+waktu | `ttlSeconds`, `statusEfektif` | |
| Penggunaan ulang | Token aktif untuk (subjek, layanan, purpose) yang sama dikembalikan lagi (`reused: true`) | `reused` | token "statis" |
| Pertukaran token | Penerbitan token baru untuk layanan lain lewat `source_pseudonym`, tanpa `subject_id` | `exchangeToken` | konversi |
| Re-issue | Penerbitan ulang token kedaluwarsa pada transaksi belum terminal | `reIssue` | refresh |
| Pseudonim domain | Token berumur panjang P5 yang jadi kunci `contact_registry` | `notificationDomainId` | |
| Blind index | `subject_lookup`, HMAC deterministik untuk mencari di atas kolom terenkripsi | `subjectLookup` | hash biasa |
| Brankas identitas | Tabel `identity_vault`: NIK, nama, HP, rekening terenkripsi per kolom | `identityVault` | "tabel user" |
| Audit rutin | `audit-request` yang mengembalikan token P7 + data transaksi, tanpa identitas | `auditRequest` | pembukaan identitas |
| Pembukaan identitas (disclosure) | Proses bersyarat membuka atribut brankas: permintaan → persetujuan admin lain → `/de-pseudonymize` | `disclosureRequest` | "de-pseudonymize" saja (itu langkah terakhir) |
| De-pseudonimisasi | Satu langkah akhir `POST /de-pseudonymize` dengan `disclosure_id` APPROVED, lima gerbang | `dePseudonymize` | |
| Empat mata (four-eyes) | Pemohon ≠ penyetuju | `chk_four_eyes`, `SELF_APPROVAL` | |
| Gerbang (GATE 1..5) | Pemeriksaan berurutan pada `/de-pseudonymize`; berhenti di kegagalan pertama | `gate` | gate = gateway (jangan campur) |
| Gateway | API Gateway Kong + plugin `privacy-tokenizer` | `gateway` | gate |
| Privacy hotspot | Privacy Service sebagai titik kegagalan/honeypot tunggal | | |
| Mode | `PRIVACY_MODE`: `baseline`, `proposed` (hanya dua kondisi, ADR-0003) | `PrivacyMode` | |
| Baseline | Tanpa pseudonimisasi; identitas asli mengalir ke layanan hilir | | |
| Proposed | Dengan seluruh lapisan privasi | | "usulan" di naskah |
| HELD | Transaksi ditahan menunggu analis Fraud (di Privacy dicatat `IN_PROGRESS`) | `HELD` | |
| Cold start | Token Fraud tanpa riwayat; dua aturan dilewati | `rulesSkipped` | |
| Nilai kenari (canary) | Nilai unik per atribut pengenal, disisipkan di data uji untuk dicari persis di payload/DB/log | `canary` | |
| E(s) | Rasio paparan layanan s = jumlah pengenal langsung yang diterima / 6 (nama, NIK, HP, email, rekening, customer_id) | | |
| Konsol admin | Klien API berperan admin/auditor (tidak ada UI, bukan layanan); `requesting_service = ADMIN_CONSOLE` | `ADMIN_CONSOLE` | (bentuk klaim: OPEN_QUESTIONS Q-07) |
| Service JWT / Actor token | Service JWT di `Authorization` menentukan `requesting_service` (klaim `azp`); Actor token di `X-Actor-Token` adalah JWT manusia yang divalidasi ulang penerima untuk `actor_id` dan peran (ADR-0007) | `requestingService`, `actorToken` | header peran/aktor polos (dilarang) |
| Kode klien | Delapan `code` yang tampak ke klien eksternal (ADR-0008); `reason` rinci hanya antar-layanan dan audit | `ClientErrorCode` | "reason" ke klien |
| Jendela idempotensi | Selama token P1 yang sama berlaku (`TTL_PAYMENT_PROCESSING`); di luar itu kunci yang sama menghasilkan 409 (ADR-0009) | `idempotencyWindow` | |
| Paparan terkontrol | Atribut identitas yang keluar dari Privacy hanya lewat pembukaan bersyarat yang disetujui; dilaporkan terpisah dari E(s) | | "paparan" polos |
| E_umum / E_spesifik | Rincian E(s) per kelas data: pengenal umum (nama, NIK, HP, email, `customer_id`) dan spesifik (rekening); bukti pendukung, bukan metrik utama | | |
| Konfirmasi spec (K-nn) | Keputusan yang diusulkan spec dengan nilai bawaan, menunggu jawaban Fanny (`OPEN_QUESTIONS.md` bagian F) | | |
| gateway-adapter | Layanan NestJS tipis pengganti Kong pada fase lokal; perilaku tokenisasi identik dengan plugin `privacy-tokenizer` (ADR-0004) | `gateway-adapter` | |
| dev-idp | Penerbit JWT tiruan khusus dev (RS256 + JWKS) pengganti Keycloak pada fase lokal (ADR-0004) | `dev-idp` | Keycloak (fase Docker) |

## Peran (Keycloak)

`admin`, `auditor`, `fraud_analyst`, `bank` (bank simulator), dan service account per layanan (`API_GATEWAY`, `TRANSACTION`, `FRAUD`, `NOTIFICATION`, `RECONCILIATION`). Detail klaim dan masa berlaku (access token ≤ 5 menit, NFR-21) diputuskan di Fase 1.

## Pola ID

`CUST-000101` (customer_id fiktif), `TX-10001` (transaction_id, dibangkitkan Gateway), `PSEU-` + 8 heks huruf besar (token), `KASUS-2026-014` (nomor kasus), UUID untuk `id` baris, `Idempotency-Key` UUID dari klien.

## Cara memperbarui

Tambah baris saat istilah baru dipakai dalam diskusi atau kode. Bila dua istilah bertabrakan, putuskan satu dan tulis yang lain di kolom "Jangan dipakai". Keputusan arsitektural yang menyertainya masuk ADR.
