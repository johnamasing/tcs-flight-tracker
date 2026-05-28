/**
 * FlightAware AeroAPI Proxy  v9.0
 * Google Apps Script
 *
 * /flights/{ident}  → 日付なしで呼出、GAS側で日付フィルタ（直近〜2日先）
 * /schedules/{s}/{e} → origin + destination + airline + flight_number で検索（2日以上先）
 *                      3週間超の期間はチャンク分割で対応（最大約2ヶ月）
 *                      origin/destination は /flights のデータから自動取得
 *                      空港名・都市名も /flights のデータで補完
 */

var AEROAPI_KEY = "mxqCgIkpfd7dBfS8XLlu8FkI7Msn3scP";
var AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi";

var AIRPORT_IATA_TO_ICAO = {
  "HND": "RJTT", "NRT": "RJAA", "KIX": "RJBB", "ITM": "RJOO",
  "FUK": "RJFF", "CTS": "RJCC", "NGO": "RJGG", "OKA": "ROAH",
  "SDJ": "RJSS", "HIJ": "RJOA", "KOJ": "RJFK", "NGS": "RJFU",
  "KMJ": "RJFT", "OIT": "RJFO", "MYJ": "RJOM", "TAK": "RJOT",
  "KMI": "RJFM", "AOJ": "RJSA", "AKJ": "RJEC", "MMB": "RJCM",
  "ICN": "RKSI", "GMP": "RKSS", "PUS": "RKPK",
  "PEK": "ZBAA", "PVG": "ZSPD", "HKG": "VHHH", "TPE": "RCTP",
  "SIN": "WSSS", "BKK": "VTBS", "MNL": "RPLL", "KUL": "WMKK",
  "CGK": "WIII", "HAN": "VVNB", "SGN": "VVTS",
  "SYD": "YSSY", "LAX": "KLAX", "SFO": "KSFO", "JFK": "KJFK",
  "LHR": "EGLL", "CDG": "LFPG", "DXB": "OMDB", "DFW": "KDFW",
  "ORD": "KORD", "SEA": "KSEA", "YVR": "CYVR", "DEL": "VIDP"
};

var AIRLINE_IATA_TO_ICAO = {
  "JL": "JAL", "NH": "ANA", "MM": "APJ", "GK": "JJP", "BC": "SKY",
  "KE": "KAL", "OZ": "AAR", "BX": "ABL", "7C": "JJA", "TW": "TWB",
  "LJ": "JNA", "ZE": "ESR", "RS": "ASV",
  "CA": "CCA", "MU": "CES", "CZ": "CSN", "HU": "CHH",
  "CI": "CAL", "BR": "EVA", "HX": "CRK", "CX": "CPA",
  "SQ": "SIA", "TG": "THA", "MH": "MAS", "VN": "HVN",
  "VJ": "VJC", "PR": "PAL", "GA": "GIA", "QF": "QFA",
  "EK": "UAE",
  "UA": "UAL", "DL": "DAL", "AA": "AAL", "AC": "ACA",
  "BA": "BAW", "LH": "DLH", "AF": "AFR", "TK": "THY"
};

function normalizeIdent(raw) {
  if (!raw || typeof raw !== "string") return "";
  var s = raw.toUpperCase().replace(/\s/g, "");
  if (s === "") return "";
  var m = s.match(/^([A-Z]{3})(\d+)$/) || s.match(/^([A-Z0-9]{2})(\d+)$/);
  if (!m) return s;
  if (AIRLINE_IATA_TO_ICAO[m[1]]) return AIRLINE_IATA_TO_ICAO[m[1]] + m[2];
  return s;
}

function splitIdent(ident) {
  var m = ident.match(/^([A-Z]{3})(\d+)$/) || ident.match(/^([A-Z0-9]{2})(\d+)$/);
  if (!m) return null;
  return { airline: m[1], flightNumber: m[2] };
}

/** 日付文字列を YYYY-MM-DD に正規化（T以降を除去） */
function toDateStr(s) {
  if (!s) return "";
  return s.substring(0, 10);
}

/** 日付範囲を最大21日（3週間）ごとのチャンクに分割 */
function chunkDateRange(startDate, endDate) {
  var MAX_DAYS = 21;
  var chunks = [];
  var s = new Date(startDate + "T00:00:00Z");
  var e = new Date(endDate + "T00:00:00Z");
  if (s >= e) return [{ start: startDate, end: endDate }];
  while (s < e) {
    var ce = new Date(s.getTime() + MAX_DAYS * 86400000);
    if (ce > e) ce = e;
    chunks.push({
      start: s.toISOString().slice(0, 10),
      end: ce.toISOString().slice(0, 10)
    });
    s = ce;
  }
  return chunks;
}

