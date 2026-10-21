# Tinjauan keamanan tiket K-28/K-29 (tautan transaksi)

Cara: `/security-review` dua tahap atas diff tiket saja (`feat/m2-12-privacy-http-layer...HEAD`): satu agen pembaca-saja mengidentifikasi, temuan disaring (kepercayaan di bawah 8 dari 10 dibuang). Penyerang: pemanggil yang mengendalikan badan permintaan atau satu layanan hilir yang dikuasai.

| Temuan | Tingkat | Keputusan |
| --- | --- | --- |
| Re-issue dapat menanam tautan baru untuk `transaction_id` dari badan permintaan di konteks sumber Gateway (TRANSACTION, PAYMENT_PROCESSING), yang dibaca bentuk 3 (kepercayaan 7). Kondisi serupa sudah ada sebelum K-28 (re-issue menimpa `transaction_id` baris) | Medium | **Diperbaiki.** Re-issue tidak pernah membuat tautan: hanya memindahkan tautan yang sudah menunjuk token yang digantikan, selain itu `IDEMPOTENCY_CONFLICT`. Tes `K-28 a re-issue never plants a link`; mutan (penjaga dihapus) terbunuh |

Diperiksa dan bersih: seluruh SQL berparameter; bentuk 3 mengikat `subject_type`, layanan, dan purpose ke kunci tautan, jadi tautan konteks lain tidak bisa dibaca sebagai sumber; `IDEMPOTENCY_CONFLICT` hanya menyingkap bahwa transaction id sudah tertaut di konteks pemanggil sendiri; baris audit tidak memuat subjek; `DELETE` hanya pada `transaction_link` untuk `privpay_app`, auditor tanpa hak; kripto dan pengikatan AAD tidak berubah.

Belum diuji: `revoke_subject` (M3-02) belum menghapus tautan; fail-closed di Docker (M7).
