-- 10_bank_policy_schema.sql
-- ------------------------------------------------------------------
-- Bank / NBFC policy storage for the loan portal.
--
-- Run this ONCE in Supabase: Dashboard -> SQL Editor -> New query ->
-- paste -> Run. Then run 20_seed_banks.sql to load the data from
-- Policy_details_as_per_2024.xlsx.
--
-- This sits alongside your existing schema.sql (users, applications).
-- It does not modify or drop anything that file created.
--
-- WHY THE DATA IS SPLIT ACROSS FIVE TABLES
-- The spreadsheet is a grid: banks across the top, policy criteria down
-- the side, and a sentence of free English in every cell. Two different
-- things live in those sentences:
--
--   (a) hard numbers  - "25K+", "700+", "21 years to 58 Years"
--   (b) human judgement - "based on the clarification we can do it"
--
-- (a) belongs in typed columns so Postgres can filter on it in
-- milliseconds. (b) can only be read by a language model. So we store
-- both: bank_policies keeps every sentence exactly as typed (nothing is
-- lost), and bank_rules holds the numbers pulled out of those sentences.
-- Matching then runs in two stages - SQL narrows 30 desks down to a
-- handful, Gemini reads the sentences for those few and explains.
-- ------------------------------------------------------------------

-- 1. The lender itself. Fifteen distinct banks/NBFCs appear in the sheet.
create table if not exists public.banks (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,          -- 'hdfc_bank'
  name       text not null,                 -- 'HDFC Bank'
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2. A "desk" = one column of the spreadsheet.
--    The sheet has HDFC three times (the bank direct, Nithyananda's desk,
--    Manohar's desk) and each quotes slightly different rules. Collapsing
--    them into one HDFC row would silently throw away two policies, so
--    each column gets its own row here, pointing at the same bank.
create table if not exists public.bank_desks (
  id            uuid primary key default gen_random_uuid(),
  bank_id       uuid not null references public.banks(id) on delete cascade,
  slug          text not null unique,       -- 'hdfc_bank_nithyananda'
  contact_name  text,                       -- 'Nithyananda'  (null = bank direct)
  contact_phone text,
  source_label  text,                       -- the raw column header, for traceability
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists bank_desks_bank_id_idx on public.bank_desks(bank_id);

-- 3. The criteria - one row per row of the spreadsheet (36 of them).
--    Kept as a table rather than 36 columns so you can add a criterion
--    next year without an ALTER TABLE and a code change.
create table if not exists public.policy_criteria (
  id    uuid primary key default gen_random_uuid(),
  slug  text not null unique,               -- 'minimum_cibil_score'
  sl_no int,                                -- Sl no from the sheet
  label text not null                       -- 'Minimum Cibil Score'
);

-- 4. Every cell of the grid, verbatim. This is the source of truth and
--    the text the AI reads. 669 rows from the 2024 sheet.
create table if not exists public.bank_policies (
  id           uuid primary key default gen_random_uuid(),
  desk_id      uuid not null references public.bank_desks(id) on delete cascade,
  criterion_id uuid not null references public.policy_criteria(id) on delete cascade,
  policy_text  text not null,
  updated_at   timestamptz not null default now(),
  unique (desk_id, criterion_id)
);
create index if not exists bank_policies_desk_idx on public.bank_policies(desk_id);

-- 5. The machine-readable layer, extracted from the text in (4).
--    NULL means "the sheet did not say" - treated as no restriction,
--    never as a rejection.
create table if not exists public.bank_rules (
  desk_id              uuid primary key references public.bank_desks(id) on delete cascade,
  min_salary_listed    int,          -- rupees per month, listed company
  min_salary_unlisted  int,
  min_cibil            int,
  min_age              int,
  max_age              int,
  min_exp_months       int,
  max_loan_amount      bigint,       -- rupees
  max_tenure_months    int,
  max_foir_pct         int,          -- max EMI-to-income ratio allowed
  roi_min              numeric(5,2),
  roi_max              numeric(5,2),
  unlisted_allowed     boolean,
  contract_emp_allowed boolean,
  bpo_nbfc_allowed     boolean,
  has_policy_data      boolean not null default true,
  review_note          text,         -- put your corrections' reasoning here
  updated_at           timestamptz not null default now()
);

-- ------------------------------------------------------------------
-- Row level security
--
-- Policy data is reference data, not user data: the browser may READ it
-- but must never write it. So a single read-only policy on each table,
-- and no insert/update/delete policy at all - which blocks writes for
-- the anon key entirely. You edit these tables from the Supabase Table
-- Editor or by re-running the seed, both of which bypass RLS.
-- ------------------------------------------------------------------
alter table public.banks           enable row level security;
alter table public.bank_desks      enable row level security;
alter table public.policy_criteria enable row level security;
alter table public.bank_policies   enable row level security;
alter table public.bank_rules      enable row level security;

drop policy if exists banks_read           on public.banks;
drop policy if exists bank_desks_read      on public.bank_desks;
drop policy if exists policy_criteria_read on public.policy_criteria;
drop policy if exists bank_policies_read   on public.bank_policies;
drop policy if exists bank_rules_read      on public.bank_rules;

create policy banks_read           on public.banks           for select using (true);
create policy bank_desks_read      on public.bank_desks      for select using (true);
create policy policy_criteria_read on public.policy_criteria for select using (true);
create policy bank_policies_read   on public.bank_policies   for select using (true);
create policy bank_rules_read      on public.bank_rules      for select using (true);

-- ------------------------------------------------------------------
-- Stage 1 of matching: the SQL filter.
--
-- Takes the applicant's details as jsonb and returns every desk with a
-- verdict. Three verdicts, not two:
--
--   'eligible' - meets every rule the sheet states
--   'review'   - breaks no stated rule, but the sheet is silent on
--                something that matters (missing data is not a pass)
--   'rejected' - breaks a rule that is written down
--
-- Expected input keys (all optional; anything absent is skipped):
--   monthly_income, cibil_score, age, experience_months, loan_amount,
--   existing_emi, company_type ('listed'|'unlisted'|'government'),
--   employment_type ('salaried'|'contract'|'self_employed'),
--   industry, enquiries_3m, bounces_12m, accommodation
-- ------------------------------------------------------------------
drop function if exists public.match_banks(jsonb);

create or replace function public.match_banks(p_application jsonb)
returns table (
  desk_slug     text,
  bank_name     text,
  contact_name  text,
  contact_phone text,
  verdict       text,
  reasons       text[],
  policies      jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_income   int   := floor(nullif(p_application->>'monthly_income', '')::numeric)::int;
  v_cibil    int   := floor(nullif(p_application->>'cibil_score', '')::numeric)::int;
  v_age      int   := floor(nullif(p_application->>'age', '')::numeric)::int;
  v_exp      int   := floor(nullif(p_application->>'experience_months', '')::numeric)::int;
  v_amount   bigint:= floor(nullif(p_application->>'loan_amount', '')::numeric)::bigint;
  v_emi      int   := coalesce(floor(nullif(p_application->>'existing_emi', '')::numeric)::int, 0);
  v_comp     text  := lower(coalesce(p_application->>'company_type', ''));
  v_emp      text  := lower(coalesce(p_application->>'employment_type', ''));
  v_industry text  := lower(coalesce(p_application->>'industry', ''));
begin
  return query
  select
    d.slug,
    b.name,
    d.contact_name,
    d.contact_phone,
    case
      when cardinality(f.fails) > 0 then 'rejected'
      when cardinality(f.gaps)  > 0 then 'review'
      else 'eligible'
    end,
    f.fails || f.gaps,
    (select coalesce(jsonb_object_agg(pc.sl_no || '. ' || pc.label, bp.policy_text), '{}'::jsonb)
       from public.bank_policies bp
       join public.policy_criteria pc on pc.id = bp.criterion_id
      where bp.desk_id = d.id)
  from public.bank_desks d
  join public.banks b on b.id = d.bank_id
  left join public.bank_rules r on r.desk_id = d.id
  cross join lateral (
    select
      -- Written-down rules the applicant breaks.
      array_remove(array[
        case when v_cibil is not null and r.min_cibil is not null and v_cibil < r.min_cibil
             then format('CIBIL %s is below their minimum of %s', v_cibil, r.min_cibil) end,
        case when v_age is not null and r.min_age is not null and v_age < r.min_age
             then format('Age %s is below their minimum of %s', v_age, r.min_age) end,
        case when v_age is not null and r.max_age is not null and v_age > r.max_age
             then format('Age %s is above their maximum of %s', v_age, r.max_age) end,
        case when v_exp is not null and r.min_exp_months is not null and v_exp < r.min_exp_months
             then format('%s months experience is below their minimum of %s', v_exp, r.min_exp_months) end,
        case when v_amount is not null and r.max_loan_amount is not null and v_amount > r.max_loan_amount
             then format('Requested amount exceeds their cap of Rs %s', r.max_loan_amount) end,
        case when v_income is not null and v_comp = 'listed' and r.min_salary_listed is not null
              and v_income < r.min_salary_listed
             then format('Salary Rs %s is below their listed-company minimum of Rs %s',
                         v_income, r.min_salary_listed) end,
        case when v_income is not null and v_comp = 'unlisted' and r.min_salary_unlisted is not null
              and v_income < r.min_salary_unlisted
             then format('Salary Rs %s is below their unlisted-company minimum of Rs %s',
                         v_income, r.min_salary_unlisted) end,
        case when v_comp = 'unlisted' and r.unlisted_allowed is false
             then 'They do not fund unlisted companies' end,
        case when v_emp = 'contract' and r.contract_emp_allowed is false
             then 'They do not fund contract employees' end,
        case when r.bpo_nbfc_allowed is false
              and v_industry ~ '(bpo|pharma|nbfc|insurance|real estate)'
             then 'They do not fund this industry' end,
        case when v_income is not null and v_income > 0 and r.max_foir_pct is not null
              and (v_emi::numeric / v_income) * 100 > r.max_foir_pct
             then format('Existing EMIs are %s%% of income, above their FOIR cap of %s%%',
                         round((v_emi::numeric / v_income) * 100), r.max_foir_pct) end
      ]::text[], null) as fails,

      -- Things the sheet does not answer. Not a rejection, but not a pass.
      array_remove(array[
        case when r.desk_id is null or r.has_policy_data is false
             then 'No policy recorded for this desk - confirm with them directly' end,
        case when v_cibil is null then 'CIBIL score not provided' end,
        case when v_income is null then 'Monthly income not provided' end,
        case when v_comp = '' then 'Company type (listed/unlisted) not provided' end,
        case when r.min_cibil is null and r.has_policy_data
             then 'Their minimum CIBIL is not recorded' end,
        case when v_age is not null and r.max_age is null and r.has_policy_data
             then 'Their age limit is not recorded' end,
        case when v_amount is not null and r.max_loan_amount is null and r.has_policy_data
             then 'Their maximum loan amount is not recorded' end,
        case when v_income is not null and v_comp = 'listed'
              and r.min_salary_listed is null and r.has_policy_data
             then 'Their minimum salary is not recorded' end
      ]::text[], null) as gaps
  ) f
  where d.is_active
  order by
    case
      when cardinality(f.fails) > 0 then 3
      when cardinality(f.gaps)  > 0 then 2
      else 1
    end,
    r.roi_min nulls last,
    b.name;
end;
$$;

grant execute on function public.match_banks(jsonb) to anon;

-- Handy read-only view for a "browse all policies" admin screen.
create or replace view public.v_bank_policy_grid as
select b.name as bank, d.contact_name, d.contact_phone,
       pc.sl_no, pc.label as criterion, bp.policy_text
from public.bank_policies bp
join public.bank_desks d      on d.id  = bp.desk_id
join public.banks b           on b.id  = d.bank_id
join public.policy_criteria pc on pc.id = bp.criterion_id;

notify pgrst, 'reload schema';
