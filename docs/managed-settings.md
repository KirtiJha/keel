# Managed settings vs plugin settings — a recommendation

Build spec M9.4: *"Document which gates belong in managed settings
(undisableable) versus plugin settings (overridable). Do not decide this alone —
produce the recommendation and ask."*

This is the recommendation. **Nothing here is implemented as managed policy** —
every gate currently ships as plugin settings, which a repo can override. Moving
any row into the managed column is an organisational decision.

> **Decided for v1: nothing is managed.** The maintainer's answer to the three
> questions below is *no managed settings, telemetry on by default, local-only*
> — see `docs/decisions.md` §16. The recommendation column stands as written and
> is the starting point for the review in step 3 of the sequence; it is not the
> current configuration. **The two rows marked "Managed" below ship overridable
> like everything else.**

---

## The principle

A gate belongs in **managed settings** only when all three hold:

1. **Bypassing it has consequences beyond the developer's own repo** — security,
   data integrity, a contract other teams depend on.
2. **It cannot produce a false positive that leaves someone genuinely stuck**
   with no legitimate escape hatch.
3. **Someone owns the exception process**, and that process is faster than
   asking a platform engineer to edit a config.

Everything else belongs in **plugin settings**. A gate a team cannot disable and
cannot satisfy is a gate that gets worked around — by copying files, by
committing from a different tool, or by turning the whole plugin off. That
outcome is worse than the gate not existing.

---

## Recommendation

| Gate | Recommend | Why |
|---|---|---|
| **Standards packs, `severity: high`** | Plugin | Rules are org-specific and imperfect. A wrong rule should cost one PR to delete, not a support ticket. Rule of the road 5 says delete rules that do not fire — that only works if teams can act. |
| **Standards packs, `medium`/`low`** | Plugin | Advisory by construction. |
| **TDD gate 1 — test weakening** | **Managed, once piloted** | Silently weakening a test is the failure mode with the worst blast radius, and it already has a first-class escape hatch: `keel: allow-test-change <reason>`, which is recorded. Meets all three tests. **Do not enable before the pilot reports a false-positive rate.** |
| **TDD gate 2 — mocking the unit under test** | Plugin | Correct nearly always, but pairing is convention-based, and a repo with an unusual layout can trip it with no override available. |
| **TDD gate 3 — observed RED** | Plugin | The most valuable gate and the most situational. Spikes, generated code, and emergency fixes are all legitimate. `KEEL_SPIKE=1` exists precisely because the answer is sometimes "not now". |
| **TDD gate 4 — assertion lint** | Plugin | Low stakes; a warning that becomes a habit. |
| **Mutation score floor** | Plugin | It is a *ratchet*. Teams need to raise it on their own schedule, and a floor set centrally will be either too low to matter or too high to pass. |
| **Spec size cap** | Plugin | Advisory at the cap by design. |
| **Archive at merge** | **Managed** | This is the rule that keeps specs from rotting, it runs in CI rather than in the loop, and the fix is mechanical — archive the change. Nobody is ever stuck. |
| **Secret redaction in telemetry** | **Managed** | Not a gate a developer interacts with, and the only failure mode is a leak. There is no legitimate reason to switch it off. |
| **`MessageDisplay` formatter** | Plugin | Cosmetic. |
| **Telemetry collection** | Org decision | Out of scope for this document: it is a privacy and works-council question, not an engineering one. |

---

## Suggested sequence

1. Ship everything as plugin settings. **This is the current state.**
2. Run the pilots. Watch `keel doctor` for gate hit rates and TDD trips,
   and specifically for overrides — a gate overridden often is a gate that is
   wrong, not a team that is undisciplined.
3. After a quarter, move only the rows marked **Managed** above, and only if
   their measured false-positive rate is near zero.
4. Review quarterly. The default at every review is *removal*, not retention.

---

## Answered

1. **Anything managed in v1?** **No.** Everything ships overridable, including
   the two rows recommended above. Lock things down later, with measured
   false-positive rates, or not at all.
2. **Who owns the exception process?** Moot while nothing is locked. Whoever
   revisits question 1 inherits this one — and if the answer at that point is
   "file a ticket", the gate should stay overridable.
3. **Telemetry?** **On by default, local-only.** Opt-in would have sampled only
   the teams already sold on Keel, which is the wrong population for judging
   which gates are wrong. Nothing is transmitted: `.keel/telemetry` is JSONL on
   local disk and `keel telemetry ship` bundles it to the same disk. This
   retires the "telemetry destination" input — the destination is the file.

Recorded in `docs/decisions.md` §16.
