-- ===========================================================================
--  A THROWAWAY SHOP TO REPLAY THE FAILED-CARD EVENTS AT.
--
--  ⚠️ READ BEFORE RUNNING. Four parts. Run each on its own and look at what it
--  prints before moving on. PART 3 deletes the row again.
--
--  WHAT THIS IS. scripts/stripe-dunning.mjs built a shop in the Stripe SANDBOX
--  and made its card fail for real, seven days of retries, ending in a
--  cancellation. Those events name a Stripe customer, and the webhook handler
--  finds a shop BY stripe_customer_id. So something on this database has to
--  carry that id for the few minutes the replay takes.
--
--  ⚠️ WHY A NEW ROW AND NOT AN EXISTING SHOP. There is exactly one shop on
--  production and it is MHC Fab. Pointing it at this customer and replaying
--  would set it past_due, then canceled - which locks you and the crew out of
--  the live app. The junk "jim built" shop that would have done the job was
--  cleaned up. So: a brand new row, with no logins attached, which no one can
--  see and nothing links to, deleted at the end.
--
--  ⚠️ NOT A SCHEMA CHANGE. No columns, policies, functions or triggers. One
--  INSERT, some column values, one DELETE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  PART 0 - PROVE THERE IS NOTHING THERE ALREADY. Read-only.
--  Expected: zero rows. If it returns one, a previous run was not cleaned up;
--  skip PART 1 and use the id it prints.
-- ---------------------------------------------------------------------------
select id, name, subscription_status, stripe_customer_id, created_at
  from public.companies
 where name = 'zz dunning test - delete me';


-- ---------------------------------------------------------------------------
--  PART 1 - CREATE IT, set up as a working shop that has paid us once.
--
--  The starting state the test needs:
--    * subscription_status = active   - a normal, paying shop
--    * first_paid_at       = set      - ⚠️ THIS IS WHAT EARNS A GRACE PERIOD.
--                                       Without it a failed card locks the
--                                       shop immediately, which is a real
--                                       case but a DIFFERENT one.
--    * grace_ends_at       = null     - no clock running yet
--    * the two Stripe ids  = the sandbox objects the events are about
--
--  It refuses to run twice.
-- ---------------------------------------------------------------------------
do $setup$
declare
  v_id uuid;
  -- From scripts/stripe-dunning-output.txt, 18 September, against
  -- acct_1UEaUKH23o1oRIgR (the ShopWorks sandbox). Not live objects.
  v_customer     text := 'cus_VHZHMdQBII3jU7';
  v_subscription text := 'sub_1UH08ZH23o1oRIgRUUoKPNsk';
begin
  if exists (select 1 from public.companies where name = 'zz dunning test - delete me') then
    raise exception 'The test shop already exists. Run PART 3 first, or reuse it.';
  end if;

  -- ⚠️ If anything else on this database already carries that customer id,
  -- stop: the handler finds shops by it and two matches is a coin toss.
  if exists (select 1 from public.companies where stripe_customer_id = v_customer) then
    raise exception 'Another shop already carries % - stopping.', v_customer;
  end if;

  insert into public.companies (name, subscription_status)
  values ('zz dunning test - delete me', 'active')
  returning id into v_id;

  update public.companies
     set stripe_customer_id     = v_customer,
         stripe_subscription_id = v_subscription,
         plan_id                = 'band_1_15',
         billing_interval       = 'monthly',
         first_paid_at          = now() - interval '40 days',
         current_period_end     = now() + interval '20 days',
         grace_ends_at          = null,
         past_due_notified_at   = null,
         locked_notified_at     = null,
         cancel_at_period_end   = false,
         trial_ends_at          = null
   where id = v_id;

  raise notice 'OK - test shop % created on sandbox customer %', v_id, v_customer;
end
$setup$;

-- ⚠️ COPY THE id THIS PRINTS. The replay script needs it.
select id, name, subscription_status, stripe_customer_id, stripe_subscription_id,
       first_paid_at, grace_ends_at
  from public.companies
 where name = 'zz dunning test - delete me';


-- ---------------------------------------------------------------------------
--  PART 2 - AFTER THE REPLAY. Read-only.
--
--  ⚠️ The replay script prints the row after EVERY event, and that is where
--  the proof is. By the time the cancellation has landed, grace_ends_at is
--  correctly back to null - a cancelled shop has no clock left to run. So this
--  query shows the END state, not the grace window.
--
--  WHAT YOU WANT TO SEE HERE:
--    subscription_status     canceled
--    stripe_subscription_id  null - a dead subscription is forgotten, so the
--                            shop is able to buy again
--    stripe_customer_id      still set - same customer, history intact
--    first_paid_at           unchanged. It is never cleared.
-- ---------------------------------------------------------------------------
select name,
       subscription_status,
       grace_ends_at,
       stripe_subscription_id,
       stripe_customer_id,
       first_paid_at,
       past_due_notified_at
  from public.companies
 where name = 'zz dunning test - delete me';


