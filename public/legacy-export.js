// Legacy export helper. Reads the old tracker's saved data from this browser and downloads it as a local file.
// It never sends data anywhere, never erases anything, and does not read the old permission store.
(function () {
  "use strict";
  var KEYS = ["tt_tasks", "tt_kpis", "tt_users", "tt_nid"];
  var status = document.getElementById("status");
  var button = document.getElementById("download");
  var stored = {};
  var found = 0;
  try {
    KEYS.forEach(function (k) {
      var v = window.localStorage.getItem(k);
      stored[k] = v;
      if (v !== null) found++;
    });
  } catch (e) {
    status.textContent = "This browser does not allow reading saved site data here.";
    return;
  }
  function count(raw) { try { var v = JSON.parse(raw); return Array.isArray(v) ? v.length : 0; } catch (e) { return 0; } }
  function kpiCount(raw) {
    try { var n = 0, v = JSON.parse(raw); Object.keys(v || {}).forEach(function (u) { Object.keys(v[u] || {}).forEach(function (b) { if (Array.isArray(v[u][b])) n += v[u][b].length; }); }); return n; } catch (e) { return 0; }
  }
  if (!found) { status.textContent = "No old tracker data is saved in this browser."; return; }
  // Counts only; the contents are never displayed on this page.
  status.textContent = "Found " + count(stored.tt_tasks) + " task(s) and " + kpiCount(stored.tt_kpis) + " KPI(s) saved in this browser.";
  button.disabled = false;
  button.addEventListener("click", function () {
    var file = { format: "sb-task-tracker-legacy-export", version: 1, exported_at: new Date().toISOString(), keys: stored };
    var blob = new Blob([JSON.stringify(file)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tt-legacy-export-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    status.textContent = "Downloaded. Nothing was removed from this browser.";
  });
})();
