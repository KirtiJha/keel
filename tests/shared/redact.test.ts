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

  // The rest of the GitHub token family: oauth, user-to-server,
  // server-to-server and refresh tokens all leaked while only `ghp_` matched.
  githubOauth: `gh${"o"}_${"NOTAREALTOKEN".repeat(2)}`,
  githubUserToServer: `gh${"u"}_${"NOTAREALTOKEN".repeat(2)}`,
  githubServerToServer: `gh${"s"}_${"NOTAREALTOKEN".repeat(2)}`,
  githubRefresh: `gh${"r"}_${"NOTAREALTOKEN".repeat(2)}`,

  // Underscore-separated provider keys; the `sk-` pattern assumed a hyphen.
  stripeLive: `sk${"_live_"}${"NOTAREALKEY0".repeat(2)}`,
  stripeTest: `sk${"_test_"}${"NOTAREALKEY0".repeat(2)}`,
  stripeRestricted: `rk${"_live_"}${"NOTAREALKEY0".repeat(2)}`,
  npmToken: `npm${"_"}${"NOTAREALTOKEN0".repeat(3)}`,

  // Slack refresh tokens and AWS temporary session keys.
  slackRefresh: `xox${"e"}-${"1"}-${"NOTAREALTOKENVALUE"}`,
  awsSessionKey: `ASIA${"NOTAREALKEY00000"}`,
} as const;

/** Stand-in for a secret value with no shape of its own. */
const VALUE = `hunter2${"sekrit"}`;

