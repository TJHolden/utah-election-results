/* State-feed adapter for the election-night tracker.
 *
 * civicAPI stopped answering on election night, so the tracker had no data.
 * This serves it the same shape it already expects, built from the state's own
 * feed (results.json, mirrored from the Lieutenant Governor's office every two
 * minutes by a GitHub Action). Nothing in the tracker changes — it still thinks
 * it is reading civicAPI, so the map, tabs and projections work as built.
 *
 * Loaded before the app bundle. Everything below is self-contained.
 */
(function () {
  "use strict";

  var STATE_AB = "UT";
  var STATE_NAME = "Utah";
  var RESULTS = "results.json";
  var TTL = 25000; // re-read the mirrored file at most this often

  var nativeFetch = window.fetch.bind(window);
  var cache = null;
  var cacheAt = 0;
  var inflight = null;

  // A stable id per race, so /race/{id} lookups and the tracker's own caching
  // line up between refreshes. Name-derived, not positional, so adding a race
  // never renumbers the others.
  function raceId(name) {
    var h = 2166136261;
    for (var i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return 900000000 + (h % 90000000);
  }

  var PARTY_FULL = {
    R: "Republican", D: "Democratic", L: "Libertarian", I: "Unaffiliated",
    C: "Constitution", F: "Forward", G: "Green", UU: "United Utah", IA: "Independent American"
  };

  function titleCase(s) {
    return String(s || "").toLowerCase()
      .replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); })
      .replace(/\bMc([a-z])/g, function (m, c) { return "Mc" + c.toUpperCase(); })
      .replace(/\b(Ii|Iii|Iv|Jr|Sr)\b/g, function (m) { return m.toUpperCase(); });
  }

  // Name the contest so the tracker's own classifier files it correctly:
  // it reads election_name / election_type for "state house", "u.s. house",
  // "amendment", "question" and so on.
  function contestName(r) {
    var base = String(r.n || "").replace(/\s*\(Multi-County\)\s*$/, "").trim();
    if (r.k === "judicial") {
      var who = (base.match(/Shall\s+(.+?)\s+be retained/i) || [])[1] || base;
      var seat = (base.match(/office of (?:Judge|Justice) of the (.+?)\?/i) || [])[1] || "";
      return STATE_NAME + " Judicial Retention Question — " + titleCase(who) +
             (seat ? " (" + seat.replace(/^the\s+/i, "") + ")" : "");
    }
    return STATE_NAME + " " + base;
  }

  function contestType(r) {
    switch (r.k) {
      case "ushouse": return "U.S. House";
      case "senate": return "State Senate";
      case "house": return "State House";
      case "measure": return "Referendum";
      case "judicial": return "Referendum";
      case "school": return "School Board";
      default: return "Other";
    }
  }

  function districtOf(r) {
    var m = String(r.n || "").replace(/\(Multi-County\)/, "").match(/(\d+)\s*$/);
    return m ? m[1] : "";
  }

  function toCivic(r) {
    var total = 0, i;
    for (i = 0; i < r.c.length; i++) total += r.c[i][2] || 0;
    var cands = r.c.map(function (c) {
      // A Yes/No option gets no party. The tracker discards any race where
      // every candidate's name equals its party — that's how it recognises
      // whole-chamber tallies — so naming the party "For" would silently drop
      // every ballot measure and retention question.
      var isYN = /^(yes|no|for|against)$/i.test(String(c[0]).trim());
      return {
        name: titleCase(c[0]),
        party: isYN ? "" : (PARTY_FULL[c[1]] || c[1] || ""),
        votes: c[2] || 0,
        percent: total > 0 ? +((c[2] || 0) / total * 100).toFixed(2) : 0,
        winner: !!c[3],
        incumbent: false
      };
    });
    var name = contestName(r);
    return {
      id: raceId(name),
      election_name: name,
      election_type: contestType(r),
      type: contestType(r),
      election_scope: (r.k === "measure" || r.k === "judicial") ? "Statewide" : "Local",
      election_date: "2026-11-03T05:00:00.000Z",
      country: "US",
      province: STATE_AB,
      district: districtOf(r),
      municipality: null,
      // The state publishes reporting units (counties or localities), not
      // precincts. Report that share rather than inventing a precinct count.
      percent_reporting: r.tu > 0 ? Math.round((r.ru / r.tu) * 100) : (total > 0 ? 100 : 0),
      registered_voters: null,
      test_data: false,
      has_breakdown: !!(r.rg && r.rg.length),
      region_results: regionResults(r),
      candidates: cands
    };
  }

  // County results, in the shape the tracker's county map reads: keyed by a
  // slug, each with the county's name, FIPS and its own candidate rows.
  // Only contests the mirror carries a breakdown for have one; everything else
  // is a district map and never asks.
  function regionResults(r) {
    if (!r.rg || !r.rg.length) return {};
    var out = {};
    for (var i = 0; i < r.rg.length; i++) {
      var row = r.rg[i];                       // [name, fips, rpt, total, opts]
      var name = row[0], fips = row[1], rpt = row[2], opts = row[4] || [];
      var total = 0, k;
      for (k = 0; k < opts.length; k++) total += opts[k][1] || 0;
      var key = String(name).toLowerCase()
        .replace(/\s+county$/, "").replace(/[^a-z0-9]/g, "");
      out[key] = {
        name: name,
        type: "County",
        fips: fips,
        percent_reporting: rpt,
        candidates: opts.map(function (o) {
          var isYN = /^(yes|no|for|against)$/i.test(String(o[0]).trim());
          return {
            name: titleCase(o[0]),
            party: isYN ? "" : "",
            votes: o[1] || 0,
            percent: total > 0 ? +((o[1] || 0) / total * 100).toFixed(2) : 0,
            winner: false
          };
        })
      };
    }
    return out;
  }

  function load() {
    if (cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = nativeFetch(RESULTS + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("results.json " + r.status);
        return r.json();
      })
      .then(function (d) {
        cache = (d.races || []).map(toCivic);
        cacheAt = Date.now();
        inflight = null;
        return cache;
      })
      .catch(function (e) {
        inflight = null;
        if (cache) return cache;   // serve the last good copy rather than nothing
        throw e;
      });
    return inflight;
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  window.fetch = function (input, init) {
    var url = String((input && input.url) ? input.url : input || "");
    if (url.indexOf("civicapi.org") === -1) return nativeFetch(input, init);

    return load().then(function (races) {
      if (/\/race\/search/.test(url)) {
        var q;
        try { q = new URL(url, location.href).searchParams; } catch (e) { q = null; }
        var prov = q && q.get("province");
        var query = q && q.get("query");
        var out = races;
        if (prov && prov.toUpperCase() !== STATE_AB) out = [];
        if (query) {
          var needle = query.toLowerCase();
          out = out.filter(function (r) {
            return r.election_name.toLowerCase().indexOf(needle) !== -1;
          });
        }
        return json({ races: out, total: out.length });
      }
      var m = /\/race\/(\d+)/.exec(url);
      if (m) {
        var hit = null;
        for (var i = 0; i < races.length; i++) {
          if (String(races[i].id) === m[1]) { hit = races[i]; break; }
        }
        return hit ? json(hit) : json({ error: "not found" }, 404);
      }
      return json({ races: [], total: 0 });
    }).catch(function () {
      return json({ races: [], total: 0 });
    });
  };

  window.__STATE_FEED__ = {
    state: STATE_AB,
    source: RESULTS,
    peek: function () { return cache; }
  };
})();
