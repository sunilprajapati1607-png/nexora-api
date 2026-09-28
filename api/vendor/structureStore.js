/**
 * Nexora — Bag Construction ("Structure") Master Store
 * Lets the user create, edit, duplicate and delete bag constructions from
 * inside the app (the "Structure window" — no code changes needed to add
 * a new bag type). Each structure is a set of ON/OFF flags — tick a field
 * ON and it appears in the Calculation window for that construction; tick
 * it OFF and it's hidden. This is the same STRUCTURE-master mechanism the
 * legacy system used, just made editable in a real UI instead of an
 * AppSheet table.
 *
 * Seed data (constructions.js, 29 real production types) is never mutated
 * on disk — user edits are stored as overrides/additions in localStorage
 * and merged on top at read time, so "Reset to factory" is always
 * possible per construction.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexoraStructureStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'nexora.structures.v1';

  // Two behaviour-only flags the calculation engine reads directly (not
  // tied to a visible input field, so they don't come from fieldDefs.js).
  const BEHAVIOR_FLAGS = [
    { key: 'YARN WT', label: 'Use default yarn weight (top/bottom stitching)' },
    { key: 'CTN YARN WT', label: 'Use default cotton yarn weight (easy-open)' }
  ];

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : { overrides: {}, deleted: [] };
    } catch (e) {
      return { overrides: {}, deleted: [] };
    }
  }
  function persist(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  /* 4.44.1 — A CONSTRUCTION HAS ONE NAME, WHATEVER CASE IT IS TYPED IN.

     Found on a real installation: a construction stored as
     "1L Stitch Bag" sat beside the seed "1L STITCH BAG", and every
     lookup here compared names with ===. Three things followed, and all
     three were on the owner's screen at once:

       · the picker showed the same construction TWICE, the two
         indistinguishable because both are displayed properCase'd;
       · isSeed() said the mis-cased one was not a seed, so the editor
         offered no "Reset to factory" — a construction whose fields had
         been unticked could not be put back, and the calculation window
         for it drew no sections, no Quick Calculations and no result;
       · and the duplicate check let the fork be created in the first
         place, because "1L Stitch Bag" !== "1L STITCH BAG".

     So every name is compared by its KEY — trimmed and upper-cased —
     while the name itself is stored exactly as the plant typed it. An
     override that matches a seed is folded ONTO that seed rather than
     added beside it, and saving under a seed's name in another case
     writes under the seed's own spelling, which quietly heals a fork
     the next time that construction is saved.

     Nothing about a construction's CONTENT changes here. A record whose
     flags were turned off still has them off — it is simply reachable,
     listed once, and resettable again. */
  function key(name) { return String(name == null ? '' : name).trim().toUpperCase(); }

  function seedList() {
    return (typeof NexoraConstructions !== 'undefined') ? NexoraConstructions.CONSTRUCTIONS : [];
  }

  /* 4.45.0 — THE DELIVERED FIELDS ARE THE FLOOR.

       "1l stitch bag some structure are not available thats why
        calculation window is not sawing technical filed and disturbed
        calculation window so restore those data from old version of
        structure in new version"

     4.44.1 made a mis-cased fork reachable and resettable, and said
     plainly that it changed nothing a construction CONTAINED. On the
     owner's machine that was not enough: the record's flags were still
     off, and a calculation window with its Width and Length unticked
     draws nothing at all. Nobody had reset it, because nobody knew that
     was the fault.

     So the delivered flags are read back as a floor, every time. A
     delivered construction shows at least the fields it was delivered
     with; an override can add a field, never take one away. The plant
     that wants a thinner variant duplicates the construction, which is
     what Duplicate has been for since 0.3.0. And a delivered construction
     is never absent: a "deleted" entry against a seed is simply ignored,
     which is what puts the missing ones back. */
  function floor(seed, over) {
    const out = JSON.parse(JSON.stringify(over));
    out.name = seed.name;                       /* the delivered spelling, always */
    out.fields = out.fields || {};
    Object.keys(seed.fields || {}).forEach((f) => { if (seed.fields[f]) out.fields[f] = true; });
    return out;
  }

  /** The fields a delivered construction always shows — locked in the editor. */
  function deliveredOn(name) {
    const k = key(name);
    const c = seedList().find((x) => key(x.name) === k);
    const out = {};
    if (!c) return out;
    Object.keys(c.fields || {}).forEach((f) => { if (c.fields[f]) out[f] = true; });
    return out;
  }

  function getAll() {
    const seed = seedList();
    const data = load();
    const gone = {};
    (data.deleted || []).forEach((n) => { gone[key(n)] = 1; });
    /* Keyed by the upper-cased name so a mis-cased override lands on the
       seed it is an override OF, rather than beside it. */
    const byKey = {};
    Object.keys(data.overrides).forEach((n) => { byKey[key(n)] = data.overrides[n]; });
    const map = {};
    seed.forEach((c) => {
      const k = key(c.name);
      /* 4.45.0 — never gone, never thinner than delivered (see floor). */
      map[k] = byKey[k] ? floor(c, byKey[k]) : c;
    });
    Object.keys(byKey).forEach((k) => {
      if (!gone[k] && !map[k]) map[k] = byKey[k];
    });
    return Object.keys(map).sort().map((k) => map[k]);
  }

  function get(name) {
    const k = key(name);
    return getAll().find((c) => key(c.name) === k) || null;
  }

  function isSeed(name) {
    const k = key(name);
    return !!seedList().find((c) => key(c.name) === k);
  }

  /** The seed's own spelling of a name, when there is one. */
  function seedNameOf(name) {
    const k = key(name);
    const c = seedList().find((x) => key(x.name) === k);
    return c ? c.name : null;
  }

  function isCustom(name) {
    return !isSeed(name);
  }

  function isModified(name) {
    const data = load();
    const k = key(name);
    return Object.keys(data.overrides).some((n) => key(n) === k);
  }

  /** Create a blank structure template (all flags off) to start "+ New Structure" from. */
  function blank(name) {
    const fields = {};
    (typeof NexoraFieldDefs !== 'undefined' ? NexoraFieldDefs.FIELDS : []).forEach((f) => {
      if (f.flagKey) fields[f.flagKey] = false;
    });
    BEHAVIOR_FLAGS.forEach((b) => { fields[b.key] = false; });
    fields['TARGET WEIGHT'] = true;
    fields['RESULT WEIGHT'] = true;
    return { name: name || '', description: '', scope: '', status: 'ACTIVE', fields };
  }

  /**
   * Save a structure. `previousName` lets the editor rename a construction
   * (delete the old key, write the new one) — pass the same name as
   * `construction.name` when not renaming.
   */
  function save(construction, previousName) {
    const data = load();
    /* 4.45.0 — a delivered construction keeps its name. Renaming one
       used to retire the seed under the old name and create a custom
       record under the new, which is a delete by another door. */
    if (previousName && isSeed(previousName)) construction.name = seedNameOf(previousName);
    if (previousName && key(previousName) !== key(construction.name)) {
      Object.keys(data.overrides).forEach((n) => {
        if (key(n) === key(previousName)) delete data.overrides[n];
      });
      if (isSeed(previousName) && !data.deleted.some((n) => key(n) === key(previousName))) {
        data.deleted.push(previousName);
      }
    }
    /* A name that matches a seed is stored under the SEED’s spelling, so
       one construction can never become two because of a capital. */
    const seeded = seedNameOf(construction.name);
    if (seeded) construction.name = seeded;
    /* and any earlier mis-cased key for the same construction goes with
       it, which is what heals an installation that already has a fork. */
    Object.keys(data.overrides).forEach((n) => {
      if (key(n) === key(construction.name)) delete data.overrides[n];
    });
    data.overrides[construction.name] = construction;
    data.deleted = (data.deleted || []).filter((n) => key(n) !== key(construction.name));
    persist(data);
    return construction;
  }

  function duplicate(name, newName) {
    const src = get(name);
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.name = newName;
    copy.status = 'ACTIVE';
    return save(copy);
  }

  function remove(name) {
    /* 4.45.0 — delivered constructions cannot be removed, and the
       Structure Master no longer offers to remove anything: a structure
       is added and edited, never deleted. Kept for restore and for
       tests; refuses a seed. */
    if (isSeed(name)) return false;
    const data = load();
    const k = key(name);
    Object.keys(data.overrides).forEach((n) => { if (key(n) === k) delete data.overrides[n]; });
    if (!data.deleted.some((n) => key(n) === k)) data.deleted.push(name);
    persist(data);
    return true;
  }

  /** Put a construction back exactly as it was delivered. Every
   *  spelling of its name goes, so a fork is swept up with it. */
  function resetToSeed(name) {
    const data = load();
    const k = key(name);
    Object.keys(data.overrides).forEach((n) => { if (key(n) === k) delete data.overrides[n]; });
    data.deleted = (data.deleted || []).filter((n) => key(n) !== k);
    persist(data);
  }

  return { getAll, get, isSeed, isCustom, isModified, blank, save, duplicate, remove, resetToSeed, seedNameOf, deliveredOn, key, BEHAVIOR_FLAGS };
});
