# Document Metadata Research

> Research into extractable metadata from court decision documents.
> Goal: enrich Vectorize chunk headers and metadata for better search quality.

## Current State

Each chunk in Vectorize has this metadata:

```
doc_id, court, year, title, chunk_index, court_level, subcourt
```

Chunks are embedded as **raw text** — no contextual header, no jurisdiction info.

---

## Extractable Metadata (by source)

### 1. ΔΙΚΑΙΟΔΟΣΙΑ (Jurisdiction) — from document body

A structured field that appears after `**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**` in many documents.
Extractable with regex. Contains the **type of dispute or jurisdiction**.

#### Coverage by court

| Court | Total docs | With ΔΙΚΑΙΟΔΟΣΙΑ | Coverage |
|-------|-----------|-------------------|----------|
| Εφετείο (Appeal) | 1,111 | 1,106 | 99.5% |
| Οικογενειακό (Family) | 1,389 | 832 | 60% |
| Ανώτατο/aad (Old Supreme) | 45,015 | 22,830 | 50.7% |
| Πολιτικό/pol (Civil) | 23,839 | 283 | 1.2% |

#### Values by court type

**Family Court (oik) — dispute type:**

| Value | Translation | Count |
|-------|-------------|-------|
| ΔΙΑΤΡΟΦΗΣ | Alimony/maintenance | ~325 |
| ΓΟΝΙΚΗΣ ΜΕΡΙΜΝΑΣ | Custody / parental care | ~224 |
| ΠΕΡΙΟΥΣΙΑΚΩΝ ΔΙΑΦΟΡΩΝ | Property dispute | ~91 |
| ΧΡΗΣΗΣ ΟΙΚΟΓΕΝΕΙΑΚΗΣ ΣΤΕΓΗΣ | Use of family home | ~23 |
| ΑΠΟΚΛΕΙΣΤΙΚΗΣ ΧΡΗΣΗΣ | Exclusive use (of home) | ~16 |
| ΛΥΣΗΣ ΓΑΜΟΥ / ΔΙΑΖΥΓΙΟΥ | Divorce | ~15 |
| ΔΙΑΤΡΟΦΗΣ ΤΕΚΝΩΝ | Child maintenance | ~11 |
| ΠΑΤΡΙΚΗΣ ΑΝΑΓΝΩΡΙΣΗΣ | Paternity recognition | ~10 |
| ΥΙΟΘΕΣΙΑΣ | Adoption | ~3 |
| ΓΑΜΙΚΩΝ ΔΙΑΦΟΡΩΝ | Marital disputes | ~3 |
| ΓΕΝΙΚΩΝ ΑΙΤΗΣΕΩΝ | General applications | ~8 |

**Court of Appeal — jurisdiction type:**

| Value | Translation | Count |
|-------|-------------|-------|
| ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ | Civil jurisdiction | ~590 |
| ΠΟΙΝΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ | Criminal jurisdiction | ~280 |
| ΑΝΑΘΕΩΡΗΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ | Review jurisdiction | ~187 |

Note: appears with various prefixes (`ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ -`, `ΕΦΕΤΕΙΟ -`, etc.) and formatting inconsistencies (`‑` vs `-`, extra spaces, `****`). Needs normalization.

**Old Supreme Court (aad) — jurisdiction level:**

| Value | Translation | Count |
|-------|-------------|-------|
| ΔΕΥΤΕΡΟΒΑΘΜΙΑ | Appellate (2nd instance) | ~7,230 |
| ΑΝΑΘΕΩΡΗΤΙΚΗ | Review | ~3,810 |
| ΠΡΩΤΟΒΑΘΜΙΑ | Original (1st instance) | ~1,826 |
| ΝΑΥΤΟΔΙΚΕΙΟΥ | Admiralty | ~154 |

**Civil Court (pol) — specialized jurisdictions (rare):**

| Value | Translation | Count |
|-------|-------------|-------|
| ΠΤΩΧΕΥΣΕΩΝ | Bankruptcy | 57 |
| ΕΠΙΚΥΡΩΣΗΣ ΔΙΑΘΗΚΩΝ | Probate / will validation | ~33 |
| ΑΦΕΡΕΓΓΥΟΤΗΤΑΣ | Insolvency | 19 |
| ΔΙΑΧΕΙΡΙΣΕΩΝ | Estate administration | ~17 |
| ΝΑΥΤΟΔΙΚΕΙΟΥ | Admiralty | 4 |

#### Extraction method

Regex on the first ~30 lines after `**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**`. Look for a line containing `ΔΙΚΑΙΟΔΟΣΙΑ`. Strip markdown formatting (`*`, `#`, extra spaces).

```python
# Pseudocode
after_keimeno = text.split("ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ")[1] if "ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ" in text else ""
for line in after_keimeno.split("\n")[:30]:
    cleaned = re.sub(r'[*#]', '', line).strip()
    if "ΔΙΚΑΙΟΔΟΣΙΑ" in cleaned:
        jurisdiction = cleaned
        break
```