function callAeroAPI(path) {
  var url = AEROAPI_BASE + path;
  var opts = { method: "get", headers: { "x-apikey": AEROAPI_KEY, "Accept": "application/json; charset=UTF-8" }, muteHttpExceptions: true };
  try {
    var r = UrlFetchApp.fetch(url, opts);
    var code = r.getResponseCode(), body = r.getContentText();
    if (code === 200) { var p = JSON.parse(body); p._apiPath = path; return p; }
    return { error: true, status: code, message: body, _apiPath: path };
  } catch (e) { return { error: true, status: 0, message: e.toString(), _apiPath: path }; }
}

/** 複数パスを並列リクエスト */
function callAeroAPIBatch(paths) {
  var opts = { method: "get", headers: { "x-apikey": AEROAPI_KEY, "Accept": "application/json; charset=UTF-8" }, muteHttpExceptions: true };
  var requests = paths.map(function(p) { return { url: AEROAPI_BASE + p, method: "get", headers: opts.headers, muteHttpExceptions: true }; });
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    return responses.map(function(r, i) {
      try {
        var code = r.getResponseCode(), body = r.getContentText();
        if (code === 200) { var p = JSON.parse(body); p._apiPath = paths[i]; return p; }
        return { error: true, status: code, message: body, _apiPath: paths[i] };
      } catch (e) { return { error: true, status: 0, message: e.toString(), _apiPath: paths[i] }; }
    });
  } catch (e) {
    return paths.map(function(p) { return { error: true, status: 0, message: e.toString(), _apiPath: p }; });
  }
}

function makeResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function isFutureDate(dateStr) {
  if (!dateStr) return false;
  return (new Date(dateStr + "T00:00:00Z").getTime() - new Date().getTime()) / 86400000 > 2;
}

function filterByDate(flights, start, end) {
  if (!start && !end) return flights;
  var s = toDateStr(start);
  var e = toDateStr(end);
  return flights.filter(function(f) {
    var dep = (f.scheduled_out || "").substring(0, 10);
    var arr = (f.scheduled_in || "").substring(0, 10);
    if (s && dep < s && arr < s) return false;
    if (e && dep > e && arr > e) return false;
    return true;
  });
}

/**
 * /schedules を全チャンク並列で取得
 * 試行順序: 1. airline+flight_number → 2. IATA airline → 3. origin+destination
 * 全チャンクを一括並列リクエストし、失敗時のみ次の試行へ
 */
function searchSchedulesBatch(icaoIdent, origParts, origin, destination, chunks) {
  var debugPaths = [];

  // 試行1: airline + flight_number（全チャンク並列）
  if (origParts) {
    var paths1 = chunks.map(function(c) {
      return "/schedules/" + c.start + "/" + c.end + "?airline=" + origParts.airline + "&flight_number=" + origParts.flightNumber + "&max_pages=3";
    });
    var results1 = callAeroAPIBatch(paths1);
    var all1 = [];
    var ok1 = false;
    results1.forEach(function(d, i) {
      var count = (!d.error && d.scheduled) ? d.scheduled.length : 0;
      debugPaths.push({ path: paths1[i], ok: !d.error, count: count });
      if (count > 0) { all1 = all1.concat(d.scheduled); ok1 = true; }
    });
    if (ok1) return { scheduled: all1, debugPaths: debugPaths };
  }

  // 試行2: IATA airline コード（全チャンク並列）
  if (origParts) {
    var iataAirline = null;
    for (var k in AIRLINE_IATA_TO_ICAO) { if (AIRLINE_IATA_TO_ICAO[k] === origParts.airline) { iataAirline = k; break; } }
    if (iataAirline) {
      var paths2 = chunks.map(function(c) {
        return "/schedules/" + c.start + "/" + c.end + "?airline=" + iataAirline + "&flight_number=" + origParts.flightNumber + "&max_pages=3";
      });
      var results2 = callAeroAPIBatch(paths2);
      var all2 = [];
      var ok2 = false;
      results2.forEach(function(d, i) {
        var count = (!d.error && d.scheduled) ? d.scheduled.length : 0;
        debugPaths.push({ path: paths2[i], ok: !d.error, count: count });
        if (count > 0) { all2 = all2.concat(d.scheduled); ok2 = true; }
      });
      if (ok2) return { scheduled: all2, debugPaths: debugPaths };
    }
  }

  // 試行3: origin + destination（全チャンク並列）→ GAS側フィルタ
  if (origin && destination) {
    var paths3 = chunks.map(function(c) {
      return "/schedules/" + c.start + "/" + c.end + "?origin=" + origin + "&destination=" + destination + "&max_pages=3";
    });
    var results3 = callAeroAPIBatch(paths3);
    var all3 = [];
    results3.forEach(function(d, i) {
      var items = (!d.error && d.scheduled) ? d.scheduled : [];
      debugPaths.push({ path: paths3[i], ok: !d.error, count: items.length });
      all3 = all3.concat(items);
    });
    if (all3.length > 0) {
      var filtered = all3.filter(function(s) { return s.ident === icaoIdent || s.ident_iata === (origParts ? origParts.airline + origParts.flightNumber : ""); });
      if (filtered.length > 0) return { scheduled: filtered, debugPaths: debugPaths };
    }
  }

  return { scheduled: [], debugPaths: debugPaths };
}

