/**
 * Fr. Bobby Vogel — Meeting Scheduler (Google Apps Script web app)
 * ----------------------------------------------------------------
 * Public booking site that reads Fr. Bobby's Google Calendar, offers open
 * times at the parish where he celebrates Mass that day, writes bookings back
 * to his calendar, and emails everyone when anything changes.
 *
 * Files in this project:  Code.gs  ·  Index.html  ·  appsscript.json
 * First-time setup: run  setup()  once, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Then run  showLinks().
 */

/* =========================================================================
 *  SETTINGS — edit freely
 * ========================================================================= */
var CONFIG = {
  OWNER_NAME: 'Fr. Bobby Vogel',
  ADMIN_EMAIL: 'bvogel@stmaryrush.org',        // where "new / changed meeting" alerts go
  // Your own booking page, once the scheduler is embedded on your website with the
  // JavaScript embed code (e.g. 'https://www.example.com/schedule'). Emailed links and
  // "Book a new time" buttons then point there. Leave '' to use the Google link.
  PUBLIC_URL: '',
  TIMEZONE: 'America/Indiana/Indianapolis',

  // Calendar that bookings are written to.
  BOOKING_CALENDAR_ID: 'primary',
  // "Fr. Bobby Masses" — decides WHERE he is each day.
  MASS_CALENDAR_ID: 'c_403df8beafb2fb918b04cffa209b79d742f2889c539bc65f6e46348765d2186d@group.calendar.google.com',
  // Every calendar whose events should block a time slot.
  BUSY_CALENDAR_IDS: [
    'primary',
    'c_403df8beafb2fb918b04cffa209b79d742f2889c539bc65f6e46348765d2186d@group.calendar.google.com'
  ],

  BUFFER_MINUTES: 15,      // gap kept before and after every existing event
  SLOT_STEP_MINUTES: 30,   // offered start times: 9:00, 9:30, 10:00 …
  MIN_NOTICE_HOURS: 24,    // earliest a slot can be booked (per-type override below)
  DAYS_AHEAD: 60,          // how far out people can book
  CLOSED_WEEKDAYS: [0, 1], // 0 = Sunday, 1 = Monday — never bookable

  // Meeting hours by weekday (2 = Tue … 6 = Sat). Meetings must start and end inside.
  HOURS: {
    2: ['09:00', '19:30'],
    3: ['09:00', '19:30'],
    4: ['09:00', '19:30'],
    5: ['09:00', '19:30'],
    6: ['09:00', '16:00']
  },

  // Only offer a parish on days Fr. Bobby celebrates Mass there.
  REQUIRE_MASS_AT_LOCATION: true,
  MASS_TITLE: /\b(mass|misa)\b/i,
  // Mass locations that are NOT bookable (Richmond, Liberty…) — ignored for location.
  OTHER_PLACES: /richmond|liberty|bridget|st\.? andrew/i,
  // All-day events with these words block the whole day even if marked "Free".
  DAY_OFF_TITLE: /vacation|out of office|\booo\b|day off|retreat|\baway\b/i,

  BOOKING_COLOR_ID: '5',   // Google Calendar color for booked meetings (5 = Banana)

  LOCATIONS: [
    {
      id: 'rushville', name: 'Rushville', parish: 'St. Mary Catholic Church',
      address: '512 N Perkins St, Rushville, IN 46173',
      match: /rushville|perkins|st\.? mary'?s church|^sm\b/i, colorIds: ['11']
    },
    {
      id: 'connersville', name: 'Connersville', parish: 'St. Gabriel Catholic Church',
      address: '232 W 9th St, Connersville, IN 47331',
      match: /connersville|gabriel|^sg\b/i, colorIds: ['10']
    }
  ],

  TYPES: [
    { id: 'marriage', name: 'Marriage Preparation', short: 'Marriage Prep', minutes: 60, icon: 'rings',
      blurb: 'Begin preparing for your wedding in the Church. Please reach out at least six months before your date.' },
    { id: 'sacramental', name: 'Sacramental Preparation', short: 'Sacramental Prep', minutes: 45, icon: 'shell',
      options: ['Baptism', 'Confirmation'],
      blurb: 'Plan a Baptism for your child, or talk through Confirmation.' },
    { id: 'ocia', name: 'OCIA: Joining the Church', short: 'OCIA', minutes: 60, icon: 'door',
      blurb: 'Curious about becoming Catholic, or finishing your sacraments as an adult? Start here.' },
    { id: 'funeral', name: 'Funeral Planning', short: 'Funeral Planning', minutes: 60, icon: 'candle', minNoticeHours: 4,
      blurb: 'Plan the Funeral Mass for someone you love. If a death has just occurred, please also call the parish office.' },
    { id: 'dinner', name: 'Dinner or Social Visit', short: 'Dinner', minutes: 120, icon: 'table', needsAddress: true,
      hours: ['17:00', '21:00'],
      blurb: 'Invite Fr. Bobby to share a meal with your family.' }
  ],

  // Extra dates to close, e.g. '2026-12-26': 'Christmas break'
  EXTRA_CLOSED_DATES: {
  }
};

/* =========================================================================
 *  WEB APP ENTRY
 * ========================================================================= */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var t = HtmlService.createTemplateFromFile('Index');
  var boot = {
    page: ['manage', 'admin'].indexOf(p.page) >= 0 ? p.page : 'book',
    id: p.id || '', token: p.t || '', key: p.key || '', loc: p.loc || '',
    baseUrl: publicUrl_(),
    embed: p.embed === '1',
    owner: CONFIG.OWNER_NAME,
    tz: CONFIG.TIMEZONE,
    locations: CONFIG.LOCATIONS.map(function (l) {
      return { id: l.id, name: l.name, parish: l.parish, address: l.address };
    }),
    types: CONFIG.TYPES.map(function (x) {
      return { id: x.id, name: x.name, minutes: x.minutes, icon: x.icon, blurb: x.blurb,
               options: x.options || null, needsAddress: !!x.needsAddress };
    })
  };
  t.boot = JSON.stringify(boot).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Schedule a visit · ' + CONFIG.OWNER_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* =========================================================================
 *  PUBLIC API (called from the page with google.script.run)
 * ========================================================================= */

