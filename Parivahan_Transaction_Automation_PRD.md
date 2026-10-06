# PRD — Parivahan Transaction Status Automation

## 1. Product Overview

### Product Name
Parivahan Transaction Automation

### Purpose
Automate the repetitive process of checking transaction/payment details on the Government of India Parivahan eTrans PGI Transaction Status website.

The current manual workflow requires the user to:
1. Open the Transaction Status page.
2. Select "Challan No./Application No.".
3. Enter an Application/Challan Number.
4. Complete CAPTCHA manually when required.
5. Click Search.
6. Read the resulting transaction table.
7. Manually copy/write the required information.

The product will automate steps 2, 3, 5, 6 and 7 while keeping CAPTCHA handling manual in the initial phase.

## 2. Problem Statement

Users who need to check many Application/Challan Numbers have to repeat the same search process for every number. This creates:
- Repetitive manual work
- Data-entry errors
- Slow processing
- Difficulty maintaining structured records
- Difficulty processing multiple application numbers

The goal is to convert this workflow into a reliable automated process.

## 3. Goals

### Primary Goals
- Automate the Parivahan transaction-status search process.
- Accept an Application/Challan Number as input.
- Automatically select the correct search option.
- Enter the number.
- Trigger the search.
- Detect and extract the resulting transaction row.
- Return structured data instead of requiring manual transcription.
- Build the automation in a way that can later support bulk processing.
- Eventually provide a mobile-friendly interface.

### Secondary Goals
- Export results to CSV/Excel.
- Store previous searches.
- Support bulk Application/Challan Numbers.
- Show successful, failed and not-found searches.
- Provide retry handling for temporary website failures.

## 4. Non-Goals — Phase 1

The first version will NOT:
- Automatically solve or bypass CAPTCHA.
- Attempt to defeat website security mechanisms.
- Automate CAPTCHA solving.
- Modify any Parivahan records.
- Submit payments.
- Perform any action other than transaction-status lookup.
- Depend on a mobile app installation.

CAPTCHA will remain a manual user step initially.

## 5. Target Users

### Primary User
A user who repeatedly checks Parivahan transaction/payment statuses and currently records the returned information manually.

### Usage Environment
- Desktop during development
- Mobile browser in later phases
- Potentially multiple searches per session

## 6. Current Manual Workflow

```text
Open Parivahan Transaction Status
        |
        v
Select "Challan No./Application No."
        |
        v
Enter Application/Challan Number
        |
        v
Complete CAPTCHA manually
        |
        v
Click Search
        |
        v
Read transaction table
        |
        v
Manually write/copy required fields
```

## 7. Proposed Workflow — Phase 1

```text
Start automation
        |
        v
Open Parivahan Transaction Status
        |
        v
Select "Challan No./Application No."
        |
        v
Enter Application/Challan Number
        |
        v
User completes CAPTCHA if required
        |
        v
Click Search
        |
        v
Wait for result
        |
        v
Detect result table
        |
        v
Extract required fields
        |
        v
Return structured JSON
```

## 8. Phase 1 MVP

### Input

Single Application/Challan Number.

Example:

```text
FNHR26107623401
```

### Processing

The automation should:
1. Launch/open the Parivahan Transaction Status page.
2. Select the "Challan No./Application No." radio option.
3. Locate the input field.
4. Enter the provided number.
5. Pause for manual CAPTCHA completion when CAPTCHA is presented.
6. Click Search.
7. Wait for the response/table.
8. Determine whether a result exists.
9. Extract the result row.
10. Return structured data.

### Expected Output

```json
{
  "applicationNo": "FNHR26107623401",
  "vehicleNo": "HR31V0031",
  "transactionNo": "HRZ2610026781486",
  "paymentId": "FNHR26107623401",
  "paymentDate": "2026-10-02 19:02:04.253",
  "paymentConfirmationDate": "2026-10-02 19:03:58.0",
  "paymentGateway": "IDBI",
  "bankRefNo": "11000385470159",
  "grn": "627513274420",
  "cin": "82",
  "status": "FOUND"
}
```

The exact fields should be confirmed from the live website DOM during implementation because table columns may change.

## 9. Result States

The automation must support at least:

### FOUND
A matching transaction row was returned.

### NOT_FOUND
The search completed but no matching transaction was returned.

### CAPTCHA_REQUIRED
The automation is waiting for the user to complete CAPTCHA.

### WEBSITE_ERROR
The website failed to load or returned an unexpected error.

### TIMEOUT
The expected result did not appear within the configured timeout.

### INVALID_INPUT
The supplied Application/Challan Number is empty or invalid.

## 10. Technical Architecture — Phase 1

### Recommended Stack

#### Automation
- Node.js
- Playwright

#### API
- Node.js
- Express.js or Fastify

#### Initial Interface
- CLI or simple local web page

#### Data
- JSON during MVP
- PostgreSQL/MongoDB in a later phase

### Architecture

