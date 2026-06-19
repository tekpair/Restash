// Restash — shared Supabase data layer for the customer app (index.html)
// and the staff console (console.html). Exposes window.RestashAPI.
//
// Loads after the supabase-js UMD bundle and config.js.
(function () {
  'use strict';

  var cfg = window.RESTASH_CONFIG || {};
  var rawUrl = cfg.SUPABASE_URL || '';
  var rawKey = cfg.SUPABASE_ANON_KEY || '';
  var configured = !!rawUrl && !!rawKey && !/YOUR-|REPLACE|EXAMPLE/i.test(rawUrl + rawKey);

  var sb = null;
  if (configured && window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(rawUrl, rawKey);
  }

  // ---- helpers ----------------------------------------------------
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function unwrap(res) {
    if (res && res.error) throw new Error(res.error.message || 'Request failed');
    return res ? res.data : null;
  }
  function bySortKey(key) { return function (a, b) { return (a[key] || 0) - (b[key] || 0); }; }
  function byCreatedAsc(a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); }

  function mapItems(rows) {
    return (rows || []).slice().sort(bySortKey('position')).map(function (it) {
      return {
        titleName: it.title_name, platformName: it.platform_name,
        editionName: it.edition_name, condName: it.cond_name,
        qty: it.qty, lineMid: it.line_mid
      };
    });
  }
  function mapHistory(rows) {
    return (rows || []).slice().sort(byCreatedAsc).map(function (h) {
      return { label: h.label, date: fmtDate(h.created_at), note: h.note || undefined };
    });
  }
  function mapNotes(rows) {
    return (rows || []).slice().sort(byCreatedAsc).map(function (n) {
      return { text: n.body, by: n.author_name || 'Staff', date: fmtDate(n.created_at) };
    });
  }
  function deriveLabels(items) {
    var totalGames = items.reduce(function (s, i) { return s + i.qty; }, 0);
    var itemName = items.length === 1
      ? (items[0].titleName + (items[0].qty > 1 ? ' ×' + items[0].qty : ''))
      : (totalGames + ' games');
    var plats = items.map(function (i) { return i.platformName; })
      .filter(function (x, i, a) { return a.indexOf(x) === i; });
    var platform = plats.length === 1 ? plats[0] : plats.length + ' platforms';
    return { itemName: itemName, platform: platform };
  }

  // claim row -> shape used by index.html (customer)
  function mapClaimCustomer(row) {
    var items = mapItems(row.claim_items);
    var labels = deriveLabels(items);
    return {
      ref: row.ref, itemName: labels.itemName, platform: labels.platform,
      items: items, estLow: row.est_low, estHigh: row.est_high,
      payout: row.payout, address: row.address || '',
      offerAmount: row.offer_amount, customerResponse: row.customer_response,
      createdAt: fmtDate(row.created_at), status: row.status,
      history: mapHistory(row.claim_history)
    };
  }
  // claim row -> shape used by console.html (staff)
  function mapClaimStaff(row) {
    return {
      ref: row.ref, cust: row.cust_name, email: row.cust_email, phone: row.cust_phone,
      payout: row.payout, address: row.address || '', status: row.status,
      createdAt: fmtDate(row.created_at), estLow: row.est_low, estHigh: row.est_high,
      items: mapItems(row.claim_items), history: mapHistory(row.claim_history),
      assignee: row.assignee_name || null, assigneeId: row.assignee_id || null,
      offerAmount: row.offer_amount, customerResponse: row.customer_response,
      flagged: !!row.flagged, notes: mapNotes(row.claim_notes)
    };
  }
  function mapAccount(row) {
    return {
      id: row.id, name: row.full_name, email: row.email, phone: row.phone,
      address: row.address, joined: fmtDate(row.created_at), flagged: !!row.flagged,
      notes: mapNotes(row.account_notes)
    };
  }

  function need() { if (!sb) throw new Error('Supabase is not configured. Edit config.js with your project URL and anon key.'); }
  async function rpc(name, args) { need(); return unwrap(await sb.rpc(name, args || {})); }

  // ---- public API -------------------------------------------------
  var API = {
    configured: configured,
    client: function () { return sb; },
    fmtDate: fmtDate,

    // auth -----------------------------------------------------------
    async currentUser() {
      if (!sb) return null;
      var data = unwrap(await sb.auth.getSession());
      return (data && data.session) ? data.session.user : null;
    },
    onAuthChange: function (cb) {
      if (!sb) return function () {};
      var sub = sb.auth.onAuthStateChange(function (_evt, session) { cb(session ? session.user : null); });
      return function () { if (sub && sub.data && sub.data.subscription) sub.data.subscription.unsubscribe(); };
    },
    async signUp(o) {
      need();
      var data = unwrap(await sb.auth.signUp({
        email: o.email, password: o.password,
        options: { data: { full_name: o.name || '', phone: o.phone || '' } }
      }));
      return data;
    },
    async signIn(o) { need(); return unwrap(await sb.auth.signInWithPassword({ email: o.email, password: o.password })); },
    async signOut() { if (sb) await sb.auth.signOut(); },
    async updatePassword(password) { need(); return unwrap(await sb.auth.updateUser({ password: password })); },
    async resetPassword(email) {
      need();
      var redirectTo = window.location.origin + window.location.pathname;
      return unwrap(await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo }));
    },

    // profile --------------------------------------------------------
    async getProfile() {
      var u = await API.currentUser();
      if (!u) return null;
      var data = unwrap(await sb.from('profiles').select('*').eq('id', u.id).single());
      return data;
    },
    async updateProfile(p) {
      need();
      var u = await API.currentUser();
      if (!u) throw new Error('Not signed in');
      var patch = {};
      if (p.full_name != null) patch.full_name = p.full_name;
      if (p.phone != null) patch.phone = p.phone;
      if (p.address != null) patch.address = p.address;
      return unwrap(await sb.from('profiles').update(patch).eq('id', u.id).select().single());
    },

    // catalog --------------------------------------------------------
    async getCatalog() {
      need();
      var r = await Promise.all([
        sb.from('platforms').select('*').order('position'),
        sb.from('titles').select('*').order('position'),
        sb.from('editions').select('*').order('position'),
        sb.from('conditions').select('*').order('position')
      ]);
      var platforms = unwrap(r[0]), titles = unwrap(r[1]), editions = unwrap(r[2]), conditions = unwrap(r[3]);
      var nested = platforms.map(function (p) {
        return {
          id: p.id, name: p.name, icon: p.icon,
          titles: titles.filter(function (t) { return t.platform_id === p.id; }).map(function (t) {
            return {
              id: t.id, name: t.name,
              editions: editions.filter(function (e) { return e.title_id === t.id; }).map(function (e) {
                return { id: e.id, key: e.edition_key, name: e.name, base: e.base, desc: e.description || undefined };
              })
            };
          })
        };
      });
      var conds = conditions.map(function (c) {
        return { id: c.id, name: c.name, mult: Number(c.mult), desc: c.description, ineligible: !!c.ineligible, icon: c.icon };
      });
      return { platforms: nested, conditions: conds };
    },

    // customer claims ------------------------------------------------
    async submitClaim(o) {
      return rpc('submit_claim', {
        p_items: o.items, p_payout: o.payout,
        p_phone: o.phone || '', p_address: o.address || '', p_notes: o.notes || ''
      });
    },
    async myClaims() {
      need();
      var rows = unwrap(await sb.from('claims')
        .select('*, claim_items(*), claim_history(*)')
        .order('created_at', { ascending: false }));
      return rows.map(mapClaimCustomer);
    },
    async claimByRef(ref) {
      need();
      var row = unwrap(await sb.from('claims')
        .select('*, claim_items(*), claim_history(*)').eq('ref', ref).single());
      return mapClaimCustomer(row);
    },
    async respondToOffer(ref, response) { return rpc('respond_to_offer', { p_ref: ref, p_response: response }); },

    // staff ----------------------------------------------------------
    async allClaims() {
      need();
      var rows = unwrap(await sb.from('claims')
        .select('*, claim_items(*), claim_history(*)')
        .order('created_at', { ascending: false }));
      return rows.map(mapClaimStaff);
    },
    async staffClaimByRef(ref) {
      need();
      var row = unwrap(await sb.from('claims')
        .select('*, claim_items(*), claim_history(*), claim_notes(*)').eq('ref', ref).single());
      return mapClaimStaff(row);
    },
    async accounts() {
      need();
      var rows = unwrap(await sb.from('profiles').select('*')
        .eq('role', 'customer').order('created_at', { ascending: false }));
      return rows.map(mapAccount);
    },
    async accountByEmail(email) {
      need();
      var row = unwrap(await sb.from('profiles').select('*, account_notes(*)').eq('email', email).single());
      return mapAccount(row);
    },
    async team() {
      need();
      var rows = unwrap(await sb.from('team_members').select('*').order('position'));
      return rows.map(function (m) {
        return { group: m.group_name, name: m.name, role: m.role, email: m.email,
                 location: m.location, focus: m.focus || [], desc: m.description };
      });
    },

    // staff actions (all enforce is_staff() + lifecycle server-side)
    reviewClaim:      function (ref) { return rpc('review_claim', { p_ref: ref }); },
    acceptClaim:      function (ref) { return rpc('accept_claim', { p_ref: ref }); },
    declineClaim:     function (ref) { return rpc('decline_claim', { p_ref: ref }); },
    markReceived:     function (ref) { return rpc('mark_received', { p_ref: ref }); },
    makeOffer:        function (ref, amount) { return rpc('make_offer', { p_ref: ref, p_amount: amount }); },
    rejectReturn:     function (ref) { return rpc('reject_return', { p_ref: ref }); },
    authorizePayment: function (ref) { return rpc('authorize_payment', { p_ref: ref }); },
    confirmReturn:    function (ref) { return rpc('confirm_return', { p_ref: ref }); },
    assignClaim:      function (ref) { return rpc('assign_claim', { p_ref: ref }); },
    releaseClaim:     function (ref) { return rpc('release_claim', { p_ref: ref }); },
    setClaimFlag:     function (ref, on) { return rpc('set_claim_flag', { p_ref: ref, p_flag: on }); },
    addClaimNote:     function (ref, body) { return rpc('add_claim_note', { p_ref: ref, p_body: body }); },
    setAccountFlag:   function (id, on) { return rpc('set_account_flag', { p_profile: id, p_flag: on }); },
    addAccountNote:   function (id, body) { return rpc('add_account_note', { p_profile: id, p_body: body }); }
  };

  window.RestashAPI = API;
})();