/** Open days + time slots for a parish and meeting type. */
function getAvailability(locationId, typeId, bookingId, token) {
  var loc = findLocation_(locationId), type = findType_(typeId);
  var exclude = null;
  if (bookingId) {               // rescheduling: ignore the person's own current slot
    var b = authBooking_(bookingId, token);
    exclude = b.eventId;
  }
  return availabilityPayload_(loc, type, exclude, false);
}

/** Create a booking. */
function createBooking(form) {
  form = form || {};
  if (form.website) throw new Error('Something went wrong. Please try again.'); // bot honeypot
  var loc = findLocation_(form.location), type = findType_(form.type);
  var c = validateContact_(form, type);
  var start = Number(form.start);
  if (!start) throw new Error('Please choose a time.');

  var active = readBookings_().filter(function (b) {
    return b.status === 'Confirmed' && b.email.toLowerCase() === c.email.toLowerCase() && b.start > Date.now();
  });
  if (active.length >= 4) throw new Error('You already have several meetings on the calendar. Please contact the parish office to schedule more.');

  var booking;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    assertSlotOpen_(loc, type, start, null, false);
    booking = {
      id: newId_(), token: newToken_(), status: 'Confirmed',
      location: loc.id, type: type.id, detail: c.detail,
      start: start, end: start + type.minutes * 60000,
      name: c.name, email: c.email, phone: c.phone, address: c.address, notes: c.notes,
      eventId: '', seq: 0, created: new Date().toISOString(), log: ''
    };
    var ev = Calendar.Events.insert(eventResource_(booking), CONFIG.BOOKING_CALENDAR_ID, { sendUpdates: 'none' });
    booking.eventId = ev.id;
    booking.eventLink = ev.htmlLink;
    addLog_(booking, 'Booked by ' + c.name);
    insertBooking_(booking);
    clearCache_();
  } finally {
    lock.releaseLock();
  }
  safe_(function () { emailPerson_('created', booking); });
  safe_(function () { emailAdmin_('created', booking); });
  return view_(booking, true);
}

/** Booking details for the person's "manage" link. */
function getBooking(id, token) {
  return view_(authBooking_(id, token), true);
}

/** The person moves their own meeting. */
function rescheduleBooking(id, token, newStart) {
  var b, old;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    b = authBooking_(id, token);
    assertChangeable_(b);
    newStart = Number(newStart);
    var loc = findLocation_(b.location), type = findType_(b.type);
    assertSlotOpen_(loc, type, newStart, b.eventId, false);
    old = b.start;
    moveBooking_(b, newStart, 'Moved by ' + b.name);
  } finally {
    lock.releaseLock();
  }
  safe_(function () { emailPerson_('moved-self', b, { oldStart: old }); });
  safe_(function () { emailAdmin_('moved', b, { oldStart: old }); });
  return view_(b, true);
}

/** The person cancels. */
function cancelBooking(id, token, reason) {
  var b;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    b = authBooking_(id, token);
    assertChangeable_(b);
    cancel_(b, 'Cancelled by ' + b.name + (reason ? ': ' + String(reason).slice(0, 300) : ''));
  } finally {
    lock.releaseLock();
  }
  safe_(function () { emailPerson_('cancelled-self', b); });
  safe_(function () { emailAdmin_('cancelled', b, { reason: reason }); });
  return view_(b, true);
}

/* ---------- Admin (Fr. Bobby) ---------- */

function adminList(key) {
  checkAdmin_(key);
  var now = Date.now(), all = readBookings_();
  var sortAsc = function (a, b) { return a.start - b.start; };
  return {
    sheetUrl: getSheet_().getParent().getUrl(),
    publicUrl: publicUrl_(),
    upcoming: all.filter(function (b) { return b.status === 'Confirmed' && b.end >= now; }).sort(sortAsc).map(function (b) { return view_(b, false); }),
    past: all.filter(function (b) { return b.status === 'Confirmed' && b.end < now && b.end > now - 45 * 864e5; }).sort(sortAsc).reverse().map(function (b) { return view_(b, false); }),
    cancelled: all.filter(function (b) { return b.status === 'Cancelled' && b.start > now - 45 * 864e5; }).sort(sortAsc).reverse().map(function (b) { return view_(b, false); })
  };
}

function adminAvailability(key, id) {
  checkAdmin_(key);
  var b = findBooking_(id);
  if (!b) throw new Error('Meeting not found.');
  return availabilityPayload_(findLocation_(b.location), findType_(b.type), b.eventId, true);
}

/** Move a meeting. force = true skips the availability check (manual override). */
function adminReschedule(key, id, newStart, message, force) {
  checkAdmin_(key);
  var b, old;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    b = findBooking_(id);
    if (!b || b.status !== 'Confirmed') throw new Error('This meeting is no longer active.');
    if (typeof newStart === 'string' && newStart.indexOf('T') > 0) {   // manual "YYYY-MM-DDTHH:mm" (parish time)
      newStart = zoned_(newStart.slice(0, 10), newStart.slice(11, 16)).getTime();
    }
    newStart = Number(newStart);
    if (!newStart) throw new Error('Choose a new time.');
    if (!force) assertSlotOpen_(findLocation_(b.location), findType_(b.type), newStart, b.eventId, true);
    old = b.start;
    moveBooking_(b, newStart, 'Moved by ' + CONFIG.OWNER_NAME + (message ? ': ' + message : ''));
  } finally {
    lock.releaseLock();
  }
  safe_(function () { emailPerson_('moved-admin', b, { oldStart: old, message: message }); });
  return view_(b, false);
}

