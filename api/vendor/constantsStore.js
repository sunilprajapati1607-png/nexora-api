/**
 * Nexora — Technical Constants Store
 * Seeded from the recovered legacy DEFAULT master (constants.js), editable
 * by the user at runtime, persisted locally. Every calculation reads the
 * CURRENT value at calculate-time (never hardcoded into the formula),
 * matching spec §29's "editable, versioned, auditable" requirement.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NexoraConstantsStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const KEY = 'nexora.constants.v1';
  const CUSTOM_KEY = 'nexora.constants.custom.v1';
  const LINKS_KEY = 'nexora.constants.links.v1';

  function loadOverrides() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveOverrides(overrides) {
    try { localStorage.setItem(KEY, JSON.stringify(overrides)); } catch (e) { /* ignore */ }
  }

  // ---- User-added ("custom") constants — sit alongside the recovered
  // legacy seed list, editable and deletable, grouped like any other. ----
  function loadCustom() {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveCustom(list) {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function addCustom(constant) {
    const list = loadCustom();
    if (list.find((c) => c.description === constant.description)) {
      throw new Error('A constant named "' + constant.description + '" already exists.');
    }
    list.push({
      description: constant.description,
      value: Number(constant.value) || 0,
      unit: constant.unit || '',
      group: constant.group || 'CUSTOM',
      custom: true
    });
    saveCustom(list);
  }
  function removeCustom(description) {
    saveCustom(loadCustom().filter((c) => c.description !== description));
    const links = loadLinks();
    delete links[description];
    saveLinks(links);
  }
  function isCustom(description) {
    return !!loadCustom().find((c) => c.description === description);
  }

  // ---- Field <-> constant links — set from the Constants Master ("Link to
  // field(s)"), consumed by the calculation window so a linked field's
  // blank value is filled from the constant's current value at calc time,
  // not just shown as a placeholder. ----
  function loadLinks() {
    try {
      const raw = localStorage.getItem(LINKS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }
  function saveLinks(links) { try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch (e) { /* ignore */ } }

  /** fieldKeys linked to this constant description. */
  function getLinkedFields(description) { return loadLinks()[description] || []; }
  function setLinkedFields(description, fieldKeys) {
    const links = loadLinks();
    if (fieldKeys && fieldKeys.length) links[description] = fieldKeys;
    else delete links[description];
    saveLinks(links);
  }
  /** Reverse lookup used by the calculation form: fieldKey -> constant description (or null). */
  function getLinkForField(fieldKey) {
    const links = loadLinks();
    for (const desc of Object.keys(links)) {
      if (links[desc].indexOf(fieldKey) > -1) return desc;
    }
    return null;
  }

  function getAll(seedList) {
    const overrides = loadOverrides();
    const seeded = seedList.map((c) => Object.assign({}, c, {
      value: overrides[c.description] !== undefined ? overrides[c.description] : c.value,
      isOverridden: overrides[c.description] !== undefined,
      custom: false
    }));
    const custom = loadCustom().map((c) => Object.assign({}, c, {
      value: overrides[c.description] !== undefined ? overrides[c.description] : c.value,
      isOverridden: overrides[c.description] !== undefined,
      custom: true
    }));
    return seeded.concat(custom);
  }

  function getLookup(seedList) {
    const list = getAll(seedList);
    const map = {};
    list.forEach((c) => { map[c.description] = c.value; });
    return map;
  }

  function setValue(description, value) {
    const overrides = loadOverrides();
    overrides[description] = value;
    saveOverrides(overrides);
  }

  function reset(description) {
    const overrides = loadOverrides();
    delete overrides[description];
    saveOverrides(overrides);
  }

  return {
    getAll, getLookup, setValue, reset,
    addCustom, removeCustom, isCustom,
    getLinkedFields, setLinkedFields, getLinkForField
  };
});
