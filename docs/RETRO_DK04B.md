# RETRO DK-04 sesi B (Keycloak jadi IdP tumpukan)

Singkat.

## Yang berjalan baik

- Pintu keluar memori memaksa ukur dulu: 0,59 GB di WSL 4 GB, 2,98 GB di 6 GB. Keputusan berbasis angka.
- Port `UserDirectory` menjaga `RegistrationFlow` tidak tahu IdP mana yang dipakai.
- Edge-check fase `claims` menemukan fakta nyata: `idp-admin` tidak bisa memberi `admin` (403) tetapi bisa memberi `auditor`/`fraud_analyst`.

## Yang mahal

- `docker compose run smoke` tanpa berkas Postman membuat Compose membuat ulang Keycloak: realm diimpor ulang, kunci baru, 401 di mana-mana. Pakai set `-f` yang sama; aturan dicatat di CLAUDE.md.
- Id permintaan berurutan di edge-check muncul lagi di log adapter dari run lama (lulus/gagal palsu). Pakai UUID acak per run.
- Heredoc Bash dengan backtick dan tanda kutip gagal berulang; tulis skrip penyunting ke berkas dengan alat Write.
- Environment Postman mengalahkan globals Newman: variabel `dev_password` kosong di environment membuat password grant gagal.
- Probe ad hoc yang membaca `secrets/` ditolak pemeriksa izin; diagnosis dipindah ke skrip repo.
- `/code-review` dengan argumen satu hash hanya meninjau merge itu terhadap induknya, bukan seluruh DK-04. Beri rentang eksplisit.

## Disarankan

- Putuskan dua temuan `/security-review` (audiens lebar, satu kata sandi) sebelum DK-06 dan M7.