function adminCancel(key, id, message) {
  checkAdmin_(key);
  var b;
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    b = findBooking_(id);
    if (!b || b.status !== 'Confirmed') throw new Error('This meeting is no longer active.');
    cancel_(b, 'Cancelled by ' + CONFIG.OWNER_NAME + (message ? ': ' + message : ''));
  } finally {
    lock.releaseLock();
  }
  safe_(function () { emailPerson_('cancelled-admin', b, { message: message }); });
  return view_(b, false);
}

/* =========================================================================
 *  CALENDAR SYNC — runs every 15 min (installed by setup()).
 *  If Fr. Bobby drags or deletes a booked meeting directly in Google Calendar,
 *  the person is emailed automatically.
 * ========================================================================= */
function syncCalendarChanges() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  var notices = [];
  try {
    var now = Date.now();
    readBookings_().forEach(function (b) {
      if (b.status !== 'Confirmed' || b.end < now || !b.eventId) return;
      var ev = null;
      try { ev = Calendar.Events.get(CONFIG.BOOKING_CALENDAR_ID, b.eventId); } catch (err) { ev = null; }
      if (!ev || ev.status === 'cancelled') {
        cancel_(b, 'Deleted in Google Calendar', true);
        notices.push(['cancelled-admin', b, {}]);
        return;
      }
      var s = ev.start && ev.start.dateTime ? new Date(ev.start.dateTime).getTime() : null;
      var e = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime).getTime() : null;
      if (s && (s !== b.start || e !== b.end)) {
        var old = b.start;
        b.start = s; b.end = e; b.seq = (b.seq || 0) + 1;
        addLog_(b, 'Moved in Google Calendar');
        saveBooking_(b);
        notices.push(['moved-admin', b, { oldStart: old }]);
      }
    });
    if (notices.length) clearCache_();
  } finally {
    lock.releaseLock();
  }
  notices.forEach(function (n) { safe_(function () { emailPerson_(n[0], n[1], n[2]); }); });
}

/* =========================================================================
 *  AVAILABILITY ENGINE
 * ========================================================================= */
function availabilityPayload_(loc, type, excludeEventId, isAdmin) {
  var now = new Date();
  var fromYmd = ymdOf_(now);
  var days = CONFIG.DAYS_AHEAD + 1;
  var data = loadCalendarWindow_(fromYmd, days, !!excludeEventId);
  var t = type;
  if (isAdmin) { t = clone_(type); t.minNoticeHours = 0; }
  var list = computeAvailability_({
    location: loc, type: t, massEvents: data.mass, busyEvents: data.busy,
    nowMs: now.getTime(), fromYmd: fromYmd, days: days, excludeEventId: excludeEventId
  });
  return { tz: CONFIG.TIMEZONE, location: loc.id, type: type.id, days: list };
}

/**
 * Pure function (no Apps Script services except date formatting) so it can be tested.
 * Returns [{date:'YYYY-MM-DD', reason:null|string, elsewhere:locId|null, slots:[{t,label}]}]
 */
function computeAvailability_(o) {
  var massPlaces = {};
  o.massEvents.forEach(function (ev) {
    if (ev.status === 'cancelled' || !ev.start || !ev.start.dateTime) return;
    if (!CONFIG.MASS_TITLE.test(ev.summary || '')) return;
    var place = classifyPlace_(ev);
    if (!place) return;
    var ymd = ymdOf_(new Date(ev.start.dateTime));
    (massPlaces[ymd] = massPlaces[ymd] || {})[place] = true;
  });

  var blockedDays = {}, busy = [];
  o.busyEvents.forEach(function (ev) {
    if (ev.status === 'cancelled') return;
    if (o.excludeEventId && ev.id === o.excludeEventId) return;
    if (ev.start && ev.start.date) {                       // all-day event
      if (isBlocking_(ev) || CONFIG.DAY_OFF_TITLE.test(ev.summary || '')) {
        for (var d = ev.start.date; d < ev.end.date; d = addDays_(d, 1)) blockedDays[d] = true;
      }
      return;
    }
    if (!isBlocking_(ev)) return;
    busy.push([new Date(ev.start.dateTime).getTime(), new Date(ev.end.dateTime).getTime()]);
  });

  var type = o.type, loc = o.location;
  var noticeH = type.minNoticeHours != null ? type.minNoticeHours : CONFIG.MIN_NOTICE_HOURS;
  var earliest = o.nowMs + noticeH * 3600000;
  var dur = type.minutes * 60000, buf = CONFIG.BUFFER_MINUTES * 60000, step = CONFIG.SLOT_STEP_MINUTES * 60000;
  var out = [];

  for (var i = 0; i < o.days; i++) {
    var ymd = addDays_(o.fromYmd, i);
    var wd = weekday_(ymd);
    var day = { date: ymd, reason: null, elsewhere: null, slots: [] };
    var places = massPlaces[ymd] || {};
    var holiday = holidayName_(ymd);

    if (CONFIG.CLOSED_WEEKDAYS.indexOf(wd) >= 0) day.reason = 'Closed';
    else if (holiday) day.reason = holiday;
    else if (blockedDays[ymd]) day.reason = 'Away';
    else if (CONFIG.REQUIRE_MASS_AT_LOCATION && !places[loc.id]) {
      var other = Object.keys(places)[0] || null;
      day.elsewhere = other;
      day.reason = other ? 'In ' + findLocation_(other).name : 'Not available';
    }

    if (!day.reason) {
      var hours = type.hours || CONFIG.HOURS[wd];
      if (!hours) day.reason = 'Closed';
      else {
        var ws = zoned_(ymd, hours[0]).getTime(), we = zoned_(ymd, hours[1]).getTime();
        for (var s = ws; s + dur <= we; s += step) {
          if (s < earliest) continue;
          var e = s + dur, ok = true;
          for (var k = 0; k < busy.length; k++) {
            if (s - buf < busy[k][1] && e + buf > busy[k][0]) { ok = false; break; }
          }
          if (ok) day.slots.push({ t: s, label: fmt_(new Date(s), 'h:mm a') });
        }
        if (!day.slots.length) day.reason = (we <= earliest) ? 'Too soon' : 'Fully booked';
      }
    }
    out.push(day);
  }
  return out;
}

