# Log kerja PrivPay

Catatan kronologis (terbaru di atas) tentang **rencana, perubahan, masalah, dan keputusan**. Aturan (permintaan Fanny, 2026-11-11): setiap perencanaan, perubahan, dan masalah dicatat di sini pada hari terjadinya, dengan hash commit bila ada. Keputusan arsitektur tetap ditulis sebagai ADR; log ini menunjuk ke sana. Dokumen sistem yang dirangkum: [DOKUMENTASI_SISTEM.md](DOKUMENTASI_SISTEM.md). Serah-terima per tiket: [HANDOFF.md](HANDOFF.md).

Format entri: tanggal, judul, lalu butir **Rencana**, **Perubahan**, **Masalah**, **Keputusan**, **Belum selesai** (hanya yang relevan).

---

## 2026-11-11: Kinerja v2 tahap A dan B (cabang `feat/perf-v2-privacy-hot-path`)

**Rencana.** `docs/PLAN_PERFORMA_V2.md`: A (pangkas query per operasi di Privacy), B (`POST /pseudonymize/batch` untuk P1 dan P2), C (cache token terbatas), lalu ukur v2 dengan protokol sama seperti v1. Fanny meminta gerbang penuh dijalankan sekali setelah ketiga tahap, bukan per tahap.

**Perubahan.**
- Tahap A, commit `07b185c`: `expireStale` dan `findActive` digabung menjadi `expireAndFindActive` (satu statement). Tes PERF-01 menghitung statement. CHANGELOG diperbarui; `.gitignore` menambah `artifacts/`, `docs/penulisan/`, `docs/hasil.zip`, `docs/hasil/kinerja/resmi/` dan `resmii/`.
- Tahap B, commit `b52d31a`: ADR-0019 dinyatakan Accepted (Fanny, 2026-11-11). Privacy Service: rute `POST /pseudonymize/batch`, `TokenService.generateBatch`. Gateway: `PrivacyPort.pseudonymizeBatch` (adapter HTTP, fake, passthrough baseline) dan `Tokenizer` memakai satu panggilan. Plugin Kong: `privacy.pseudonymize_batch`, `core.tokenize` menerima fungsi batch, `run-vectors.lua` melaporkan `privacy_batches`. Dokumen: spec privacy 4.1a, AZ-18b di endpoints, PRD_ERRATA E-34, CHANGELOG.
- Setelah commit B: ADR-0019 diberi butir 2a (penyempitan: satu elemen per `subject_type`, urutan kunci menurut `subject_type`), disetujui Fanny. Berkas baru: `docs/DOKUMENTASI_SISTEM.md`, `docs/LOG_KERJA.md`.
- Skill `privpay-working-style` ditulis ulang dari pola prompt Fanny (langkah 0, aturan tetap, aturan memori, laporan akhir wajib) dan diberi aturan pembaruan dokumen. Belum di-commit.

**Bukti (2026-11-11).**
- `pnpm lint`, `pnpm typecheck`: bersih. `pnpm test`: 96 suite, 1663 tes lulus.
- `pnpm test:integration` (penuh, memori bebas 5,65 GB, Docker mati, sekitar 29 menit): 70 suite, 1243 tes lulus.
- Spec Lua di Docker (`edge-lua.docker.spec.ts`): 11 lulus, luacheck bersih (dijalankan pada memori bebas 2,8 GB; hanya kontainer sekali pakai, tumpukan tidak dinyalakan).
- Mutasi: penghapusan pengurutan kunci membuat tes urutan kunci gagal (1 gagal); kode dikembalikan, 41 tes hijau.
- `secret-scan:tree` bersih sebelum tiap commit.
- `pnpm test:security` (dijalankan sendirian): 1 suite, 24 tes lulus, kode keluar 0.
- `pnpm audit --prod --audit-level high`: "No known vulnerabilities found", kode keluar 0.
- `gitleaks detect --log-opts="--all"`: 493 commit dipindai, tanpa temuan, kode keluar 0. `secret-scan:tree`: kode keluar 0.
- `/code-review medium` atas diff cabang terhadap `main`: 9 temuan. Diperbaiki: komparator urut (`localeCompare`); `core.tokenize` gagal tertutup bila fungsi batch tidak diberikan; batas `MAX_BATCH` satu konstanta di Privacy (batas ganda di Gateway dihapus, cek jumlah item terhadap permintaan sudah menjaganya); `Tokenizer` menjawab `SERVICE_UNAVAILABLE` (bukan `INTERNAL_ERROR`) bila port memberi token lebih sedikit dari yang diminta (tes ADR-0019 baru, dibuktikan dengan mutasi: 1 gagal, dipulihkan 23 hijau). Ditolak dengan alasan: `cjson.decode` tanpa pelindung (plugin memakai `cjson.safe`, mengembalikan nil dan tidak melempar); CTE tak terpakai pada `expireAndFindActive` (sudah dikomentari dan diuji PERF-01 dan suite integrasi); penahanan dua kunci dan satu koneksi (sifat bawaan ADR-0019, diukur di v2). Dicatat: `PassthroughPrivacyPort.pseudonymizeBatch` tanpa batas ukuran (tiruan uji baseline). Menunggu keputusan Fanny: apakah batch wajib `transaction_id` sama untuk kedua elemen (penyempitan baru di luar ADR; lihat N-65).
- Setelah perbaikan review: lint, typecheck kode keluar 0; `pnpm test` 96 suite / 1664 tes lulus; integrasi terarah (batch, token-service, http, seluruh Gateway) 12 suite / 233 tes lulus; `test:edge` Lua 11 lulus (memori bebas 3,52 GB setelah Docker menyala).