Normalization needed:
- Strip court name prefix: `ΕΦΕΤΕΙΟ ΚΥΠΡΟΥ - ΠΟΛΙΤΙΚΗ ΔΙΚΑΙΟΔΟΣΙΑ` → `ΠΟΛΙΤΙΚΗ`
- Remove markdown artifacts: `****`, `######`, etc.
- Normalize dashes: `‑` (U+2011) → `-`
- Collapse whitespace

---

### 2. Proceeding Type — from file path and filename

**100% coverage** — derived from directory structure.

#### First Instance subcourts (apofaseised)

| Path segment | Proceeding type | Greek label |
|-------------|----------------|-------------|
| `apofaseised/pol/` | Civil | Πολιτική |
| `apofaseised/poin/` | Criminal | Ποινική |
| `apofaseised/oik/` | Family | Οικογενειακή |
| `apofaseised/enoik/` | Rent/tenancy | Ενοικιαστική |
| `apofaseised/erg/` | Labour | Εργατική |

#### Old Supreme Court meros (aad)

| Path segment | Proceeding type | Greek label |
|-------------|----------------|-------------|
| `meros_1/` | Criminal | Ποινική |
| `meros_2/` | Civil | Πολιτική |
| `meros_3/` | Labour / Land | Εργατική / Κτηματική |
| `meros_4/` | Administrative | Διοικητική |

#### Appeal type (from filename patterns)

| Filename pattern | Meaning | Greek |
|-----------------|---------|-------|
| `*PolEf*` | Civil Appeal | Πολιτική Έφεση |
| `*PoinEf*` or `*Poin*` | Criminal Appeal | Ποινική Έφεση |
| `*PolAit*` | Civil Application | Πολιτική Αίτηση |
| `*EDDait*` | Appeal vs Administrative Court | Έφεση κ. Διοικ. Δικαστηρίου |

#### Court type (from path, 100% coverage)

| Court path | Implied type |
|-----------|-------------|
| `administrative/`, `administrativeIP/` | Administrative |
| `courtOfAppeal/` | Appeal |
| `supreme/`, `supremeAdministrative/` | Supreme |
| `areiospagos/` | Foreign (Greek) |

---

### 3. ECLI Numbers

Format: `ECLI:CY:{COURT_CODE}:{YEAR}:{LETTER}{NUMBER}`

| Letter | Meaning |
|--------|---------|
| A | Civil cases |
| B | Criminal cases |
| C | Mixed / other |
| D | Applications / miscellaneous |

Court codes observed: `AD` (Ανώτατο), `ODLAR` (Οικ. Δικ. Λάρνακας), `DEDLEF` (Δικ. Εργ. Διαφ. Λεμεσού), `DEELEM` (Δικ. Εργ. Διαφ. Λεμεσού), `DDDP` (Διοικ. Δικ. Διεθν. Προστασίας), `ODTHO` (Οικ. Δικ. Θρησκευτικών Ομάδων), etc.

Extraction: regex `ECLI:CY:\w+:\d{4}:\w+` from the first ~20 lines after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ.

Not high priority for chunk headers (court and year already in metadata), but the letter code (A/B/D) can confirm civil vs criminal classification.

---

### 4. Case Number Format

The case number format itself indicates the proceeding type:

| Pattern | Meaning |
|---------|---------|
| `Αρ. Αγ.` / `Αρ. Αγωγής` | Lawsuit (civil action) |
| `Αρ. Αίτησης` | Application (family/labour/rent) |
| `Αρ. Υπόθεσης` | Case (criminal/administrative) |
| `Πολιτική Έφεση Αρ.` | Civil appeal |
| `Ποινική Έφεση Αρ.` | Criminal appeal |
| `Αίτηση Διαζυγίου Αρ.` | Divorce application |
| `Αίτηση Πτώχευσης` | Bankruptcy application |

---

### 5. Court Name with Location

Extractable from the body (after ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ):

| Pattern | Example |
|---------|---------|
| `ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ {CITY}` | ΕΠΑΡΧΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ ΛΕΥΚΩΣΙΑΣ |
| `ΟΙΚΟΓΕΝΕΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ {CITY}` | ΟΙΚΟΓΕΝΕΙΑΚΟ ΔΙΚΑΣΤΗΡΙΟ ΛΑΡΝΑΚΑΣ |
| `ΔΙΚΑΣΤΗΡΙΟ ΕΡΓΑΤΙΚΩΝ ΔΙΑΦΟΡΩΝ {CITY}` | ΔΙΚΑΣΤΗΡΙΟ ΕΡΓΑΤΙΚΩΝ ΔΙΑΦΟΡΩΝ ΛΕΜΕΣΟΣ |
| `ΔΙΚΑΣΤΗΡΙΟ ΕΛΕΓΧΟΥ ΕΝΟΙΚΙΑΣΕΩΝ {CITY}` | ΔΙΚΑΣΤΗΡΙΟ ΕΛΕΓΧΟΥ ΕΝΟΙΚΙΑΣΕΩΝ ΛΕΜΕΣΟΥ |
| `ΜΟΝΙΜΟ ΚΑΚΟΥΡΓΙΟΔΙΚΕΙΟ {CITY}` | ΜΟΝΙΜΟ ΚΑΚΟΥΡΓΙΟΔΙΚΕΙΟ ΛΕΥΚΩΣΙΑΣ |