/** Does this event make Fr. Bobby busy? */
function isBlocking_(ev) {
  if (ev.status === 'cancelled') return false;
  if (ev.eventType === 'workingLocation' || ev.eventType === 'birthday') return false;
  if (ev.transparency === 'transparent') return false;      // marked "Free"
  if (ev.selfStatus === 'declined') return false;           // invitations he declined
  return true;
}

/** Which bookable parish is this event at? */
function classifyPlace_(ev) {
  var where = ev.location || '', what = ev.summary || '';
  if (CONFIG.OTHER_PLACES.test(where)) return null;
  for (var i = 0; i < CONFIG.LOCATIONS.length; i++) {
    var L = CONFIG.LOCATIONS[i];
    if (L.match.test(where) || L.match.test(what)) return L.id;
  }
  if (!where && ev.colorId) {
    for (var j = 0; j < CONFIG.LOCATIONS.length; j++) {
      if (CONFIG.LOCATIONS[j].colorIds.indexOf(String(ev.colorId)) >= 0) return CONFIG.LOCATIONS[j].id;
    }
  }
  return null;
}

/** Major holidays & seasons when nothing is scheduled. */
function holidayName_(ymd) {
  if (CONFIG.EXTRA_CLOSED_DATES[ymd]) return CONFIG.EXTRA_CLOSED_DATES[ymd];
  var y = Number(ymd.slice(0, 4)), md = ymd.slice(5);
  var fixed = {
    '12-24': 'Christmas Eve', '12-25': 'Christmas Day',
    '12-31': "New Year's Eve", '01-01': 'Mary, Mother of God',
    '07-04': 'Independence Day'
  };
  if (fixed[md]) return fixed[md];
  var diff = daysBetween_(easter_(y), ymd);
  if (diff === -46) return 'Ash Wednesday';
  if (diff >= -7 && diff <= 1) return 'Holy Week';      // Palm Sunday → Easter Monday
  if (ymd === thanksgiving_(y)) return 'Thanksgiving';
  return null;
}

function easter_(y) {
  var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
      m = Math.floor((a + 11 * h + 22 * l) / 451),
      month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return y + '-' + pad_(month) + '-' + pad_(day);
}

function thanksgiving_(y) {
  var w = weekday_(y + '-11-01');
  return y + '-11-' + pad_(1 + ((4 - w + 7) % 7) + 21);
}

function assertSlotOpen_(loc, type, start, excludeEventId, isAdmin) {
  var t = type;
  if (isAdmin) { t = clone_(type); t.minNoticeHours = 0; }
  var ymd = ymdOf_(new Date(start));
  var today = ymdOf_(new Date());
  if (!isAdmin && daysBetween_(today, ymd) > CONFIG.DAYS_AHEAD) throw new Error('That date is too far ahead. Please choose an earlier day.');
  var data = loadCalendarWindow_(ymd, 1, true);
  var day = computeAvailability_({
    location: loc, type: t, massEvents: data.mass, busyEvents: data.busy,
    nowMs: Date.now(), fromYmd: ymd, days: 1, excludeEventId: excludeEventId
  })[0];
  var ok = day.slots.some(function (s) { return s.t === start; });
  if (!ok) throw new Error('That time was just taken or is no longer available. Please pick another time.');
}

/* ---------- Calendar reads ---------- */
function loadCalendarWindow_(fromYmd, days, fresh) {
  var cacheKey = 'win:' + fromYmd + ':' + days;
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    var hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }
  var timeMin = zoned_(fromYmd, '00:00').toISOString();
  var timeMax = zoned_(addDays_(fromYmd, days), '00:00').toISOString();
  var ids = CONFIG.BUSY_CALENDAR_IDS.slice();
  if (ids.indexOf(CONFIG.MASS_CALENDAR_ID) < 0) ids.push(CONFIG.MASS_CALENDAR_ID);
  var mass = [], busy = [];
  ids.forEach(function (id) {
    var items = listEvents_(id, timeMin, timeMax);
    if (id === CONFIG.MASS_CALENDAR_ID) mass = items;
    if (CONFIG.BUSY_CALENDAR_IDS.indexOf(id) >= 0) busy = busy.concat(items);
  });
  var result = { mass: mass, busy: busy };
  try { cache.put(cacheKey, JSON.stringify(result), 90); registerCacheKey_(cacheKey); } catch (e) { /* too big — skip */ }
  return result;
}

