-- Two more properties AMACO advertises as icons, found by the badge tripwire on the first
-- multi-line crawl (KI-11 and PC-65 carried icons the map had never seen).
--
-- `food_safe_not_durable` is deliberately separate from `food_safe`: AMACO uses it to say
-- a glaze is safe to eat off but will not wear well, which matters to anyone glazing a mug
-- and would be lost if it were folded into the plain boolean.

alter table glazes add column food_safe_not_durable boolean;
alter table glazes add column astm_d4236 boolean;

comment on column glazes.food_safe_not_durable is
  'Food safe but not wear-resistant. Distinct from food_safe, not a weaker version of it.';
