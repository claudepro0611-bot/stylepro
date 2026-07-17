# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ This is not the Next.js you know

This project runs **Next.js 16** with React 19, which has breaking changes vs. training-data Next.js. Before writing routing/data-fetching code, check `node_modules/next/dist/docs/` for the relevant guide. One confirmed change already in this repo:

- **`middleware.ts` → `proxy.ts`**. Route interception now lives in `proxy.ts` at the project root, exporting a `proxy()` function (not `middleware()`). See `proxy.ts` and `lib/supabase/middleware.ts` (the `updateSession` implementation it calls). Functionality is the same as old Middleware, just renamed.

Don't assume other Next.js APIs work as trained — verify against the docs directory when in doubt.

## Commands

```bash
npm run dev      # start dev server
npm run build    # production build
npm run start    # run production build
npm run lint     # eslint (flat config, eslint-config-next)
```

There is no test runner configured in this repo.

## Architecture

**Stack**: Next.js 16 (App Router) + React 19 + TypeScript, Tailwind v4, shadcn/ui (`style: base-nova`, neutral base, `iconLibrary: lucide`), Supabase (Postgres + Auth), Zustand, React Hook Form + Zod, Recharts.

### Multi-tenant model

Every business (clothing shop) is a **company**. Every `public.users` row belongs to a `company_id` and has a `role` (`owner | admin | manager | staff`) and a `status` (`active | inactive`). Nearly all business tables are scoped by `company_id` and protected with Postgres RLS policies that key off `public.get_company_id()` — a `security definer` SQL function (see `supabase/migrations/20260612090003_helper_functions.sql`) that resolves the current `auth.uid()`'s `company_id`. When writing a Supabase query or migration, always scope by `company_id` and rely on `get_company_id()` rather than trusting client-supplied company IDs.

One hardcoded super admin exists across the whole system: email `admin@stylepro.local` (see `SUPER_ADMIN_EMAIL` in `lib/supabase/middleware.ts` and `components/layout/Sidebar.tsx`). Only that user can access `/super-admin/*` (firm/company management) — enforced in `proxy.ts`'s `updateSession`.

Non-owner users are gated by a `permissions` JSONB column (`Permissions` record keyed by `PermissionKey`, see `lib/permissions.ts`). `PERMISSION_KEYS` is the single source of truth for both sidebar nav visibility (`components/layout/Sidebar.tsx`) and route access; `withDefaultPermissions()` merges partial/missing permission data with `DEFAULT_PERMISSIONS` (all true) so legacy rows without explicit permissions still work. Owners bypass permission checks entirely.

Auth logins are synthetic emails: staff log in with a `login` that gets suffixed into `${login}@stylepro.local` (see `LOGIN_DOMAIN_SUFFIX` in `app/(dashboard)/jamoa/actions.ts`), not real email addresses.

### Supabase client layers

Three distinct Supabase clients, each with a specific purpose — don't mix them up:

- `lib/supabase/client.ts` — browser client (`createBrowserClient`). Used from `'use client'` components for session-aware, RLS-scoped reads (most pages fetch data directly from the client this way, e.g. `app/(dashboard)/dashboard/page.tsx`).
- `lib/supabase/server.ts` → `createClient()` — session-aware server client (`createServerClient`, cookie-backed) for Server Components/Actions/Route Handlers where you need `auth.getUser()`.
- `lib/supabase/server.ts` → `supabaseServer` — service-role admin client (`SUPABASE_SECRET_KEY`). Bypasses RLS and can manage `auth.users` (create/update/delete). **Never import this into client components.** Used inside `'use server'` action files for privileged operations (creating staff accounts, cross-user reads, super-admin firm management).
- `lib/supabase/helpers.ts` → `getCompanyId(supabase)` — RPC wrapper around `get_company_id()`, needed before inserts because `company_id` is `NOT NULL` and RLS only validates it after the row exists.

### Server Actions pattern

