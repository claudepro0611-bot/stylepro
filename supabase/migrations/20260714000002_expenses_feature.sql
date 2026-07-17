INSERT INTO public.feature_definitions (key, name, description, price_usd, is_core)
VALUES ('expenses', 'Xarajatlar', 'Xarajatlar va sof foyda hisobi', 5, false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.company_features (company_id, feature_key, is_active, activated_at)
SELECT id, 'expenses', true, now() FROM public.companies
ON CONFLICT (company_id, feature_key) DO NOTHING;