function listEvents_(calendarId, timeMin, timeMax) {
  var out = [], pageToken = null;
  do {
    var res = Calendar.Events.list(calendarId, {
      timeMin: timeMin, timeMax: timeMax, singleEvents: true, orderBy: 'startTime',
      maxResults: 2500, pageToken: pageToken
    });
    (res.items || []).forEach(function (ev) {
      var me = (ev.attendees || []).filter(function (a) { return a.self; })[0];
      out.push({
        id: ev.id, summary: ev.summary || '', location: ev.location || '', status: ev.status,
        transparency: ev.transparency || '', eventType: ev.eventType || 'default', colorId: ev.colorId || '',
        selfStatus: me ? me.responseStatus : '', start: ev.start, end: ev.end
      });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

function registerCacheKey_(k) {
  var props = PropertiesService.getScriptProperties();
  var keys = JSON.parse(props.getProperty('CACHE_KEYS') || '[]');
  if (keys.indexOf(k) < 0) { keys.push(k); props.setProperty('CACHE_KEYS', JSON.stringify(keys.slice(-50))); }
}
function clearCache_() {
  var props = PropertiesService.getScriptProperties();
  var keys = JSON.parse(props.getProperty('CACHE_KEYS') || '[]');
  if (keys.length) CacheService.getScriptCache().removeAll(keys);
  props.setProperty('CACHE_KEYS', '[]');
}

/* ---------- Calendar writes ---------- */
function eventResource_(b) {
  var loc = findLocation_(b.location), type = findType_(b.type);
  var where = type.needsAddress ? b.address : loc.parish + ', ' + loc.address;
  var lines = [
    typeLabel_(b) + ' · ' + loc.name,
    '',
    'Name: ' + b.name,
    'Phone: ' + b.phone,
    'Email: ' + b.email
  ];
  if (b.address) lines.push('Address: ' + b.address);
  if (b.notes) lines.push('', 'Notes: ' + b.notes);
  lines.push('', 'Booking ' + b.id + ' — booked online.',
             'Drag this event to move it, or delete it to cancel; ' + firstName_(b.name) + ' will be emailed automatically.');
  return {
    summary: type.short + ': ' + b.name + (b.detail ? ' (' + b.detail + ')' : ''),
    location: where,
    description: lines.join('\n'),
    start: { dateTime: new Date(b.start).toISOString(), timeZone: CONFIG.TIMEZONE },
    end: { dateTime: new Date(b.end).toISOString(), timeZone: CONFIG.TIMEZONE },
    colorId: CONFIG.BOOKING_COLOR_ID,
    extendedProperties: { private: { fbBookingId: b.id } }
  };
}

function moveBooking_(b, newStart, logText) {
  var type = findType_(b.type);
  b.start = newStart;
  b.end = newStart + type.minutes * 60000;
  b.seq = (b.seq || 0) + 1;
  Calendar.Events.patch({
    start: { dateTime: new Date(b.start).toISOString(), timeZone: CONFIG.TIMEZONE },
    end: { dateTime: new Date(b.end).toISOString(), timeZone: CONFIG.TIMEZONE }
  }, CONFIG.BOOKING_CALENDAR_ID, b.eventId, { sendUpdates: 'none' });
  addLog_(b, logText);
  saveBooking_(b);
  clearCache_();
}

function cancel_(b, logText, eventAlreadyGone) {
  if (!eventAlreadyGone && b.eventId) {
    try { Calendar.Events.remove(CONFIG.BOOKING_CALENDAR_ID, b.eventId, { sendUpdates: 'none' }); } catch (e) { /* already gone */ }
  }
  b.status = 'Cancelled';
  b.seq = (b.seq || 0) + 1;
  addLog_(b, logText);
  saveBooking_(b);
  clearCache_();
}

/* =========================================================================
 *  STORAGE — a Google Sheet ("Fr. Bobby — Meeting Bookings")
 * ========================================================================= */
var COLS = ['ID', 'Token', 'Status', 'Location', 'Type', 'Detail', 'Start', 'End', 'Name', 'Email',
            'Phone', 'Address', 'Notes', 'EventId', 'Seq', 'Created', 'Updated', 'Log'];

function getSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id).getSheetByName('Bookings'); } catch (e) { /* recreate */ }
  }
  var ss = SpreadsheetApp.create('Fr. Bobby — Meeting Bookings');
  var sh = ss.getSheets()[0];
  sh.setName('Bookings');
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold').setBackground('#1D3A6E').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('A:R').setNumberFormat('@');
  props.setProperty('SHEET_ID', ss.getId());
  return sh;
}

function readBookings_() {
  var sh = getSheet_();
  var values = sh.getDataRange().getValues();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (!v[0]) continue;
    out.push({
      _row: r + 1, id: String(v[0]), token: String(v[1]), status: String(v[2]), location: String(v[3]),
      type: String(v[4]), detail: String(v[5]), start: new Date(v[6]).getTime(), end: new Date(v[7]).getTime(),
      name: String(v[8]), email: String(v[9]), phone: String(v[10]), address: String(v[11]), notes: String(v[12]),
      eventId: String(v[13]), seq: Number(v[14]) || 0, created: String(v[15]), updated: String(v[16]), log: String(v[17])
    });
  }
  return out;
}

function rowOf_(b) {
  return [b.id, b.token, b.status, b.location, b.type, b.detail || '',
          fmt_(new Date(b.start), "yyyy-MM-dd'T'HH:mm:ssXXX"), fmt_(new Date(b.end), "yyyy-MM-dd'T'HH:mm:ssXXX"),
          b.name, b.email, b.phone, b.address || '', b.notes || '', b.eventId || '', String(b.seq || 0),
          b.created || '', new Date().toISOString(), b.log || ''];
}

function insertBooking_(b) { getSheet_().appendRow(rowOf_(b)); }

function saveBooking_(b) {
  var sh = getSheet_();
  var row = b._row;
  if (!row) {
    var found = findBooking_(b.id);
    row = found && found._row;
  }
  if (!row) return insertBooking_(b);
  sh.getRange(row, 1, 1, COLS.length).setValues([rowOf_(b)]);
}

function findBooking_(id) {
  id = String(id || '').trim().toUpperCase();
  return readBookings_().filter(function (b) { return b.id === id; })[0] || null;
}

function authBooking_(id, token) {
  var b = findBooking_(id);
  if (!b || !token || b.token !== String(token)) throw new Error('We couldn\u2019t find that meeting. Please use the link from your confirmation email.');
  return b;
}

function assertChangeable_(b) {
  if (b.status !== 'Confirmed') throw new Error('This meeting has already been cancelled.');
  if (b.start < Date.now()) throw new Error('This meeting has already taken place.');
}

function addLog_(b, text) {
  var stamp = fmt_(new Date(), 'M/d h:mm a');
  b.log = (b.log ? b.log + '\n' : '') + stamp + ' — ' + text;
}

