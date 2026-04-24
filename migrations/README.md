# Database migrations

Apply manually against the Supabase project via SQL Editor or `supabase db push`.

Order matters: run files in numeric order (`0001_*`, `0002_*`, ...).

## Vault secrets

This project relies on secrets stored in Supabase Vault. To create them, run in the SQL Editor:

```sql
select vault.create_secret('danny@gantri.com',     'NORTHBEAM_EMAIL');
select vault.create_secret('G@ntriSecure',         'NORTHBEAM_PASSWORD');
select vault.create_secret('1aaaa257-60a3-4fd7-a99e-7886894240d3', 'NORTHBEAM_DASHBOARD_ID');
```

(Values are placeholders in this README; actual values live only in Supabase Vault.)
