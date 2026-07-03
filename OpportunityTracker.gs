/**
 * OpportunityTracker.gs
 * Scrapes Gmail for internship/job emails and logs one row per email into a Sheet.
 * - Backlog scrape + ongoing auto-capture (via time trigger)
 * - Dedups on Gmail message ID
 * - Optional LLM parsing (Anthropic) for deadline/role/company
 *
 * SETUP: see setup-checklist.md
 */

// ============ CONFIG ============
const LABEL_NAME   = 'Opportunities';       // Gmail label to scan
const SHEET_NAME   = 'Opportunities';       // Tab name in the bound Sheet
const USE_LLM      = true;                   // LLM classification + summary (needs API key, see setup)

// --- Provider: 'groq' (free) or 'anthropic' (paid). Switch with one line. ---
const PROVIDER     = 'groq';
const KEY_PROPERTY = { groq: 'GROQ_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[PROVIDER];
const MODEL        = { groq: 'llama-3.1-8b-instant', anthropic: 'claude-haiku-4-5-20251001' }[PROVIDER];
// Groq: 'llama-3.3-70b-versatile' is higher quality but has a tighter token/min cap.
// Anthropic: 'claude-sonnet-4-6' if classification slips.

const MAX_PER_RUN  = 120;                    // stop after N new emails/run to dodge the 6-min limit.
// ================================

const HEADERS = [
  'Date Received', 'Category', 'Company', 'Role', 'Type',
  'Compensation', 'Location', 'Deadline', 'Eligibility',
  'Summary', 'Apply Link', 'JD Link', 'Gmail Link', 'MessageID'
];

/** Reads the API key and strips any accidental whitespace/newlines from pasting. */
function getKey_() {
  const k = PropertiesService.getScriptProperties().getProperty(KEY_PROPERTY);
  return k ? k.trim() : '';
}

/**
 * Converts the HTML body to text while keeping link URLs inline as "anchor (URL)".
 * This is essential: JD/apply links are hyperlinks, so getPlainBody() drops the URL
 * and leaves only words like "here"/"Link". Reading the HTML recovers the real URLs.
 */
function bodyWithLinks_(msg) {
  let html = msg.getBody() || '';
  // Turn <a href="URL">TEXT</a> into "TEXT (URL)", skipping noise links.
  html = html.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    function (_, href, inner) {
      if (/^mailto:|^tel:|groups\.google\.com|unsubscribe|optout/i.test(href)) {
        return inner.replace(/<[^>]+>/g, ' ');   // drop the URL, keep the words
      }
      const t = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
      return t + ' (' + href + ')';               // parentheses survive tag-stripping
    });
  // Strip remaining markup into readable lines.
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(0, 4000);
}

/** MAIN — run this for backlog, and set it as the trigger target for ongoing capture. */
function syncOpportunities() {
  // Fail loudly if LLM is on but no key — prevents silent regex fallback.
  if (USE_LLM && !getKey_()) {
    throw new Error('USE_LLM is true but no API key found. Add "' + KEY_PROPERTY +
      '" under Project Settings -> Script Properties, or set USE_LLM = false.');
  }
  const sheet = getSheet_();
  const existingIds = getExistingIds_(sheet);
  const label = GmailApp.getUserLabelByName(LABEL_NAME);
  if (!label) throw new Error('Label "' + LABEL_NAME + '" not found. Create it and label some mail first.');

  const threads = label.getThreads();
  const startTime = Date.now();
  const TIME_BUDGET_MS = 5 * 60 * 1000; // bail before Apps Script's 6-min hard limit
  let processed = 0, added = 0, done = true;

  outer:
  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const id = msg.getId();
      if (existingIds.has(id)) continue;

      // Stop cleanly if we hit the per-run cap or run low on time; the next run resumes.
      if (processed >= MAX_PER_RUN || Date.now() - startTime > TIME_BUDGET_MS) {
        done = false;
        break outer;
      }

      existingIds.add(id);
      processed++;

      const base = {
        date: msg.getDate(),
        sender: msg.getFrom(),
        subject: msg.getSubject(),
        body: bodyWithLinks_(msg),   // HTML→text, keeps JD/apply URLs inline
        gmailLink: 'https://mail.google.com/mail/u/1/#inbox/' + thread.getId(),
        messageId: id
      };

      const parsed = USE_LLM ? parseWithLLM_(base) : parseWithRules_(base);

      // Append this row immediately so a timeout never loses processed work.
      sheet.appendRow([
        base.date, parsed.category, parsed.company, parsed.role, parsed.type,
        parsed.compensation, parsed.location, parsed.deadline, parsed.eligibility,
        parsed.summary, parsed.link, parsed.jdLink, base.gmailLink, id
      ]);
      added++;

      // Groq's free tier caps tokens/minute; pace proactively to avoid 429 walls.
      if (USE_LLM && PROVIDER === 'groq') Utilities.sleep(12000);
    }
  }

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd');
  }
  Logger.log('Added %s new rows this run. Backlog cleared: %s', added, done);
  if (!done) Logger.log('More remain — re-run syncOpportunities (or let the hourly trigger continue).');
}

