INSERT INTO public.feature_definitions (key, name, description, price_usd, is_core)
VALUES ('shift_system', 'Smena tizimi', 'POS da smena boshlash/yopish', 0, false)
ON CONFLICT (key) DO NOTHING;