**Masalah dan penyelesaiannya.**
1. Prettier menolak berkas tes tahap A. Diperbaiki dengan `prettier --write`; tidak ada perubahan logika.
2. Tiga temuan `gitleaks detect --no-git`: terverifikasi berupa `secrets/docker/ca/ca.key`, `tls_kong.key`, `tls_privacy.key` (aturan `private-key`), kunci TLS dev di folder yang di-gitignore. `secret-scan:tree` bersih. Bukan kebocoran; sesuai catatan di `CLAUDE.md`.
3. Skrip Python lewat heredoc Bash gagal dua kali karena tanda kutip tunggal (pelajaran RETRO_M4). Skrip kini ditulis ke berkas di scratchpad.
4. Tes konkurensi pertama (dua batch berurutan terbalik lewat HTTP) tidak gagal saat pengaman dihapus, jadi tidak membuktikan apa-apa. Diganti tes deterministik di `token-service.integration.spec.ts` yang mengamati urutan `index.lookup` (urutan kunci); mutasi kini membuatnya gagal.
5. Satu asersi tes batch membandingkan seluruh badan galat termasuk `request_id` yang unik. Fixture diperbaiki (bandingkan `code` dan `reason`), kode tidak diubah.
6. Skenario E2E TF-04 gagal setelah Gateway beralih ke batch: fixture menghitung "panggilan ketiga ke `/pseudonymize`" sebagai exchange pertama. Sekarang exchange pertama adalah panggilan pertama ke `/pseudonymize`; fixture dan komentar diperbarui, kode tidak diubah.
7. Lint menemukan pembantu tak terpakai di spec batch (salinan harness). Dihapus.
8. Gerbang penuh tertunda oleh memori: 4,9 GB (syarat 5 GB, Docker mati) dan 2,8 GB setelah Docker menyala (syarat 3,5 GB). Tumpukan Compose tidak dinyalakan. Memori kemudian 5,65 GB dan gerbang berjalan.
10. Mutasi tes `Tokenizer`: skrip pemulihan berhenti oleh `assert` (kata `privacy_answer` muncul lebih dari sekali), sehingga berkas sempat tertinggal dalam keadaan termutasi. Disadari dari keluaran skrip, dipulihkan dengan skrip yang menyasar baris tepat, diverifikasi dengan `grep` dan tes (23 hijau). Pelajaran: skrip mutasi harus memulihkan dengan jangkar unik dan memverifikasi sebelum lanjut. Satu salinan cadangan sempat dibuat di luar repo (`d:\projectindv\tok.bak`); sudah dihapus.
11. `test:security` pertama gagal 5 dari 24 tes. Penyebab sangat mungkin: run bersarang yang kukira mati ternyata masih hidup dan berjalan bersamaan dengan run kedua pada database tes yang sama (melanggar "satu proses pada satu waktu"). Run sendirian: 24 lulus. Belum dibuktikan dengan pengulangan khusus. Pelajaran: jangan membungkus proses dengan `&` di dalam tugas latar belakang; jalankan langsung dengan `run_in_background` dan tunggu notifikasinya.
9. Sesi terputus saat `test:integration` berjalan; proses induknya ternyata tetap hidup dan selesai sendiri. Hasilnya dibaca dari berkas keluaran, bukan dijalankan ulang.

**Keputusan.**
- ADR-0019 Accepted (Fanny). Penyempitan satu elemen per `subject_type` disetujui Fanny.
- Nilai T (jendela cache tahap C): Fanny meminta nilai normal industri. Usulan Claude **T = 5 detik** (env, dibatasi sisa umur token), dengan T = 30 detik sebagai varian sensitivitas bila perlu. Dasar: RFC 7662 (jendela pencabutan; tidak ada nilai universal), panduan cache keputusan otorisasi di gateway (1–5 detik bawaan; 30–60 detik hanya untuk risiko rendah; transfer finansial tanpa cache), Ory Talos (15 detik / 1 menit / 5 menit). Sumbernya dokumentasi dan tulisan praktisi, bukan jurnal; kutip RFC 7662 di naskah. **Belum disetujui Fanny.**

**Belum selesai.**
- Newman kedua mode dan payload scan dengan rute batch (butuh tumpukan Compose; memori bebas sesudah Docker menyala hanya 2,98 sampai 3,52 GB), `/simplify`, tinjauan keamanan manual, `/security-review` (akhir milestone).
- Keputusan Fanny soal temuan review 7 (`transaction_id` sama untuk kedua elemen batch).
- Tahap C menunggu persetujuan T dan dua ADR (cache token; klaim gagal-tertutup menjadi "tertutup setelah jendela T").
- Pengukuran v2 (butuh laptop kedua, k6) dan pembaruan naskah.
- Terbuka lama: CI GitHub gagal 0 detik (dugaan `hashFiles()` di `if:` job `lua` dan `containers`); jangan merge 10 PR Dependabot dulu; 71 commit lokal di depan `origin/main`; keputusan `docs/hasil/kinerja/resmii/`; bagian "Status perintah" di `CLAUDE.md` usang; verifikasi referensi naskah.
