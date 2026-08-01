/**
 * Redaction - Strip credentials from text before it is written to memory.
 *
 * The memory store is shared across every project on one machine, so a token
 * captured during work on one repository would otherwise sit in a file that
 * every other project's sessions read at session start. Per-project stores
 * would have contained that; this design does not, so redaction runs on the
 * write path -- inside the capture tool, before anything reaches disk.
 *
 * Two passes: known credential shapes first, then a high-entropy fallback for
 * what the patterns miss.
 *
 * This is a mitigation, not a guarantee. Pattern matching cannot catch a secret
 * written out in prose ("the password is hunter2"), and the entropy pass is
 * deliberately conservative -- see the false-positive notes below.
 *
 * @module Redaction
 */

export interface Redaction {
  readonly kind: string;
}

export interface RedactionResult {
  readonly text: string;
  readonly redactions: ReadonlyArray<Redaction>;
}

interface CredentialPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

/**
 * Known credential shapes. Ordered longest/most-specific first so a PEM block
 * is not partially eaten by a narrower rule.
 */
const CREDENTIAL_PATTERNS: ReadonlyArray<CredentialPattern> = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { kind: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack-token", pattern: /\bxox[abporsu]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    // key=value / key: value where the key names a credential. The value stops
    // at whitespace, quotes, or a comma so surrounding prose survives.
    kind: "credential-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|apikey|api_key|access_key|private_key)[A-Za-z0-9_.-]*)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi,
  },
];

const REDACTED = (kind: string) => `[redacted:${kind}]`;

/**
 * Shannon entropy in bits per character. Random credentials sit high; English
 * text, hex digests, and dotted identifiers sit lower.
 */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Minimum length before a bare token is even considered for the entropy pass. */
const ENTROPY_MIN_LENGTH = 28;

/** Bits per character above which a long unbroken token looks generated. */
const ENTROPY_THRESHOLD = 4.0;

/**
 * Shapes that are long, dense, and completely benign. Redacting these is worse
 * than missing a secret: a redactor that mangles commit hashes and UUIDs gets
 * switched off, and then it protects nothing at all.
 */
const ENTROPY_ALLOWLIST: ReadonlyArray<RegExp> = [
  /^[0-9a-f]{7,64}$/i, // git SHAs, checksums, hex digests
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[\w.-]+@[\w.-]+\.\w+$/, // email address
  /^(?:https?|file|git|ssh):\/\/\S+$/i, // URL
  // Filesystem paths. Deliberately keyed on the separator rather than the
  // character class: an earlier version allowed anything matching [\w./-]+,
  // which is also the shape of most base64 secrets, so every generated token
  // slipped through untouched. Standard base64 also contains "/", so tokens
  // carrying "+" or "=" are excluded here and left to the entropy check.
  /^[^+=]*\/[^+=]*$/,
  // Lowercase dotted/kebab/snake identifiers (orchestration.turn.quiesced,
  // some-feature-flag, 1.3.0-beta.10). Requiring lowercase keeps mixed-case
  // generated tokens out.
  /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/,
];

function looksGenerated(token: string): boolean {
  if (token.length < ENTROPY_MIN_LENGTH) {
    return false;
  }
  if (ENTROPY_ALLOWLIST.some((allowed) => allowed.test(token))) {
    return false;
  }
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

/**
 * Redact credentials from `text`, returning the cleaned text and what was
 * removed. Markers are visible on purpose: a note that reads oddly should show
 * that something was taken out rather than silently losing meaning.
 */
export function redactSecrets(text: string): RedactionResult {
  const redactions: Array<Redaction> = [];
  let result = text;

  for (const { kind, pattern } of CREDENTIAL_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, pattern.flags), (...args) => {
      redactions.push({ kind });
      // The assignment rule keeps its key so the note still says *what* was
      // configured, only not to what value.
      if (kind === "credential-assignment") {
        const key = args[1] as string;
        return `${key}=${REDACTED(kind)}`;
      }
      return REDACTED(kind);
    });
  }

  // Entropy pass over whatever survived, token by token so surrounding prose is
  // untouched.
  result = result.replace(/\S+/g, (token) => {
    if (token.includes("[redacted:")) {
      return token;
    }
    if (!looksGenerated(token)) {
      return token;
    }
    redactions.push({ kind: "high-entropy" });
    return REDACTED("high-entropy");
  });

  return { text: result, redactions };
}
