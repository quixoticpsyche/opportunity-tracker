# 📬 Opportunity Tracker

> Every internship and job that lands in your inbox — classified, parsed, and dropped into a spreadsheet. Automatically. For free.

## The problem

If you're an IIT Madras BS student, you know the drill. The Industry Interaction
Cell (IIC) fires opportunity emails into your inbox all day — `Job Opportunity |
Junior Data Scientist at Sanmar Group | Chennai`, `Internship Opportunity –
Vegam – Apply by 11 AM IST`, deadlines buried in the third paragraph, JD links
hidden behind "click here."

They pile up. You mean to track them. You don't. By the time you go looking for
"that AI Engineer role from last week," it's three hundred emails deep and the
deadline was yesterday.

I wanted **one clean list** — every opportunity to date, with the company, the
role, the deadline, and both links, all in one sheet I could sort and filter.
Doing that by hand for 600+ emails was never going to happen. So I automated it.

## What it does

Point it at your Gmail, and it:

- 🏷️ reads every email under an `Opportunities` label,
- 🤖 uses a free LLM to figure out what each one *is* — `Job` / `Internship` /
  `Hackathon` / `Event` / `Other` — so hackathons and webinars don't clutter your
  real opportunities,
- 📋 extracts **company, role, type, compensation, location, deadline, eligibility,
  a one-line summary, the apply link, and the JD link**,
- 🔗 digs the real URLs out of the email's HTML, so hyperlinked "Apply here" /
  "Detailed JD" links actually get captured instead of the word "here,"
- 📝 writes one tidy row per email into a Google Sheet,
- ⏰ and then runs itself **every hour on Google's servers** — so new opportunities
  get logged while you sleep, and you never touch it again.

All on free tiers. No server, no credit card, no cost.

## How it works

It's a single [Google Apps Script](https://developers.google.com/apps-script)
bound to a Sheet. Gmail, the script, and the Sheet all live in Google's cloud, so
once the hourly trigger is set it runs whether your laptop is on or not. Parsing
is done by [Groq](https://groq.com)'s free API (blazing-fast Llama inference);
swap to Anthropic's Claude with a one-line config change if you'd rather.

Dedup is on Gmail message ID, so it's safe to re-run and it resumes exactly where
it left off — no duplicates, no gaps.

## Setup

1. **Create a Sheet**, open **Extensions → Apps Script**, paste in
   `OpportunityTracker.gs`, save.
2. **Label your mail.** Build a Gmail search that isolates your opportunity source.
   Mine is basically:
   ```
   from:(iic@study.iitm.ac.in) subject:("Job Opportunity" OR Internship OR Hiring OR Placement OR Recruitment OR Opportunity)
   ```
   Turn it into a filter → **Apply label: `Opportunities`**, and tick *"Also apply
   filter to matching conversations"* to catch the whole backlog.
3. **Get a free Groq key** at [console.groq.com](https://console.groq.com) — no card
   needed. In Apps Script: **Project Settings → Script Properties → Add** →
   `GROQ_API_KEY` = your key.
4. **Run `syncOpportunities`.** Groq's free tier is rate-limited, so the backlog
   fills in over several runs — the log tells you when it's `Backlog cleared: true`.
5. **Run `installTrigger` once.** Now it's hourly and hands-off. Close the tab.

## Switching the LLM

One line picks the provider:

```js
const PROVIDER = 'groq';        // 'groq' (free) or 'anthropic' (paid)
```

Each reads its own key from Script Properties (`GROQ_API_KEY` /
`ANTHROPIC_API_KEY`). No key committed to the repo — bring your own. If a key's
missing, the script fails loudly instead of quietly dropping to the regex parser.

Want zero LLM at all? Set `USE_LLM = false` and it runs on pure regex — free,
offline, slightly rougher extraction.

## The functions

| Function | What it does |
|---|---|
| `syncOpportunities` | The main job — scrapes labelled mail into the Sheet. Also the hourly trigger target. |
| `installTrigger` | Sets up the hourly auto-capture. Run once. |
| `resetSheet` | Wipes rows and rewrites the header. Use after changing the schema. |


## License

MIT — do whatever you like with it. See `LICENSE`.

---

*Built because I got tired of losing good opportunities in a sea of unread mail.*
