# E(s) mode proposed (M6-02)

Commit `b5a4f2f191537898598877a9bac4c27e318057c9` (pohon kerja bersih), 2026-11-02T07:24:44.091Z, 1000 nasabah sintetis, FRAUD_HISTORY_DAYS=30.
Tepi: Kong 3.9.4 -> gateway-adapter (Keycloak as IdP). Batas laju: off for the measurement (adapter and Kong), the same in both modes.
Klien mengirim nik dan nama pada pembayaran: yes in both modes (identical client behaviour; baseline forwards, proposed drops at the Gateway).

Ini ukuran paparan struktural pengenal langsung, bukan risiko identifikasi ulang dan bukan pengukuran kinerja.

## Kontrol positif pemindai

Kenari yang sengaja ditanam harus ketemu (enam atribut): payload customer_id, nik, hp, rekening, email, nama; basis data customer_id, nik, hp, rekening, email, nama; log customer_id, nik, hp, rekening, email, nama.

## E(s) teramati dibanding Tabel IV

| Layanan | Harapan Tabel IV | Teramati | E harapan | E teramati | E_umum | E_spesifik | Kurang | Tak terduga | Presisi | Recall | Cocok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| transaction | - | - | 0/6 | 0/6 | 0.0000 | 0.0000 | - | - | 1.0000 | 1.0000 | ya |
| fraud | - | - | 0/6 | 0/6 | 0.0000 | 0.0000 | - | - | 1.0000 | 1.0000 | ya |
| notification | hp | hp | 1/6 | 1/6 | 0.2000 | 0.0000 | - | - | 1.0000 | 1.0000 | ya |
| reconciliation | - | - | 0/6 | 0/6 | 0.0000 | 0.0000 | - | - | 1.0000 | 1.0000 | ya |

Auth (Keycloak, di luar zona perlindungan): teramati customer_id (E = 1/6). Tabel IV tidak memuat Auth, jadi tidak ada harapan untuknya.

Rata-rata E(s): seluruh layanan (empat layanan + Auth) 0.0667; hanya dalam zona perlindungan (empat layanan) 0.0417.
Per kelas: umum seluruh 0.0800, umum dalam zona 0.0500; spesifik seluruh 0.0000, spesifik dalam zona 0.0000.

## Rincian atribut per lokasi

| Layanan | payload | basis data | log |
| --- | --- | --- | --- |
| transaction | - | - | - |
| fraud | - | - | - |
| notification | hp | hp | - |
| reconciliation | - | - | - |
| auth | - | customer_id | - |

## Komponen di luar Tabel IV (informasi, tidak masuk rata-rata)

- kong: payload = -; database = -; log = -
- gateway: payload = -; database = -; log = -
- sms-simulator: payload = -; database = -; log = -
- privacy-service: payload = -; database = -; log = -

Pertukaran HTTP yang diamati proksi: 7022.

## Alur

```json
{
  "customers": 1000,
  "registered": 1000,
  "payments": 2500,
  "completedOrHeldAtPayment": {
    "COMPLETED": 2250,
    "HELD": 250
  },
  "reviewed": 250,
  "settlementReportStatus": 202,
  "settlementItems": 500,
  "reconciliationRunStatus": 200,
  "reconciliationRunSeconds": 9.816,
  "reconciliationRunServiceSide": null,
  "reconciliation": {
    "batch_id": "B-20261102",
    "tx_count": 2500,
    "matched": 500,
    "unmatched": 2000,
    "status": "PARTIAL"
  },
  "seconds": 187
}
```

## Pembukaan identitas bersyarat (dilaporkan TERPISAH, paparan terkontrol)

```json
{
  "available": true,
  "attempted": 5,
  "auditTokensIssued": 5,
  "statusOfAuditRequest": [
    200,
    200,
    200,
    200,
    200
  ],
  "opened": 5,
  "onlyApprovedAttribute": 5,
  "valueMatchesRegistered": 5,
  "auditRowsFound": 5,
  "auditTextClean": 5,
  "routineAuditTextClean": 5,
  "residueAfterDisclosure": {
    "reconciliation database": [],
    "reconciliation log": [],
    "gateway log": [],
    "kong log": []
  }
}
```

