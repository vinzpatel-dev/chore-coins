# 🪙 Chore Coins V2

A mobile-first PWA for tracking chores and pocket money for **Zay** 🧒 and **Shay** 👧.
Parents-only, PIN-gated, with live sync across devices via Supabase.

**Live:** https://vinzpatel-dev.github.io/chore-coins/

## Features
- Today's chore list, filtered by each chore's frequency (daily / specific days / X-per-week / weekly / one-off)
- Shared chores tick independently per kid; individual chores per kid
- Ad-hoc bonuses & deductions with notes
- Auto streak bonus (configurable days + amount per kid)
- Per-kid payout cycles (weekly / fortnightly / monthly) with full breakdown and history
- Reports: earnings this week/period, most completed, missed chores, day-by-day log
- Real-time sync so both parents' phones stay current
- Installable PWA (manifest + service worker + home-screen icons)

## Stack
- Preact + htm + Supabase JS (all via ESM CDN — no build step)
- Supabase Postgres backend (tables prefixed `cc_`)
- Deployed as static files on GitHub Pages

## Config
Backend keys live in `config.js`. The Supabase key is the public **anon** key by design; access is governed by RLS.

Default PIN: **1234** (change it in Settings).
