# ADR-0007: Identitas pemanggil, peran, dan akun seed (pola dua token)

- Status: Accepted (disetujui Fanny, Fase 1a, 2026-10-19)
- Tanggal: 2026-10-19
- Pengambil keputusan: Fanny
- Terkait: D-16, NFR-21, FR-09, TK-07, TK-08, TK-24, TK-25, TK-28, Q-04, Q-05, Q-07, ADR-0004

## Konteks

`requesting_service` harus selalu dari klaim JWT (D-16). Tabel 3 memakai `ADMIN_CONSOLE` sebagai pemanggil, padahal admin dan auditor adalah manusia yang masuk lewat Gateway. `de-pseudonymize` dan `generate_from_transaction` dipanggil Reconciliation, tetapi membutuhkan `actor_id` dan peran auditor yang tidak boleh berupa header polos yang bisa dipalsukan.

## Keputusan

1. **`requesting_service`** selalu dari klaim `azp` (klien) token di `Authorization`, dipetakan lewat allowlist: `API_GATEWAY`, `TRANSACTION`, `FRAUD`, `NOTIFICATION`, `RECONCILIATION`, `ADMIN_CONSOLE` (klien manusia), `BANK`. Tidak pernah dari body.
2. **Operasi manusia yang dilayani langsung Privacy** (`/audit-log`, revoke, `/disclosure-requests`): Gateway meneruskan JWT manusia apa adanya sebagai `Authorization` (`azp=ADMIN_CONSOLE`). `actor_id` = `sub`; peran dari klaim peran.
3. **Operasi manusia lewat layanan** (audit-request di Reconciliation, review transaksi di Transaction): `Authorization` berisi JWT service pemanggil; `X-Actor-Token` berisi JWT manusia. Penerima memvalidasinya ulang (JWKS, `exp`, `aud`) untuk `actor_id` dan peran. Tidak ada header peran atau aktor polos.
4. **JWT nasabah** (membawa klaim `customer_id`) tidak pernah diteruskan ke hilir. Gateway memakai JWT service `API_GATEWAY` (invarian 1 dan 6).
5. **`customer_id`**: `dev-idp` membangkitkan `CUST-NNNNNN` berurutan (fiktif, mulai `CUST-000101`) sebagai atribut pengguna saat A2 dan memasukkannya ke klaim `customer_id` JWT nasabah. `gateway-adapter` hanya membaca klaim. Keycloak nanti: atribut pengguna + protocol mapper (utang terjadwal). ID berurutan berentropi rendah: risiko T-02 diakui, kerahasiaan `K_index` penjaganya.
6. **Klien dan peran (dev-idp):** `customer-app`; `admin-console` (manusia: `admin`, `auditor`, `fraud_analyst`); `bank-simulator` (peran `bank`); service account per layanan `API_GATEWAY`, `TRANSACTION`, `FRAUD`, `NOTIFICATION`, `RECONCILIATION`. Privacy Service tidak punya service account (tidak memanggil keluar).
7. **Token:** access token ≤ 300 detik; `aud` per layanan tujuan; token service di-cache sampai `exp` dikurangi 30 detik (NFR-21).
8. **Akun seed fiktif:** 3 nasabah (PRD 16), 2 admin (empat mata), 2 auditor (TK-28), 1 fraud analyst, 1 bank. Setiap manusia memegang tepat satu peran; `SELF_APPROVAL` tetap ditegakkan di kode dan `chk_four_eyes`, bukan oleh pemisahan peran.

## Tambahan (disetujui Fanny, 2026-10-19) dan bukti Fase 2

- **Aturan tambahan:** bila `Authorization` sudah berupa token manusia (`ADMIN_CONSOLE`), `X-Actor-Token` ditolak (tidak ada identitas ganda). Dicatat juga di spec.
- **Risiko sisa (threat-model T-15):** layanan hilir yang diretas dapat memakai ulang token aktor manusia yang masih berlaku (≤ 5 menit) untuk operasi yang dibolehkan layanannya. Usulan mitigasi untuk spec (Fase 3, bukan Fase 2): batasi `aud` token aktor ke layanan tujuan.
- **Bukti prototipe (sekali pakai, `node --test`, 10 tes lulus):** `requesting_service` hanya dari `azp` token layanan (token aktor yang mengaku `azp` layanan atau `requesting_service` ditolak; `requesting_service` di body diabaikan); token layanan atau token nasabah sebagai token aktor ditolak; token manusia sebagai `Authorization` menghasilkan `ADMIN_CONSOLE` dan tidak dapat memanggil operasi khusus layanan (`POLICY_NOT_ALLOWED`); token kedaluwarsa, `aud` salah, penanda tangan lain, `alg=none`, dan `HS256` ditolak untuk kedua token; peran harus tepat satu. Mutasi manual satu kali (tidak dikomit): kode diubah agar token aktor menentukan layanan, dan tiga tes yang relevan gagal.

## Konsekuensi

- Positif: aktor dan peran terverifikasi kriptografis; invarian 1, 6, dan D-16 terjaga.
- Negatif / utang: penerima harus memvalidasi dua token; pemetaan klaim `dev-idp` ke Keycloak menjadi utang fase Docker.
- Dampak pada keamanan dan privasi: tidak ada jalur `customer_id` ke hilir lewat JWT; header aktor polos dilarang.
- Dampak pada pengujian: tes negatif untuk `X-Actor-Token` tidak valid, kedaluwarsa, `aud` salah, dan token manusia dipakai sebagai `Authorization` oleh layanan yang tidak berhak.
- Yang harus diubah: spec `privacy-service` dan `gateway-tokenizer`, `CONTEXT.md`.

## Kapan ditinjau ulang

Saat Keycloak menggantikan `dev-idp`, atau bila Tabel 3 diubah.