Cities: ΛΕΥΚΩΣΙΑΣ (Nicosia), ΛΕΜΕΣΟΥ (Limassol), ΛΑΡΝΑΚΑΣ (Larnaca), ΠΑΦΟΥ (Paphos), ΑΜΜΟΧΩΣΤΟΥ (Famagusta).

Not high priority for chunk headers — court is already known from metadata. But could be useful for geographic filtering in the future.

---

## Document Structure (canonical)

```markdown
# {Case Title with parties, case number, date}

**ΑΝΑΦΟΡΕΣ:**                              ← NOISE (cross-references)
**Κυπριακή νομολογία...**
[Case A](/path/a.md)
[Case B](/path/b.md)
**Κυπριακή νομοθεσία...**
[Law X](/path/x.html)
**Θεσμοί Πολιτικής Δικονομίας...**

**ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ:**                      ← DECISION TEXT STARTS

ECLI:CY:AD:2024:A123                       ← ECLI (when present)

**{COURT NAME WITH CITY}**                 ← Court name
**{ΔΙΚΑΙΟΔΟΣΙΑ TYPE}**                     ← Jurisdiction (when present)
**Ενώπιον:** {Judge name}                  ← Judge
**Αρ. {case type}: {number}**              ← Case number

Μεταξύ:                                    ← Parties
{Plaintiff}
{Role: Ενάγουσα / Αιτήτρια / Κατηγορία}
-και-
{Defendant}
{Role: Εναγόμενος / Καθ' ων η Αίτηση / Κατηγορούμενος}

Εμφανίσεις:                                ← Lawyers
Για {Party}: {Lawyer name}

***ΑΠΟΦΑΣΗ***                              ← Decision

{Decision text with sections like:}
***Εισαγωγικά***
***Μαρτυρία***
***Νομική Πτυχή***
***Αξιολόγηση - Ευρήματα***
```

Note: not all documents follow this structure exactly. Older documents and some courts have variations. The ΑΝΑΦΟΡΕΣ section is sometimes absent. The ΚΕΙΜΕΝΟ ΑΠΟΦΑΣΗΣ marker is present in most but not all documents.

---

## Recommended Extraction for Chunk Headers

### Priority fields (for contextual embedding header)

| Field | Source | Coverage | Impact |
|-------|--------|----------|--------|
| Court display name | path mapping | 100% | High |
| Year | path | 100% | High |
| Title | first `# ` heading | ~100% | High |
| Proceeding type | path (subcourt/meros) | 100% for 1st instance | High |
| Jurisdiction / dispute type | ΔΙΚΑΙΟΔΟΣΙΑ regex | ~50% overall, 99% appeals | High |

### Proposed header format

**With jurisdiction (when available):**
```
Δικαστήριο: Εφετείο Κύπρου | Δικαιοδοσία: Ποινική | Έτος: 2024 | Title
```

**Without jurisdiction (fallback to proceeding type from path):**
```
Δικαστήριο: Επαρχιακό Δικαστήριο | Κλάδος: Πολιτική | Έτος: 2013 | Title
```

**Family court with dispute type:**
```
Δικαστήριο: Οικογενειακό Δικαστήριο | Δικαιοδοσία: Γονική Μέριμνα | Έτος: 2023 | Title
```

### Proposed new metadata field

Add `jurisdiction` to Vectorize metadata:
- Extracted from ΔΙΚΑΙΟΔΟΣΙΑ when available
- Fallback: proceeding type from path/subcourt
- Normalized to canonical values (e.g., `ΠΟΛΙΤΙΚΗ`, `ΠΟΙΝΙΚΗ`, `ΓΟΝΙΚΗΣ_ΜΕΡΙΜΝΑΣ`, etc.)
- Create metadata index for filtering

---

## Low-Priority Fields (not for current re-embedding)

| Field | Feasibility | Notes |
|-------|-------------|-------|
| Previous court instance | Hard — in body text | Requires NLP, not structured |
| Specific legal topic | Very hard | Requires LLM classification |
| Judge names | Medium — after "Ενώπιον:" | Not useful for search |
| Lawyer names | Medium — in "Εμφανίσεις:" | Not useful for search |
| City/location | Medium — in court name | Useful for future geo-filter |