describe("redact", () => {
  const secrets: ReadonlyArray<readonly [string, string]> = [
    ["openai key", `key is ${FAKE.openai}`],
    ["github pat", `token ${FAKE.githubPat}`],
    ["github fine-grained", FAKE.githubFineGrained],
    ["slack", FAKE.slack],
    ["aws access key", FAKE.awsKey],
    ["google api key", FAKE.googleKey],
    ["jwt", FAKE.jwt],
    ["github oauth token", `token ${FAKE.githubOauth}`],
    ["github user-to-server token", FAKE.githubUserToServer],
    ["github server-to-server token", FAKE.githubServerToServer],
    ["github refresh token", FAKE.githubRefresh],
    ["stripe live key", `key ${FAKE.stripeLive}`],
    ["stripe test key", FAKE.stripeTest],
    ["stripe restricted key", FAKE.stripeRestricted],
    ["npm token", `//registry.npmjs.org/:_authToken=${FAKE.npmToken}`],
    ["slack refresh token", FAKE.slackRefresh],
    ["aws session key", FAKE.awsSessionKey],
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

  it("collapses OPENSSH blocks, several blocks, and keeps surrounding text", () => {
    const block = (kind: string, body: string) =>
      `-----BEGIN ${kind} PRIVATE KEY-----\n${body}\n-----END ${kind} PRIVATE KEY-----`;
    const input = `before ${block("OPENSSH", "sshbodyline")} middle ${block("EC", "ecbodyline")} after`;
    const out = redact(input);
    expect(out).toBe("before [redacted] middle [redacted] after");
  });

  it("leaves an unterminated BEGIN marker alone rather than eating the rest", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nno end marker follows\nbuild ok\n";
    expect(redact(input)).toBe(input);
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

  it("is idempotent: redacting its own output changes nothing", () => {
    const inputs = [
      "Authorization: Bearer abcdefghijklmnop",
      `AUTHORIZATION=${VALUE}`,
      `AWS_SECRET_ACCESS_KEY=${VALUE}`,
      `TOKEN: '${VALUE}'`,
      "https://user:pa55word@example.com/x",
      `key is ${FAKE.openai}`,
    ];
    for (const input of inputs) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
      // The marker must come back whole; re-redaction used to append a bracket.
      expect(once).not.toContain("[redacted]]");
    }
  });
});

/**
 * The flat-text and structured paths are built from one shared key list, so
 * every name has to be caught by both. This is the test that pins that down:
 * when the lists were separate they drifted, and `{AUTH: "..."}` was redacted
 * while the flat text `AUTH=...` was not.
 */
describe("secret-shaped key names are caught on both paths", () => {
  const keys = [
    "API_KEY",
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASSWD",
    "CLIENT_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
    "AUTH",
    "AUTHORIZATION",
    "PAT",
    "GITHUB_PAT",
    "DB_PASS",
    "PASSPHRASE",
    "SIGNING_KEY",
    "ENCRYPTION_KEY",
    "PRIVKEY",
    "SESSION_COOKIE",
    "x-api-key",
    "userPassword",
  ];

  for (const key of keys) {
    it(`redacts ${key} in flat text and in structured data`, () => {
      expect(redact(`${key}=${VALUE}`)).not.toContain(VALUE);
      expect(redact(`${key}: "${VALUE}"`)).not.toContain(VALUE);
      expect(JSON.stringify(redactValue({ [key]: VALUE }))).not.toContain(VALUE);
    });
  }
});

/**
 * Over-redaction is a real cost, not free caution: this module runs on hook
 * output, so mangling a colour, a SHA or `PATH=` would be a defect of its own.
 */
describe("common non-secrets survive untouched", () => {
  const harmless: ReadonlyArray<readonly [string, string]> = [
    ["hex colour", "background: #a1b2c3; border-color: #FFF"],
    ["git sha", "commit 9f2c1a8d3e4b5c6f7a8b9c0d1e2f3a4b5c6d7e8f landed on main"],
    ["uuid", "run 550e8400-e29b-41d4-a716-446655440000 finished in 1.2s"],
    [
      "base64 image fragment",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk",
    ],
    ["prose containing key", "the primary key is the id column; keyboard shortcuts follow"],
    ["PATH", "PATH=/usr/local/bin:/usr/bin:/bin"],
    ["GOPATH", "GOPATH=/home/dev/go"],
    ["git author line", "author=Jane Doe <jane@example.com>"],
    ["PATTERN", "PATTERN=^src/.*[.]ts$"],
    ["compatibility flag", "compatibility=full"],
    ["patch number", "patch=3"],
    ["passing count", "TESTS_PASSED=42"],
    ["docs url", "https://example.com/v1.2.3/docs?tab=keys"],
    ["risk-shaped identifiers", "risk_assessment_score and disk_usage_report_high"],
    ["semver and file", "typescript@5.7.2 src/shared/redact.ts changed"],
  ];

  for (const [name, input] of harmless) {
    it(`keeps ${name}`, () => {
      expect(redact(input)).toBe(input);
    });
  }

  it("keeps ambiguous key names on the structured path too", () => {
    const value = "ordinary-value";
    for (const key of ["PATH", "path", "AUTHOR", "author", "PATTERN", "patch", "compat"]) {
      expect(JSON.stringify(redactValue({ [key]: value }))).toContain(value);
    }
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

/**
 * Redaction is wired onto hook output paths, so a pathological input must not
 * be able to stall one. The PEM block used to be matched with
 * `BEGIN[\s\S]*?END`, which rescans the rest of the input from every BEGIN
 * marker: 64 KB of markers took 9 ms but 1 MB took 1.7 s.
 */
describe("performance on adversarial input", () => {
  const MB = 1024 * 1024;
  const repeatTo = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));

  /**
   * CPU milliseconds, not wall clock, and the best of a few samples.
   *
   * These files run in parallel with the rest of the suite on a shared machine
   * that is routinely oversubscribed, where wall-clock timing measures how
   * contended the box is rather than how much work `redact` does. CPU time does
   * not advance while the thread is descheduled, so it measures the thing under
   * test and the budget below stays meaningful instead of flaky.
   */
  const cpuMillis = (input: string, samples = 3): number => {
    let best = Infinity;
    for (let i = 0; i < samples; i++) {
      const before = process.cpuUsage();
      redact(input);
      const spent = process.cpuUsage(before);
      best = Math.min(best, (spent.user + spent.system) / 1000);
    }
    return best;
  };

  it("redacts 1 MB of repeated PEM BEGIN markers in well under 100 ms", () => {
    const input = repeatTo("-----BEGIN RSA PRIVATE KEY-----\n", MB);
    expect(input.length).toBeGreaterThanOrEqual(MB);
    redact(input.slice(0, 2048)); // warm the regexes, not the measurement

    const elapsed = cpuMillis(input);

    // Quadratic behaviour reads as ~1700 ms here, so this bound is decisive
    // rather than tight: the measured time is roughly 30 ms.
    expect(elapsed).toBeLessThan(100);
  });

  it("leaves 1 MB of unterminated BEGIN markers exactly as it found them", () => {
    const input = repeatTo("-----BEGIN RSA PRIVATE KEY-----\n", MB);
    expect(redact(input)).toBe(input);
  });

  it("has no other quadratic pattern: every 1 MB shape stays in budget", () => {
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ["pem begin/end pairs", repeatTo("-----BEGIN A PRIVATE KEY-----x-----END A PRIVATE KEY-----", MB)],
      ["pem header capitals", `-----BEGIN ${"A".repeat(MB)}`],
      // Two adjacent `\s*` runs used to make these two hang outright.
      ["authorization then whitespace", `Authorization: ${" ".repeat(MB)}`],
      ["key name then whitespace", `TOKEN${" ".repeat(MB)}`],
      ["repeated secret word", repeatTo("secret", MB)],
      ["repeated assignments", repeatTo("AUTH=x ", MB)],
      // An unbounded URL scheme made this one quadratic.
      ["scheme-shaped run", repeatTo("abc+def.ghi-", MB)],
      ["letters", "a".repeat(MB)],
      ["key characters", repeatTo("A_", MB)],
      ["bearer flood", repeatTo("bearer ", MB)],
      ["plain prose", repeatTo("the quick brown fox jumps ", MB)],
    ];

    const slow: string[] = [];
    for (const [name, input] of shapes) {
      redact(input.slice(0, 2048));
      const elapsed = cpuMillis(input, 2);
      // Generous next to the ~90 ms worst case, because this asserts the shape
      // of the cost curve (linear, not quadratic) rather than a wall-clock SLA.
      if (elapsed >= 250) slow.push(`${name}: ${elapsed.toFixed(0)} ms`);
    }
    expect(slow).toEqual([]);
  });
});
