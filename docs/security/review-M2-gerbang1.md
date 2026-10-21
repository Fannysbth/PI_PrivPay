# Tinjauan keamanan M2, gerbang 1 (skema privacy-db dan modul Crypto)

Cakupan: `services/privacy-service/migrations/proposed/` (M2-01), `services/privacy-service/src/crypto/` (M2-02), tesnya, dan perubahan `createTestDb`. Cara: tinjauan independen oleh agen terpisah yang hanya membaca (tidak menjalankan tes atau kueri), dengan penyerang yang memegang peran `privpay_app`, peran `privpay_auditor`, salinan dump basis data, masukan terpilih ke modul Crypto, atau log. Bukti lari dari pihak saya: mutasi manual dan gerbang penuh pada tiket masing-masing (lihat CHANGELOG).

Hasil: **tanpa temuan Critical atau High.** Jalur tulis, ubah, hapus, dan baca `audit_log` oleh `privpay_app` tertutup (hanya `INSERT`; tanpa `TRUNCATE`, `REFERENCES`, atau `CREATE` pada skema); `privpay_auditor` hanya `SELECT audit_log`.

## Temuan

| Tingkat | Temuan | Status |
| --- | --- | --- |
| Medium | `chk_purged` dan `chk_vault_purged` hanya menegakkan "purged berarti kosong"; arah sebaliknya tidak: baris dengan `subject_lookup` NULL dan `purged_at` NULL diterima, dan `uq_mapping_active` memperlakukan NULL sebagai berbeda, jadi token aktif ganda untuk subjek yang sama dapat ditulis oleh aplikasi yang dibobol | **menunggu keputusan Fanny, N-24** (menyimpang dari DDL PRD 11 yang berlaku apa adanya) |
| Low | `disclosure_request` dapat ditulis `APPROVED` tanpa `approver_id`/`decided_at`/`expires_at`; `requested_attrs` tanpa CHECK; kolom teks bebas (`pseudonym`, `reason`, `status`) tanpa CHECK format; `chk_four_eyes` tidak membedakan huruf besar/kecil | N-24 (bagian dari paket pengetatan yang sama); pada prinsipnya ID aktor berasal dari klaim `sub` token, bukan teks bebas |
| Low | `RowBinding` adalah `Buffer` yang dapat diubah setelah diterbitkan, sehingga AAD kosong bisa lolos pemeriksaan keanggotaan | **diperbaiki**: `FieldCipher` memakai salinan privat byte AAD; tes mengubah binding setelah terbit |
| Low | teks dengan surrogate yatim menjadi U+FFFD saat disandikan: dua ID berbeda dapat menghasilkan lookup dan AAD yang sama; `subjectId`, `serviceId`, `purpose` kosong diterima | **diperbaiki**: ditolak (`malformed`) di `encodeParts`, `encrypt`, `lookup`, `mint`; tes dan mutasi |
| Low | `readKey` menerima kunci berentropi rendah (mis. semua nol) selama 32 byte dan berbeda | diterima: pembuatan kunci adalah tugas operator (`make-secrets`/`openssl rand`); tidak ada pemeriksaan entropi yang bermakna untuk 32 byte |
| Info | percobaan ulang `DROP DATABASE` pada `42501` di `createTestDb` aman: target selalu `privpay_<svc>_test_<akhiran>` tervalidasi dan diberi tanda kutip, hanya untuk `42501`, paling lama sekitar lima detik | tidak ada tindakan |

## Butir checklist yang jatuh tempo

| # | Status | Bukti |
| --- | --- | --- |
| S-03 | lulus | tiga kunci 32 byte, semua pasangan berbeda (termasuk antarversi medan), dari berkas; kunci mentah di env ditolak; `crypto.spec.ts` |
| S-22 | lulus separuh | arah "purged berarti kosong" ditegakkan dan diuji per kolom; arah sebaliknya menunggu N-24 |
| S-31, S-32, S-33 | lulus | blob, IV acak, tag 16 byte, versi kunci dari header; hanya `node:crypto`; AAD terikat baris, jenis, dan kolom; mutasi pada 26 pengaman terbunuh (23 + 3) |
| S-34, S-35 | lulus | `schema.integration.spec.ts` dengan koneksi peran asli |
| T-16 | lulus | tes pemindahan antar baris, jenis, kolom, dan penukaran langsung di basis data |
| NFR-07 | lulus | kunci tidak tampil di JSON, `inspect`, atau pesan galat |
| NFR-09 | lulus | aplikasi tidak pernah pemilik skema, tanpa `DELETE` di tabel mana pun |
| FR-25, FR-30 | lulus (tingkat skema dan kripto) | dump `row_to_json` tanpa plaintext; pemeriksaan kunci |
