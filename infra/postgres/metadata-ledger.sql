create table if not exists watasu_delivery_ledger (
  tenant_id text not null,
  request_id text not null,
  request_version text not null,
  idempotency_key text not null,
  submitted_at timestamptz not null,
  delivered_at timestamptz not null,
  delivery_status text not null,
  destination_url_hash text not null,
  encrypted_payload_hash text not null,
  webhook_status integer,
  error_code text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, request_id, request_version, idempotency_key, delivered_at)
);

create index if not exists watasu_delivery_ledger_request_idx
  on watasu_delivery_ledger (tenant_id, request_id, request_version);

create index if not exists watasu_delivery_ledger_idempotency_idx
  on watasu_delivery_ledger (tenant_id, request_id, request_version, idempotency_key);

create index if not exists watasu_delivery_ledger_delivered_at_idx
  on watasu_delivery_ledger (tenant_id, delivered_at);