Mutations that need elevated privilege (creating team users, super-admin firm CRUD) live in colocated `actions.ts` files (`'use server'`) next to their page, e.g. `app/(dashboard)/jamoa/actions.ts`, `app/(dashboard)/super-admin/actions.ts`. Convention:
- Public exported functions wrap an `...Internal` function in try/catch and return `{ error: string }` on failure instead of throwing (so client code can render inline errors without try/catch boilerplate).
- Every mutating action starts with a `requireCompanyOwner()`/auth check before touching data.
- Row-level validation (login format, password length, uniqueness) happens in the action, not the DB.

### Data fetching pattern in pages

Most dashboard pages are `'use client'` components that fetch directly from Supabase in a `useEffect` via `lib/supabase/client.ts`, then manually map snake_case DB columns to the camelCase interfaces in `lib/types/index.ts` (e.g. `dashboard/page.tsx`'s `load()` function). There is no data-fetching abstraction/React Query layer — each page owns its own fetch + mapping + loading state.

### Domain types vs. DB schema

`lib/types/index.ts` defines the app-facing camelCase interfaces (`Product`, `Transaction`, `Employee`, etc.) that pages map Supabase rows into. `lib/data/mockData.ts` holds sample/mock data (check whether a given page still reads from this vs. live Supabase before assuming either). `supabase/migrations/*.sql` is the source of truth for actual DB schema — migrations are timestamp-ordered and additive (never edit a merged migration; add a new one).

### Unused schema: invoices / invoice_items

`public.invoices` and `public.invoice_items` (see `supabase/migrations/20260612090007_invoices.sql`) exist in the DB but have zero `.from('invoices'|'invoice_items')` references anywhere in the app — dead schema, not wired to any page or action yet.

TODO (future feature): connect to the POS module (`app/(dashboard)/pos/page.tsx`) to generate a receipt/invoice after each completed transaction (`handleSell`). Needed:
- PDF receipt generation
- Invoice list page (new route, e.g. `app/(dashboard)/invoices/`)
- Send receipt to customer (SMS/Email)

### i18n and currency

- `lib/i18n/` — client-side i18n via React context (`LanguageProvider`/`useLanguage`), not `next-intl` or App Router i18n routing. Languages: `uz` (default), `ru`, `en`. Translation keys are dot-path strings resolved against `lib/i18n/translations.ts` (`resolve()` walks the path); add new UI strings there as `TranslationKey` entries, not inline literals. Persisted to `localStorage` (`stylepro-language`).
- `lib/currency/CurrencyContext.tsx` — same pattern for UZS/USD display with a hardcoded `USD_RATE`. `formatPrice`/`formatShortPrice` are the only sanctioned way to render money in the UI.
- Both providers are client-only and wrap the app in `components/Providers.tsx`, alongside `next-themes` for dark mode (`class` attribute, default light).

### UI conventions

- Route groups: `app/(auth)/` (login, no sidebar) vs `app/(dashboard)/` (authenticated shell with `Sidebar` + `Header`, see `app/(dashboard)/layout.tsx`).
- shadcn primitives live in `components/ui/`; domain components are grouped by feature folder (`components/dashboard/`, `components/jamoa/`, `components/super-admin/`).
- Sizing domain concept: `lib/sizes.ts` defines `SizeType` (`clothing | shoe | universal`) used by product groups to determine which size set (`CLOTHING_SIZES`/`SHOE_SIZES`) applies — check this before adding size-related UI.
- Tailwind v4 with CSS variables (`app/globals.css`); dark mode via `dark:` variants driven by `next-themes`, not a custom class toggle.

### Design system ("Floxen" — monochrome premium)

All new pages and components must follow this system (see `app/(dashboard)/dashboard/page.tsx` and `components/layout/Sidebar.tsx` as reference implementations):

- **Philosophy**: near-monochrome. Grayscale chrome everywhere; color is reserved for semantic status (green/amber/red) and the single indigo-600 accent on special actions (Export, Upgrade — not yet implemented anywhere in-app, but this is the color to use if/when they're added). Primary buttons, active tabs, sidebar nav, focus rings, progress bars, links — all monochrome, not colored.
- **Main background**: `bg-gray-50 dark:bg-gray-950` (app shell, `app/(dashboard)/layout.tsx`); cards/sidebar/header are `bg-white dark:bg-gray-900` on top of it. Page padding: `px-6 py-5`.
- **Primary actions**: `bg-slate-900 hover:bg-slate-800 text-white` (monochrome dark fill — this counts as "on-brand", not a color accent).
- **Active/selected state** (tabs, segmented toggles, filter pills, sidebar nav, pagination): `bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100` — NOT a colored fill. Distinguished from inactive purely by elevation (shadow + border), since both sit on a white/gray-50 surface.
- **Focus rings**: monochrome — `focus:border-gray-400 dark:focus:border-gray-500` (no colored ring).
- **Links/accents**: monochrome — `text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100`.
- **Special-action accent**: `indigo-600` — reserved exclusively for Export/Upgrade-class actions. Do not use it for regular primary buttons or active states.
- **Corners**: mixed — `rounded-lg` for buttons/inputs, `rounded-xl` for cards.
- **Shadows**: subtle only — `shadow-sm` on cards/active-states, `shadow-md` on hover.
- **Animation**: minimal — only hover transitions (`transition-colors`/`transition-all duration-200`); no lift/scale hover effects on KPI cards.
- **Icons**: monochrome — `text-gray-400` inactive/decorative, `text-gray-900` for an active/emphasized icon, `lucide-react`. No per-item rainbow icon-badge systems (the sidebar nav icons and KPI icons are all plain `text-gray-400`, not individually colored).
- **Data display**: mixed — tables for lists, cards for summaries.
- **Status badges**: pill style — `rounded-full px-2 py-0.5 text-xs` (green/amber/red for states — these are semantic and exempt from the monochrome rule, same as chart/legend colors for categorical data).
- **Sizing**: balanced — `text-sm` body, page title `text-xl font-semibold` (h1), `py-2` buttons.
- No emojis in UI.

Component patterns:
- Primary button: `bg-slate-900 hover:bg-slate-800 text-white rounded-lg px-4 py-2 text-sm font-medium`
- Special-action button (Export/Upgrade only): `bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium`
- Card: `bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6`
- KPI card: `bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5` with a `w-9 h-9 rounded-lg bg-gray-50 dark:bg-gray-800` icon box (`text-gray-400` icon) top-left and an optional `text-emerald-600 bg-emerald-50` (or red, if negative) trend pill top-right — see `KpiIconBox`/`TrendBadge` in `app/(dashboard)/dashboard/page.tsx`.
- Input: `border border-gray-200 rounded-lg px-3 py-2 focus:border-gray-400 dark:focus:border-gray-500`
- Table header: `text-sm text-gray-500 font-medium border-b border-gray-100`
- Status badge: `rounded-full px-2 py-0.5 text-xs` (`bg-green-100 text-green-700` etc.)
- Tab/toggle active: `bg-white dark:bg-gray-900 shadow-sm border border-gray-100 dark:border-gray-700 text-gray-900 dark:text-gray-100 rounded-lg px-4 py-2`
- Links/accents: `text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100`
- Sidebar: white, `border-r border-gray-100 dark:border-gray-800`; company header card (logo + name + role) at top, decorative search bar (⌘K hint, not wired to a real command palette) below it, then monochrome nav — see `components/layout/Sidebar.tsx`.

Remember every class above needs a `dark:` counterpart (e.g. `border-gray-100 dark:border-gray-800`, `bg-white dark:bg-gray-900`) — this codebase is dark-mode-aware everywhere via `next-themes`, and a page that only styles the light variant is an inconsistency, not a valid interpretation of this system.
