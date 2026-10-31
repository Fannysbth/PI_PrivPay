# ADR-0017: Keycloak menggantikan dev-idp: pemetaan klaim, customer_id tetap CUST-nnnnnn

- Status: Accepted (keputusan Fanny, 2026-10-31, dua pilihan pada orientasi DK-04). Diimplementasikan penuh di sesi B (2026-11-01): Keycloak adalah IdP tumpukan Compose di kedua mode.
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

**Sesi A (tiket 1 dan 2) selesai:** (1) `createIdpTokenCache` dan `idpJwksSource(http, idp)` di `packages/common` menggantikan lima salinan pengambil token; `IDP_KIND` (`dev-idp` bawaan, `keycloak`) dan `IDP_REALM` ada di `idpConfigShape`; klien HTTP bersama dapat mengirim `form`; sumber JWKS Keycloak hanya menyimpan kunci RS256 `sig` dan anggota publiknya; `kong-config` memakai jalur dan pemilihan yang sama. (2) Profil Compose `keycloak` (`keycloak-realm` merender realm dari berkas rahasia ke volume, `keycloak` 26.4.0 terpin digest, 768 MiB, heap 320 MiB, tanpa administrator bootstrap sehingga tidak ada rahasia di env, healthcheck port manajemen 9000); bukan IdP bawaan dan tidak ikut tumpukan bawaan.

Catatan desain: di Keycloak audiens token akun layanan berasal dari peran akun itu, jadi `aud` memuat semua layanan yang boleh dipanggilnya, bukan satu (dev-idp menyempitkan ke satu). Parameter `audience` diabaikan di Keycloak. Keterbatasan tambahan: realm hanya diimpor bila belum ada (data H2 hidup sepanjang kontainer), jadi rahasia atau kata sandi yang berubah butuh `down -v` atau kontainer baru; `start-dev` bukan konfigurasi produksi; `IDP_ISSUER` harus diisi dengan alamat realm bila `IDP_KIND=keycloak` (render menolak bawaan dev-idp; layanan di tiket 3). Keterbatasan: token ke Privacy dapat dipakai ulang oleh penerima yang disusupi untuk layanan lain dalam tabel akun itu sampai `exp` (T-15); penyempitan per-audiens lewat scope opsional bisa ditambahkan di tiket 3.

**Sesi B (tiket 3) selesai:** pintu keluar memori lolos dengan batas WSL 6 GB (memori bebas laptop 2,98 GB dengan tumpukan penuh mode usulan + Keycloak tanpa dev-idp; dengan 4 GB hanya 0,59 GB). Port `UserDirectory` di adapter (`services/gateway/src/user-directory.ts`): `keycloakUserDirectory` membangkitkan `CUST-` + 6 digit acak, memeriksa atribut lewat Admin API sebelum dan sesudah membuat pengguna (satu pemegang atau pengguna sendiri dihapus dan kandidat lain dicoba), memberi peran `customer`, dan mengembalikan pengguna bila peran gagal; kompensasi menghapus lewat id catatan Keycloak. Keycloak menjadi IdP bawaan (`idp` dev-idp hanya `--profile dev-idp`); `kong-config` memakai kunci `sig` saja; plugin Kong meminta token Privacy sebagai form di jalur realm (`idp_token_path`, `idp_form`); satu cache token bersama untuk semua upstream karena audiens diabaikan. Bukti: Newman lewat Kong 149 request, 115 asersi (usulan) dan 103 (baseline), 0 gagal; `docker:edge-check` fase `base`, `claims` (aud salah 403, azp salah 401, peran salah 403, kunci lain 401 dari Kong, peran ganda 401) dan `expiry` (token asli 300 detik) di usulan, `base` dan `claims` di baseline; payload scan: usulan hanya PSEU- (3 tes), baseline kontrol positif (2 tes); fail-closed (usulan). Temuan: `idp-admin` dapat memberi peran `auditor` dan `fraud_analyst` tetapi tidak `admin` (403): bila Gateway disusupi, pemegang rahasia `idp-admin` dapat membuat pengguna berperan auditor/analis; dicatat sebagai keterbatasan (rahasia `idp-admin` hanya di Gateway). Pencarian atribut Admin API menaruh kandidat `customer_id` di query ke IdP yang akan memilikinya (jaringan internal, klien HTTP tidak mencatat URL); larangan CLAUDE.md "customer_id di URL/query" ditafsirkan untuk URL layanan yang mencatat, bukan untuk pencarian IdP: butuh persetujuan Fanny.

**Dulu dijadwalkan untuk sesi B:** port registrasi Admin API di adapter (customer_id acak + pemeriksaan atribut, kompensasi), memindahkan tumpukan ke Keycloak (IDP_KIND di Compose, bank-simulator dengan `BANK_PASSWORD_FILE`), koleksi Postman (password grant) dan README, Newman dan mutasi lewat Kong, payload scan ulang, dan memori tumpukan penuh.

## Keterbatasan tambahan (tinjauan kode DK-04, 2026-11-01)

- Transportasi ke Keycloak adalah HTTP biasa di jaringan Docker internal (`sslRequired: none`): rahasia klien dan kata sandi uji tidak terenkripsi di jaringan itu. TLS DK-03 hanya menutup jalur Gateway ke Privacy. Dapat diterima untuk prototipe dev; TLS ke IdP perlu keputusan sebelum dipakai di luar laptop.
- Berkas realm hasil render memuat semua rahasia klien dan kata sandi uji dalam teks biasa di volume `keycloak-import` (hanya dipasang pada renderer dan Keycloak, jaringan internal); izin berkas 0644 dibiarkan karena uid Keycloak berbeda dari renderer.
- `accessTokenLifespan: 300` adalah literal di renderer realm, bukan dari env TTL (aturan CLAUDE.md). Fase `expiry` pada edge-check menunggu token asli 305 detik karena itu.
- Tabel klien, peran, dan pengguna di `scripts/docker/keycloak-realm.cjs` disalin dari registri dev-idp tanpa tes yang membandingkan keduanya; perubahan satu sisi tidak terdeteksi. Utang: tes perbandingan.
- Tes klaim di `keycloak-claims.docker.spec.ts` untuk penolakan hanya menegaskan "bukan accepted" pada beberapa kasus (tidak mengunci alasan). Edge-check `claims` mengunci kode dan bentuk jawaban lewat Kong.
- `idp-admin` dapat memberi peran `auditor` dan `fraud_analyst`, tidak `admin` (403, diukur di edge-check `claims`). Rahasianya hanya di Gateway.

## Konsekuensi

- Positif: kontrak klaim tidak berubah; bukti pemetaan ada sebelum penyambungan; tidak ada validator yang berubah.
- Negatif / utang: Keycloak dev mode H2 (bukan produksi); klien manusia publik dengan password grant hanya untuk dev; kunci Keycloak stabil menghilangkan kebutuhan membuat ulang `gateway`/`kong-config`/`kong` bersama IdP, tetapi hanya setelah penyambungan selesai.

## Kapan ditinjau ulang

Saat penyambungan Compose selesai, atau bila batas memori 0,9 GB bebas tidak terpenuhi dengan tumpukan penuh.
