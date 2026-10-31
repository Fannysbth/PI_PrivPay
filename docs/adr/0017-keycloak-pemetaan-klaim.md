# ADR-0017: Keycloak menggantikan dev-idp: pemetaan klaim, customer_id tetap CUST-nnnnnn

- Status: Accepted (keputusan Fanny, 2026-10-31, dua pilihan pada orientasi DK-04). Implementasi bertahap: realm dan pemetaan klaim terbukti; penyambungan ke Compose dan layanan belum (lihat Status).
- Tanggal: 2026-10-31
- Pengambil keputusan: Fanny
- Terkait: ADR-0007, ADR-0008, ADR-0014, ADR-0015, ADR-0016, Q-04, Q-07, Metodologi Tabel III, DF2, DF19

## Konteks

dev-idp (ADR-0004) menerbitkan klaim yang diperiksa `authenticate()` (`packages/common/src/authenticate.ts`): `sub`, `azp` (klien), `aud` (per peran atau per akun layanan), `exp` ≤ 300 detik, `roles` (tepat satu; hanya token manusia), `customer_id` (`CUST-nnnnnn`; hanya nasabah), dan akun layanan tanpa `roles`/`customer_id`. Keycloak harus menerbitkan klaim yang sama tanpa mengubah aturan itu (ADR-0007: dua token `Authorization` + `X-Actor-Token`, satu peran per manusia).

## Keputusan

1. **Satu realm `privpay`, Keycloak 26.4.0 mode dev** (citra dipin dengan digest `sha256:5f3fb534…`; H2 bawaan, tanpa PostgreSQL tambahan). Heap dibatasi (`-Xms128m -Xmx320m`), kontainer maksimal 768 MiB. Diukur: 485 MiB setelah start, memori bebas laptop 2,6 GB (hanya Keycloak, Docker menyala).
2. **Realm dibangkitkan, bukan ditulis tangan:** `scripts/docker/keycloak-realm.cjs` merender JSON impor dari tabel sistem dan dari berkas rahasia (`<klien>_client_secret`, `idp-admin_client_secret`, `keycloak_dev_user_password`, dibuat `pnpm docker:secrets`). Tidak ada rahasia literal di repositori.
3. **Pemetaan klaim.** Klien manusia `customer-app`, `admin-console`, `bank-simulator` (publik, password grant, hanya dev) dengan *scope mapping* ke peran jenisnya, sehingga nasabah di `admin-console` tidak mendapat peran. Mapper `roles` (peran realm, hanya klien manusia), `customer_id` (atribut), dan `oidc-audience-resolve-mapper`. Audiens diturunkan dari peran klien resource (`api-gateway`, `privacy-service`, ... masing-masing peran `access`) yang dimiliki komposit peran realm atau akun layanan, mengikuti `ROLE_SERVICES` dan `SERVICE_AUDIENCES`. Akun layanan (`api-gateway`, `transaction`, `fraud`, `notification`, `reconciliation`) tanpa mapper `roles`. Peran bawaan realm dikosongkan.
4. **`customer_id` tetap `CUST-nnnnnn`** (pilihan Fanny): adapter akan membangkitkan `CUST-` + 6 digit acak, memeriksa lewat Admin API (pencarian atribut) bahwa belum dipakai, menyimpannya sebagai atribut pengguna. Tidak ada validator, kolom baseline, atau format PRD yang berubah. Profil pengguna Keycloak mengelola `customer_id` dengan pola `^CUST-[0-9]{6}$`. Risiko T-02 (entropi rendah) tetap diakui seperti ADR-0007 butir 5.
5. **Kata sandi uji:** satu berkas rahasia fiktif untuk semua pengguna uji (pilihan Fanny); dua admin dan dua auditor berbeda (empat mata); pengguna berperan ganda tetap ditolak (`UNAUTHENTICATED`, `claims`).
6. **Klien `idp-admin`** (akun layanan; `manage-users`, `query-users`, `view-users`, `view-realm`) satu-satunya yang boleh mengelola pengguna (pendaftaran, kompensasi ADR-0005/0014); tokennya tidak pernah dikirim ke layanan dan bukan token layanan (ditolak di semua layanan).
7. **JWKS Keycloak memuat kunci `sig` RS256 dan kunci `enc` RSA-OAEP:** Kong dan layanan hanya memakai kunci `use=sig`, `alg=RS256`, tepat satu.

## Status

Terbukti (`pnpm test:edge tests/docker/keycloak-claims`, 13 tes pada Keycloak sekali pakai): klaim nasabah, administrator, analis, bank, dan akun layanan diterima `authenticate()` pada layanan yang benar saja; nasabah di klien admin dan administrator di klien nasabah tidak mendapat token yang bisa dipakai; token berkunci lain ditolak; `X-Actor-Token` bersama token layanan bekerja; dua orang berbeda untuk empat mata; peran ganda ditolak; Admin API (`idp-admin`) membuat, mencari lewat atribut, dan menghapus pengguna.

**Belum dikerjakan (lanjutan DK-04):** layanan Keycloak di Compose (profil; dev-idp dan Keycloak tidak boleh menyala bersamaan), langkah render realm saat start, pengambil token bersama di lima layanan (Keycloak memakai form-urlencoded dan `scope` untuk audiens, bukan badan JSON), jalur JWKS dan issuer dari konfigurasi, port registrasi Admin API di adapter, pemilihan kunci `sig` di `kong-config`, koleksi Postman (password grant) dan README, Newman dan mutasi lewat Kong, payload scan ulang, dan pengukuran memori dengan tumpukan penuh.

## Konsekuensi

- Positif: kontrak klaim tidak berubah; bukti pemetaan ada sebelum penyambungan; tidak ada validator yang berubah.
- Negatif / utang: Keycloak dev mode H2 (bukan produksi); klien manusia publik dengan password grant hanya untuk dev; kunci Keycloak stabil menghilangkan kebutuhan membuat ulang `gateway`/`kong-config`/`kong` bersama IdP, tetapi hanya setelah penyambungan selesai.

## Kapan ditinjau ulang

Saat penyambungan Compose selesai, atau bila batas memori 0,9 GB bebas tidak terpenuhi dengan tumpukan penuh.
