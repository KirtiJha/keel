import { describe, expect, it } from "vitest";

import { redact, redactValue } from "../../src/shared/redact.js";

/**
 * Fixtures are assembled at runtime rather than written as literals.
 *
 * A test for a secret redactor necessarily contains secret-shaped strings, and
 * a literal one trips GitHub's push-protection scanner — which blocked this
 * commit until the strings were split. Concatenation keeps the regexes under
 * test exactly as they were while leaving no scannable literal in the file.
 *
 * None of these are real credentials; every one is `NOTAREAL...` padding.
 */
const FAKE = {
  openai: `sk-${"NOTAREALKEY".repeat(3)}`,
  githubPat: `ghp_${"NOTAREALTOKEN".repeat(2)}`,
  githubFineGrained: `github_pat_${"11NOTAREAL".repeat(3)}`,
  slack: `xox${"b"}-${"NOTAREAL"}-${"TOKENVALUE"}`,
  awsKey: `AKIA${"NOTAREALKEY00000"}`,
  googleKey: `AIza${"SyNOTAREALKEYNOTAREALKEYNOTAREALKEY"}`,
  jwt: `eyJ${"NOTAREALHEADER"}.${"eyJNOTAREALPAYLOAD"}.${"NOTAREALSIGNATURE"}`,
} as const;

describe("redact", () => {
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["openai key", `key is ${FAKE.openai}`],
    ["github pat", `token ${FAKE.githubPat}`],
    ["github fine-grained", FAKE.githubFineGrained],
    ["slack", FAKE.slack],
    ["aws access key", FAKE.awsKey],
    ["google api key", FAKE.googleKey],
    ["jwt", FAKE.jwt],
  ];

  for (const [name, input] of secrets) {
    it(`removes a ${name}`, () => {
      const out = redact(input);
      expect(out).toContain("[redacted]");
      // The secret body must not survive anywhere in the output.
      const body = input.split(/\s+/).at(-1) ?? "";
      expect(out).not.toContain(body);
    });
  }

  it("redacts secret-shaped assignments regardless of syntax", () => {
    expect(redact("API_KEY=hunter2sekrit")).not.toContain("hunter2sekrit");
    expect(redact('"password": "hunter2sekrit"')).not.toContain("hunter2sekrit");
    expect(redact("client_secret = hunter2sekrit")).not.toContain("hunter2sekrit");
    expect(redact("AWS_SECRET_ACCESS_KEY: hunter2sekrit")).not.toContain("hunter2sekrit");
  });

  it("redacts authorization headers and bearer tokens", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redact("bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  });

  it("redacts inline URL credentials but keeps the scheme", () => {
    const out = redact("https://user:pa55word@example.com/x");
    expect(out).not.toContain("pa55word");
    expect(out).toContain("https://");
  });

  it("collapses a PEM private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nsecretline\n-----END RSA PRIVATE KEY-----";
    const out = redact(pem);
    expect(out).toBe("[redacted]");
    expect(out).not.toContain("secretline");
  });

  it("leaves ordinary text untouched", () => {
    const plain = "src/auth/refresh.ts:42 rule no-raw-color-values failed";
    expect(redact(plain)).toBe(plain);
  });

  it("is stable across repeated calls (module-level regex lastIndex)", () => {
    const input = `API_KEY=hunter2sekrit and ${FAKE.openai}`;
    const first = redact(input);
    const second = redact(input);
    const third = redact(input);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});

describe("redactValue", () => {
  it("scrubs nested objects and arrays, keys included", () => {
    const out = redactValue({
      list: [{ api_key: "hunter2sekrit" }],
      nested: { deep: { token: "hunter2sekrit" } },
      safe: 42,
    }) as Record<string, unknown>;

    expect(JSON.stringify(out)).not.toContain("hunter2sekrit");
    expect(out["safe"]).toBe(42);
  });

  it("terminates on deeply nested input", () => {
    let deep: Record<string, unknown> = { token: "hunter2sekrit" };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => redactValue(deep)).not.toThrow();
    expect(JSON.stringify(redactValue(deep))).not.toContain("hunter2sekrit");
  });

  it("preserves primitives and drops functions", () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(true)).toBe(true);
    expect(redactValue(7)).toBe(7);
    expect(redactValue(() => 1)).toBeUndefined();
  });
});
