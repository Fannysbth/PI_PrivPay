# secrets/

Folder ini sengaja kosong di git. Isinya dibuat lokal dan TIDAK PERNAH di-commit (`.gitignore` mengecualikan semuanya kecuali README ini).

Buat untuk dev (jalankan dari root repo; kunci dev tidak boleh dipakai di VPS):

```
for f in pseudonym_hmac_secret blind_index_secret field_encryption_key; do
  openssl rand -hex 32 > secrets/$f      # 32 byte acak, hex
done
for f in privacy_db_password transaction_db_password fraud_db_password \
         notification_db_password reconciliation_db_password keycloak_db_password \
         keycloak_admin_password grafana_admin_password; do
  openssl rand -base64 24 > secrets/$f
done
chmod 600 secrets/*
```

Aturan: tiga kunci Privacy Service harus berbeda satu sama lain; aplikasi menolak start bila hilang, kosong, atau sama. Perkakas otomatis tidak boleh membaca isi folder ini.
