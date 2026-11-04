#!/usr/bin/env python3
"""Pull the Utah Lt. Governor's official results feed and write results.json.

Runs in GitHub Actions, where there is no CORS and no rate limiting, so the
page can read a same-origin file instead of calling civicAPI from the browser.
Source: https://electionresults.utah.gov/results/public/Utah/General11032026
"""
import json, sys, urllib.request, datetime, os

API = ("https://electionresults.utah.gov/results/public/api/elections/"
       "Utah/General11032026/data")

PARTY = {
    "Republican": "R", "Democratic": "D", "Democrat": "D",
    "Libertarian": "L", "Unaffiliated": "I", "Independent": "I",
    "Constitution": "C", "Independent American": "IA",
    "Forward": "F", "Green": "G", "United Utah": "UU",
}


def en(items):
    for it in (items or []):
        if it.get("languageId") == "en":
            return (it.get("text") or "").strip()
    return ""


def party_code(p):
    name = en((p or {}).get("name"))
    if not name:
        return ""
    return PARTY.get(name, name[:2].upper())


def kind(name, contest_type):
    if name.startswith("U.S. House"):
        return "ushouse"
    if name.startswith("State Senate"):
        return "senate"
    if name.startswith("State House"):
        return "house"
    if name.startswith("State School Board"):
        return "school"
    if name.startswith("Constitutional Amendment") or name.startswith(("Proposition", "Initiative")):
        return "measure"
    if name.startswith("Shall "):
        return "judicial"
    return "other"


def district(name):
    """Sort key: the district number, where there is one."""
    tok = name.replace("(Multi-County)", "").strip().split()
    for t in reversed(tok):
        if t.isdigit():
            return int(t)
    return 9999


def main():
    req = urllib.request.Request(API, headers={
        "Accept": "application/json",
        "User-Agent": "utah-election-results/1.0 (github actions)",
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        data = json.load(r)

    items = data.get("ballotItems") or []
    if not items:
        print("feed returned no ballotItems — leaving results.json alone", file=sys.stderr)
        return 1

    as_of = None
    races = []
    for x in items:
        name = en(x.get("name"))
        rs = x.get("reportingStatus") or {}
        if rs.get("asOf") and (as_of is None or rs["asOf"] > as_of):
            as_of = rs["asOf"]
        vote_for = x.get("voteFor") or []
        seats = 1
        if vote_for and isinstance(vote_for[0], dict):
            seats = vote_for[0].get("voteFor") or 1
        opts = ((x.get("summaryResults") or {}).get("ballotOptions")) or []
        races.append({
            "n": name,
            "k": kind(name, x.get("contestType")),
            "d": district(name),
            "seats": seats,
            "ru": rs.get("reportingUnits") or 0,
            "tu": rs.get("totalUnits") or 0,
            "v": x.get("voteTotal") or 0,
            "c": [[
                en(o.get("name")),
                party_code(o.get("party")),
                o.get("voteCount") or 0,
                1 if o.get("isWinner") else 0,
                1 if o.get("isWriteIn") else 0,
            ] for o in opts],
        })

    out = {
        "src": "Utah Lt. Governor's Office — electionresults.utah.gov",
        "srcUrl": "https://electionresults.utah.gov/results/public/Utah/General11032026",
        "election": "General11032026",
        "asOf": as_of,
        "pulled": datetime.datetime.now(datetime.timezone.utc)
                      .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "totalVotes": sum(r["v"] for r in races),
        "races": races,
    }

    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "results.json")

    # Never overwrite a fuller count with an emptier one — a partial or failed
    # feed read should not wipe votes that are already published.
    if os.path.exists(path):
        try:
            with open(path) as f:
                prev = json.load(f)
            if prev.get("totalVotes", 0) > out["totalVotes"]:
                print("feed total (%d) is below the published total (%d) — keeping the published file"
                      % (out["totalVotes"], prev.get("totalVotes", 0)), file=sys.stderr)
                return 0
        except Exception:
            pass

    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote %s — %d races, %s votes, asOf %s"
          % (path, len(races), f"{out['totalVotes']:,}", as_of))
    return 0


if __name__ == "__main__":
    sys.exit(main())