/* =========================================================================
 *  EMAIL
 * ========================================================================= */
function emailPerson_(kind, b, extra) {
  extra = extra || {};
  var loc = findLocation_(b.location), type = findType_(b.type);
  var first = firstName_(b.name);
  var when = longWhen_(b);
  var label = typeLabel_(b);
  var subject, intro, heading, accent = '#1D3A6E', showManage = true, ics = 'PUBLISH', bookAgain = false;

  if (kind === 'created') {
    heading = 'Your meeting is confirmed';
    subject = 'Confirmed: ' + label + ' with ' + CONFIG.OWNER_NAME + ' — ' + shortWhen_(b);
    intro = 'Dear ' + first + ',<br><br>Thank you for reaching out. Your meeting with ' + CONFIG.OWNER_NAME + ' is on the calendar.';
  } else if (kind === 'moved-self') {
    heading = 'Your meeting has moved';
    subject = 'Updated: your meeting is now ' + shortWhen_(b);
    intro = 'Dear ' + first + ',<br><br>Your meeting has been moved. Here are the new details' +
            (extra.oldStart ? ' (it was ' + esc_(fmt_(new Date(extra.oldStart), "EEEE, MMMM d 'at' h:mm a")) + ')' : '') + '.';
  } else if (kind === 'moved-admin') {
    heading = 'Your meeting was rescheduled';
    subject = CONFIG.OWNER_NAME + ' rescheduled your meeting — now ' + shortWhen_(b);
    intro = 'Dear ' + first + ',<br><br>' + CONFIG.OWNER_NAME + ' needed to move your meeting' +
            (extra.oldStart ? ' from ' + esc_(fmt_(new Date(extra.oldStart), "EEEE, MMMM d 'at' h:mm a")) : '') +
            '. The new time is below. If it doesn\u2019t work for you, use the button to choose another.' +
            (extra.message ? '<br><br><em>“' + esc_(extra.message) + '”</em>' : '');
  } else if (kind === 'cancelled-self') {
    heading = 'Your meeting is cancelled';
    subject = 'Cancelled: ' + label + ' on ' + shortWhen_(b);
    intro = 'Dear ' + first + ',<br><br>Your meeting has been cancelled. Whenever you\u2019re ready, you\u2019re welcome to book a new time.';
    accent = '#8E2433'; showManage = false; ics = 'CANCEL'; bookAgain = true;
  } else if (kind === 'cancelled-admin') {
    heading = 'Your meeting was cancelled';
    subject = CONFIG.OWNER_NAME + ' cancelled your meeting on ' + shortWhen_(b);
    intro = 'Dear ' + first + ',<br><br>' + CONFIG.OWNER_NAME + ' had to cancel the meeting below. Please choose a new time that works for you.' +
            (extra.message ? '<br><br><em>“' + esc_(extra.message) + '”</em>' : '');
    accent = '#8E2433'; showManage = false; ics = 'CANCEL'; bookAgain = true;
  }

  var rows = detailRows_(b, false);
  var buttons = '';
  if (showManage) {
    buttons += button_(manageUrl_(b), 'Change or cancel', '#1D3A6E') + '&nbsp;&nbsp;' + button_(gcalLink_(b), 'Add to Google Calendar', '#A9822F');
  }
  if (bookAgain) buttons += button_(withQuery_(publicUrl_(), 'loc=' + b.location), 'Book a new time', '#1D3A6E');

  var html = shell_(accent, heading, intro + '<br><br>' + rows + '<br>' + buttons +
    (type.needsAddress ? '' : '<p style="margin:22px 0 0;color:#5b6475;font-size:14px;">Meeting place: ' + esc_(loc.parish) + ', ' + esc_(loc.address) + '</p>'));

  MailApp.sendEmail({
    to: b.email, subject: subject, htmlBody: html, name: CONFIG.OWNER_NAME, replyTo: CONFIG.ADMIN_EMAIL,
    attachments: [Utilities.newBlob(icsFor_(b, ics), 'text/calendar', 'meeting.ics')]
  });
}

function emailAdmin_(kind, b, extra) {
  extra = extra || {};
  var label = typeLabel_(b), subject, intro, accent = '#1D3A6E';
  if (kind === 'created') {
    subject = 'New meeting: ' + label + ' — ' + b.name + ' (' + shortWhen_(b) + ')';
    intro = '<b>' + esc_(b.name) + '</b> booked a meeting with you.';
  } else if (kind === 'moved') {
    subject = 'Moved: ' + b.name + ' — now ' + shortWhen_(b);
    intro = '<b>' + esc_(b.name) + '</b> moved their meeting' +
            (extra.oldStart ? ' from ' + esc_(fmt_(new Date(extra.oldStart), "EEE, MMM d 'at' h:mm a")) : '') + '.';
  } else if (kind === 'cancelled') {
    subject = 'Cancelled: ' + b.name + ' — ' + shortWhen_(b);
    intro = '<b>' + esc_(b.name) + '</b> cancelled their meeting.' + (extra.reason ? '<br><br><em>“' + esc_(extra.reason) + '”</em>' : '');
    accent = '#8E2433';
  }
  var buttons = button_(adminUrl_(), 'Open your bookings', '#1D3A6E');
  var html = shell_(accent, kind === 'created' ? 'New meeting' : (kind === 'moved' ? 'Meeting moved' : 'Meeting cancelled'),
    intro + '<br><br>' + detailRows_(b, true) + '<br>' + buttons);
  MailApp.sendEmail({ to: CONFIG.ADMIN_EMAIL, subject: subject, htmlBody: html, name: 'Meeting Scheduler', replyTo: b.email });
}

