# HANDOFF (2026-10-21): Gerbang 1 M3 selesai di `feat/m3-gerbang-1` (lokal, belum di-merge)

Sumber kebenaran tetap `CLAUDE.md`, `docs/DESIGN_DECISIONS.md`, ADR, PRD. `main` (lokal, belum di-push) memuat M0, M1, M2; cabang M3 bertumpu langsung di atasnya.

## Pembagian gerbang M3

- Gerbang 1 (`feat/m3-gerbang-1`): M3-01 `resolve-domain`, M3-02 pencabutan token dan subjek. **Selesai.**
- Gerbang 2 (`feat/m3-gerbang-2`): M3-03 pembacaan audit, M3-04 alur pembukaan identitas. Cabang dibuat dari ujung `feat/m3-gerbang-1` setelah disetujui.
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

## Langkah berikutnya

1. Persetujuan Anda atas Gerbang 1 (merge ke `main`) dan tafsir K-33 di atas.
2. Gerbang 2: M3-03 (`GET /audit-log`, timeline, summary; pool `auditor`) dan M3-04 (alur pembukaan identitas empat mata).
3. Gerbang 3: M3-05 dan M3-06, lalu `/security-review` milestone M2/M3.

Aturan hemat tetap: dokumentasi singkat sekali per tiket, dua review hanya untuk tiket inti, keluaran ringkas, satu proses pada satu waktu. Sisa 39 database tes dapat dibersihkan dengan `pnpm db:test-databases drop` (ketik `DROP <jumlah>`).
