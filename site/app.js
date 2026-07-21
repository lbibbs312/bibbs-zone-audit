/* Bibbs Zone Audit — static PWA.
   Reads published MDOT RIDE work-zone data (refreshed by CI). Reports send
   immediately to the review inbox through the report relay; if the phone is
   offline they wait in local storage and send automatically. */
(() => {
  "use strict";

  const GEOFENCE_METERS = 402.336;        // quarter mile, same rule as the reviewer station
  const NEAR_METERS = GEOFENCE_METERS * 2;
  const MAX_GPS_ACCURACY_METERS = 100;
  const MAX_PHOTOS = 8;
  const LIST_LIMIT = 60;
  const CANDIDATE_LIMIT = 12;
  const CANDIDATE_RANGE_METERS = 12000;
  const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
  const RELAY_URL = "https://bibbstechnology.com/api/zone-reports";

  let dataset = null;
  let datasetError = "";
  let userLocation = null;   // {latitude, longitude, accuracyMeters, capturedAt}
  let mapInstance = null;

  const view = document.getElementById("view");
  const dataStrip = document.getElementById("data-strip");
  document.getElementById("year").textContent = String(new Date().getFullYear());

  /* ---------- utilities ---------- */

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

  const published = (value, fallback = "Not published") =>
    value === null || value === undefined || value === "" ? fallback : String(value);

  const statusLabel = (value) => published(value, "Status not published")
    .replace(/[-_]/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());

  const dateLabel = (value) => {
    if (!value) return "Not published";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? String(value)
      : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  };

  const distanceLabel = (meters) => {
    if (meters === null || meters === undefined) return "Distance unavailable";
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet)} ft away`;
    return `${(meters / 1609.344).toFixed(1)} mi away`;
  };

  const classificationLabel = (code) => ({
    inside_reported_area: "Inside reported area",
    near_reported_area: "Near reported area",
    outside_reported_area: "Outside reported area",
    location_unavailable: "Location unavailable",
    location_accuracy_too_low: "Location accuracy too low",
  }[code] || "Location unavailable");

  /* ---------- geometry ---------- */

  const toMeters = (latitude, longitude, refLatitude) => {
    const metersPerDegree = 111320;
    return {
      x: longitude * metersPerDegree * Math.cos((refLatitude * Math.PI) / 180),
      y: latitude * metersPerDegree,
    };
  };

  const segmentDistance = (point, a, b) => {
    const abX = b.x - a.x;
    const abY = b.y - a.y;
    const lengthSquared = abX * abX + abY * abY;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
    }
    const x = a.x + t * abX;
    const y = a.y + t * abY;
    return { distance: Math.hypot(point.x - x, point.y - y), t };
  };

  const geometryLines = (geometry) => {
    if (!geometry) return [];
    if (geometry.type === "LineString") return [geometry.coordinates];
    if (geometry.type === "MultiLineString") return geometry.coordinates;
    if (geometry.type === "Point") return [[geometry.coordinates, geometry.coordinates]];
    return [];
  };

  const closestOnGeometry = (latitude, longitude, geometry) => {
    const lines = geometryLines(geometry);
    if (!lines.length) return null;
    const point = toMeters(latitude, longitude, latitude);
    let best = null;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i += 1) {
        const [lonA, latA] = line[i];
        const [lonB, latB] = line[i + 1];
        const a = toMeters(latA, lonA, latitude);
        const b = toMeters(latB, lonB, latitude);
        const result = segmentDistance(point, a, b);
        if (!best || result.distance < best.distanceMeters) {
          best = {
            distanceMeters: result.distance,
            latitude: latA + (latB - latA) * result.t,
            longitude: lonA + (lonB - lonA) * result.t,
          };
        }
      }
    }
    return best;
  };

  const classify = (distanceMeters, accuracyMeters) => {
    if (distanceMeters === null || distanceMeters === undefined) return "location_unavailable";
    if (accuracyMeters !== null && accuracyMeters > MAX_GPS_ACCURACY_METERS) return "location_accuracy_too_low";
    if (distanceMeters <= GEOFENCE_METERS) return "inside_reported_area";
    if (distanceMeters <= NEAR_METERS) return "near_reported_area";
    return "outside_reported_area";
  };

  /* ---------- data ---------- */

  const loadDataset = async () => {
    try {
      const response = await fetch("data/zones.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      dataset = await response.json();
      datasetError = "";
    } catch (error) {
      datasetError = "Live data could not be loaded right now.";
      dataset = dataset || null;
    }
    renderDataStrip();
  };

  const renderDataStrip = () => {
    if (!dataset) {
      dataStrip.textContent = datasetError || "Loading MDOT work-zone data…";
      dataStrip.classList.toggle("stale", Boolean(datasetError));
      return;
    }
    const generated = new Date(dataset.generated_at_utc);
    const age = Date.now() - generated.getTime();
    const time = generated.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    if (age > STALE_AFTER_MS) {
      dataStrip.className = "data-strip stale";
      dataStrip.textContent = `MDOT data last collected ${time} — it may be out of date.`;
    } else {
      dataStrip.className = "data-strip";
      dataStrip.textContent = `${dataset.zone_count} MDOT work-zone records · collected ${time}`;
    }
  };

  const zoneById = (eventId) =>
    dataset?.zones.find((zone) => zone.event_id === eventId) || null;

  const withDistance = (zone) => {
    if (!userLocation || !zone.geometry) return { ...zone, distanceMeters: null, closestPoint: null };
    const closest = closestOnGeometry(userLocation.latitude, userLocation.longitude, zone.geometry);
    return {
      ...zone,
      distanceMeters: closest ? closest.distanceMeters : null,
      closestPoint: closest ? { latitude: closest.latitude, longitude: closest.longitude } : null,
    };
  };

  const nearbyCandidates = (originId) => {
    const located = dataset.zones.map(withDistance);
    let nearby = located
      .filter((zone) => zone.distanceMeters !== null && zone.distanceMeters <= CANDIDATE_RANGE_METERS)
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, CANDIDATE_LIMIT);
    const origin = located.find((zone) => zone.event_id === originId);
    if (origin && !nearby.some((zone) => zone.event_id === originId)) {
      nearby = [origin, ...nearby].slice(0, CANDIDATE_LIMIT);
    }
    if (!nearby.length && origin) nearby = [origin];
    return nearby;
  };

  /* ---------- location ---------- */

  const requestLocation = () => new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        userLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: Math.max(0, position.coords.accuracy || 0),
          capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
        };
        resolve(userLocation);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });

  /* ---------- storage ---------- */

  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("bibbs-zone-audit", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("reports", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const dbAction = async (mode, action) => {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("reports", mode);
        const store = tx.objectStore("reports");
        const request = action(store);
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };

  const saveReport = (record) => dbAction("readwrite", (store) => store.put(record));
  const listReports = () => dbAction("readonly", (store) => store.getAll());
  const deleteReport = (id) => dbAction("readwrite", (store) => store.delete(id));

  const refreshBadge = async () => {
    const badge = document.getElementById("pending-badge");
    try {
      const reports = await listReports();
      const queued = reports.filter((item) => item.status === "queued").length;
      badge.textContent = String(queued);
      badge.hidden = queued === 0;
    } catch { badge.hidden = true; }
  };

  /* ---------- immediate delivery with offline retry ---------- */

  const exportablePayload = (record) => {
    const { status, sent_at, send_error, ...rest } = record;
    return { ...rest, photos: record.photos.map(({ blob, ...meta }) => meta) };
  };

  const sendReport = async (record) => {
    const form = new FormData();
    form.append(
      "report_file",
      new File(
        [JSON.stringify(exportablePayload(record), null, 2)],
        `${record.id}.json`,
        { type: "application/json" },
      ),
    );
    for (const photo of record.photos) {
      form.append(
        "photos",
        new File([photo.blob], photo.name || "photo", { type: photo.type || "image/jpeg" }),
      );
    }
    const response = await fetch(RELAY_URL, { method: "POST", body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error || `The report could not be sent (HTTP ${response.status}).`);
    }
    record.status = "sent";
    record.sent_at = new Date().toISOString();
    record.send_error = "";
    await saveReport(record);
    return record;
  };

  let retryInFlight = false;
  const retryQueuedReports = async () => {
    if (retryInFlight || !navigator.onLine) return;
    retryInFlight = true;
    try {
      const reports = await listReports();
      for (const record of reports.filter((item) => item.status === "queued")) {
        try {
          await sendReport(record);
        } catch (error) {
          record.send_error = String(error.message || error);
          await saveReport(record);
        }
      }
    } catch { /* storage unavailable; nothing to retry */ }
    retryInFlight = false;
    refreshBadge();
  };
  window.addEventListener("online", retryQueuedReports);

  /* ---------- shared render pieces ---------- */

  const zoneMetaLine = (zone) => {
    const status = statusLabel(zone.event_status);
    const statusClass = `status-${(zone.event_status || "unknown").toLowerCase()}`;
    return `<p class="zone-meta"><span class="${statusClass}">${esc(status)}</span> · ${esc(published(zone.lane_summary))}</p>`;
  };

  const zoneCard = (zone) => `
    <article class="zone-card">
      <div class="zone-card-top">
        <div>
          <p class="eyebrow">${esc(zone.event_id)}</p>
          <h3>${esc(zone.road_display)}</h3>
        </div>
        ${zone.distanceMeters !== null && zone.distanceMeters !== undefined
          ? `<span class="zone-distance">${esc(distanceLabel(zone.distanceMeters))}</span>` : ""}
      </div>
      <p class="zone-sub">${esc(statusLabel(zone.direction))} · ${esc(published(zone.beginning_cross_street, "Beginning not published"))} to ${esc(published(zone.ending_cross_street, "End not published"))}</p>
      ${zoneMetaLine(zone)}
      <details class="more">
        <summary>More MDOT details</summary>
        <dl class="fact-grid">
          <div><dt>Published dates</dt><dd>${esc(dateLabel(zone.start_date))} through ${esc(dateLabel(zone.end_date))}</dd></div>
          <div><dt>Last MDOT update</dt><dd>${esc(dateLabel(zone.update_date))}</dd></div>
          ${zone.description ? `<div><dt>MDOT description</dt><dd>${esc(zone.description)}</dd></div>` : ""}
        </dl>
      </details>
      <div class="zone-actions">
        <a class="button button-primary" href="#/report/${encodeURIComponent(zone.event_id)}">Report what you saw</a>
        <a class="button" href="#/zone/${encodeURIComponent(zone.event_id)}">Reported area</a>
      </div>
    </article>`;

  /* ---------- views ---------- */

  const renderList = () => {
    if (!dataset) {
      view.innerHTML = `<p class="empty">${esc(datasetError || "Loading MDOT work-zone data…")}</p>`;
      return;
    }
    const query = (window.sessionStorage.getItem("bza-query") || "").trim().toLowerCase();
    let zones = dataset.zones;
    if (query) {
      zones = zones.filter((zone) =>
        [zone.road_display, zone.event_id, zone.beginning_cross_street, zone.ending_cross_street, zone.description]
          .some((field) => field && String(field).toLowerCase().includes(query)));
    }
    zones = zones.map(withDistance);
    if (userLocation) {
      zones.sort((a, b) => (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity));
    }
    const total = zones.length;
    zones = zones.slice(0, LIST_LIMIT);

    view.innerHTML = `
      <h1>Michigan work zones</h1>
      <p class="form-help">Published MDOT construction listings. Choose one to see its reported area or to report what you saw.</p>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search road, cross street, or ETX number" value="${esc(window.sessionStorage.getItem("bza-query") || "")}">
        <div class="button-row">
          <button id="near-me" class="button button-accent" type="button">Near Me</button>
        </div>
        <p class="location-status" id="location-status">${userLocation
          ? `Sorted by distance from your location (GPS accuracy about ${Math.round(userLocation.accuracyMeters)} m).`
          : "Your browser will ask before sharing location."}</p>
        <p class="list-note">Showing ${zones.length} of ${total}${total !== dataset.zone_count ? ` matching (${dataset.zone_count} statewide)` : " statewide"} — search or use Near Me to narrow.</p>
      </div>
      <div class="card-list">${zones.map(zoneCard).join("") || `<p class="empty">No listings match this search.</p>`}</div>`;

    document.getElementById("search").addEventListener("input", (event) => {
      window.sessionStorage.setItem("bza-query", event.target.value);
      renderList();
    });
    document.getElementById("near-me").addEventListener("click", async () => {
      document.getElementById("location-status").textContent = "Requesting your current location…";
      const location = await requestLocation();
      if (!location) {
        document.getElementById("location-status").textContent =
          "Location was not captured. You can still search the list.";
        return;
      }
      renderList();
    });
  };

  const destroyMap = () => {
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  };

  const drawMap = (element, zone) => {
    destroyMap();
    if (!zone.geometry || typeof L === "undefined") {
      element.remove();
      return;
    }
    mapInstance = L.map(element, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapInstance);
    const lines = geometryLines(zone.geometry).map((line) => line.map(([lon, lat]) => [lat, lon]));
    const layer = L.polyline(lines, { color: "#022a62", weight: 5 }).addTo(mapInstance);
    let bounds = layer.getBounds();
    if (userLocation) {
      const here = [userLocation.latitude, userLocation.longitude];
      L.circle(here, { radius: Math.max(userLocation.accuracyMeters, 5), color: "#f26b1d", fillOpacity: .12 }).addTo(mapInstance);
      L.circleMarker(here, { radius: 6, color: "#f26b1d", fillOpacity: 1 }).addTo(mapInstance);
      bounds = bounds.extend(here);
    }
    mapInstance.fitBounds(bounds.pad(0.2));
  };

  const renderZone = (eventId) => {
    const zone = zoneById(eventId);
    if (!zone) { view.innerHTML = `<p class="empty">This MDOT record is not in the current data.</p>`; return; }
    const located = withDistance(zone);
    view.innerHTML = `
      <a class="back-link" href="#/">← All work zones</a>
      <p class="eyebrow">${esc(zone.event_id)}</p>
      <h1>${esc(zone.road_display)}</h1>
      ${zoneMetaLine(zone)}
      ${located.distanceMeters !== null ? `<p class="zone-sub">${esc(distanceLabel(located.distanceMeters))} · ${esc(classificationLabel(classify(located.distanceMeters, userLocation?.accuracyMeters ?? null)))}</p>` : ""}
      <div id="zone-map" class="map-box" aria-label="MDOT-reported road area"></div>
      <p class="form-help">The blue line is MDOT's reported area from the published feed. It is geographic context only — it does not assess closures, traffic, or safe stopping.</p>
      <dl class="fact-grid panel">
        <div><dt>Direction</dt><dd>${esc(statusLabel(zone.direction))}</dd></div>
        <div><dt>Cross streets</dt><dd>${esc(published(zone.beginning_cross_street, "Beginning not published"))} to ${esc(published(zone.ending_cross_street, "End not published"))}</dd></div>
        <div><dt>Lane or ramp</dt><dd>${esc(published(zone.lane_summary))}</dd></div>
        <div><dt>Vehicle impact</dt><dd>${esc(statusLabel(zone.vehicle_impact))}</dd></div>
        <div><dt>Published dates</dt><dd>${esc(dateLabel(zone.start_date))} through ${esc(dateLabel(zone.end_date))}</dd></div>
        <div><dt>Last MDOT update</dt><dd>${esc(dateLabel(zone.update_date))}</dd></div>
        ${zone.description ? `<div><dt>MDOT description</dt><dd>${esc(zone.description)}</dd></div>` : ""}
      </dl>
      <a class="button button-primary" style="width:100%" href="#/report/${encodeURIComponent(zone.event_id)}">Report what you saw</a>`;
    drawMap(document.getElementById("zone-map"), zone);
  };

  /* ---------- report capture ---------- */

  const reportState = { photos: [] };

  const candidateRow = (zone, checked) => `
    <div class="candidate">
      <label>
        <input type="radio" name="candidate" value="${esc(zone.event_id)}" ${checked ? "checked" : ""}>
        <span>
          <span class="title">${esc(zone.road_display)} · ${esc(statusLabel(zone.direction))}</span>
          <span class="id">${esc(zone.event_id)}</span>
          <span class="span">${esc(published(zone.beginning_cross_street, "Beginning not published"))} to ${esc(published(zone.ending_cross_street, "End not published"))}</span>
          <span class="meta">${esc(distanceLabel(zone.distanceMeters))} · ${esc(classificationLabel(classify(zone.distanceMeters, userLocation?.accuracyMeters ?? null)))}</span>
        </span>
      </label>
    </div>`;

  const optionList = (name, options, required = true) => `
    <div class="option-list">
      ${options.map(([value, label]) => `
        <label><input type="radio" name="${name}" value="${value}" ${required ? "required" : ""}><span>${label}</span></label>`).join("")}
    </div>`;

  const photoSection = (idPrefix) => `
    <input id="${idPrefix}-photo-input" type="file" accept="image/*" multiple hidden>
    <div class="button-row">
      <button class="button" type="button" id="${idPrefix}-add-photos">Add photographs</button>
    </div>
    <div id="${idPrefix}-photo-list" class="photo-grid"></div>`;

  const wirePhotoSection = (idPrefix) => {
    const input = document.getElementById(`${idPrefix}-photo-input`);
    const list = document.getElementById(`${idPrefix}-photo-list`);
    const render = () => {
      list.innerHTML = "";
      reportState.photos.forEach((file, index) => {
        const url = URL.createObjectURL(file);
        const figure = document.createElement("figure");
        figure.innerHTML = `<img src="${url}" alt="Selected photograph ${index + 1}">
          <figcaption>${esc(file.name)}</figcaption>
          <button type="button" class="photo-remove" data-index="${index}">Remove</button>`;
        figure.querySelector("img").addEventListener("load", () => URL.revokeObjectURL(url));
        list.append(figure);
      });
    };
    document.getElementById(`${idPrefix}-add-photos`).addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      for (const file of input.files) {
        if (reportState.photos.length >= MAX_PHOTOS) break;
        reportState.photos.push(file);
      }
      input.value = "";
      render();
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest(".photo-remove");
      if (!button) return;
      reportState.photos.splice(Number(button.dataset.index), 1);
      render();
    });
  };

  const buildRecord = (eventId, answers) => {
    const chosenId = answers.candidateId;
    const chosen = chosenId ? withDistance(zoneById(chosenId) || zoneById(eventId)) : null;
    const now = new Date();
    return {
      id: `BZA-${now.getTime().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0")}`,
      created_at: now.toISOString(),
      created_at_local: now.toLocaleString(),
      app: "bibbs-zone-audit",
      report_mode: answers.reportMode,
      feed_generated_at_utc: dataset?.generated_at_utc || null,
      feed_update_date: dataset?.feed?.update_date || null,
      zone: chosen ? {
        event_id: chosen.event_id,
        road_display: chosen.road_display,
        direction: chosen.direction,
        beginning_cross_street: chosen.beginning_cross_street,
        ending_cross_street: chosen.ending_cross_street,
        lane_summary: chosen.lane_summary,
        event_status: chosen.event_status,
        start_date: chosen.start_date,
        end_date: chosen.end_date,
        update_date: chosen.update_date,
      } : null,
      capture_context_event_id: eventId,
      safety_role: answers.safetyRole,
      match_disposition: answers.matchDisposition,
      observed_condition: answers.observedCondition,
      workers_present: answers.workersPresent,
      navigation_checked: answers.navigationChecked,
      navigation_result: answers.navigationChecked ? answers.navigationResult : "not_checked",
      map_provider: answers.navigationChecked ? answers.mapProvider : "unknown",
      vehicle_response: answers.vehicleResponse,
      notes: answers.notes,
      location: userLocation ? {
        latitude: userLocation.latitude,
        longitude: userLocation.longitude,
        accuracy_meters: userLocation.accuracyMeters,
        captured_at: userLocation.capturedAt,
        distance_to_geometry_meters: chosen?.distanceMeters ?? null,
        classification: classify(chosen?.distanceMeters ?? null, userLocation.accuracyMeters),
        closest_point: chosen?.closestPoint || null,
      } : { classification: "location_unavailable" },
      photos: reportState.photos.map((file) => ({
        name: file.name, type: file.type, size: file.size, blob: file,
      })),
      status: "queued",
      sent_at: null,
      send_error: "",
    };
  };

  const saveAndSend = async (record, submitButton) => {
    submitButton.disabled = true;
    submitButton.textContent = "Sending…";
    try {
      await saveReport(record);
    } catch (error) {
      submitButton.disabled = false;
      submitButton.textContent = "Send report";
      throw new Error(`The report could not be saved on this phone: ${error?.message || error}`);
    }
    await refreshBadge();
    try {
      await sendReport(record);
      window.location.hash = `#/pending?sent=${encodeURIComponent(record.id)}`;
    } catch (error) {
      record.send_error = String(error.message || error);
      await saveReport(record);
      window.location.hash = `#/pending?saved=${encodeURIComponent(record.id)}`;
    }
  };

  const renderReport = (eventId, params) => {
    const origin = zoneById(eventId);
    if (!origin) { view.innerHTML = `<p class="empty">This MDOT record is not in the current data.</p>`; return; }
    reportState.photos = [];
    if ((params.get("mode") || "") === "full") renderFullInspection(eventId);
    else renderQuickCheck(eventId);
  };

  /* ----- quick check: role, workers yes/no, auto GPS, send ----- */

  const renderQuickCheck = (eventId) => {
    const origin = zoneById(eventId);
    view.innerHTML = `
      <a class="back-link" href="#/zone/${encodeURIComponent(eventId)}">← ${esc(origin.road_display)}</a>
      <h1>Quick check</h1>
      <p class="form-help">One question, sent immediately for review. Your location and time are captured automatically.</p>
      <form id="quick-form">
        <fieldset class="panel">
          <legend>You are</legend>
          <div class="safety-banner"><span class="safety-icon">!</span>
            <p><strong>Continue only if you are legally parked or a passenger.</strong> Never answer while driving.</p></div>
          ${optionList("safety_role", [["parked", "Parked"], ["passenger", "Passenger"]])}
        </fieldset>

        <fieldset class="panel">
          <legend>Are workers still present in this work zone?</legend>
          <div class="big-choice">
            <label><input type="radio" name="workers_present" value="yes" required><span>Yes</span></label>
            <label><input type="radio" name="workers_present" value="no" required><span>No</span></label>
            <label class="wide"><input type="radio" name="workers_present" value="unknown" required><span>I could not tell</span></label>
          </div>
        </fieldset>

        <fieldset class="panel">
          <legend>Work zone</legend>
          <p id="quick-zone-line" class="form-help">Matching by your location…</p>
          <details id="quick-zone-change">
            <summary class="form-help" style="cursor:pointer;color:var(--navy);font-weight:700">Not this one? Choose the right record</summary>
            <div id="quick-candidates" class="candidate-scroll"></div>
            <div class="option-list" style="margin-top:8px">
              <label><input type="radio" name="candidate" value=""><span>No matching MDOT work zone is shown</span></label>
            </div>
          </details>
          <p id="quick-gps" class="form-help"></p>
        </fieldset>

        <details class="panel" style="padding:14px">
          <summary style="font-weight:800;cursor:pointer">Add photographs or a note (optional)</summary>
          <div style="margin-top:10px">
            ${photoSection("quick")}
            <label style="display:block;margin-top:10px">Short note
              <textarea name="notes" maxlength="1000" rows="2"></textarea>
            </label>
          </div>
        </details>

        <p class="form-error" id="quick-error" hidden></p>
        <button class="button button-primary button-send" type="submit">Send report</button>
        <p class="form-help" style="text-align:center;margin-top:10px">
          Doing a full inspection? <a href="#/report/${encodeURIComponent(eventId)}?mode=full">Open the full form</a>.
        </p>
      </form>`;

    const zoneLine = document.getElementById("quick-zone-line");
    const gpsLine = document.getElementById("quick-gps");
    const candidatesBox = document.getElementById("quick-candidates");
    let autoSelectedId = eventId;

    const refreshZoneLine = () => {
      const picked = document.querySelector('input[name="candidate"]:checked');
      const pickedId = picked ? picked.value : autoSelectedId;
      if (!pickedId) {
        zoneLine.innerHTML = `No matching MDOT work zone selected — the report still sends for manual review.`;
        return;
      }
      const zone = withDistance(zoneById(pickedId) || zoneById(eventId));
      zoneLine.innerHTML = `<strong>${esc(zone.road_display)}</strong> · ${esc(zone.event_id)} · ${esc(distanceLabel(zone.distanceMeters))}`;
    };

    const refreshCandidates = () => {
      const nearby = nearbyCandidates(eventId);
      if (userLocation && nearby.length && nearby[0].distanceMeters !== null) {
        autoSelectedId = nearby[0].event_id;
      }
      candidatesBox.innerHTML = nearby
        .map((zone) => candidateRow(zone, zone.event_id === autoSelectedId))
        .join("");
      refreshZoneLine();
    };

    view.addEventListener("change", (event) => {
      if (event.target.name === "candidate") refreshZoneLine();
    });

    (async () => {
      gpsLine.textContent = "Requesting your current location…";
      const location = await requestLocation();
      gpsLine.textContent = location
        ? `Location captured · GPS accuracy about ${Math.round(location.accuracyMeters)} m · recorded as observed.`
        : "Location was not captured — the report still sends for manual review.";
      refreshCandidates();
    })();

    wirePhotoSection("quick");

    document.getElementById("quick-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorBox = document.getElementById("quick-error");
      errorBox.hidden = true;
      const data = new FormData(event.target);
      const picked = document.querySelector('input[name="candidate"]:checked');
      const candidateId = picked ? picked.value : autoSelectedId;
      const record = buildRecord(eventId, {
        reportMode: "quick_check",
        safetyRole: String(data.get("safety_role")),
        workersPresent: String(data.get("workers_present")),
        candidateId: candidateId || null,
        matchDisposition: candidateId ? "cannot_tell" : "no_matching_record",
        observedCondition: "cannot_tell",
        navigationChecked: false,
        navigationResult: "not_checked",
        mapProvider: "unknown",
        vehicleResponse: "not_observed",
        notes: String(data.get("notes") || "").trim(),
      });
      try {
        await saveAndSend(record, event.target.querySelector(".button-send"));
      } catch (error) {
        errorBox.textContent = String(error.message || error);
        errorBox.hidden = false;
      }
    });
  };

  /* ----- full inspection: the complete evidence-grade form ----- */

  const renderFullInspection = (eventId) => {
    const origin = zoneById(eventId);
    view.innerHTML = `
      <a class="back-link" href="#/report/${encodeURIComponent(eventId)}">← Quick check</a>
      <h1>Full inspection</h1>
      <p class="form-help">The complete evidence-grade report for a parked observer or assigned reviewer. It sends immediately for review.</p>
      <form id="report-form">
        <fieldset class="panel">
          <legend>1. Safety</legend>
          <div class="safety-banner"><span class="safety-icon">!</span>
            <p><strong>Continue only if you are legally parked or a passenger.</strong> Do not enter a closure or stop on a freeway shoulder.</p></div>
          <div class="option-list">
            <label><input id="safety-ok" type="checkbox" required><span>I can continue safely.</span></label>
          </div>
        </fieldset>

        <fieldset class="panel">
          <legend>2. Your role</legend>
          ${optionList("safety_role", [["parked", "Parked"], ["passenger", "Passenger"]])}
        </fieldset>

        <fieldset class="panel">
          <legend>3. Match the road work</legend>
          <p class="form-help" id="gps-note">Requesting your current location…</p>
          <button class="button" type="button" id="retry-gps">Try location again</button>
          <div id="candidates" class="candidate-scroll"></div>
          <p class="form-help">Nothing is selected automatically. Compare the road, direction, and cross streets.</p>
          <h3 style="margin-top:12px">How does the selected record relate to what you observed?</h3>
          ${optionList("match_disposition", [
            ["selected_record", "This is the work zone I observed"],
            ["reported_location_incorrect", "MDOT's reported location appears incorrect"],
            ["not_observed", "This is not the work zone I observed"],
            ["cannot_tell", "I cannot tell"],
            ["no_matching_record", "No matching MDOT work zone is shown"],
          ])}
        </fieldset>

        <fieldset class="panel">
          <legend>4. Are workers still present?</legend>
          ${optionList("workers_present", [
            ["yes", "Yes"],
            ["no", "No"],
            ["unknown", "I could not tell"],
          ])}
        </fieldset>

        <fieldset class="panel">
          <legend>5. What road condition did you observe?</legend>
          ${optionList("observed_condition", [
            ["matches_mdot", "It matched the MDOT listing"],
            ["does_not_match", "It did not match the MDOT listing"],
            ["cannot_tell", "I could not tell"],
          ])}
        </fieldset>

        <fieldset class="panel">
          <legend>6. Did you personally check directions in a navigation app?</legend>
          ${optionList("navigation_checked", [["no", "No"], ["yes", "Yes"]])}
          <div id="navigation-follow-up" hidden>
            <h3 style="margin-top:12px">What did the directions do?</h3>
            ${optionList("navigation_result", [
              ["routed_around", "Routed me around the closure"],
              ["directed_toward_closure", "Directed me toward the closed road or ramp"],
              ["closure_shown_route_unclear", "Showed the closure, but the route was unclear"],
              ["cannot_tell", "I could not tell"],
            ], false)}
            <h3 style="margin-top:12px">Which navigation app?</h3>
            ${optionList("map_provider", [
              ["google_maps", "Google Maps"], ["waze", "Waze"],
              ["apple_maps", "Apple Maps"], ["other", "Another app"], ["unknown", "I do not know"],
            ], false)}
          </div>
        </fieldset>

        <fieldset class="panel">
          <legend>7. What did you observe a vehicle do?</legend>
          ${optionList("vehicle_response", [
            ["turned_around", "Turned around"],
            ["stopped_at_closure", "Stopped at the closure"],
            ["took_detour", "Took a detour"],
            ["other", "Other"],
            ["not_observed", "I did not observe a vehicle response"],
          ])}
        </fieldset>

        <fieldset class="panel">
          <legend>8. Photographs</legend>
          <p class="form-help">Original files are kept as-is. Up to ${MAX_PHOTOS}.</p>
          ${photoSection("full")}
        </fieldset>

        <fieldset class="panel">
          <legend>9. Optional short note</legend>
          <textarea name="notes" maxlength="1000" rows="3"></textarea>
        </fieldset>

        <p class="form-error" id="form-error" hidden></p>
        <button class="button button-primary button-send" type="submit">Send report</button>
      </form>`;

    const candidatesBox = document.getElementById("candidates");
    const gpsNote = document.getElementById("gps-note");

    const renderCandidates = () => {
      candidatesBox.innerHTML = nearbyCandidates(eventId)
        .map((zone) => candidateRow(zone, false))
        .join("");
    };
    const captureLocation = async () => {
      gpsNote.textContent = "Requesting your current location…";
      const location = await requestLocation();
      gpsNote.textContent = location
        ? `Location captured: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)} · GPS accuracy about ${Math.round(location.accuracyMeters)} m. Your exact coordinates are saved as observed.`
        : "Location was not captured. You can still send this report for manual review.";
      renderCandidates();
    };
    document.getElementById("retry-gps").addEventListener("click", captureLocation);
    captureLocation();

    const form = document.getElementById("report-form");
    form.addEventListener("change", (event) => {
      if (event.target.name === "navigation_checked") {
        document.getElementById("navigation-follow-up").hidden = event.target.value !== "yes";
      }
    });
    wirePhotoSection("full");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const errorBox = document.getElementById("form-error");
      errorBox.hidden = true;
      const data = new FormData(form);
      const navigationChecked = data.get("navigation_checked") === "yes";
      if (navigationChecked && (!data.get("navigation_result") || !data.get("map_provider"))) {
        errorBox.textContent = "Answer both navigation questions or choose No for question 6.";
        errorBox.hidden = false;
        return;
      }
      const chosenId = data.get("candidate");
      const disposition = String(data.get("match_disposition"));
      if (disposition !== "no_matching_record" && !chosenId) {
        errorBox.textContent = "Choose an MDOT record in step 3, or answer that no matching work zone is shown.";
        errorBox.hidden = false;
        return;
      }
      const record = buildRecord(eventId, {
        reportMode: "full_inspection",
        safetyRole: String(data.get("safety_role")),
        workersPresent: String(data.get("workers_present")),
        candidateId: disposition === "no_matching_record" ? null : String(chosenId),
        matchDisposition: disposition,
        observedCondition: String(data.get("observed_condition")),
        navigationChecked,
        navigationResult: String(data.get("navigation_result") || "not_checked"),
        mapProvider: String(data.get("map_provider") || "unknown"),
        vehicleResponse: String(data.get("vehicle_response")),
        notes: String(data.get("notes") || "").trim(),
      });
      try {
        await saveAndSend(record, form.querySelector(".button-send"));
      } catch (error) {
        errorBox.textContent = String(error.message || error);
        errorBox.hidden = false;
      }
    });
  };

  /* ---------- saved reports ---------- */

  const exportReport = async (record) => {
    const json = new File(
      [JSON.stringify(exportablePayload(record), null, 2)],
      `${record.id}.json`,
      { type: "application/json" },
    );
    const files = [json, ...record.photos.map((photo, index) =>
      new File([photo.blob], photo.name || `${record.id}-photo-${index + 1}`, { type: photo.type || "image/jpeg" }))];
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files, title: record.id });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };

  const reportStatusChip = (record) => {
    if (record.status === "sent") {
      return `<span class="chip chip-sent">Sent ${record.sent_at ? esc(new Date(record.sent_at).toLocaleString()) : ""}</span>`;
    }
    if (record.status === "queued") {
      return `<span class="chip chip-queued">Waiting to send — retries automatically</span>`;
    }
    return `<span class="chip">Saved on this phone</span>`;
  };

  const renderPending = async (params) => {
    let reports = [];
    try { reports = await listReports(); } catch { /* shown below */ }
    reports.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const sentId = params.get("sent");
    const savedId = params.get("saved");
    view.innerHTML = `
      <a class="back-link" href="#/">← All work zones</a>
      <h1>Your reports</h1>
      ${sentId ? `<div class="notice success">Report ${esc(sentId)} was sent for review.</div>` : ""}
      ${savedId ? `<div class="notice error">Report ${esc(savedId)} is saved on this phone — it could not be sent yet and will retry automatically.</div>` : ""}
      <p class="form-help">Reports send immediately when possible. Anything that could not send stays here and retries when you are back online. Export is a manual backup.</p>
      <div class="card-list" style="grid-template-columns:1fr">
        ${reports.map((record) => `
          <article class="report-card" data-id="${esc(record.id)}">
            <h3>${esc(record.id)}</h3>
            <p class="meta">${esc(record.created_at_local || record.created_at)} · ${esc(record.zone?.road_display || "No matching MDOT record")} · ${esc(String(record.photos.length))} photo(s)${record.workers_present ? ` · Workers: ${esc(record.workers_present)}` : ""}</p>
            <p class="meta">${reportStatusChip(record)}</p>
            <div class="button-row" style="margin-top:10px">
              ${record.status !== "sent" ? `<button class="button button-primary" data-action="send">Send now</button>` : ""}
              <button class="button" data-action="export">Export</button>
              <button class="button" data-action="delete">Delete</button>
            </div>
          </article>`).join("") || `<p class="empty">No reports on this phone.</p>`}
      </div>`;

    view.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const card = button.closest(".report-card");
      const record = reports.find((item) => item.id === card.dataset.id);
      if (!record) return;
      if (button.dataset.action === "send") {
        button.disabled = true;
        button.textContent = "Sending…";
        try {
          await sendReport(record);
          window.location.hash = `#/pending?sent=${encodeURIComponent(record.id)}`;
          renderPending(new URLSearchParams(`sent=${encodeURIComponent(record.id)}`));
        } catch (error) {
          record.send_error = String(error.message || error);
          await saveReport(record);
          button.disabled = false;
          button.textContent = "Send now";
          window.alert(String(error.message || error));
        }
        refreshBadge();
        return;
      }
      if (button.dataset.action === "export") {
        button.disabled = true;
        try { await exportReport(record); } finally { button.disabled = false; }
      }
      if (button.dataset.action === "delete") {
        if (!window.confirm(`Delete ${record.id} from this phone?${record.status !== "sent" ? " It has NOT been sent yet." : ""}`)) return;
        await deleteReport(record.id);
        await refreshBadge();
        renderPending(new URLSearchParams());
      }
    }, { once: true });
  };

  /* ---------- router ---------- */

  const route = async () => {
    destroyMap();
    const hash = window.location.hash || "#/";
    const [path, queryString] = hash.slice(1).split("?");
    const params = new URLSearchParams(queryString || "");
    const parts = path.split("/").filter(Boolean);
    window.scrollTo(0, 0);
    if (!parts.length) { renderList(); return; }
    if (parts[0] === "zone" && parts[1]) { renderZone(decodeURIComponent(parts[1])); return; }
    if (parts[0] === "report" && parts[1]) { renderReport(decodeURIComponent(parts[1]), params); return; }
    if (parts[0] === "pending") { await renderPending(params); return; }
    renderList();
  };

  window.addEventListener("hashchange", route);

  /* ---------- start ---------- */

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  }

  loadDataset().then(() => { route(); refreshBadge(); retryQueuedReports(); });
})();
