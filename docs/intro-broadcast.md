# Draft broadcast — bot intro

Hi team 👋

I'm *gantri-ai*, the internal analytics assistant for Gantri. I live in Slack and answer questions about the business by pulling live data from Northbeam, Google Analytics 4, our Porter database, and the Grafana dashboards — then I come back with the answer, with sources, in seconds.

Think of me as the analyst you can ping at any hour without bothering anyone. No need to know SQL, no need to know which dashboard has what — just describe what you want.

---

*📊 Marketing & Attribution* — Northbeam
• _"What's our ROAS by channel last 7 days?"_
• _"Compare native Meta ROAS vs Northbeam-attributed for April"_
• _"Top 10 campaigns by revenue this month"_
• _"LTV/CAC ratio per channel for Q1"_
• _"Which Meta campaigns have the lowest marginal ROAS — I want to cut 20% of budget"_
• _"% revenue from new vs returning customers per channel"_
• _"Forecasted revenue at 30/60/90 days for Google Ads"_

*🌐 Site Behavior* — Google Analytics 4
• _"Top 20 landing pages by sessions in April"_
• _"Which product pages do users actually scroll all the way down?"_
• _"How many active users are on gantri.com right now?"_
• _"Add-to-cart rate by device this month"_
• _"Top 30 events that fired last week"_

*🏭 Orders & Operations* — Porter
• _"How many late orders do we have right now?"_ — full per-order table with causes, customer deadlines, days past, notes
• _"Did Hannah's order ship?"_ — by customer name or order ID
• _"AOV for Trade orders this quarter, broken out by status"_
• _"How many Wholesale orders shipped this month?"_

*📈 Sales & Finance* — Grafana dashboards
• _"Pull the Sales report for last week, broken out by transaction type"_
• _"On-time delivery rate this month"_
• _"Run the OKR dashboard for Q1"_
• _"CSAT and NPS for the past 30 days"_

*🔍 Cross-source comparisons*
• _"Compare daily NB orders vs Porter for the last 14 days"_
• _"Why don't NB and Porter match for January?"_ — I'll give you the exact order(s) that differ and why (timezone edge, post-hoc refund, rounding, etc.)

---

*📑 Reports, canvases, and CSVs*

Anything tabular, I deliver in the right format automatically:
• Small breakdowns → inline in chat
• Per-row tables → I'll open a *Slack Canvas* with the full data
• Big exports (50+ rows) → CSV file attached to the thread
• Just ask: _"open a canvas with the top 50 customers by lifetime value"_

---

*📅 Recurring reports — set it once, get it forever*

If a question is useful daily/weekly/monthly, subscribe to it instead of re-asking:
• _"Send me Sales totals every Monday at 7am PT"_
• _"Daily DM at 9am with NB-attributed revenue by channel"_
• _"Weekly late-orders report on Fridays at 4pm"_
• _"Every Monday at 8am, send a CSV with all late Trade orders"_

I compile each subscription into a deterministic plan once, and the runner re-fires it on cron — same numbers every time, no drift. Manage them with: _"what reports do I have"_, _"unsubscribe from the daily sales report"_.

---

*💡 Feature requests — make me faster*

If you find yourself asking the same question repeatedly and it takes me more than ~30 seconds to answer, *please tell me*. Send: _"feature request: [your ask]"_ and it goes straight to Danny. We build dedicated tools for those — they run in 1–2 seconds and the answer is always exact.

Real examples we already built this way:
• Late-orders report with cause analysis — was 45s, now 4s
• Page-completion / scroll-depth analysis — used to time out, now 2s
• Per-order diff between Northbeam and Porter, with likely-cause classifier
• Daily NB-vs-Porter side-by-side, no manual joining

The more you tell me what you ask, the sharper I get.

---

*✨ A few things worth knowing*
• I cite my sources at the bottom of every answer (Northbeam, Porter, Grafana, GA4).
• If you spot a wrong number, reply _"that's wrong because…"_ and I'll log it as feedback for Danny.
• I'm allowlisted — only the leadership, marketing, and analytics teams can see me. Conversations are private DMs.
• I cache results that are unlikely to change (closed-period attribution, settled days). Repeat questions come back near-instant.

Just DM me. Try it now: _"how much did we spend on ads this week?"_ 🚀

— gantri-ai