```text
                User
                 |
                 v
       Local Web Interface / CLI
                 |
                 v
          Node.js API
                 |
                 v
            Playwright
                 |
                 v
      Parivahan Transaction Page
                 |
        +--------+--------+
        |                 |
     CAPTCHA           Search
     Manual               |
        |                 v
        +----------> Result Table
                          |
                          v
                   Data Extraction
                          |
                          v
                    JSON Response
```

## 11. Playwright Automation Design

The automation should use resilient selectors wherever possible.

Preferred selector priority:

1. Stable element IDs
2. Name attributes
3. Form labels
4. Accessible roles
5. CSS selectors
6. XPath only when necessary

Avoid relying only on:
- Element position
- Dynamic generated class names
- Exact visual coordinates

### Example Logical Flow

```javascript
await page.goto(TRANSACTION_STATUS_URL);

await selectChallanApplicationOption();

await page.fill(applicationInput, applicationNumber);

await waitForCaptchaIfRequired();

await page.click(searchButton);

await waitForTransactionResult();

const result = await extractTransactionRow();
```

The actual selectors must be discovered from the current live DOM rather than hardcoded from the screenshot.

## 12. CAPTCHA Handling

### Phase 1

CAPTCHA is explicitly manual.

The automation should detect that the search is waiting for CAPTCHA and pause.

Possible UX:

```text
Application Number:
FNHR26107623401

Status:
Waiting for CAPTCHA

[ CAPTCHA completed ]

Continue Search
```

Or, if Playwright is running in a visible browser:

```text
Browser opens
      ↓
Application number entered
      ↓
CAPTCHA appears
      ↓
User solves CAPTCHA
      ↓
Automation continues
```

### Future Phase

CAPTCHA behavior should only be changed if the website provides an officially supported mechanism. The product should not attempt to bypass or defeat CAPTCHA/security controls.

## 13. Data Extraction

The extractor should map website columns into normalized application fields.

Potential fields:

| Website Field | Internal Field |
|---|---|
| Vehicle No | vehicleNo |
| Application No | applicationNo |
| Transaction No/AUIN | transactionNo |
| Payment Id | paymentId |
| Payment Date | paymentDate |
| Payment Conf Date | paymentConfirmationDate |
| Payment Gateway | paymentGateway |
| Bank Ref.No | bankRefNo |
| GRN | grn |
| CIN | cin |
| Amount | amount |

Unknown/new columns should not break the entire extraction process.

## 14. Error Handling

The automation must handle:

### Network Errors
- Retry page load
- Configurable timeout

### Website Changes
- Log selector failures
- Return a clear extraction error

### Empty Result
Return:

```json
{
  "status": "NOT_FOUND",
  "applicationNo": "FNHR26107623401"
}
```

### Unexpected Table Structure

Return an error with enough diagnostic information for development without exposing sensitive information unnecessarily.

## 15. Logging

Development logs should record:

```text
[INFO] Starting search
[INFO] Application: FNHR26107623401
[INFO] Transaction page loaded
[INFO] Search type selected
[INFO] Application number entered
[INFO] Waiting for CAPTCHA
[INFO] CAPTCHA completed
[INFO] Search submitted
[INFO] Result found
[INFO] Transaction extracted
```

Production logs should avoid unnecessarily storing sensitive information.

## 16. Phase 2 — Bulk Processing

After the single-search MVP works reliably, support multiple numbers.

### Input

```text
FNHR26107623401
FNHR26107623402
FNHR26107623403
FNHR26107623404
```

Or CSV:

```csv
applicationNo
FNHR26107623401
FNHR26107623402
FNHR26107623403
```

### Processing

```text
Input List
    |
    v
Validate Numbers
    |
    v
Search Number 1
    |
    v
Extract Result
    |
    v
Search Number 2
    |
    v
Extract Result
    |
    v
...
    |
    v
Generate Results
```

The implementation should respect reasonable delays and website limitations rather than generating excessive requests.

### MVP Bulk Processing and Exports

The local API accepts a CSV upload in the `file` multipart field or a JSON request containing an `applicationNos` array:

```http
POST /api/transaction/bulk?format=xlsx
```

Supported `format` values are `json`, `csv`, and `xlsx`. CSV and XLSX formats are returned as downloadable files; JSON returns `{ "results": [...] }`. CSV input may include an `applicationNo`/`challanNo` header or contain one number per row. Each row is processed sequentially with a delay between searches, and an upload may contain up to 100 numbers. Invalid rows are included in the output with an `INVALID_INPUT` status rather than stopping the whole batch.

For command-line processing:

```text
npm run bulk -- input.csv --format xlsx --output results.xlsx
```

## 17. Phase 3 — Mobile Web Application

The user should eventually be able to perform the automation from a phone.

### Mobile UX

```text
--------------------------------
 Parivahan Automation
--------------------------------

Application / Challan Number

[ FNHR26107623401        ]

          [ Search ]

--------------------------------

Status: Found

Vehicle No:
HR31V0031

Transaction No:
HRZ2610026781486

Payment ID:
FNHR26107623401

Payment Date:
2026-10-02

Bank Ref:
11000385470159

GRN:
627513274420

       [ Copy ]

--------------------------------
```

