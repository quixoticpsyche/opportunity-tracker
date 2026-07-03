# Opportunity Tracker

A Google Apps Script that scrapes internship/job emails from Gmail and logs each one
as a structured row in a Google Sheet — category, company, role, compensation,
deadline, eligibility, apply link, and JD link — using a free LLM to parse the details.

Built originally for the IIT Madras BS Industry Interaction Cell (IIC) mailing list,
but works for any career-cell / newsletter source you can isolate with a Gmail filter.

## What it does

- Reads emails under a Gmail label and appends one row per email to a Sheet.
- Uses an LLM (Groq's free tier by default) to classify each mail
  (`Job` / `Internship` / `Hackathon` / `Event` / `Other`) and extract fields.
- Reads the **HTML** body, so hyperlinked "Apply here" / "Detailed JD" URLs are captured.
- Dedups on Gmail message ID — safe to re-run, resumes where it left off.
- Runs hourly via a time trigger for hands-off ongoing capture.

## Setup

1. **Create a Sheet**, then open **Extensions → Apps Script** and paste in
   `OpportunityTracker.gs`. Save.
2. **Label your mail.** In Gmail, build a search that isolates opportunity mail, e.g.
   `from:(iic@study.iitm.ac.in) subject:("Job Opportunity" OR Internship OR Hiring OR Placement OR Recruitment OR Opportunity)`
   Create a filter from it → **Apply label: `Opportunities`** and tick
   *"Also apply filter to matching conversations"* to backfill.
3. **Add your API key.** Get a free key at [console.groq.com](https://console.groq.com)
   (no credit card). In Apps Script: **Project Settings → Script Properties → Add** →
   name `GROQ_API_KEY`, value = your key.
4. **Run** `syncOpportunities`. Repeat until the log says `Backlog cleared: true`
   (Groq's free tier is rate-limited, so the backlog clears over several runs).
5. **Run** `installTrigger` once for hourly auto-capture.

## Switching LLM provider

One line in the config controls the provider:

```js
const PROVIDER = 'groq';        // or 'anthropic'
```

- `groq` — free (rate-limited by tokens/minute). Model: `llama-3.1-8b-instant`.
- `anthropic` — paid, prepaid credits. Model: `claude-haiku-4-5-...`.

Each provider reads its own key from Script Properties (`GROQ_API_KEY` /
`ANTHROPIC_API_KEY`). If no key is set, the script fails loudly rather than
silently falling back to the regex parser.

## Functions

| Function | What it does |
|---|---|
| `syncOpportunities` | Main. Scrapes labelled mail into the Sheet. Also the trigger target. |
| `installTrigger` | Installs the hourly auto-capture trigger. Run once. |
| `resetSheet` | Wipes all rows and rewrites the header. Use after a schema change. |

## Notes

- **Bring your own key.** No key is committed; each user adds their own in Script Properties.
- The rule-based parser (`parseWithRules_`) is a no-API fallback — set `USE_LLM = false`
  to run fully free with no LLM, at lower extraction quality.
- Don't commit exported rows or screenshots containing real opportunity data.

## License

MIT — see `LICENSE`.
