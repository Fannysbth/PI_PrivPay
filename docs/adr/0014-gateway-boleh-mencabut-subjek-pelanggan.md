# ADR-0014: Mengizinkan API_GATEWAY memanggil revoke_subject untuk subjek CUSTOMER

- Status: Accepted (disetujui Fanny, 2026-10-22, atas pilihan "ADR baru: izinkan API_GATEWAY" pada Gerbang 4 M4)
- Tanggal: 2026-10-22
- Pengambil keputusan: Fanny
- Terkait: ADR-0005, ADR-0007, PRD Tabel 3, FR-42, FR-44, M4-08, spec gateway-tokenizer 6, spec privacy 4.6

## Konteks

ADR-0005 menetapkan kompensasi pendaftaran: bila A3 atau A4 gagal sesudah A5 (identitas sudah masuk brankas), Gateway memanggil `revoke_subject` dan menghapus pengguna IdP. PRD Tabel 3, ADR-0007, dan spek privacy 4.6 hanya mengizinkan `ADMIN_CONSOLE` dengan peran `admin` untuk `REVOKE_SUBJECT`. `POST /register` anonim, jadi Gateway tidak memegang token admin: kompensasi ditolak `POLICY_NOT_ALLOWED` dan NIK serta nama tertinggal di brankas. Dua keputusan bertabrakan; Tabel 3 tidak boleh berubah tanpa ADR.

## Opsi yang dipertimbangkan

1. Izinkan `API_GATEWAY` untuk `REVOKE_SUBJECT` subjek `CUSTOMER` saja. Kecil; tidak ada endpoint baru; kompensasi bekerja.
2. Operasi pengosongan brankas baru di Privacy. Lebih sempit, tetapi menambah endpoint di luar PRD 10 (API9).
3. Hanya hapus pengguna IdP dan biarkan admin membersihkan brankas. Identitas asli bisa tertinggal tanpa batas waktu.

## Keputusan

Opsi 1. `REVOKE_SUBJECT` boleh dipanggil oleh `ADMIN_CONSOLE` dengan peran `admin` (seperti semula) atau oleh `API_GATEWAY` dengan token layanannya sendiri, dengan syarat `subject_type = CUSTOMER`. `API_GATEWAY` untuk `ACCOUNT`, `REVOKE_TOKEN`, dan layanan lain tetap `POLICY_NOT_ALLOWED`. Audit mencatat `requesting_service = API_GATEWAY` tanpa `actor_id` (tidak ada manusia).

## Konsekuensi

- Positif: kompensasi ADR-0005 bekerja; tidak ada endpoint baru; hanya identitas pelanggan yang dapat dikosongkan.
- Negatif / utang: Gateway yang disusupi dapat mengosongkan brankas pelanggan mana pun. Itu bukan kemampuan baru yang besar: Gateway sudah dapat menerbitkan token untuk subjek mana pun, dan pengosongan hanya menghapus data (tidak membukanya).
- Dampak pada keamanan dan privasi: tidak ada jalan baru ke identitas asli; pencabutan tetap menulis baris audit; peran admin tetap tidak berubah untuk konsol.
- Dampak pada pengujian: tes layanan dan HTTP untuk pemanggil Gateway (CUSTOMER diterima, ACCOUNT dan layanan lain ditolak); satu tes lama (`API_GATEWAY` ditolak) diubah ke `TRANSACTION` karena premisnya berubah.
- Yang harus diubah: PRD Tabel 3 (dicatat sebagai E-31 di `docs/PRD_ERRATA.md`; `docs/reference/` tidak diedit), spek privacy 4.6, kode `RevocationService`.

## Kapan ditinjau ulang

Bila Notification mendapat endpoint penghapusan kontak, atau pendaftaran dipindah ke Keycloak (DK-04).
