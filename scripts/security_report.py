#!/usr/bin/env python3
"""Generate a security PR comment without disclosing detected secret values."""
import json
import os
from pathlib import Path

def safe(value, limit=120):
    return str(value or "—").replace("|", "\\|").replace("\n", " ").replace("\r", " ").replace(chr(96), "'")[:limit]

def load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

def main():
    outcomes = {key: os.getenv(key + "_OUTCOME", "unknown") for key in ("OSV", "GITLEAKS", "REMEDIATE")}
    passed = all(outcome == "success" for outcome in outcomes.values())
    branch = safe(os.getenv("AUDIT_BRANCH", ""), 100)
    sha = safe(os.getenv("AUDIT_SHA", ""), 12)
    run = os.getenv("GITHUB_RUN_ID", "")
    repo = os.getenv("GITHUB_REPOSITORY", "")
    lines = [
        "## Security audit — " + ("passed" if passed else "needs attention"), "",
        "**Branch:** " + branch + " | **Commit:** " + sha + " | **Run:** " + run,
        "", "Dependency scan: **" + outcomes["OSV"] + "**; secret scan: **" +
        outcomes["GITLEAKS"] + "**; npm remediation: **" + outcomes["REMEDIATE"] + "**.", ""
    ]
    if outcomes["REMEDIATE"] != "success":
        lines.extend(["Automatic lockfile refresh failed. See workflow logs.", ""])
    osv = load("osv-results.json")
    rows = []
    count = 0
    if isinstance(osv, dict):
        for result in osv.get("results", []):
            path = safe((result.get("source") or {}).get("path"))
            for entry in result.get("packages", []):
                pkg = entry.get("package") or {}
                for vuln in entry.get("vulnerabilities", []):
                    count += 1
                    if len(rows) >= 35:
                        continue
                    fixes = []
                    for affected in vuln.get("affected", []):
                        for rng in affected.get("ranges", []):
                            fixes.extend(event["fixed"] for event in rng.get("events", []) if event.get("fixed"))
                    ident = safe(vuln.get("id"), 80)
                    aliases = [a for a in vuln.get("aliases", []) if a.startswith("CVE-")]
                    advisory = "[" + ident + "](https://osv.dev/vulnerability/" + ident + ")"
                    if aliases:
                        cve = safe(aliases[0], 25)
                        advisory += ", [" + cve + "](https://nvd.nist.gov/vuln/detail/" + cve + ")"
                    rows.append("| " + " | ".join([
                        safe(pkg.get("name")), safe(pkg.get("version")), advisory,
                        safe(vuln.get("summary") or vuln.get("details") or "See advisory"),
                        safe(", ".join(dict.fromkeys(fixes)) or "Review advisory"), path]) + " |")
    if rows:
        lines.extend(["### Vulnerable dependencies", "",
                      "| Module | Installed | Advisory | Description | Suggested fix | File |",
                      "|---|---|---|---|---|---|", *rows, ""])
        if count > 35:
            lines.append("Showing 35 of " + str(count) + " findings. See attached OSV JSON.")
    elif outcomes["OSV"] == "success":
        lines.extend(["No vulnerable dependencies reported.", ""])
    else:
        lines.extend(["OSV report missing or invalid; inspect scan logs.", ""])
    leaks = load("gitleaks-results.json")
    if isinstance(leaks, list) and leaks:
        lines.extend(["### Potential secrets", "",
                      str(len(leaks)) + " finding(s). Values and matched snippets are never included here.", ""])
        for leak in leaks[:15]:
            lines.append("- " + safe(leak.get("RuleID"), 75) + " in " +
                         safe(leak.get("File"), 100) + " (line " +
                         safe(leak.get("StartLine"), 10) + ")")
    elif outcomes["GITLEAKS"] == "success":
        lines.extend(["No secrets detected in checked-out source files.", ""])
    else:
        lines.extend(["Secret scanning failed or found a potential leak. Review job logs.", ""])
    lines.extend(["", "[View workflow logs](https://github.com/" + repo + "/actions/runs/" + run + ")",
                  "", "Scanner results require review; a passing audit does not replace code review."])
    Path("security-comment.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

if __name__ == "__main__":
    main()
