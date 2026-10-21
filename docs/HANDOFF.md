# HANDOFF (2026-10-21): Gerbang 2 M3 selesai ditulis di `feat/m3-gerbang-2`, gerbang penuh BELUM hijau dua putaran

Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD. `main` (lokal, belum di-push) memuat M0, M1, M2 dan Gerbang 1 M3 (merge `a32b905`). `feat/m3-gerbang-2` bertumpu di atasnya dan belum di-merge.

## Status Gerbang 2

Commit: `73088cc` M3-03, `58013cd` M3-04, `8e3df06` perbaikan `/code-review`, `c572b7a` fixture smoke (sandi peran `privpay_auditor`), serta `f8e26b3` kalimat ADR-0013 di `main`/cabang. `/code-review` dan `/security-review` dijalankan; tidak ada temuan keamanan.

| Langkah | Putaran 1 | Putaran 2 |
| --- | --- | --- |
| eslint + prettier, typecheck | hijau | hijau |
| unit (2 worker) | 1027 tes hijau | 1027 tes hijau |
| integrasi | 19 suite, 447 tes hijau | **GAGAL**: 2 tes di `token-service.integration.spec.ts` (50 permintaan paralel), "Connection terminated due to connection timeout" saat `pool.connect()` |
| smoke | 20 tes hijau | tidak dijalankan (berhenti di langkah gagal) |
| audit --prod, gitleaks | bersih | tidak dijalankan |

Sebelum commit `c572b7a`, smoke gagal 1 tes (privacy-service tidak start: `ROLE_PASSWORD_FILE (unreadable)`), karena modul kini membuka pool `auditor` saat start; fixture diberi sandi `privpay_auditor`.

**Gerbang 2 belum boleh dinyatakan lulus.** Kegagalan putaran 2 ada di kode yang tidak diubah gerbang ini (hanya `db.app` dan `AuditedOperation` yang dipakai) dan tes yang sama lulus di putaran 1. Penyebab belum terbukti; dugaan: tekanan memori/CPU di mesin (sesi ini kemudian dihentikan sistem karena memori hampir habis, dan ulangan suite itu sendirian ikut dibunuh sebelum selesai). Yang harus dilakukan sesi berikut, setelah memori longgar: jalankan `token-service.integration` sendirian, lalu seluruh gerbang dua putaran dari awal. Bila gagal lagi tanpa tekanan memori, perlakukan sebagai bug nyata (pool/koneksi), jangan di-skip.

### Temuan peringatan "worker failed to exit gracefully" (unit)

Penyebab terbukti di **kode produksi**, belum diubah (menunggu persetujuan): `stop()` di `packages/common/src/nest/service-app.ts` memakai `Promise.race` antara `server.close` dan `delay.wait(SHUTDOWN_TIMEOUT_MS)` (bawaan 10 detik, `RealDelay` memakai `setTimeout` tanpa `unref`/pembatalan). Saat server selesai drain lebih dulu, timer 10 detik tetap hidup. Hanya suite yang memanggil `app.listen()` (`tools/dev-idp/test/http.spec.ts`, `services/gateway/test/gateway.spec.ts`) memicunya. Bukti: dengan `setTimeout(...).unref()` sementara di `RealDelay`, peringatan hilang di kedua suite (perubahan dikembalikan). Usulan: batalkan timer begitu `drained` menang (bukan `unref` global, agar penundaan retry tidak berubah). Efek nyata di produksi: proses tertahan sampai 10 detik setelah drain.

## Catatan untuk M3-05 (wajib diuji)

`approve` (M3-04) **tidak memeriksa bahwa token yang diminta masih hidup** (tidak dicabut, tidak kedaluwarsa, identitas belum dikosongkan); hanya `request` yang memeriksanya. Maka lima pemeriksaan `POST /de-pseudonymize` harus mencakup status token saat pemakaian (gerbang 4: `REVOKED`/`EXPIRED`, dan brankas hilang = `TOKEN_NOT_FOUND`, K-13), dan tes M3-05 harus membuktikan: permintaan yang disetujui lalu tokennya dicabut/kedaluwarsa/dikosongkan tidak dapat dibuka; persetujuan kedaluwarsa setelah 600 detik (`DISCLOSURE_EXPIRED` 410); pemakaian kedua (`DISCLOSURE_NOT_APPROVED`, status `USED`); dua pemakaian serentak, tepat satu berhasil. Tiga kasus terakhir diminta untuk Gerbang 2 tetapi membutuhkan endpoint M3-05; di M3-04 hanya diuji bahwa `expires_at = decided_at + 600 s`, bahwa persetujuan kedua adalah `DISCLOSURE_NOT_PENDING`, dan bahwa status APPROVED/USED/REJECTED/EXPIRED tidak bisa diputuskan lagi.

## Keputusan yang butuh persetujuan

- **N-28** (`OPEN_QUESTIONS.md`): peringatan ringkasan dibaca per pasangan (layanan, reason): tiga `SERVICE_MISMATCH` atau tiga `TOKEN_NOT_FOUND`, bukan campuran.
- `DISCLOSURE_APPROVAL_TTL_SECONDS` kini wajib di env (tanpa nilai bawaan); `reject` tidak mengisi `approver_id`; pool `auditor` dibuka saat start.
- Perbaikan `service-app.ts` di atas (kode produksi bersama).