/** Rule-based fallback parser (no API needed). Used only if LLM is off or fails. */
function parseWithRules_(m) {
  const subj = m.subject;
  const text = subj + '\n' + m.body;
  const category = /\bhackathon\b/i.test(text) ? 'Hackathon'
                 : /\b(webinar|workshop|session|talk|info ?session)\b/i.test(text) ? 'Event'
                 : /\bintern(ship)?\b/i.test(text) ? 'Internship'
                 : /\b(job|hiring|recruit|placement|opportunity)\b/i.test(text) ? 'Job'
                 : 'Other';
  const type = /\bintern(ship)?\b/i.test(text) ? 'Internship'
             : /\b(research|phd|fellow)/i.test(text) ? 'Research'
             : 'Full-time';
  // Company from subject patterns: "at <Co>", "| ... at <Co> |", or "– <Co> –". NOT from the IIC domain.
  const co = (subj.match(/\bat\s+([A-Z][\w&.\- ]+?)(?:\s*[|\-–]|$)/) ||
              subj.match(/[|\-–]\s*([A-Z][\w&.\- ]+?)[.\-–]/) || [])[1] || '';
  // Links are inlined as "label ... (URL)". Separate JD from apply/form.
  const jdMatch = text.match(/(?:job description|jd|detailed)\b[^(\n]*\(([^)]+)\)/i);
  const applyMatch = text.match(/(?:application form|apply here|apply|registration)\b[^(\n]*\(([^)]+)\)/i);
  const firstLink = (text.match(/https?:\/\/[^\s)>\]]+/) || [''])[0];
  const dl = text.match(/(?:deadline|apply by|last date|closes?(?: on)?|by)\s*[:\-]?\s*([A-Za-z0-9 ,\/\.]+?\d{1,4}(?:\s?(?:AM|PM|IST))?)/i);
  return {
    category: category,
    company: co.trim(),
    role: subj,
    type: type,
    compensation: (text.match(/(?:stipend|ctc|salary|package)[:\s]*([^\n]{0,40})/i) || ['',''])[1].trim(),
    location: (text.match(/\b(remote|hybrid|on-?site|[A-Z][a-z]+,\s?[A-Z]{2})\b/) || [''])[0],
    deadline: dl ? dl[1].trim() : '',
    eligibility: (text.match(/eligibilit(?:y|ies)[:\s]*([^\n]{0,80})/i) || ['',''])[1].trim(),
    summary: subj.slice(0, 120),
    link: applyMatch ? applyMatch[1].trim() : firstLink,
    jdLink: jdMatch ? jdMatch[1].trim() : ''
  };
}

const VALID_CATEGORIES = ['Job', 'Internship', 'Hackathon', 'Event', 'Other'];