/** /schedules のレスポンスを /flights 互換形式に変換（空港情報を /flights から補完） */
function convertScheduleFlight(s, airportInfo) {
  var oi = (airportInfo && airportInfo.origin) || {};
  var di = (airportInfo && airportInfo.destination) || {};
  return {
    ident: s.ident || "", ident_iata: s.ident_iata || "",
    fa_flight_id: s.fa_flight_id || "",
    operator: "", operator_iata: "",
    flight_number: (splitIdent(s.ident || "") || {}).flightNumber || "",
    aircraft_type: s.aircraft_type || "",
    status: "Scheduled",
    origin: {
      code_iata: s.origin_iata || oi.code_iata || "",
      code_icao: s.origin_icao || s.origin || "",
      name: oi.name || "", city: oi.city || "",
      gate: null, terminal: oi.terminal || null
    },
    destination: {
      code_iata: s.destination_iata || di.code_iata || "",
      code_icao: s.destination_icao || s.destination || "",
      name: di.name || "", city: di.city || "",
      gate: null, terminal: di.terminal || null
    },
    scheduled_out: s.scheduled_out || null,
    actual_out: null, estimated_out: null,
    scheduled_in: s.scheduled_in || null,
    actual_in: null, estimated_in: null,
    progress_percent: 0, departure_delay: 0, arrival_delay: 0,
    route_distance: null,
    blocked: false, cancelled: false, diverted: false,
    meal_service: s.meal_service || null,
    seats_cabin_coach: s.seats_cabin_coach || 0,
    seats_cabin_business: s.seats_cabin_business || 0,
    seats_cabin_first: s.seats_cabin_first || 0,
    _source: "schedules"
  };
}

