# Retro M4 (2026-10-22)

Dasar: kejadian nyata sepanjang Gerbang 1 sampai 4 dan M4-10 (HANDOFF, CHANGELOG, riwayat commit, `review-M4.md`). Bagian "yang kuhentikan" milik Fanny dan sengaja dikosongkan.

## 1. Yang lancar

- Tumpukan E2E dengan layanan asli (dev-idp, Gateway, Privacy, Transaction, Fraud, Notification, simulator SMS, Reconciliation) menemukan hal yang tes per layanan tidak akan temukan: Gateway tidak meneruskan `Cache-Control: no-store` pada jawaban berisi identitas (N-36), cabang `notification` yang jatuh ke jalur transaksi, logger penjadwal yang tidak mengikuti tujuan log. Kebenaran tiap layanan sudah teruji; yang gagal adalah sambungan antarlayanan.
- Mutasi menjadi kebiasaan: hampir setiap pengaman baru dibuktikan dengan menghapusnya. Mutasi juga menemukan tes yang tampak benar tetapi tidak menjaga apa pun (filter `COMPLETED` yang tersaring oleh syarat waktu; guard start-sebelum-listen; deteksi penolakan tak tertangani yang "ditangani" oleh `idle()`).
- Pemindai kenari atas seluruh alur (basis data, log, metrik, audit, jawaban) dengan kontrol positif membuat klaim "HP hanya di Notification dan simulator SMS; email di mana pun tidak ada" terukur, bukan keyakinan.
- Penolakan temuan review dengan alasan tertulis (bukan perubahan kode yang tidak perlu) diterima baik; dari 40 temuan `/code-review` sepanjang M4, sekitar sepertiga diperbaiki.
- Berhenti dan bertanya saat ADR bertabrakan (ADR-0014: kompensasi pendaftaran vs Tabel 3) menghemat salah arah; keputusan jatuh dalam satu pertanyaan.

## 2. Yang menghambat

- Mesin tertidur di tengah gerbang (kegagalan `db.integration` karena batas 30 detik habis oleh tidur 2 jam). Tanpa membaca stempel waktu log, ini tampak seperti kegagalan tak stabil.
- Alat: heredoc Bash berisi tanda kutip tunggal gagal diparse berulang kali; Prettier mengubah teks sehingga pola penyuntingan dan mutasi tidak lagi cocok; skrip mutasi yang dimatikan paksa meninggalkan mutan di berkas.
- Jest menunggu satu jam bila sebuah tes gagal sebelum menutup timer nyata (mutan `unref`), sehingga gerbang menggantung tanpa pesan.
- Spek yang tidak bisa dipenuhi apa adanya baru ketahuan saat menulis tes: email di formulir pendaftaran tanpa kolom di brankas (N-38), TX-10001..10003 yang di PRD bernomor tetap sedangkan Gateway membuat id sendiri, jam palsu yang hanya boleh maju ketika token disimpan cache.
- Perubahan yang menyentuh banyak blok env di tes (env wajib baru) memakan banyak penyuntingan mekanis.

## 3. Kesalahan AI yang berulang

- Berhenti dan menyerahkan keluaran skill (`/security-review`, `/code-review`) sebagai balasan akhir padahal pekerjaan belum selesai; terjadi dua kali di Gerbang 4 dan harus dikoreksi pengguna.
- Menulis ekspektasi tes dari ingatan tentang perilaku, bukan dari membaca kodenya: audiens salah dijawab `FORBIDDEN_ROLE` (bukan 401), bank dengan token aktor `FORBIDDEN_ROLE` (bukan `POLICY_NOT_ALLOWED`), hitungan `resync` setelah `sweep`, jam mundur membatalkan token cache.
- Fixture yang tidak menguji cabang yang dimaksud: baris HELD/FAILED tanpa `completed_at` sehingga filter status tidak pernah diuji; hanya mutasi yang menunjukkannya.
- Menyatakan satu tes pelindung padahal tes itu memanggil `idle()` yang menangani sendiri penolakan yang dicari.

## 4. Usulan perubahan CLAUDE.md (diterapkan: lihat "Pelajaran berulang")

1. Skrip penyunting dan mutasi ditulis ke berkas, bukan heredoc Bash berisi tanda kutip tunggal; setelah Prettier, cocokkan pola dari teks yang sudah diformat; setelah proses mutasi dihentikan paksa, periksa berkas telah dipulihkan.
2. Tes yang membuka sumber daya nyata (timer, soket, kolam) menutupnya di `finally`; satu asersi gagal tidak boleh meninggalkan handle yang membuat Jest menunggu.
3. Jam palsu satu tumpukan layanan hanya maju: token yang disimpan cache membawa `iat`. Urutkan langkah tes secara kronologis.
4. Bila tes kehabisan waktu atau gagal tak stabil, baca stempel waktu log lebih dulu (mesin tidur terlihat sebagai lompatan jam).
5. Keluaran sebuah skill review bukan balasan akhir: lanjutkan sampai laporan akhir yang diminta.

## 5. Yang kuhentikan

(diisi Fanny)
