-- Add brak permission to all existing users
UPDATE public.users
SET permissions = permissions || '{"brak": true}'::jsonb
WHERE permissions IS NOT NULL
  AND NOT (permissions ? 'brak');

UPDATE public.users
SET permissions = '{"brak": true}'::jsonb
WHERE permissions IS NULL;
