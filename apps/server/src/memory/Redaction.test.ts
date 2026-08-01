import { describe, expect, it } from "vite-plus/test";

import { redactSecrets } from "./Redaction.ts";

// Every credential below is deliberately fake. Never put a real-looking one in
// a test fixture: secret scanners flag them and the resulting incident paperwork
// is real even when the token is not.
const FAKE = {
  githubToken: `ghp_${"x".repeat(36)}`,
  githubPat: `github_pat_${"y".repeat(30)}`,
  awsKeyId: "AKIAIOSFODNN7EXAMPLE",
  slackToken: `xoxb-${"1".repeat(12)}-${"2".repeat(12)}`,
  jwt: `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(20)}.${"b".repeat(20)}`,
  privateKey: [
    "-----BEGIN RSA PRIVATE KEY-----",
    "z".repeat(40),
    "-----END RSA PRIVATE KEY-----",
  ].join("\n"),
};

const kinds = (text: string) => redactSecrets(text).redactions.map((redaction) => redaction.kind);

describe("known credential shapes", () => {
  it.each([
    ["github-token", FAKE.githubToken],
    ["github-pat", FAKE.githubPat],
    ["aws-access-key-id", FAKE.awsKeyId],
    ["slack-token", FAKE.slackToken],
    ["jwt", FAKE.jwt],
    ["private-key", FAKE.privateKey],
  ])("redacts a %s", (kind, secret) => {
    const { text, redactions } = redactSecrets(`before ${secret} after`);
    expect(text).not.toContain(secret);
    expect(text).toContain(`[redacted:${kind}]`);
    expect(redactions.some((redaction) => redaction.kind === kind)).toBe(true);
    // Surrounding prose must survive intact.
    expect(text.startsWith("before ")).toBe(true);
    expect(text.endsWith(" after")).toBe(true);
  });

  it("redacts a credential assignment but keeps the key name", () => {
    const { text } = redactSecrets("Set GITHUB_TOKEN=supersecretvalue123 in the env.");
    expect(text).not.toContain("supersecretvalue123");
    expect(text).toContain("GITHUB_TOKEN=[redacted:credential-assignment]");
  });

  it("redacts every secret when several appear together", () => {
    const { text } = redactSecrets(`${FAKE.githubToken} and ${FAKE.awsKeyId}`);
    expect(text).not.toContain(FAKE.githubToken);
    expect(text).not.toContain(FAKE.awsKeyId);
    expect(kinds(`${FAKE.githubToken} and ${FAKE.awsKeyId}`)).toEqual(
      expect.arrayContaining(["github-token", "aws-access-key-id"]),
    );
  });
});

// The failure mode that matters most. Over-redaction destroys legitimate notes
// and trains people to turn the redactor off, at which point it protects
// nothing. These must all pass through untouched.
describe("benign content is left alone", () => {
  it.each([
    ["a git SHA", "Fixed in bf177b205a1c4e8f9d2b3a6c7e0f1a2b3c4d5e6f"],
    ["a UUID", "Thread 3f2504e0-4f89-11d3-9a0c-0305e82c3301 resumed"],
    ["a file path", "See apps/server/src/persistence/Migrations/036_MemoryAndDrive.ts"],
    ["a URL", "Docs at https://github.com/JTBroad/t3code/blob/main/docs/README.md"],
    ["an email", "Reported by jack101091@gmail.com yesterday"],
    ["a semver", "Bumped @pierre/diffs to 1.3.0-beta.10 in the catalog"],
    ["a long sentence", "The consolidation run must never consume its own output or it degrades"],
    ["a dotted identifier", "orchestration.thread.checkpoint.baseline.captured fired twice"],
  ])("leaves %s untouched", (_label, input) => {
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });
});

describe("entropy fallback", () => {
  it("redacts a long unstructured token the patterns do not know", () => {
    const generated = "Kq7#vZ2!mB9$xT4%wR8&nL1@pJ6^hG3*dF5";
    const { text } = redactSecrets(`token ${generated}`);
    expect(text).not.toContain(generated);
    expect(text).toContain("[redacted:high-entropy]");
  });

  // Regression: an allowlist rule of [\w./-]+ intended for file paths also
  // matches base64, so every generated token like this one passed through
  // untouched. The path rule now keys on the separator instead.
  it("redacts a base64-shaped token that no named pattern covers", () => {
    const generated = "aGVsbG8td29ybGQtc2VjcmV0LXZhbHVlLTEyMzQ1Njc4OQ";
    const { text, redactions } = redactSecrets(`opaque ${generated}`);
    expect(text).not.toContain(generated);
    expect(redactions.map((redaction) => redaction.kind)).toEqual(["high-entropy"]);
  });

  // Standard base64 uses "/" too, so the path rule must not become a way to
  // smuggle a secret past the entropy check.
  it("redacts a base64 blob containing slashes and padding", () => {
    const generated = "aGVsbG8vd29ybGQvc2VjcmV0L3ZhbHVlLzEyMzQ1Njc4OWFiYw==";
    const { text } = redactSecrets(`blob ${generated}`);
    expect(text).not.toContain(generated);
    expect(text).toContain("[redacted:high-entropy]");
  });

  it("does not double-redact an already redacted marker", () => {
    const once = redactSecrets(`value ${FAKE.githubToken}`);
    const twice = redactSecrets(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toEqual([]);
  });

  it("returns text unchanged when there is nothing to redact", () => {
    const input = "Prefers migrations reviewed for idempotency before landing.";
    expect(redactSecrets(input)).toEqual({ text: input, redactions: [] });
  });
});