-- ---------------------------------------------------------------------------
--  PART 2b - THE SECOND PASS: A SHOP THAT HAS NEVER PAID US.
--
--  ⚠️ WHY THIS RUN IS NEEDED. In the first pass the shop had first_paid_at
--  set the whole way through, so the rule that DEPENDS on it was never put to
--  the test. That rule is: a card failing on a shop that has never paid is a
--  free trial ending on a bad card, and it locks immediately - no seven days.
--  Without it a 14-day trial quietly becomes 21.
--
--  Standing lesson 3: test a rule by DOING the thing it is supposed to
--  prevent. So this resets the same row with first_paid_at NULL and replays
--  the same events. The shop must come out past_due with grace_ends_at STILL
--  NULL - which my_shop_access() reads as locked, not grace.
--
--  Run this, then:
--     node scripts/stripe-replay.mjs --company <id> --yes --fresh-ids \
--       --skip invoice.paid
--
--  ⚠️ --fresh-ids is required. The handler claims each event id once, on
--  purpose, so without it the second run would do nothing and look like a
--  pass for the wrong reason.
--
--  ⚠️ --skip invoice.paid IS ALSO REQUIRED, and the first attempt at this
--  pass got it wrong. The replay begins with invoice.paid, and that event
--  STAMPS first_paid_at - which is correct, it is how a shop earns one. So
--  the column reset below was undone seconds later and the gate was handed
--  a shop that HAD paid. It passed, and proved nothing.
-- ---------------------------------------------------------------------------
update public.companies
   set subscription_status    = 'active',
       first_paid_at          = null,          -- ⚠️ the whole point of this pass
       grace_ends_at          = null,
       past_due_notified_at   = null,
       locked_notified_at     = null,
       stripe_subscription_id = 'sub_1UH08ZH23o1oRIgRUUoKPNsk',
       cancel_at_period_end   = false
 where name = 'zz dunning test - delete me';

select name, subscription_status, first_paid_at, grace_ends_at, stripe_subscription_id
  from public.companies
 where name = 'zz dunning test - delete me';


-- ---------------------------------------------------------------------------
--  PART 2c - THE THIRD PASS: THE OTHER EVENT ORDER.
--
--  ⚠️ WHY. The grace rule is written in TWO places - in syncSubscription
--  and again in the invoice.payment_failed handler - because Stripe does not
--  guarantee which of those events arrives first. In both passes so far the
--  subscription event won the race, so the copy inside payment_failed has
--  never actually run. A rule that has never executed is not a rule yet.
--
--  This puts first_paid_at back and then replays ONLY the failed payments, so
--  payment_failed is the first thing to find the shop past_due.
--
--  Run this, then:
--     node scripts/stripe-replay.mjs --company <id> --yes --fresh-ids \
--       --skip invoice.paid,customer.subscription.updated,customer.subscription.deleted
--
--  EXPECTED: the first payment_failed takes it to past_due AND sets
--  grace_ends_at seven days out. The three after it change nothing.
-- ---------------------------------------------------------------------------
update public.companies
   set subscription_status    = 'active',
       first_paid_at          = now() - interval '40 days',   -- it HAS paid us
       grace_ends_at          = null,
       past_due_notified_at   = null,
       locked_notified_at     = null,
       stripe_subscription_id = 'sub_1UH08ZH23o1oRIgRUUoKPNsk',
       cancel_at_period_end   = false
 where name = 'zz dunning test - delete me';

select name, subscription_status, first_paid_at, grace_ends_at
  from public.companies
 where name = 'zz dunning test - delete me';


-- ---------------------------------------------------------------------------
--  PART 3 - DELETE IT. Run this when the replay is done.
--
--  Nothing links to this row: no profiles, no memberships, no jobs. If the
--  delete complains about a foreign key, STOP and say so - it means something
--  attached itself and that is worth understanding before forcing it.
-- ---------------------------------------------------------------------------
delete from public.companies
 where name = 'zz dunning test - delete me';

select count(*) as should_be_zero
  from public.companies
 where name = 'zz dunning test - delete me';
