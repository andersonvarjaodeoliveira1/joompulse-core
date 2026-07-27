-- tracked_sellers.user_id nao tinha default -- front so manda
-- {seller_id:id} no insert (acompanharVendedor em app/index.html), entao
-- todo "seguir vendedor" quebrava com not-null violation. category_search_log
-- (nova, ainda sem uso) ia cair na mesma armadilha -- corrigido antes de usar.
alter table tracked_sellers      alter column user_id set default auth.uid();
alter table category_search_log  alter column user_id set default auth.uid();