function detailRows_(b, forAdmin) {
  var loc = findLocation_(b.location), type = findType_(b.type);
  var rows = [
    ['What', typeLabel_(b)],
    ['When', longWhen_(b)],
    ['Where', type.needsAddress ? b.address : loc.parish + ', ' + loc.name]
  ];
  if (forAdmin) {
    rows.push(['Phone', '<a href="tel:' + esc_(b.phone.replace(/[^\d+]/g, '')) + '" style="color:#1D3A6E;">' + esc_(b.phone) + '</a>', true]);
    rows.push(['Email', '<a href="mailto:' + esc_(b.email) + '" style="color:#1D3A6E;">' + esc_(b.email) + '</a>', true]);
    if (b.notes) rows.push(['Notes', b.notes]);
  } else {
    rows.push(['Name', b.name]);
    if (b.notes) rows.push(['Your note', b.notes]);
  }
  rows.push(['Booking', b.id]);
  return '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:15px;">' +
    rows.map(function (r) {
      return '<tr><td style="padding:9px 14px 9px 0;color:#5b6475;width:96px;vertical-align:top;border-top:1px solid #d3d9e4;">' + r[0] +
        '</td><td style="padding:9px 0;color:#13264A;vertical-align:top;border-top:1px solid #d3d9e4;">' + (r[2] ? r[1] : esc_(r[1]).replace(/\n/g, '<br>')) + '</td></tr>';
    }).join('') + '</table>';
}

function shell_(accent, heading, inner) {
  // Vellum sheet with a lapis double rule, matching the booking site.
  return '<div style="background:#EEF0F4;padding:28px 12px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;margin:0 auto;background:#F7F8FA;border:1px solid #1D3A6E;border-collapse:separate;">' +
    '<tr><td style="padding:5px;"><div style="border:1px solid #b9c3d6;">' +
    '<div style="padding:26px 30px 18px;border-bottom:3px double ' + accent + ';font-family:Georgia,\'Times New Roman\',serif;">' +
    '<div style="font-size:14px;letter-spacing:.06em;color:#7D5F1C;">✠ ' + esc_(CONFIG.OWNER_NAME) + '</div>' +
    '<div style="font-size:26px;margin-top:6px;color:' + accent + ';">' + esc_(heading) + '</div></div>' +
    '<div style="padding:24px 30px 30px;font-family:Helvetica,Arial,sans-serif;color:#13264A;font-size:16px;line-height:1.55;">' + inner + '</div>' +
    '<div style="padding:14px 30px;border-top:1px solid #d3d9e4;color:#5B6579;font-family:Helvetica,Arial,sans-serif;font-size:12px;">' +
    'St. Mary, Rushville &nbsp;|&nbsp; St. Gabriel, Connersville</div>' +
    '</div></td></tr></table></div>';
}

function button_(href, text, color) {
  return '<a href="' + href + '" style="display:inline-block;margin:6px 0;background:' + color +
    ';color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold;font-size:15px;font-family:Helvetica,Arial,sans-serif;">' + esc_(text) + '</a>';
}

function icsFor_(b, method) {
  var loc = findLocation_(b.location), type = findType_(b.type);
  var stamp = function (ms) { return fmt_utc_(new Date(ms)); };
  var escI = function (s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Fr Bobby Vogel//Scheduler//EN', 'METHOD:' + method,
    'BEGIN:VEVENT',
    'UID:' + b.id + '@frbobby-scheduler',
    'SEQUENCE:' + (b.seq || 0),
    'DTSTAMP:' + stamp(Date.now()),
    'DTSTART:' + stamp(b.start),
    'DTEND:' + stamp(b.end),
    'SUMMARY:' + escI(typeLabel_(b) + ' with ' + CONFIG.OWNER_NAME),
    'LOCATION:' + escI(type.needsAddress ? b.address : loc.parish + ', ' + loc.address),
    'DESCRIPTION:' + escI('Change or cancel: ' + manageUrl_(b)),
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');
}

function gcalLink_(b) {
  var loc = findLocation_(b.location), type = findType_(b.type);
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(typeLabel_(b) + ' with ' + CONFIG.OWNER_NAME) +
    '&dates=' + fmt_utc_(new Date(b.start)) + '/' + fmt_utc_(new Date(b.end)) +
    '&location=' + encodeURIComponent(type.needsAddress ? b.address : loc.parish + ', ' + loc.address) +
    '&details=' + encodeURIComponent('Change or cancel: ' + manageUrl_(b));
}

/* =========================================================================
 *  HELPERS
 * ========================================================================= */
function view_(b, forPerson) {
  var loc = findLocation_(b.location), type = findType_(b.type);
  var v = {
    id: b.id, status: b.status, location: loc.id, locationName: loc.name, parish: loc.parish, parishAddress: loc.address,
    type: type.id, typeName: typeLabel_(b), minutes: type.minutes, start: b.start, end: b.end,
    dateLabel: fmt_(new Date(b.start), 'EEEE, MMMM d, yyyy'),
    timeLabel: fmt_(new Date(b.start), 'h:mm a') + ' – ' + fmt_(new Date(b.end), 'h:mm a'),
    name: b.name, address: b.address, notes: b.notes, past: b.end < Date.now(),
    gcal: gcalLink_(b)
  };
  if (forPerson) {
    v.manageUrl = manageUrl_(b);
    v.email = b.email;
  } else {
    v.email = b.email; v.phone = b.phone; v.log = b.log;
  }
  return v;
}

function validateContact_(f, type) {
  var name = String(f.name || '').trim().replace(/\s+/g, ' ');
  var email = String(f.email || '').trim();
  var phone = String(f.phone || '').trim();
  var address = String(f.address || '').trim();
  var notes = String(f.notes || '').trim().slice(0, 1000);
  var detail = String(f.detail || '').trim();
  if (name.length < 2 || name.length > 100) throw new Error('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('Please enter a valid email address.');
  var digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) throw new Error('Please enter a phone number with area code.');
  if (type.needsAddress && address.length < 6) throw new Error('Please enter the address where dinner will be.');
  if (type.options && type.options.indexOf(detail) < 0) throw new Error('Please choose ' + type.options.join(' or ') + '.');
  if (!type.options) detail = '';
  return { name: name, email: email, phone: phone, address: type.needsAddress ? address.slice(0, 300) : '', notes: notes, detail: detail };
}

function findLocation_(id) {
  var l = CONFIG.LOCATIONS.filter(function (x) { return x.id === id; })[0];
  if (!l) throw new Error('Please choose Rushville or Connersville.');
  return l;
}
function findType_(id) {
  var t = CONFIG.TYPES.filter(function (x) { return x.id === id; })[0];
  if (!t) throw new Error('Please choose a kind of meeting.');
  return t;
}
function typeLabel_(b) {
  var t = findType_(b.type);
  return b.detail ? t.name + ': ' + b.detail : t.name;
}
function firstName_(n) {
  n = String(n || '').trim();
  var first = n.split(' ')[0];
  if (!first) return 'friend';
  // "The Meyer Family", "Mr. Smith", "Claire & Dan" → use the whole name
  if (/^(the|mr|mrs|ms|dr|deacon)\.?$/i.test(first) || /&|\band\b|family/i.test(n)) return n;
  return first;
}
function longWhen_(b) { return fmt_(new Date(b.start), "EEEE, MMMM d, yyyy 'at' h:mm a") + ' – ' + fmt_(new Date(b.end), 'h:mm a') + ' (Eastern)'; }
function shortWhen_(b) { return fmt_(new Date(b.start), "EEE, MMM d 'at' h:mm a"); }
function googleUrl_() { return ScriptApp.getService().getUrl(); }
/** The address people use: your own website page if PUBLIC_URL is set, else the Google link. */
function publicUrl_() { return String(CONFIG.PUBLIC_URL || '').trim() || googleUrl_(); }
function withQuery_(url, q) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + q; }
function manageUrl_(b) { return withQuery_(publicUrl_(), 'page=manage&id=' + b.id + '&t=' + b.token); }
// The admin page always stays on the Google link, so its key never passes through your website.
function adminUrl_() { return googleUrl_() + '?page=admin&key=' + adminKey_(); }

