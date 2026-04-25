-- Broaden the existing northbeam_cache into a generic tool result cache.
alter table if exists northbeam_cache rename to tool_result_cache;

alter table tool_result_cache add column if not exists tool text;
alter table tool_result_cache add column if not exists frozen boolean not null default false;

update tool_result_cache set tool = 'northbeam' where tool is null;
alter table tool_result_cache alter column tool set not null;

create index if not exists tool_result_cache_tool_idx on tool_result_cache (tool);
create index if not exists tool_result_cache_expires_idx_active
  on tool_result_cache (expires_at) where not frozen;