### Temuan `/code-review` Gerbang 2 yang ditolak

`approve` tanpa cek token (ditangani M3-05, lihat di atas); ringkasan tetap tanpa mengunci pool (sudah diperbaiki: satu snapshot); dua koneksi per permintaan audit (hanya beban, bukan kebenaran; pool bawaan cukup); jendela peringatan terpotong oleh `from`/`to` (rentang memang membatasi data yang dihitung); kursor tidak terikat pada filter (hanya posisi keyset, tidak ada dampak keamanan); admin boleh menyaring `pseudonym` pada daftar (sesuai spec 4.8 dan PRD); `basis` 64 vs kolom 32 (kebijakan menolak dulu, insert tidak pernah melihat basis panjang); helper validasi duplikat dan spread berulang (gaya, tidak diubah).

## Pembagian gerbang M3 (Gerbang 1 selesai dan di-merge ke `main`)

- Gerbang 1 (`feat/m3-gerbang-1`): M3-01 `resolve-domain`, M3-02 pencabutan token dan subjek. **Selesai.**
- Gerbang 2 (`feat/m3-gerbang-2`): M3-03 pembacaan audit, M3-04 alur pembukaan identitas. Ditulis; gerbang penuh belum hijau (lihat atas).
- Gerbang 3 (`feat/m3-gerbang-3`): M3-05 `de-pseudonymize`, M3-06 suite keamanan (`pnpm test:security`).
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
- (b) Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject` (spec 4.6: hanya baris `active`); diserahkan ke retensi, dan `RetentionJob` belum dijadwalkan.

### Keputusan di tiket (tidak ada ADR yang bertabrakan)

- `revokeToken`/`revokeSubject` ada di `RevocationService` (bukan `TokenService`, agar berkas tidak membengkak); spec 2 dan 4.6 diperbarui. Meminta persetujuan Anda bila ingin dipindah ke `TokenService`.
- `revoke_subject` tanpa apa pun: HTTP 200 `{revoked_count: 0}` dengan satu baris audit DENIED `TOKEN_NOT_FOUND` (membaca spec 4.6 harfiah). `PURGE_IDENTITY` dari pencabutan memakai `requesting_service = ADMIN_CONSOLE` dan `actor_id` admin (K-32 hanya mengatur job retensi).
- `AuditedOperation` kini menerima daftar baris SUCCESS (satu per token, spec 4.6).
- K-33 / ADR-0013 ("ikut mengosongkan atau menghapus tautan"): berlaku bila `revoke_subject` mengosongkan baris mapping; spec 7.10 hanya menandai `revoked` dan mengosongkan brankas, jadi tautan tidak disentuh (sumber `revoked` harus tetap terbaca `REVOKED`, K-29). Mohon konfirmasi tafsir ini.

## Belum teruji / belum ada

- Fail-closed dengan Privacy mati di compose (butuh Docker, M7): tidak dinyatakan lulus. Diuji di tingkat Gateway dengan Privacy asli dihentikan.
- `RetentionJob` belum dijadwalkan ke siklus hidup proses.
- Rute `/register` dan `/notification/register` serta `RegistrationFlow` (M4-08). Plugin Lua belum diuji terhadap vektor kontrak (DK-02).
- Body bukan JSON tanpa token mendapat 422 sebelum 401 (parser JSON bersama). Dicatat, belum diubah.
- `pnpm test:security` dan `pnpm newman` belum ada (M3-06, M6-01); Docker belum ada.

## Keterbatasan yang sudah dicatat

- Token yang terbit bersamaan dengan `revoke_subject` bisa lolos pencabutan (Gateway boleh menerbitkan token baru untuk subjek yang sama).
- Baris `expired` yang masih menyimpan identitas tidak dicabut atau dikosongkan `revoke_subject`; diserahkan ke retensi, dan `RetentionJob` belum dijadwalkan.

## Langkah berikutnya

1. Saat memori longgar: `token-service.integration` sendirian, lalu gerbang penuh dua putaran dari awal di `feat/m3-gerbang-2` (hentikan di langkah pertama yang gagal). Baru setelah itu minta persetujuan merge ke `main`.
2. Putusan Anda atas N-28 dan perbaikan `service-app.ts` (kode produksi bersama).
3. Gerbang 3: M3-05 `de-pseudonymize` (dengan catatan di atas) dan M3-06 suite keamanan (`pnpm test:security`), lalu `/security-review` milestone M2/M3 dan `/retro`.
4. Sebelum M4: `/improve-codebase-architecture` setelah M4 dan M5; Docker menyusul setelah M4 stabil (ADR-0004).

Aturan hemat tetap: dokumentasi singkat sekali per tiket, dua review hanya untuk tiket inti, keluaran ringkas, satu proses pada satu waktu, jangan menjalankan tes saat memori hampir habis. Sisa database tes dapat dibersihkan dengan `pnpm db:test-databases drop` (ketik `DROP <jumlah>`).