const SYSTEM_PROMPT =
  'You triage a university career-cell email into ONE JSON object. ' +
  'Output ONLY JSON — no prose, no markdown fences. Use "" for any field not present. ' +
  'Schema (all keys required, in this order):\n' +
  '{"category": one of Job|Internship|Hackathon|Event|Other, ' +
  '"company": hiring company/organizer (NEVER the mailing list or IITM/study.iitm — the actual employer), ' +
  '"role": job/internship title or event name, ' +
  '"type": Internship|Full-time|Research|"" , ' +
  '"compensation": stipend/CTC/salary if stated, ' +
  '"location": city / Remote / Hybrid, ' +
  '"deadline": application deadline exactly as written e.g. "30 June 2026, 8 PM IST", ' +
  '"eligibility": who can apply (degree/branch/experience), ' +
  '"summary": ONE sentence, max 20 words, ' +
  '"link": the application/registration form URL (labelled Application Form / Apply here), ' +
  '"jd_link": the detailed Job Description URL (labelled JD / Job Description / Detailed JD). ' +
  'Pick the correct URL from those inlined in the body as "text (URL)". If a JD link is absent, use "".}\n' +
  'Category rules: Job/Internship = a real paid role to apply for. Hackathon = coding competition. ' +
  'Event = webinar/workshop/info-session. Other = reminders, results, generic notices.';

/** Provider-aware LLM parser. Validates schema, retries on error, backs off on rate limits. */
function parseWithLLM_(m) {
  const key = getKey_();
  if (!key) return parseWithRules_(m);
  const userMsg = 'Subject: ' + m.subject + '\n\nBody:\n' + m.body;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = (PROVIDER === 'groq')
        ? callGroq_(key, userMsg)
        : callAnthropic_(key, userMsg);

      // Rate limited: back off and retry (Groq's free tier caps tokens/minute).
      if (resp.getResponseCode() === 429) {
        Logger.log('Rate limited (429), backing off ' + ((attempt + 1) * 20) + 's...');
        Utilities.sleep((attempt + 1) * 20000);
        continue;
      }

      const data = JSON.parse(resp.getContentText());
      if (data.error) { Logger.log('API error: ' + JSON.stringify(data.error)); Utilities.sleep(2000); continue; }

      const raw = (PROVIDER === 'groq') ? groqText_(data) : anthropicText_(data);
      const p = JSON.parse(raw);

      if (VALID_CATEGORIES.indexOf(p.category) === -1) { Logger.log('Bad category, retrying.'); continue; }

      return {
        category:     p.category,
        company:      str_(p.company),
        role:         str_(p.role) || m.subject,
        type:         str_(p.type),
        compensation: str_(p.compensation),
        location:     str_(p.location),
        deadline:     str_(p.deadline),
        eligibility:  str_(p.eligibility),
        summary:      str_(p.summary) || m.subject.slice(0, 120),
        link:         str_(p.link),
        jdLink:       str_(p.jd_link)
      };
    } catch (e) {
      Logger.log('LLM parse attempt ' + (attempt + 1) + ' failed: ' + e);
    }
  }
  Logger.log('LLM failed, falling back to rules for: ' + m.subject);
  return parseWithRules_(m);
}

/** Groq call — OpenAI-compatible chat completions with JSON mode. */
function callGroq_(key, userMsg) {
  return UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },   // forces valid JSON
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg }
      ]
    }),
    muteHttpExceptions: true
  });
}

/** Anthropic call — Messages API with assistant prefill to force JSON. */
function callAnthropic_(key, userMsg) {
  return UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: userMsg },
        { role: 'assistant', content: '{' }
      ]
    }),
    muteHttpExceptions: true
  });
}

function groqText_(data) {
  return (data.choices && data.choices[0] && data.choices[0].message.content || '').trim();
}
function anthropicText_(data) {
  let raw = (data.content || []).map(c => c.text || '').join('').trim();
  return raw.startsWith('{') ? raw : '{' + raw;   // undo the prefill
}

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

// ---------- helpers ----------
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getExistingIds_(sheet) {
  const last = sheet.getLastRow();
  const ids = new Set();
  if (last < 2) return ids;
  const col = HEADERS.indexOf('MessageID') + 1;
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(r => r[0] && ids.add(r[0]));
  return ids;
}

/** Run to wipe everything and rewrite the new-schema header, so the backlog reprocesses cleanly. */
function resetSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('No sheet to reset.'); return; }
  sheet.clear();
  sheet.appendRow(HEADERS);
  sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e8eaed');
  sheet.setFrozenRows(1);
  Logger.log('Sheet reset with new schema. Re-run syncOpportunities to rebuild.');
}

/** Run ONCE to install an hourly auto-capture trigger. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncOpportunities') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncOpportunities').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed.');
}
