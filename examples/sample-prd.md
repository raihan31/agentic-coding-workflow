# PRD: Text Toolkit v1

| | |
|---|---|
| Owner | Platform team |
| Status | Approved for build |
| Target | Existing TypeScript library in this repository |

## 1. Background

Several services re-implement small text helpers with inconsistent behaviour (different slug rules, truncation that cuts words in half). We want one tested, dependency-free implementation in this library.

## 2. Goals

- One canonical implementation of common text helpers.
- Predictable behaviour documented by tests.

## 3. Functional requirements

### 3.1 Slugs (Must)
`slugify(input: string): string` returns a URL-safe slug: lowercase, outer whitespace trimmed, every run of characters other than ASCII letters and digits replaced by a single hyphen, no leading or trailing hyphens. An input with no ASCII letters or digits returns an empty string.

### 3.2 Truncation (Must)
`truncate(text: string, maxLength: number, ellipsis = "…"): string` shortens text to at most `maxLength` characters including the ellipsis, cutting at a word boundary where possible. Text already within the limit is returned unchanged. A `maxLength` smaller than the ellipsis length is an error.

### 3.3 Word count (Should)
`wordCount(text: string): number` counts words separated by whitespace. Empty or whitespace-only text has zero words.

### 3.4 Public entry point (Must)
All helpers are exported from a single module, `src/text/index.ts`.

## 4. Non-functional requirements

- No new runtime dependencies (Must).
- Pure functions with no I/O (Must).
- Every helper has unit tests using the repository's existing test setup (Must).

## 5. Out of scope

- Transliteration of non-ASCII characters (for example "ü" → "u") is deferred to v2.
- A command-line interface.

## 6. Open points

- Behaviour of `truncate` when the first word alone is longer than `maxLength` has not been decided.