function adminKey_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('ADMIN_KEY');
  if (!k) { k = newToken_(); props.setProperty('ADMIN_KEY', k); }
  return k;
}
function checkAdmin_(key) {
  if (!key || String(key) !== adminKey_()) throw new Error('This admin link isn\u2019t valid. Use the link from your scheduler emails.');
}

function newId_() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', s = 'FB-';
  for (var i = 0; i < 6; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function newToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

function fmt_(d, pattern) { return Utilities.formatDate(d, CONFIG.TIMEZONE, pattern); }
function fmt_utc_(d) { return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"); }
function ymdOf_(d) { return fmt_(d, 'yyyy-MM-dd'); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }
function addDays_(ymd, n) {
  var d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday_(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); }
function daysBetween_(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }
function tzOffset_(d) { var z = fmt_(d, 'Z'); return z.slice(0, 3) + ':' + z.slice(3); }
/** A Date for a wall-clock time in the parish time zone. */
function zoned_(ymd, hm) {
  var off = tzOffset_(new Date(ymd + 'T12:00:00Z'));
  var d = new Date(ymd + 'T' + hm + ':00' + off);
  var off2 = tzOffset_(d);
  if (off2 !== off) d = new Date(ymd + 'T' + hm + ':00' + off2);
  return d;
}
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function clone_(o) { var c = {}; for (var k in o) c[k] = o[k]; return c; }
function safe_(fn) { try { fn(); } catch (e) { console.error(e); } }

/* =========================================================================
 *  ONE-TIME SETUP & UTILITIES (run from the Apps Script editor)
 * ========================================================================= */

/** Run once. Creates the bookings sheet, admin key, and the calendar-sync trigger. */
function setup() {
  var sh = getSheet_();
  adminKey_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCalendarChanges') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncCalendarChanges').timeBased().everyMinutes(15).create();
  // Touch each calendar so authorization covers them.
  CONFIG.BUSY_CALENDAR_IDS.concat([CONFIG.MASS_CALENDAR_ID]).forEach(function (id) { Calendar.Calendars.get(id); });
  Logger.log('Setup complete. Bookings sheet: ' + sh.getParent().getUrl());
  Logger.log('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), then run showLinks().');
}

/** After deploying, run this to print your public link and private admin link. */
function showLinks() {
  var url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log('Deploy the web app first (Deploy → New deployment → Web app).'); return; }
  if (CONFIG.PUBLIC_URL) Logger.log('Your website booking page:        ' + CONFIG.PUBLIC_URL);
  Logger.log('PUBLIC booking link (share this):  ' + url);
  Logger.log('  Rushville-only link:            ' + url + '?loc=rushville');
  Logger.log('  Connersville-only link:         ' + url + '?loc=connersville');
  Logger.log('PRIVATE admin link (keep secret):  ' + adminUrl_());
  Logger.log('Bookings sheet:                    ' + getSheet_().getParent().getUrl());
}

/** Preview open days for the next 3 weeks in the log, to check the Mass-location logic. */
function previewAvailability() {
  CONFIG.LOCATIONS.forEach(function (loc) {
    var res = availabilityPayload_(loc, CONFIG.TYPES[0], null, false);
    Logger.log('== ' + loc.name + ' (' + CONFIG.TYPES[0].name + ') ==');
    res.days.slice(0, 21).forEach(function (d) {
      Logger.log(d.date + '  ' + (d.reason || d.slots.map(function (s) { return s.label; }).join(', ')));
    });
  });
}

/** Rotate the admin link if it was ever shared by mistake. */
function resetAdminLink() {
  PropertiesService.getScriptProperties().deleteProperty('ADMIN_KEY');
  showLinks();
}
