// Passive Modifier Engine (Foundry V12)
// Exposes: FUCompanion.api.passiveModifier.evaluatePassiveModifiers({ actor, actionCtx, finalElement? })
(function(){
  const ROOT = (globalThis.FUCompanion = globalThis.FUCompanion || {});
  ROOT.api = ROOT.api || {};
  const TAG = '[ONI][PassiveModifierEngine]';
  const DEBUG = true;

  function log(...a){ if (DEBUG) console.log(TAG, ...a); }
  function warn(...a){ if (DEBUG) console.warn(TAG, ...a); }

  const ELEMENTS = new Set(['all','elementless','physical','air','bolt','dark','earth','fire','ice','light','poison']);
  function normEl(v){ const s = String(v ?? '').trim().toLowerCase(); return ELEMENTS.has(s) ? s : (s ? s : ''); }
  function normSkillType(v){ const s = String(v ?? '').trim().toLowerCase(); return s; }

  function readActorProps(actor){ return actor?.system?.props ?? actor?.system ?? {}; }

  function getFlagDotted(actor, ns, key){
    try {
      if (!actor || !ns || !key) return undefined;
      const root = actor.getFlag?.(ns, key.split('.')[0]);
      if (key.indexOf('.') < 0) return root;
      const parts = key.split('.');
      let cur = actor.getFlag?.(ns, parts[0]);
      for (let i=1;i<parts.length;i++) { if (cur == null) return undefined; cur = cur?.[parts[i]]; }
      return cur;
    } catch (e) { return undefined; }
  }

  function toNumber(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }

  function buildCtx(actor, actionCtx, finalElement){
    const a = actionCtx || {};
    const core = a.core || a.dataCore || {};
    const meta = a.meta || {};
    const adv  = a.advPayload || a.adv || {};

    const elementCandidates = [ finalElement, meta.elementType, adv.elementType, core.elementType, a.elementType ];
    const elementType = normEl(elementCandidates.find(s => typeof s === 'string' && s.length) || '');

    const skillTypeRaw = core.skillTypeRaw ?? meta.skillTypeRaw ?? a.skillTypeRaw ?? '';
    const skillTypeNorm = normSkillType(skillTypeRaw);
    const isSpellish = !!(a?.dataCore?.isSpell || meta?.isSpellish || a?.isSpell || String(skillTypeNorm)==='spell');

    const isCrit = !!(a?.accuracy?.isCrit || adv?.isCrit || meta?.isCrit);
    const valueType = String(adv?.valueType || a?.valueType || meta?.valueType || 'hp');

    return { action: { elementType, skillTypeRaw, skillTypeNorm, isSpellish, isCrit, valueType }, actor: { flags: true, props: readActorProps(actor) } };
  }

  function evalPredicate(node, ctx, actor){
    if (!node || typeof node !== 'object') return true;
    // composite
    if (Array.isArray(node.all)) { if (!node.all.every(n => evalPredicate(n, ctx, actor))) return false; }
    if (Array.isArray(node.any)) { if (!node.any.some(n => evalPredicate(n, ctx, actor))) return false; }
    if (Array.isArray(node.none)) { if (node.none.some(n => evalPredicate(n, ctx, actor))) return false; }

    // leaf: action
    const a = node.action || {};
    if (a.elementIn) {
      const arr = Array.isArray(a.elementIn) ? a.elementIn.map(normEl) : [];
      if (arr.length){
        const el = ctx.action.elementType || '';
        if (!(arr.includes('all') || (el && arr.includes(el)))) return false;
      }
    }
    if (a.skillTypeIn) {
      const arr = Array.isArray(a.skillTypeIn) ? a.skillTypeIn.map(normSkillType) : [];
      if (arr.length) { if (!arr.includes(ctx.action.skillTypeNorm)) return false; }
    }
    if (typeof a.isSpellish === 'boolean') { if (ctx.action.isSpellish !== a.isSpellish) return false; }
    if (typeof a.isCrit === 'boolean') { if (ctx.action.isCrit !== a.isCrit) return false; }

    // leaf: actor
    const act = node.actor || {};
    if (act.flagEquals) {
      const { ns, key, equals } = act.flagEquals; const v = getFlagDotted(actor, ns, key);
      if (v !== equals) return false;
    }
    if (act.flagCompare) {
      const { ns, key, op, value } = act.flagCompare; const v = toNumber(getFlagDotted(actor, ns, key), NaN); const t = toNumber(value, NaN);
      switch (op) {
        case '>':  if (!(v >  t)) return false; break;
        case '>=': if (!(v >= t)) return false; break;
        case '<':  if (!(v <  t)) return false; break;
        case '<=': if (!(v <= t)) return false; break;
        case '==': if (!(v == t)) return false; break;
        case '!=': if (!(v != t)) return false; break;
        default: return false;
      }
    }
    if (act.propCompare) {
      const { key, op, value } = act.propCompare; const props = readActorProps(actor); const v = toNumber(props?.[key], NaN); const t = toNumber(value, NaN);
      switch (op) {
        case '>':  if (!(v >  t)) return false; break;
        case '>=': if (!(v >= t)) return false; break;
        case '<':  if (!(v <  t)) return false; break;
        case '<=': if (!(v <= t)) return false; break;
        case '==': if (!(v == t)) return false; break;
        case '!=': if (!(v != t)) return false; break;
        default: return false;
      }
    }
    return true;
  }

  function addTo(map, key, amt){ if (!key) return; const k = normEl(key) || 'all'; map[k] = (map[k] || 0) + toNumber(amt, 0); }

  async function evaluatePassiveModifiers({ actor, actionCtx, finalElement = null } = {}){
    if (!actor) return { flatByElement:{}, pctByElement:{}, critFlat:0, critMult:1, breakdown:[], usedRules:[], options:{ recalcOnConfirm:'never' } };
    const props = readActorProps(actor);
    const items = Array.from(actor.items ?? []);
    const ctx = buildCtx(actor, actionCtx, finalElement);

    const out = { flatByElement:{}, pctByElement:{}, critFlat:0, critMult:1, breakdown:[], usedRules:[], options:{ recalcOnConfirm:'never' } };

    function bumpRecalc(policy){
      const order = { 'never':0, 'ifElementUnknown':1, 'always':2 };
      const cur = out.options.recalcOnConfirm || 'never';
      out.options.recalcOnConfirm = (order[policy] > order[cur]) ? policy : cur;
    }

    for (const it of items){
      const ip = it?.system?.props ?? it?.system ?? {};
      const flagRules = (typeof it.getFlag === "function") ? (it.getFlag("oni","passive_rules") ?? null) : null; const rules = Array.isArray(ip.passive_rules) ? ip.passive_rules : (Array.isArray(flagRules) ? flagRules : []);
      if (!rules.length) continue;
      for (const rule of rules){
        try {
          const rId = String(rule?.id ?? `${it.id || it.name}-rule-${out.usedRules.length}`);
          const label = String(rule?.label ?? it?.name ?? rId);
          const when = rule?.when ?? {};
          const ok = evalPredicate(when, ctx, actor);
          if (!ok) continue;
          const effects = Array.isArray(rule?.effects) ? rule.effects : [];
          const opts = rule?.options || {};
          if (opts?.recalcOnConfirm) bumpRecalc(String(opts.recalcOnConfirm));

          for (const eff of effects){
            const type = String(eff?.type || '').toLowerCase();
            if (type === 'flat') {
              const el = normEl(eff?.element || 'all');
              addTo(out.flatByElement, el || 'all', eff?.amount || 0);
              out.breakdown.push({ source: label, type:'flat', element: el || 'all', amount: toNumber(eff?.amount || 0), why: 'rule:flat' });
            } else if (type === 'percent') {
              const el = normEl(eff?.element || 'all');
              addTo(out.pctByElement, el || 'all', eff?.amount || 0);
              out.breakdown.push({ source: label, type:'percent', element: el || 'all', amount: toNumber(eff?.amount || 0), why: 'rule:percent' });
            } else if (type === 'critflat') {
              out.critFlat += toNumber(eff?.amount || 0);
              out.breakdown.push({ source: label, type:'critFlat', amount: toNumber(eff?.amount || 0), why: 'rule:critFlat' });
            } else if (type === 'critmult') {
              const m = toNumber(eff?.amount || 1, 1);
              out.critMult *= (m > 0 ? m : 1);
              out.breakdown.push({ source: label, type:'critMult', amount: m, why: 'rule:critMult' });
            }
          }
          out.usedRules.push(rId);
        } catch (e) {
          warn('rule error', e);
        }
      }
    }

    log('evaluate done', { element: ctx.action.elementType, flat: out.flatByElement, pct: out.pctByElement, crit: { flat: out.critFlat, mult: out.critMult }, used: out.usedRules.length });
    return out;
  }

  ROOT.api.passiveModifier = { evaluatePassiveModifiers };
  log('Installed');
})();


