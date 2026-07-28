-- `is_dipping` already existed as a column but nothing populated it. AMACO marks the
-- dry dipping-bucket formulations with their own icon (`dippingicon-web.png`), and the
-- distinction matters: their own product copy warns that "all dry dipping glazes can be
-- difficult to layer... they require thorough testing prior to layering full piece".
comment on column glazes.is_dipping is
  'Dry dipping-bucket formulation, read from the product page icon. AMACO warns these '
  'layer differently from the brushing glazes, so it is a real caveat rather than packaging.';
