# Database migrations

Apply manually against the Supabase project via SQL Editor or `supabase db push`.

Order matters: run files in numeric order (`0001_*`, `0002_*`, ...).

## Vault secrets

This project relies on secrets stored in Supabase Vault. To create them, run in the SQL Editor:

```sql
select vault.create_secret('<email>',        'NORTHBEAM_EMAIL');
select vault.create_secret('<password>',     'NORTHBEAM_PASSWORD');
select vault.create_secret('<workspace-id>', 'NORTHBEAM_DASHBOARD_ID');
```

The real values are documented privately (out of this repo). Populate them in Supabase Vault via the SQL Editor; never commit them to version control.