Recommended implementation:
- React
- Responsive UI
- PWA
- Node.js backend
- Playwright worker

## 18. Phase 4 — Bulk Mobile Processing

Mobile user can paste many application numbers:

```text
FNHR26107623401
FNHR26107623402
FNHR26107623403
FNHR26107623404
```

The UI displays:

```text
Processing: 3 / 4

FNHR26107623401   FOUND
FNHR26107623402   FOUND
FNHR26107623403   NOT FOUND
FNHR26107623404   PROCESSING
```

Then:

```text
[ Export CSV ]
[ Export Excel ]
[ Copy All ]
```

## 19. Data Storage

### MVP
No persistent database required.

Use in-memory/JSON output.

### Later

PostgreSQL schema example:

```text
transaction_searches
---------------------
id
application_no
vehicle_no
transaction_no
payment_id
payment_date
payment_confirmation_date
payment_gateway
bank_ref_no
grn
cin
amount
status
created_at
updated_at
```

## 20. Security & Privacy

The application should:
- Use HTTPS in production.
- Avoid exposing internal automation endpoints publicly.
- Validate user input.
- Rate-limit API requests.
- Avoid logging unnecessary personal/payment information.
- Never store CAPTCHA answers.
- Never store browser credentials unless explicitly required.
- Keep automation credentials/secrets in environment variables.
- Restrict access to the automation API.

## 21. Performance Requirements

For a single search:

- Page load: target < 10 seconds under normal conditions.
- Result extraction: target < 5 seconds after search response.
- Total automated processing excluding manual CAPTCHA: target < 20 seconds.

These are targets, not guarantees, because the government website's performance is outside our control.

## 22. Reliability Requirements

The automation should:
- Detect page-load failures.
- Retry transient failures.
- Detect changed page structure.
- Provide meaningful errors.
- Never silently return incorrect data.
- Preserve the original Application/Challan Number with every result.

## 23. MVP Acceptance Criteria

Phase 1 is complete when:

- [ ] Application/Challan number can be provided.
- [ ] Parivahan transaction page opens.
- [ ] "Challan No./Application No." is selected automatically.
- [ ] Number is entered automatically.
- [ ] CAPTCHA can be completed manually.
- [ ] Search is triggered.
- [ ] Result table is detected.
- [ ] Required fields are extracted.
- [ ] Structured JSON result is generated.
- [ ] NOT_FOUND is correctly detected.
- [ ] Timeout/error states are handled.
- [ ] No CAPTCHA bypass is implemented.
- [ ] Automation can be demonstrated reliably with multiple test numbers.

## 24. Development Milestones

### Milestone 1 — Website Inspection
- Inspect live DOM.
- Identify stable selectors.
- Identify CAPTCHA behavior.
- Identify result-table structure.

### Milestone 2 — Playwright POC
Build:

```text
Node.js
   +
Playwright
   +
Single Application Number
```

Output extracted JSON.

### Milestone 3 — Error Handling
Add:
- Timeout handling
- NOT_FOUND detection
- Website errors
- Logging

### Milestone 4 — API
Create:

```http
POST /api/transaction/search
```

Request:

```json
{
  "applicationNo": "FNHR26107623401"
}
```

Response:

```json
{
  "status": "FOUND",
  "data": {
    "applicationNo": "FNHR26107623401",
    "vehicleNo": "HR31V0031"
  }
}
```

### Milestone 5 — Mobile UI
Build responsive React/PWA interface.

### Milestone 6 — Bulk Search
Add multiple-number input and CSV/Excel export.

### Milestone 7 — Persistence
Add PostgreSQL if historical records are required.

## 25. Future Enhancements

Possible future features:

- Bulk CSV upload
- Excel export
- Search history
- Search scheduling
- Automatic retry
- Dashboard
- Result filtering
- Duplicate detection
- Status notifications
- Multiple users
- Authentication
- Audit logs
- Background job queue using BullMQ/Redis

## 26. Final Product Vision

The final product should reduce this:

```text
Select
↓
Type
↓
CAPTCHA
↓
Search
↓
Read
↓
Write
↓
Repeat
↓
Repeat
↓
Repeat
```

to:

```text
Paste Application Numbers
        ↓
Complete CAPTCHA when required
        ↓
Start Processing
        ↓
Automation searches
        ↓
Results automatically extracted
        ↓
Download / Copy structured data
```

## 27. Recommended Implementation Order

Do NOT start with the mobile application.

Start with:

```text
STEP 1
Inspect website DOM
        ↓
STEP 2
Build Playwright script
        ↓
STEP 3
Make ONE search work
        ↓
STEP 4
Extract complete table row
        ↓
STEP 5
Handle CAPTCHA manually
        ↓
STEP 6
Add error handling
        ↓
STEP 7
Convert to API
        ↓
STEP 8
Build mobile UI
        ↓
STEP 9
Add bulk processing
        ↓
STEP 10
Add Excel/CSV export
```

This keeps the project low-risk and lets us validate the most important part — reliable interaction with the Parivahan website — before building the rest of the system.
