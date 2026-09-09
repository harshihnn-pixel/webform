-- 30_application_matches.sql   (OPTIONAL)
-- ------------------------------------------------------------------
-- Everything works without this file. Run it if you want the lender
-- recommendations kept on the application row, so an advisor opening
-- the file next week sees what was suggested at submission time.
--
-- Run AFTER schema.sql and 10_bank_policy_schema.sql.
-- ------------------------------------------------------------------

alter table public.applications
  add column if not exists matches jsonb;

drop function if exists public.save_application_matches(uuid, jsonb);

create or replace function public.save_application_matches(
  p_application_id uuid, p_matches jsonb
) returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.applications
     set matches = coalesce(p_matches, '{}'::jsonb)
   where id = p_application_id;

  if not found then
    raise exception 'Unknown application';
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.save_application_matches(uuid, jsonb) to anon;

notify pgrst, 'reload schema';
