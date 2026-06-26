// Restash — shared data layer for the customer app (index.html) and the staff
// console (console.html). Exposes window.RestashAPI.
//
// If config.js holds real Supabase values, every call hits Supabase. Otherwise
// it falls back to an in-memory DEMO backend (seeded data, the same offer
// algorithm) so the whole site is testable with no setup. RestashAPI.demo is
// true in that mode. Loads after the supabase-js UMD bundle and config.js.
(function () {
  'use strict';

  var cfg = window.RESTASH_CONFIG || {};
  var rawUrl = cfg.SUPABASE_URL || '', rawKey = cfg.SUPABASE_ANON_KEY || '';
  var configured = !!rawUrl && !!rawKey && !/YOUR-|REPLACE|EXAMPLE/i.test(rawUrl + rawKey);
  var sb = (configured && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(rawUrl, rawKey) : null;

  // ---- shared helpers ---------------------------------------------
  function fmtDate(iso) { if (!iso) return ''; return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function unwrap(res) { if (res && res.error) throw new Error(res.error.message || 'Request failed'); return res ? res.data : null; }
  function bySortKey(k) { return function (a, b) { return (a[k] || 0) - (b[k] || 0); }; }
  function byCreatedAsc(a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); }

  // ---- the offer algorithm (mirrors compute_offer in SQL) ----------
  var DEFAULT_PRICING = { margin_low: 0.35, margin_mid: 0.45, margin_high: 0.57, tier_mid_min: 20, tier_high_min: 50, ship_cost: 4.50, fee_pct: 0.029, fee_flat: 0.30, min_quote: 25, min_games: 3 };

  // ---- Bulk Seller program (beta) — single source of truth for the rules ----
  // Hard requirements gating entry + the ongoing commitments approved sellers
  // must keep. Surfaced identically in the customer app and the staff console.
  var BULK_RULES = {
    min_paid: 50,            // lifetime paid claims, in good standing, to qualify
    min_age_days: 60,        // account must be at least this old
    min_per_shipment: 15,    // games per shipment/manifest once active
    min_games_per_month: 50, // games shipped per month or the seller is suspended
    reapply_months: 3        // wait after a closure before reapplying
  };
  var BULK_STATUSES = ['pending', 'approved', 'suspended', 'declined', 'closed'];
  // 24/7 direct line Bulk Sellers get (placeholder contact for the demo).
  var BULK_LINE = { phone: '(518) 555-0100', email: 'bulk@getrestash.gg' };
  // Referral program — deliberately NOT a withdrawable balance (that risks
  // money-transmitter rules). The reward is a one-time bonus applied to the
  // referrer's next ACCEPTED offer, earned when a friend completes their first
  // paid claim. Both sides get it.
  var REFERRAL = { bonus: 10, qualify: 'their first paid claim' };
  // A short, shareable, deterministic referral code for a profile.
  function refCode(p) {
    var s = p.id || '', n = 0; for (var i = 0; i < s.length; i++) { n = (n * 31 + s.charCodeAt(i)) >>> 0; }
    var first = (p.full_name || 'Restash').split(' ')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
    return first.slice(0, 6) + (n % 9000 + 1000);
  }
  // Compute a seller's eligibility from paid-claim count, account age, and whether
  // the account is in good standing (no counterfeit / condition-mismatch flags).
  function bulkEligibility(paidClaims, ageDays, cleanStanding) {
    var paidOk = paidClaims >= BULK_RULES.min_paid;
    var ageOk = ageDays >= BULK_RULES.min_age_days;
    var clean = cleanStanding !== false;
    return { paidClaims: paidClaims, ageDays: ageDays, paidOk: paidOk, ageOk: ageOk, clean: clean, eligible: paidOk && ageOk && clean };
  }
  function daysSince(iso) { if (!iso) return 0; return Math.floor((Date.now() - Date.parse(iso)) / 86400000); }

  function marginFor(unit, c) { c = c || DEFAULT_PRICING; if (unit >= c.tier_high_min) return c.margin_high; if (unit >= c.tier_mid_min) return c.margin_mid; return c.margin_low; }
  // items: [{ unit_market, qty }]
  function computeOffer(items, c) {
    c = c || DEFAULT_PRICING;
    var sub = 0; (items || []).forEach(function (it) { sub += it.unit_market * it.qty * marginFor(it.unit_market, c); });
    if (sub <= 0) return 0;
    var offer = sub - c.ship_cost - (sub * c.fee_pct + c.fee_flat);
    return offer < 0 ? 0 : Math.round(offer);
  }

  // Market value of one game at a condition: real per-condition price when we
  // have it (PriceCharting loose/cib/new), else base × the condition multiplier.
  function marketValue(edition, condition) {
    var base = edition.base, mult = (condition && condition.mult) || 0, id = condition && condition.id;
    if (id === 'loose') return edition.looseMarket != null ? edition.looseMarket : base * mult;
    if (id === 'complete') return base;
    if (id === 'sealed') return edition.newMarket != null ? edition.newMarket : base * mult;
    return base * mult;
  }

  // ---- DB row -> view-model mappers --------------------------------
  function mapItems(rows) {
    return (rows || []).slice().sort(bySortKey('position')).map(function (it) {
      return { id: it.id, titleName: it.title_name, platformName: it.platform_name, editionName: it.edition_name,
        condName: it.cond_name, claimedCondName: it.claimed_cond_name || it.cond_name, conditionId: it.condition_id,
        editionId: it.edition_id, qty: it.qty, lineMid: it.line_mid, unitMarket: Number(it.unit_market || 0) };
    });
  }
  function mapHistory(rows) { return (rows || []).slice().sort(byCreatedAsc).map(function (h) { return { label: h.label, date: fmtDate(h.created_at), note: h.note || undefined }; }); }
  function mapNotes(rows) { return (rows || []).slice().sort(byCreatedAsc).map(function (n) { return { text: n.body, by: n.author_name || 'Staff', date: fmtDate(n.created_at) }; }); }
  function mapMessages(rows) { return (rows || []).slice().sort(byCreatedAsc).map(function (m) { return { from: m.author, name: m.author_name || (m.author === 'staff' ? 'Restash' : 'You'), body: m.body, date: fmtDate(m.created_at), at: m.created_at }; }); }
  function deriveLabels(items) {
    var totalGames = items.reduce(function (s, i) { return s + i.qty; }, 0);
    var itemName = items.length === 1 ? (items[0].titleName + (items[0].qty > 1 ? ' ×' + items[0].qty : '')) : (totalGames + ' games');
    var plats = items.map(function (i) { return i.platformName; }).filter(function (x, i, a) { return a.indexOf(x) === i; });
    return { itemName: itemName, platform: plats.length === 1 ? plats[0] : plats.length + ' platforms' };
  }
  function bulkLabel(row) { var n = row.est_count != null ? Number(row.est_count) : null; return 'Bulk lot' + (n ? ' · ~' + n + ' games' : ''); }
  function mapClaimCustomer(row) {
    var items = mapItems(row.claim_items), labels = deriveLabels(items);
    var bulk = !!row.bulk;
    return { ref: row.ref, itemName: bulk ? bulkLabel(row) : labels.itemName, platform: bulk ? 'Bulk' : labels.platform, items: items,
      bulk: bulk, manifest: row.manifest || '', estCount: row.est_count != null ? Number(row.est_count) : null,
      estLow: row.est_low, estHigh: row.est_high,
      payout: row.payout, paidAmount: row.paid_amount, address: row.address || '', offerAmount: row.offer_amount, customerResponse: row.customer_response,
      createdAt: fmtDate(row.created_at), createdAtISO: row.created_at, status: row.status, history: mapHistory(row.claim_history), messages: mapMessages(row.claim_messages), customerNote: row.customer_notes || '' };
  }
  function mapClaimStaff(row) {
    return { ref: row.ref, cust: row.cust_name, email: row.cust_email, phone: row.cust_phone, payout: row.payout, address: row.address || '',
      status: row.status, createdAt: fmtDate(row.created_at), estLow: row.est_low, estHigh: row.est_high, items: mapItems(row.claim_items),
      bulk: !!row.bulk, manifest: row.manifest || '', estCount: row.est_count != null ? Number(row.est_count) : null, paidAmount: row.paid_amount,
      history: mapHistory(row.claim_history), assignee: row.assignee_name || null, assigneeId: row.assignee_id || null,
      offerAmount: row.offer_amount, customerResponse: row.customer_response, flagged: !!row.flagged, notes: mapNotes(row.claim_notes), messages: mapMessages(row.claim_messages), customerNote: row.customer_notes || '' };
  }
  function mapBulk(row) {
    return { status: row.bulk_status || null, reason: row.bulk_reason || '', appliedAt: row.bulk_applied_at || null,
      decidedAt: row.bulk_decided_at || null, agreementAt: row.bulk_agreement_at || null, idProvided: !!row.bulk_id_provided,
      lifetimePaid: row.lifetime_paid != null ? Number(row.lifetime_paid) : 0 };
  }
  function mapAccount(row) { return { id: row.id, name: row.full_name, email: row.email, phone: row.phone, address: row.address, createdAt: row.created_at, joined: fmtDate(row.created_at), flagged: !!row.flagged, notes: mapNotes(row.account_notes), bulk: mapBulk(row) }; }
  function mapPricing(row) { var o = {}; Object.keys(DEFAULT_PRICING).forEach(function (k) { o[k] = row && row[k] != null ? Number(row[k]) : DEFAULT_PRICING[k]; }); return o; }

  // =================================================================
  // SUPABASE backend
  // =================================================================
  function need() { if (!sb) throw new Error('Supabase not configured'); }
  async function rpc(name, args) { need(); return unwrap(await sb.rpc(name, args || {})); }
  var supa = {
    demo: false,
    async currentUser() { var d = unwrap(await sb.auth.getSession()); return (d && d.session) ? d.session.user : null; },
    onAuthChange: function (cb) { var s = sb.auth.onAuthStateChange(function (_e, sess) { cb(sess ? sess.user : null); }); return function () { if (s && s.data && s.data.subscription) s.data.subscription.unsubscribe(); }; },
    async signUp(o) { return unwrap(await sb.auth.signUp({ email: o.email, password: o.password, options: { data: { full_name: o.name || '', phone: o.phone || '' } } })); },
    async signIn(o) { return unwrap(await sb.auth.signInWithPassword({ email: o.email, password: o.password })); },
    async signOut() { await sb.auth.signOut(); },
    async updatePassword(p) { return unwrap(await sb.auth.updateUser({ password: p })); },
    async resetPassword(email) { return unwrap(await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname })); },
    onPasswordRecovery: function (cb) {
      var s = sb.auth.onAuthStateChange(function (event) { if (event === 'PASSWORD_RECOVERY') cb(); });
      return function () { if (s && s.data && s.data.subscription) s.data.subscription.unsubscribe(); };
    },
    async getProfile() { var u = await supa.currentUser(); if (!u) return null; return unwrap(await sb.from('profiles').select('*').eq('id', u.id).single()); },
    async updateProfile(p) { var u = await supa.currentUser(); if (!u) throw new Error('Not signed in'); var patch = {}; if (p.full_name != null) patch.full_name = p.full_name; if (p.phone != null) patch.phone = p.phone; if (p.address != null) patch.address = p.address; return unwrap(await sb.from('profiles').update(patch).eq('id', u.id).select().single()); },
    async requestDataExport() { return rpc('request_data_export'); },
    async deleteAccount() { await rpc('delete_my_account'); try { await sb.auth.signOut(); } catch (e) {} },
    // Bulk Seller (beta). Customer applies; staff approve/decline/suspend/close.
    async bulkApply(o) { return rpc('apply_bulk_seller', { p_agreement: !!(o && o.agreement), p_id_provided: !!(o && o.idProvided) }); },
    async closeBulkMembership() { return rpc('close_bulk_membership', {}); },
    async listBulkSellers() { var rows = unwrap(await sb.from('profiles').select('*, account_notes(*)').not('bulk_status', 'is', null).order('bulk_applied_at', { ascending: false })); return rows.map(mapAccount); },
    async decideBulkSeller(profileId, decision, reason) { return rpc('decide_bulk_seller', { p_profile: profileId, p_decision: decision, p_reason: reason || '' }); },
    // Active Bulk Seller submits one manifest -> auto-accepted, prepaid label.
    async submitBulkClaim(o) { return rpc('submit_bulk_claim', { p_manifest: o.manifest || '', p_est_count: (o.estCount != null ? o.estCount : null), p_payout: o.payout, p_phone: o.phone || '', p_address: o.address || '' }); },
    makeBulkOffer: function (r, a, x) { return rpc('make_bulk_offer', { p_ref: r, p_amount: a, p_reason: x || '' }); },
    async getCatalog() {
      var r = await Promise.all([sb.from('platforms').select('*').order('position'), sb.from('titles').select('*').order('position'), sb.from('editions').select('*').order('position'), sb.from('conditions').select('*').order('position'), sb.from('pricing_config').select('*').eq('id', 1).single()]);
      var platforms = unwrap(r[0]), titles = unwrap(r[1]), editions = unwrap(r[2]), conditions = unwrap(r[3]);
      var pricing = mapPricing(r[4] && r[4].data);
      return { platforms: buildNested(platforms, titles, editions), conditions: mapConds(conditions), pricing: pricing };
    },
    async conditions() { var rows = unwrap(await sb.from('conditions').select('*').order('position')); return mapConds(rows); },
    async pricing() { var row = unwrap(await sb.from('pricing_config').select('*').eq('id', 1).single()); return mapPricing(row); },
    async submitClaim(o) { return rpc('submit_claim', { p_items: o.items, p_payout: o.payout, p_phone: o.phone || '', p_address: o.address || '', p_notes: o.notes || '' }); },
    async myClaims() { var rows = unwrap(await sb.from('claims').select('*, claim_items(*), claim_history(*), claim_messages(*)').order('created_at', { ascending: false })); return rows.map(mapClaimCustomer); },
    async claimByRef(ref) { var row = unwrap(await sb.from('claims').select('*, claim_items(*), claim_history(*), claim_messages(*)').eq('ref', ref).single()); return mapClaimCustomer(row); },
    async respondToOffer(ref, r) { return rpc('respond_to_offer', { p_ref: ref, p_response: r }); },
    async sendClaimMessage(ref, body) { return rpc('send_claim_message', { p_ref: ref, p_body: body }); },
    async getReferral() { return rpc('get_referral'); },
    async allClaims() { var rows = unwrap(await sb.from('claims').select('*, claim_items(*), claim_history(*)').order('created_at', { ascending: false })); return rows.map(mapClaimStaff); },
    async staffClaimByRef(ref) { var row = unwrap(await sb.from('claims').select('*, claim_items(*), claim_history(*), claim_notes(*), claim_messages(*)').eq('ref', ref).single()); return mapClaimStaff(row); },
    async accounts() { var rows = unwrap(await sb.from('profiles').select('*').eq('role', 'customer').order('created_at', { ascending: false })); return rows.map(mapAccount); },
    async accountByEmail(email) { var row = unwrap(await sb.from('profiles').select('*, account_notes(*)').eq('email', email).single()); return mapAccount(row); },
    async team() { var rows = unwrap(await sb.from('team_members').select('*').order('position')); return rows.map(mapTeam); },
    reviewClaim: function (r) { return rpc('review_claim', { p_ref: r }); }, acceptClaim: function (r) { return rpc('accept_claim', { p_ref: r }); },
    declineClaim: function (r, x) { return rpc('decline_claim', { p_ref: r, p_reason: x || '' }); }, markReceived: function (r) { return rpc('mark_received', { p_ref: r }); },
    regradeItem: function (i, c) { return rpc('regrade_item', { p_item_id: i, p_condition_id: c }); },
    makeOffer: function (r, a, x) { return rpc('make_offer', { p_ref: r, p_amount: a, p_reason: x || '' }); }, rejectReturn: function (r, x) { return rpc('reject_return', { p_ref: r, p_reason: x || '' }); },
    authorizePayment: function (r) { return rpc('authorize_payment', { p_ref: r }); }, confirmReturn: function (r) { return rpc('confirm_return', { p_ref: r }); },
    assignClaim: function (r) { return rpc('assign_claim', { p_ref: r }); }, releaseClaim: function (r) { return rpc('release_claim', { p_ref: r }); },
    setClaimFlag: function (r, o) { return rpc('set_claim_flag', { p_ref: r, p_flag: o }); }, addClaimNote: function (r, b) { return rpc('add_claim_note', { p_ref: r, p_body: b }); },
    sendStaffMessage: function (r, b) { return rpc('send_staff_message', { p_ref: r, p_body: b }); },
    setAccountFlag: function (i, o) { return rpc('set_account_flag', { p_profile: i, p_flag: o }); }, addAccountNote: function (i, b) { return rpc('add_account_note', { p_profile: i, p_body: b }); }
  };
  function buildNested(platforms, titles, editions) {
    return platforms.map(function (p) { return { id: p.id, name: p.name, icon: p.icon, titles: titles.filter(function (t) { return t.platform_id === p.id; }).map(function (t) { return { id: t.id, name: t.name, editions: editions.filter(function (e) { return e.title_id === t.id; }).map(function (e) { return { id: e.id, key: e.edition_key, name: e.name, base: e.base, desc: e.description || undefined, looseMarket: e.loose_market != null ? Number(e.loose_market) : undefined, newMarket: e.new_market != null ? Number(e.new_market) : undefined }; }) }; }) }; });
  }
  function mapConds(rows) { return rows.map(function (c) { return { id: c.id, name: c.name, mult: Number(c.mult), desc: c.description, ineligible: !!c.ineligible, icon: c.icon }; }); }
  function mapTeam(m) { return { group: m.group_name, name: m.name, role: m.role, email: m.email, location: m.location, focus: m.focus || [], desc: m.description }; }

  // =================================================================
  // DEMO backend (in-memory; no setup required)
  // =================================================================
  var demo = (function () {
    var nowISO = new Date().toISOString();
    function days(n) { return new Date(Date.now() - n * 864e5).toISOString(); }
    var ed = {}; // edition lookup by id
    // E(id, key, name, cibMarket, looseMarket, newMarket, desc)
    function E(id, key, name, base, loose, newm, desc) { var o = { id: id, key: key, name: name, base: base, looseMarket: loose, newMarket: newm, desc: desc }; ed[id] = o; return o; }
    var platforms = [
      { id: 'switch', name: 'Nintendo Switch', icon: 'handheld', titles: [
        { id: 'totk', name: 'The Legend of Zelda: Tears of the Kingdom', editions: [E('ed-totk', 'std', 'Standard', 48, 40, 55)] },
        { id: 'botw', name: 'The Legend of Zelda: Breath of the Wild', editions: [E('ed-botw', 'std', 'Standard', 40, 32, 50)] },
        { id: 'odyssey', name: 'Super Mario Odyssey', editions: [E('ed-ody', 'std', 'Standard', 40, 33, 48)] },
        { id: 'mk8d', name: 'Mario Kart 8 Deluxe', editions: [E('ed-mk8d', 'std', 'Standard', 44, 38, 50)] },
        { id: 'smash', name: 'Super Smash Bros. Ultimate', editions: [E('ed-smash', 'std', 'Standard', 48, 42, 55)] },
        { id: 'acnh', name: 'Animal Crossing: New Horizons', editions: [E('ed-acnh', 'std', 'Standard', 42, 34, 48)] },
        { id: 'metroidd', name: 'Metroid Dread', editions: [E('ed-metroidd', 'std', 'Standard', 36, 28, 44)] },
        { id: 'luigi3', name: "Luigi's Mansion 3", editions: [E('ed-luigi3', 'std', 'Standard', 40, 32, 47)] },
        { id: 'xeno2', name: 'Xenoblade Chronicles 2', editions: [E('ed-xeno2', 'std', 'Standard', 45, 35, 55)] } ] },
      { id: 'ps4', name: 'PlayStation 4', icon: 'gamepad', titles: [
        { id: 'gow', name: 'God of War', editions: [E('ed-gow', 'std', 'Standard', 15, 11, 22)] },
        { id: 'spiderman', name: "Marvel's Spider-Man", editions: [E('ed-spiderman', 'std', 'Standard', 16, 12, 24)] },
        { id: 'tlou2', name: 'The Last of Us Part II', editions: [E('ed-tlou2', 'std', 'Standard', 17, 13, 24)] },
        { id: 'bloodborne', name: 'Bloodborne', editions: [E('ed-bloodborne', 'std', 'Standard', 17, 13, 26)] },
        { id: 'rdr2', name: 'Red Dead Redemption 2', editions: [E('ed-rdr2', 'std', 'Standard', 19, 15, 27)] },
        { id: 'ghost', name: 'Ghost of Tsushima', editions: [E('ed-ghost', 'std', 'Standard', 19, 15, 27)] },
        { id: 'persona5r', name: 'Persona 5 Royal', editions: [E('ed-persona5r', 'std', 'Standard', 28, 22, 38)] },
        { id: 'witcher3', name: 'The Witcher 3: Wild Hunt', editions: [E('ed-witcher3', 'std', 'Standard', 14, 11, 20), E('ed-witcher3-goty', 'goty', 'Game of the Year Edition', 23, 17, 33, 'Includes all expansions')] } ] },
      { id: 'xbox', name: 'Xbox One', icon: 'gamepad', titles: [
        { id: 'halomcc', name: 'Halo: The Master Chief Collection', editions: [E('ed-halo', 'std', 'Standard', 16, 12, 24)] },
        { id: 'forza4', name: 'Forza Horizon 4', editions: [E('ed-forza', 'std', 'Standard', 17, 13, 25)] },
        { id: 'rdr2x', name: 'Red Dead Redemption 2', editions: [E('ed-rdr2x', 'std', 'Standard', 18, 14, 26)] },
        { id: 'gears5', name: 'Gears 5', editions: [E('ed-gears5', 'std', 'Standard', 12, 9, 19)] },
        { id: 'seaofthieves', name: 'Sea of Thieves', editions: [E('ed-seaofthieves', 'std', 'Standard', 15, 11, 23)] },
        { id: 'oriwotw', name: 'Ori and the Will of the Wisps', editions: [E('ed-oriwotw', 'std', 'Standard', 23, 17, 31)] },
        { id: 'cuphead', name: 'Cuphead', editions: [E('ed-cuphead', 'std', 'Standard', 23, 17, 30)] },
        { id: 'sunset', name: 'Sunset Overdrive', editions: [E('ed-sunset', 'std', 'Standard', 13, 9, 21)] } ] } ];
    var conds = [ { id: 'sealed', name: 'Brand New (Sealed)', mult: 1.40, desc: 'Factory sealed, never opened', ineligible: false, icon: 'box' },
      { id: 'complete', name: 'Complete', mult: 1.00, desc: 'Case, cover art, inserts, and a clean disc or cart', ineligible: false, icon: 'gamecase' },
      { id: 'loose', name: 'Game Only (Loose)', mult: 0.60, desc: 'Disc or cart only — no case or artwork', ineligible: false, icon: 'disc' },
      { id: 'broken', name: 'Not Working / Counterfeit', mult: 0, desc: "Won't play, cracked, or a reproduction", ineligible: true, icon: 'xcircle' } ];
    var condById = {}; conds.forEach(function (c) { condById[c.id] = c; });
    var pricing = JSON.parse(JSON.stringify(DEFAULT_PRICING));

    function item(edId, condId, qty, pos) { var e = ed[edId], c = condById[condId]; var unit = marketValue(e, c); return { id: 'di-' + (seq++), title_name: titleOf(edId), platform_name: platOf(edId), edition_name: e.name, cond_name: c.name, claimed_cond_name: c.name, condition_id: condId, edition_id: edId, qty: qty, unit_market: unit, line_mid: Math.round(unit * qty), position: pos }; }
    function titleOf(edId) { var r = ''; platforms.forEach(function (p) { p.titles.forEach(function (t) { t.editions.forEach(function (e) { if (e.id === edId) r = t.name; }); }); }); return r; }
    function platOf(edId) { var r = ''; platforms.forEach(function (p) { p.titles.forEach(function (t) { t.editions.forEach(function (e) { if (e.id === edId) r = p.name; }); }); }); return r; }
    var seq = 1;
    function h(label, note, when) { return { label: label, note: note || null, created_at: when }; }

    function bulkFields(o) { return Object.assign({ bulk_status: null, bulk_reason: '', bulk_applied_at: null, bulk_decided_at: null, bulk_agreement_at: null, bulk_id_provided: false, lifetime_paid: 0 }, o || {}); }
    var profiles = [
      Object.assign({ id: 'staff-connor', full_name: 'Connor Waugaman', email: 'admin@getrestash.gg', phone: '', address: '', role: 'staff', flagged: false, created_at: days(120), account_notes: [] }, bulkFields()),
      // Maya is a long-tenured power seller — meets the bar, so signing in as
      // her demonstrates the customer "apply for Bulk Seller" happy path.
      Object.assign({ id: 'cust-maya', full_name: 'Maya Chen', email: 'maya.chen@email.com', phone: '(518) 555-0142', address: '203 Remsen St, Cohoes, NY 12047', role: 'customer', flagged: false, created_at: days(78), account_notes: [], referrals: [{ name: 'Alex P.', status: 'qualified', bonus: 10, date: days(21) }, { name: 'Sam R.', status: 'qualified', bonus: 10, date: days(9) }, { name: 'Jordan T.', status: 'joined', bonus: 0, date: days(3) }] }, bulkFields({ lifetime_paid: 63 })),
      Object.assign({ id: 'cust-devon', full_name: 'Devon Brooks', email: 'devon.brooks@email.com', phone: '(518) 555-0188', address: '88 Vliet Blvd, Cohoes, NY 12047', role: 'customer', flagged: false, created_at: days(9), account_notes: [] }, bulkFields()),
      Object.assign({ id: 'cust-noah', full_name: 'Noah Kim', email: 'noah.kim@email.com', phone: '(518) 555-0195', address: '31 Howard St, Cohoes, NY 12047', role: 'customer', flagged: true, created_at: days(11), account_notes: [{ body: 'Submitted a non-working copy described as Complete. Review future claims carefully.', author_name: 'Connor Waugaman', created_at: days(10) }] }, bulkFields()),
      // A pending application waiting in the console's Bulk Sellers queue.
      Object.assign({ id: 'cust-jordan', full_name: 'Jordan Vega', email: 'jordan.vega@email.com', phone: '(518) 555-0117', address: '12 Saratoga St, Cohoes, NY 12047', role: 'customer', flagged: false, created_at: days(72), account_notes: [] }, bulkFields({ lifetime_paid: 58, bulk_status: 'pending', bulk_applied_at: days(2), bulk_agreement_at: days(2), bulk_id_provided: true })),
      // An approved, active Bulk Seller (locked out of the standard flow).
      Object.assign({ id: 'cust-riley', full_name: 'Riley Park', email: 'riley.park@email.com', phone: '(518) 555-0163', address: '5 Ontario St, Cohoes, NY 12047', role: 'customer', flagged: false, created_at: days(112), account_notes: [] }, bulkFields({ lifetime_paid: 72, bulk_status: 'approved', bulk_applied_at: days(20), bulk_decided_at: days(18), bulk_agreement_at: days(20), bulk_id_provided: true })) ];
    var team = [
      { group_name: 'Founders', name: 'Connor Waugaman', role: 'Co-Founder & Operations', email: 'connor@getrestash.gg', location: 'Cohoes, NY', focus: ['Buyback pricing', 'Claim review', 'Payouts'], description: 'Runs Restash day to day — sets pricing, reviews edge-case claims, and signs off on every payout.', position: 1 },
      { group_name: 'Founders', name: 'Kamryn Washington', role: 'Co-Founder & Intake / Inspection', email: 'kamryn@getrestash.gg', location: 'Cohoes, NY', focus: ['Intake', 'Condition grading', 'Counterfeit checks'], description: 'Handles games on arrival — receives shipments, grades condition, and flags counterfeit or non-working copies.', position: 2 } ];

    function newClaim(ref, prof, items, status, extra) {
      var c = Object.assign({ id: 'dc-' + (seq++), ref: ref, customer_id: prof.id, cust_name: prof.full_name, cust_email: prof.email, cust_phone: prof.phone,
        payout: 'PayPal', address: '', est_low: 0, est_high: 0, status: status, offer_amount: null, customer_response: null, assignee_id: null, assignee_name: null,
        flagged: false, paid_amount: null, paid_method: null, created_at: days(6), claim_items: items, claim_history: [], claim_notes: [], claim_messages: [], customer_notes: '' }, extra || {});
      var offer = computeOffer(items, pricing); c.est_high = offer; c.est_low = Math.round(offer * 0.85);
      return c;
    }
    function bulkClaim(ref, prof, status, manifest, count, extra) {
      return Object.assign({ id: 'dc-' + (seq++), ref: ref, customer_id: prof.id, cust_name: prof.full_name, cust_email: prof.email, cust_phone: prof.phone,
        payout: 'PayPal', address: '', est_low: 0, est_high: 0, status: status, offer_amount: null, customer_response: null, assignee_id: null, assignee_name: null,
        flagged: false, paid_amount: null, paid_method: null, created_at: days(4), bulk: true, manifest: manifest, est_count: count,
        claim_items: [], claim_history: [], claim_notes: [], claim_messages: [], customer_notes: '' }, extra || {});
    }
    var claims = [
      // Riley (active Bulk Seller) — a lot arrived and is awaiting one bulk offer.
      bulkClaim('RS-BLK7Q2', profiles[5], 'received', '~30 PS2/PS3 games, mostly Complete, a few Loose sports titles. Two sealed. All tested working before packing.', 30, { assignee_id: 'staff-connor', assignee_name: 'Connor Waugaman', created_at: days(2), claim_history: [h('Bulk manifest submitted', '~30 games', days(2)), h('Accepted — prepaid label emailed', 'Priority intake; inspected on arrival.', days(2)), h('Games received at facility', 'Bulk lot — priority inspection.', days(1))] }),
      // Riley — a second lot in transit (label emailed, not yet arrived).
      bulkClaim('RS-BLK3X9', profiles[5], 'accepted', '~15 Nintendo Switch games, all Complete with cases and inserts.', 15, { created_at: days(1), claim_history: [h('Bulk manifest submitted', '~15 games', days(1)), h('Accepted — prepaid label emailed', 'Priority intake; inspected on arrival.', days(1))] }),
      newClaim('RS-8M4X2A', profiles[1], [item('ed-totk', 'complete', 1, 1)], 'submitted', { created_at: days(1), claim_history: [h('Claim submitted', null, days(1))] }),
      newClaim('RS-3K9P1B', profiles[2], [item('ed-gow', 'complete', 1, 1), item('ed-rdr2', 'loose', 2, 2)], 'received', { payout: 'Check', address: '88 Vliet Blvd, Cohoes, NY 12047', assignee_id: 'staff-connor', assignee_name: 'Connor Waugaman', customer_notes: 'The God of War case has a small crack on the back but the disc is mint. Both RDR2 copies are cart-only, no boxes.', created_at: days(3), claim_history: [h('Claim submitted', null, days(3)), h('Accepted — shipping label emailed', null, days(2)), h('Games received at facility', null, days(1))] }),
      newClaim('RS-2W8E4F', profiles[1], [item('ed-smash', 'sealed', 1, 1)], 'offer', { offer_amount: 28, created_at: days(5), claim_history: [h('Claim submitted', null, days(5)), h('Accepted — shipping label emailed', null, days(4)), h('Games received at facility', null, days(3)), h('Offer made: $28', 'Confirmed sealed; priced to current market.', days(2))], claim_messages: [{ author: 'customer', author_name: 'Maya Chen', body: 'Is $28 the best you can do? It came sealed and mint.', created_at: days(2) }, { author: 'staff', author_name: 'Connor Waugaman', body: 'Thanks Maya! $28 matches the current sealed market for this title, so it’s firm — but no pressure either way. Accept or decline whenever you’re ready and we’ll take it from there.', created_at: days(2) }] }),
      newClaim('RS-6N1R5G', profiles[2], [item('ed-forza', 'complete', 1, 1), item('ed-halo', 'complete', 1, 2)], 'paid', { offer_amount: 14, paid_amount: 14, paid_method: 'PayPal', created_at: days(12), claim_history: [h('Claim submitted', null, days(12)), h('Games received at facility', null, days(10)), h('Offer made: $14', null, days(9)), h('You accepted the offer', null, days(9)), h('Payment authorized via PayPal', 'PayPal 1–3 business days.', days(9))] }),
      newClaim('RS-1F2G3H', profiles[3], [item('ed-cuphead', 'complete', 1, 1)], 'received', { assignee_id: 'staff-connor', assignee_name: 'Connor Waugaman', created_at: days(2), claim_history: [h('Claim submitted', null, days(2)), h('Games received at facility', null, days(1))] }) ];

    function findClaim(ref) { return claims.filter(function (c) { return c.ref === ref; })[0]; }
    function findProfileById(id) { return profiles.filter(function (p) { return p.id === id; })[0]; }
    function findProfileByEmail(e) { return profiles.filter(function (p) { return p.email === e; })[0]; }
    function sessionProfile() { if (!demoApi._session) return null; return findProfileById(demoApi._session.id) || demoApi._session._prof; }
    function requireStaff() { var p = sessionProfile(); if (!p || p.role !== 'staff') throw new Error('Staff only'); return p; }
    function push(c, label, note) { c.claim_history.push(h(label, note, new Date().toISOString())); }
    function isStaffEmail(e) { e = (e || '').toLowerCase(); return /(^|[.@])(admin|staff|connor|kamryn)([.@])/.test(e) || e === 'admin@getrestash.gg' || /@getrestash\.gg$/.test(e); }
    function suggested(c) { return computeOffer(c.claim_items, pricing); }
    // Lifetime paid claims = seeded history (lifetime_paid) + live paid claims.
    function paidClaimsFor(prof) { var live = claims.filter(function (c) { return c.customer_id === prof.id && c.status === 'paid'; }).length; return (prof.lifetime_paid || 0) + live; }
    function bulkStatsFor(prof) { return bulkEligibility(paidClaimsFor(prof), daysSince(prof.created_at)); }

    var demoApi = {
      demo: true, _session: null,
      async currentUser() { return demoApi._session ? { id: demoApi._session.id, email: demoApi._session.email } : null; },
      onAuthChange: function () { return function () {}; },
      async signUp(o) {
        var prof = findProfileByEmail(o.email);
        if (!prof) { prof = Object.assign({ id: 'cust-' + (seq++), full_name: o.name || 'New User', email: o.email, phone: o.phone || '', address: '', role: 'customer', flagged: false, created_at: new Date().toISOString(), account_notes: [] }, bulkFields()); profiles.push(prof); }
        demoApi._session = { id: prof.id, email: prof.email, _prof: prof }; return { user: { id: prof.id } };
      },
      async signIn(o) {
        var prof = findProfileByEmail(o.email);
        if (!prof) { prof = Object.assign({ id: (isStaffEmail(o.email) ? 'staff-' : 'cust-') + (seq++), full_name: nameFromEmail(o.email), email: o.email, phone: '', address: '', role: isStaffEmail(o.email) ? 'staff' : 'customer', flagged: false, created_at: new Date().toISOString(), account_notes: [] }, bulkFields()); profiles.push(prof); }
        demoApi._session = { id: prof.id, email: prof.email, _prof: prof }; return { user: { id: prof.id } };
      },
      async signOut() { demoApi._session = null; },
      async updatePassword() { return {}; },
      async resetPassword() { return {}; },
      onPasswordRecovery: function (cb) { if (/(^|[#&?])recovery|type=recovery/.test(window.location.hash)) setTimeout(cb, 0); return function () {}; },
      async getProfile() { var p = sessionProfile(); return p ? JSON.parse(JSON.stringify(p)) : null; },
      async updateProfile(patch) { var p = sessionProfile(); if (!p) throw new Error('Not signed in'); if (patch.full_name != null) p.full_name = patch.full_name; if (patch.phone != null) p.phone = patch.phone; if (patch.address != null) p.address = patch.address; return JSON.parse(JSON.stringify(p)); },
      async requestDataExport() { var p = sessionProfile(); if (!p) throw new Error('Not signed in'); p.account_notes.push({ body: 'Customer requested a copy of their information.', author_name: 'System', created_at: new Date().toISOString() }); return { ok: true }; },
      async deleteAccount() { var p = sessionProfile(); if (!p) throw new Error('Not signed in'); for (var i = claims.length - 1; i >= 0; i--) { if (claims[i].customer_id === p.id) claims.splice(i, 1); } var idx = profiles.indexOf(p); if (idx >= 0) profiles.splice(idx, 1); demoApi._session = null; return { ok: true }; },
      async bulkApply(o) {
        var p = sessionProfile(); if (!p) throw new Error('Not signed in');
        if (p.bulk_status === 'pending') throw new Error('Your application is already under review.');
        if (p.bulk_status === 'approved') throw new Error('You are already an approved Bulk Seller.');
        if (p.bulk_status === 'suspended') throw new Error('Your Bulk Seller status is suspended — meet the monthly minimum to reinstate.');
        var s = bulkStatsFor(p);
        if (!s.eligible) throw new Error('You do not meet the Bulk Seller requirements yet.');
        if (!(o && o.agreement)) throw new Error('You must accept the Bulk Seller Agreement.');
        if (!(o && o.idProvided)) throw new Error('You must confirm you can provide a government ID.');
        var now = new Date().toISOString();
        p.bulk_status = 'pending'; p.bulk_applied_at = now; p.bulk_agreement_at = now; p.bulk_id_provided = true; p.bulk_reason = ''; p.bulk_decided_at = null;
        return { ok: true };
      },
      async closeBulkMembership() {
        var p = sessionProfile(); if (!p) throw new Error('Not signed in');
        if (p.bulk_status !== 'approved' && p.bulk_status !== 'suspended') throw new Error('Only an active Bulk Seller can close their membership.');
        p.bulk_status = 'closed';
        p.bulk_reason = 'Closed at your request — thank you for using Restash.';
        p.bulk_decided_at = new Date().toISOString();
        return { ok: true };
      },
      async listBulkSellers() { requireStaff(); return profiles.filter(function (p) { return !!p.bulk_status; }).map(function (p) { var a = mapAccount(p); a.bulk.paidClaims = paidClaimsFor(p); a.bulk.ageDays = daysSince(p.created_at); return a; }).sort(function (a, b) { return Date.parse(b.bulk.appliedAt || 0) - Date.parse(a.bulk.appliedAt || 0); }); },
      async decideBulkSeller(profileId, decision, reason) {
        requireStaff(); var p = findProfileById(profileId); if (!p) throw new Error('Account not found');
        var now = new Date().toISOString();
        if (decision === 'approve' || decision === 'reinstate') { p.bulk_status = 'approved'; p.bulk_reason = ''; }
        else if (decision === 'decline') { p.bulk_status = 'declined'; p.bulk_reason = (reason || '').trim(); }
        else if (decision === 'suspend') { p.bulk_status = 'suspended'; p.bulk_reason = (reason || '').trim(); }
        else if (decision === 'close') { p.bulk_status = 'closed'; p.bulk_reason = (reason || '').trim(); }
        else throw new Error('Unknown decision');
        p.bulk_decided_at = now;
        return { ok: true };
      },
      async getCatalog() { return { platforms: JSON.parse(JSON.stringify(platforms)), conditions: JSON.parse(JSON.stringify(conds)), pricing: JSON.parse(JSON.stringify(pricing)) }; },
      async conditions() { return JSON.parse(JSON.stringify(conds)); },
      async pricing() { return JSON.parse(JSON.stringify(pricing)); },
      async submitClaim(o) {
        var p = sessionProfile(); if (!p) throw new Error('Not signed in');
        var items = o.items.map(function (x, i) { return item(x.edition_id, x.condition_id, x.qty, i + 1); });
        var games = items.reduce(function (s, i) { return s + i.qty; }, 0);
        var offer = computeOffer(items, pricing);
        if (offer < pricing.min_quote && games < pricing.min_games) throw new Error('MIN_RULE: A claim needs an estimated offer of at least $' + pricing.min_quote + ' or at least ' + pricing.min_games + ' games.');
        var ref = 'RS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        var c = newClaim(ref, p, items, 'submitted', { payout: o.payout, address: o.address || '', cust_phone: o.phone || p.phone, customer_notes: (o.notes || '').trim(), created_at: new Date().toISOString(), claim_history: [h('Claim submitted', null, new Date().toISOString())] });
        if (o.phone) p.phone = o.phone; if (o.payout === 'Check' && o.address) p.address = o.address;
        claims.unshift(c); return ref;
      },
      // Active Bulk Seller: submit ONE manifest. Auto-accepted (prepaid label
      // emailed), priority intake — no per-item flow, no review gate.
      async submitBulkClaim(o) {
        var p = sessionProfile(); if (!p) throw new Error('Not signed in');
        if (p.bulk_status !== 'approved') throw new Error('Only active Bulk Sellers can submit a manifest.');
        var manifest = (o.manifest || '').trim();
        if (manifest.length < 10) throw new Error('Describe your lot in the manifest (at least a line).');
        var count = parseInt(o.estCount, 10); if (isNaN(count) || count < 1) count = null;
        if (count != null && count < BULK_RULES.min_per_shipment) throw new Error('Bulk shipments need at least ' + BULK_RULES.min_per_shipment + ' games.');
        if (o.payout === 'Check' && !(o.address || '').trim()) throw new Error('Add the mailing address for your check.');
        var ref = 'RS-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        var now = new Date().toISOString();
        var c = { id: 'dc-' + (seq++), ref: ref, customer_id: p.id, cust_name: p.full_name, cust_email: p.email, cust_phone: o.phone || p.phone,
          payout: o.payout || 'PayPal', address: o.address || '', est_low: 0, est_high: 0, status: 'accepted', offer_amount: null, customer_response: null,
          assignee_id: null, assignee_name: null, flagged: false, paid_amount: null, paid_method: null, created_at: now,
          bulk: true, manifest: manifest, est_count: count, claim_items: [], claim_notes: [], customer_notes: '',
          claim_history: [ h('Bulk manifest submitted', count ? '~' + count + ' games' : null, now), h('Accepted — prepaid label emailed', 'Priority intake; inspected on arrival.', now) ] };
        if (o.phone) p.phone = o.phone; if (o.payout === 'Check' && o.address) p.address = o.address;
        claims.unshift(c); return ref;
      },
      async myClaims() { var p = sessionProfile(); if (!p) return []; return claims.filter(function (c) { return c.customer_id === p.id; }).sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); }).map(mapClaimCustomer); },
      async claimByRef(ref) { var c = findClaim(ref); if (!c) throw new Error('Claim not found'); return mapClaimCustomer(c); },
      async respondToOffer(ref, r) { var c = findClaim(ref); if (!c) throw new Error('Claim not found'); var p = sessionProfile(); if (!p || c.customer_id !== p.id) throw new Error('Not your claim'); if (c.status !== 'offer') throw new Error('No open offer'); if (c.customer_response) throw new Error('You already responded'); c.customer_response = r; push(c, r === 'accepted' ? 'You accepted the offer' : 'You declined the offer', r === 'declined' ? "We'll return your games and email tracking." : null); },
      async sendClaimMessage(ref, body) { var p = sessionProfile(); if (!p) throw new Error('Not signed in'); var c = findClaim(ref); if (!c || c.customer_id !== p.id) throw new Error('Not your claim'); body = (body || '').trim(); if (!body) throw new Error('Write a message first.'); if (!c.claim_messages) c.claim_messages = []; c.claim_messages.push({ author: 'customer', author_name: p.full_name, body: body, created_at: new Date().toISOString() }); return { ok: true }; },
      async getReferral() {
        var p = sessionProfile(); if (!p) throw new Error('Not signed in');
        var refs = (p.referrals || []).slice().sort(function (a, b) { return Date.parse(b.date) - Date.parse(a.date); });
        var qualified = refs.filter(function (r) { return r.status === 'qualified'; });
        var earned = qualified.reduce(function (s, r) { return s + (r.bonus || 0); }, 0);
        var code = refCode(p);
        return { code: code, link: 'https://getrestash.gg/?ref=' + code, bonus: REFERRAL.bonus,
          joinedCount: refs.length, qualifiedCount: qualified.length, pendingCount: refs.length - qualified.length, earned: earned,
          referrals: refs.map(function (r) { return { name: r.name, status: r.status, bonus: r.bonus || 0, date: fmtDate(r.date) }; }) };
      },
      async allClaims() { requireStaff(); return claims.slice().sort(function (a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at); }).map(mapClaimStaff); },
      async staffClaimByRef(ref) { requireStaff(); var c = findClaim(ref); if (!c) throw new Error('Claim not found'); return mapClaimStaff(c); },
      async accounts() { requireStaff(); return profiles.filter(function (p) { return p.role === 'customer'; }).map(mapAccount); },
      async accountByEmail(e) { requireStaff(); var p = findProfileByEmail(e); if (!p) throw new Error('Account not found'); return mapAccount(p); },
      async team() { return team.map(mapTeam); },
      reviewClaim: sa(function (c) { st(c, 'submitted', 'reviewing', 'Under review'); }),
      acceptClaim: sa(function (c) { st(c, ['submitted', 'reviewing'], 'accepted', 'Accepted — shipping label emailed'); }),
      declineClaim: sa(function (c, x) { st(c, ['submitted', 'reviewing'], 'declined', 'Declined — not accepted', x || "We weren't able to accept this claim this cycle."); }),
      markReceived: sa(function (c) { st(c, 'accepted', 'received', 'Games received at facility'); }),
      regradeItem: function (itemId, condId) { return wrap(function () { requireStaff(); var c = claims.filter(function (cl) { return cl.claim_items.some(function (i) { return i.id === itemId; }); })[0]; if (!c) throw new Error('Item not found'); if (c.status !== 'received') throw new Error('Items can only be re-graded during inspection'); var it = c.claim_items.filter(function (i) { return i.id === itemId; })[0]; var e = ed[it.edition_id], cn = condById[condId]; if (!cn) throw new Error('Unknown condition'); var old = it.cond_name; it.condition_id = condId; it.cond_name = cn.name; it.unit_market = marketValue(e, cn); it.line_mid = Math.round(it.unit_market * it.qty); if (old !== cn.name) push(c, 'Re-graded ' + it.title_name + ': ' + old + ' → ' + cn.name, 'Condition confirmed on inspection.'); }); },
      makeOffer: function (ref, amt, x) { return wrap(function () { requireStaff(); var c = findClaim(ref); if (!c) throw new Error('Claim not found'); if (c.bulk) throw new Error('Use the bulk offer for a bulk claim'); if (c.status !== 'received') throw new Error('Can only offer on a received claim'); var s = suggested(c); if (s <= 0) throw new Error('This claim has no eligible value — reject and return it instead.'); var lo = Math.max(1, Math.floor(s * 0.85)), hi = Math.max(lo, Math.ceil(s * 1.15)); if (!amt || amt < lo || amt > hi) throw new Error('Offer must be between $' + lo + ' and $' + hi + ' for this claim (algorithm suggests $' + s + ')');
        c.status = 'offer'; c.offer_amount = amt; c.customer_response = null; push(c, 'Offer made: $' + amt, (x || '').trim() || null); }); },
      // One bulk offer for the whole lot — no per-item band (no items to price).
      makeBulkOffer: function (ref, amt, x) { return wrap(function () { requireStaff(); var c = findClaim(ref); if (!c) throw new Error('Claim not found'); if (!c.bulk) throw new Error('Not a bulk claim'); if (c.status !== 'received') throw new Error('Can only offer on a received claim'); amt = parseInt(amt, 10); if (!amt || amt < 1) throw new Error('Enter a bulk offer amount.'); c.status = 'offer'; c.offer_amount = amt; c.customer_response = null; push(c, 'Bulk offer made: $' + amt, (x || '').trim() || null); }); },
      rejectReturn: sa(function (c, x) { if (c.status !== 'received') throw new Error('Claim is not in inspection'); c.status = 'returned'; push(c, 'Rejected on inspection — returning to seller', (x || '').trim() || "We'll email tracking."); }),
      authorizePayment: sa(function (c) { if (c.status !== 'offer' || c.customer_response !== 'accepted') throw new Error('Customer has not accepted an offer'); c.status = 'paid'; c.paid_amount = c.offer_amount; c.paid_method = c.payout; push(c, 'Payment authorized via ' + c.payout, c.payout === 'PayPal' ? 'PayPal 1–3 business days.' : 'Check 3–5 business days.'); }),
      confirmReturn: sa(function (c) { if (c.status !== 'offer' || c.customer_response !== 'declined') throw new Error('No declined offer to return'); c.status = 'returned'; push(c, 'Games returned to seller', "We'll email tracking."); }),
      assignClaim: sa(function (c) { var p = requireStaff(); c.assignee_id = p.id; c.assignee_name = p.full_name; push(c, (p.full_name || 'A teammate') + ' is handling this claim'); }),
      releaseClaim: sa(function (c) { push(c, (c.assignee_name || 'A teammate') + ' released this claim'); c.assignee_id = null; c.assignee_name = null; }),
      setClaimFlag: function (ref, on) { return wrap(function () { requireStaff(); var c = findClaim(ref); c.flagged = on; }); },
      addClaimNote: function (ref, body) { return wrap(function () { var p = requireStaff(); if (!(body || '').trim()) throw new Error('Empty note'); var c = findClaim(ref); c.claim_notes.push({ body: body, author_name: p.full_name, created_at: new Date().toISOString() }); }); },
      sendStaffMessage: function (ref, body) { return wrap(function () { var p = requireStaff(); var c = findClaim(ref); if (!c) throw new Error('Claim not found'); if (!(body || '').trim()) throw new Error('Write a message first.'); if (!c.claim_messages) c.claim_messages = []; c.claim_messages.push({ author: 'staff', author_name: p.full_name, body: body.trim(), created_at: new Date().toISOString() }); }); },
      setAccountFlag: function (id, on) { return wrap(function () { requireStaff(); var p = findProfileById(id); if (p) p.flagged = on; }); },
      addAccountNote: function (id, body) { return wrap(function () { var me = requireStaff(); if (!(body || '').trim()) throw new Error('Empty note'); var p = findProfileById(id); p.account_notes.push({ body: body, author_name: me.full_name, created_at: new Date().toISOString() }); }); }
    };
    function nameFromEmail(e) { var s = (e || '').split('@')[0].replace(/[._]+/g, ' '); return s.replace(/\b\w/g, function (m) { return m.toUpperCase(); }) || 'User'; }
    function wrap(fn) { return new Promise(function (res, rej) { try { res(fn()); } catch (e) { rej(e); } }); }
    function sa(fn) { return function (ref, x) { return wrap(function () { requireStaff(); var c = findClaim(ref); if (!c) throw new Error('Claim not found'); fn(c, x); }); }; }
    function st(c, from, to, label, note) { var ok = Array.isArray(from) ? from.indexOf(c.status) !== -1 : c.status === from; if (!ok) throw new Error('Invalid status transition'); c.status = to; push(c, label, note || null); }
    return demoApi;
  })();

  // =================================================================
  var API = sb ? supa : demo;
  API.configured = true;     // demo fallback means the app always runs
  API.client = function () { return sb; };
  API.fmtDate = fmtDate;
  API.computeOffer = computeOffer;
  API.marketValue = marketValue;
  API.marginFor = marginFor;
  API.DEFAULT_PRICING = DEFAULT_PRICING;
  API.BULK = BULK_RULES;
  API.BULK_LINE = BULK_LINE;
  API.BULK_STATUSES = BULK_STATUSES;
  API.bulkEligibility = bulkEligibility;
  API.daysSince = daysSince;
  API.REFERRAL = REFERRAL;
  window.RestashAPI = API;
})();