/** /flights レスポンスを統一形式に変換 */
function convertFlight(f, fallbackIdent, fallbackIata) {
  return {
    ident: f.ident || fallbackIdent,
    ident_iata: f.ident_iata || fallbackIata,
    fa_flight_id: f.fa_flight_id || "",
    operator: f.operator || "", operator_iata: f.operator_iata || "",
    flight_number: f.flight_number || "",
    aircraft_type: f.aircraft_type || "",
    status: f.status || "Unknown",
    origin: {
      code_iata: (f.origin && f.origin.code_iata) || "",
      code_icao: (f.origin && (f.origin.code_icao || f.origin.code)) || "",
      name: (f.origin && f.origin.name) || "",
      city: (f.origin && f.origin.city) || "",
      gate: f.gate_origin || null, terminal: f.terminal_origin || null
    },
    destination: {
      code_iata: (f.destination && f.destination.code_iata) || "",
      code_icao: (f.destination && (f.destination.code_icao || f.destination.code)) || "",
      name: (f.destination && f.destination.name) || "",
      city: (f.destination && f.destination.city) || "",
      gate: f.gate_destination || null, terminal: f.terminal_destination || null
    },
    scheduled_out: f.scheduled_out || null,
    actual_out: f.actual_out || null, estimated_out: f.estimated_out || null,
    scheduled_in: f.scheduled_in || null,
    actual_in: f.actual_in || null, estimated_in: f.estimated_in || null,
    progress_percent: f.progress_percent || 0,
    departure_delay: f.departure_delay || 0, arrival_delay: f.arrival_delay || 0,
    route_distance: f.route_distance || null,
    blocked: f.blocked || false, cancelled: f.cancelled || false, diverted: f.diverted || false,
    _source: "flights"
  };
}

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = params.action || "";
  var result = {};

  try {

    if (action === "flight") {
      var rawIdent = params.ident || "";
      if (!rawIdent) return makeResponse({ success: false, error: "ident パラメータが必要です。" });

      var originalIdent = rawIdent.toUpperCase().replace(/\s/g, "");
      var ident = normalizeIdent(rawIdent);
      if (!ident) return makeResponse({ success: false, error: "無効なフライトNo: " + rawIdent });

      var startDate = toDateStr(params.start || "");
      var endDate = toDateStr(params.end || "");
      var dateNote = null, source = "flights", flights = [];
      var debugInfo = {};

      // ── STEP 1: /flights（日付なし）で直近データ取得 ──
      var flightsPath = "/flights/" + ident + "?max_pages=1";
      var data = callAeroAPI(flightsPath);
      debugInfo.flightsPath = flightsPath;

      // ICAO で失敗 → IATA でリトライ
      if (data.error && originalIdent !== ident) {
        var retryPath = "/flights/" + originalIdent + "?max_pages=1";
        var data2 = callAeroAPI(retryPath);
        debugInfo.flightsRetryPath = retryPath;
        if (!data2.error) data = data2;
      }

      var allFlights = (!data.error && data.flights) ? data.flights : [];
      debugInfo.flightsTotal = allFlights.length;

      // origin/destination + 空港詳細情報を取得（/schedules 補完用）
      var originICAO = null, destICAO = null, airportInfo = null;
      if (allFlights.length > 0) {
        var sample = allFlights[0];
        originICAO = (sample.origin && (sample.origin.code_icao || sample.origin.code)) || null;
        destICAO = (sample.destination && (sample.destination.code_icao || sample.destination.code)) || null;
        airportInfo = { origin: sample.origin, destination: sample.destination };
        debugInfo.detectedRoute = originICAO + " → " + destICAO;
      }

      // GAS側で日付フィルタ
      flights = filterByDate(allFlights, startDate, endDate);
      debugInfo.flightsFiltered = flights.length;

      // /flights データを統一形式に変換
      flights = flights.map(function(f) { return convertFlight(f, ident, originalIdent); });

      // ── STEP 2: 日付指定あり → /schedules も取得して /flights 結果とマージ ──
      if (startDate || endDate) {
        var schedStart = startDate || endDate;
        var schedEnd = endDate || "";
        if (!schedEnd) {
          var se = new Date(schedStart + "T00:00:00Z");
          se.setDate(se.getDate() + 30);
          schedEnd = se.toISOString().slice(0, 10);
        }
        var icaoParts = splitIdent(ident);

        if (originICAO && destICAO || icaoParts) {
          // 3週間ごとにチャンク分割 → 全チャンク並列取得
          var chunks = chunkDateRange(schedStart, schedEnd);
          debugInfo.scheduleChunks = chunks.length;

          var batchResult = searchSchedulesBatch(ident, icaoParts, originICAO, destICAO, chunks);
          var allScheduled = batchResult.scheduled;

          debugInfo.scheduleAttempts = batchResult.debugPaths;

          if (allScheduled.length > 0) {
            // 既存 /flights/ 結果のキーを構築（日付+ルートで重複回避）
            var existingKeys = {};
            flights.forEach(function(f) {
              var dk = (f.scheduled_out || "").substring(0, 10);
              var org = (f.origin && f.origin.code_icao) || "";
              var dst = (f.destination && f.destination.code_icao) || "";
              existingKeys[dk + "_" + org + "_" + dst] = true;
            });

            // /flights/ に無い日付+ルートのスケジュールのみ追加
            allScheduled.forEach(function(s) {
              var dk = (s.scheduled_out || "").substring(0, 10);
              var org = s.origin_icao || s.origin || "";
              var dst = s.destination_icao || s.destination || "";
              var key = dk + "_" + org + "_" + dst;
              if (!existingKeys[key]) {
                flights.push(convertScheduleFlight(s, airportInfo));
                existingKeys[key] = true;
              }
            });

            source = "mixed";
            dateNote = "全" + flights.length + "件を表示中（直近便は実績データ、それ以降はスケジュールデータ）。";
          }
        }

        if (flights.length === 0) {
          dateNote = "指定期間（" + schedStart + " 〜 " + schedEnd + "）のデータが見つかりませんでした。";
        }
      }

      // 日付昇順でソート
      flights.sort(function(a, b) {
        return (a.scheduled_out || "").localeCompare(b.scheduled_out || "");
      });

      result = {
        success: true,
        query: originalIdent, resolved: ident,
        converted: originalIdent !== ident,
        count: flights.length, dateNote: dateNote, source: source,
        _debug: debugInfo,
        flights: flights
      };

    } else if (action === "departures" || action === "arrivals") {
      var airportRaw = (params.airport || "").toUpperCase().replace(/\s/g, "");
      if (!airportRaw) return makeResponse({ success: false, error: "airport パラメータが必要です。" });
      var airport = AIRPORT_IATA_TO_ICAO[airportRaw] || airportRaw;

      var type = action;
      var startDate = toDateStr(params.start || "");
      var endDate = toDateStr(params.end || "");
      var dateNote = null;

      // 日付指定時は scheduled_ エンドポイントを使用（予定便を取得）
      var endpoint = type;
      if (startDate || endDate) {
        endpoint = "scheduled_" + type;
      }
      var aptPath = "/airports/" + airport + "/flights/" + endpoint + "?max_pages=5&type=Airline";

      var tryPath = aptPath;
      if (startDate) tryPath += "&start=" + startDate + "T00:00:00Z";
      if (endDate) tryPath += "&end=" + endDate + "T23:59:59Z";

      var data = callAeroAPI(tryPath);
      if (data.error && data.message && data.message.indexOf("INVALID_ARGUMENT") !== -1) {
        dateNote = "指定日はAPI検索範囲外（過去10日〜未来2日）のため、直近の発着便を表示しています。";
        var fallbackPath = "/airports/" + airport + "/flights/" + endpoint + "?max_pages=5&type=Airline";
        data = callAeroAPI(fallbackPath);
        endpoint = endpoint;
      }
      if (data.error) return makeResponse({ success: false, error: "API Error: " + (data.message || "Unknown") });

      var flights = data[endpoint] || [];
      if (startDate || endDate) {
        var filtered = flights.filter(function(f) {
          var t = (type === "departures") ? (f.scheduled_out || "") : (f.scheduled_in || "");
          var d = t.substring(0, 10);
          if (startDate && d < startDate) return false;
          if (endDate && d > endDate) return false;
          return true;
        });
        if (filtered.length > 0) flights = filtered;
        else if (dateNote) dateNote = "指定期間の発着データはまだ公開されていません。直近の発着便を表示しています。";
        else flights = filtered;
      }

      result = {
        success: true, airport: airportRaw, resolved_airport: airport, type: type, count: flights.length, dateNote: dateNote,
        flights: flights.map(function(f) {
          return {
            ident: f.ident || "", ident_iata: f.ident_iata || "",
            operator: f.operator || "", operator_iata: f.operator_iata || "",
            flight_number: f.flight_number || "", status: f.status || "Unknown",
            aircraft_type: f.aircraft_type || "",
            origin: { code_iata: (f.origin && f.origin.code_iata) || "", name: (f.origin && f.origin.name) || "", city: (f.origin && f.origin.city) || "", terminal: f.terminal_origin || null },
            destination: { code_iata: (f.destination && f.destination.code_iata) || "", name: (f.destination && f.destination.name) || "", city: (f.destination && f.destination.city) || "", terminal: f.terminal_destination || null },
            scheduled_out: f.scheduled_out || null, actual_out: f.actual_out || null, estimated_out: f.estimated_out || null,
            scheduled_in: f.scheduled_in || null, actual_in: f.actual_in || null, estimated_in: f.estimated_in || null,
            gate_origin: f.gate_origin || null, gate_destination: f.gate_destination || null,
            terminal_origin: f.terminal_origin || null, terminal_destination: f.terminal_destination || null
          };
        }).sort(function(a, b) {
          var tA = (type === "departures") ? (a.scheduled_out || "") : (a.scheduled_in || "");
          var tB = (type === "departures") ? (b.scheduled_out || "") : (b.scheduled_in || "");
          return tA.localeCompare(tB);
        })
      };

    } else {
      result = {
        success: true, message: "FlightAware AeroAPI Proxy v9.0",
        usage: { flight: "?action=flight&ident=JL5", flight_future: "?action=flight&ident=JL5&start=2026-05-29&end=2026-06-28", departures: "?action=departures&airport=NRT" }
      };
    }

  } catch (err) { result = { success: false, error: err.toString() }; }
  return makeResponse(result);
}
