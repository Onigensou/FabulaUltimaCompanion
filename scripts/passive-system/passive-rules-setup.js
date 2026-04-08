/**
 * Utility macro: seed custom_logic_passive onto sample items via item flags.
 * Run as GM once to attach rules to items in the world/actors.
 */
(async () => {
  const TAG='[CustomLogicPassiveSetup]';
  const wants = [
    { keys: ['Ice Mastery (Test)','Ice Mastery'], rules: [{ id:'ice-mastery-flat', label:'Ice Mastery', when:{ all:[{ action:{ elementIn:['ice'] } }] }, effects:[{ type:'flat', scope:'outgoing', element:'ice', amount:9999 }] }] },
    { keys: ['Cognitive Focus'], rules: [{ id:'focus-outgoing-bonus', label:'Cognitive Focus', when:{ all:[{ actor:{ flagEquals:{ ns:'oni', key:'focus.active', equals:true } } }] }, effects:[{ type:'percent', scope:'outgoing', element:'all', amount:0.25 }], options:{ recalcOnConfirm:'ifElementUnknown' } }] },
    { keys: ['Hypercognition'], rules: [{ id:'hyper-crit-ramp', label:'Hypercognition', when:{ all:[{ actor:{ flagCompare:{ ns:'oni', key:'focus.stacks', op:">=", value:3 } } }] }, effects:[{ type:'critMult', amount:1.5 }, { type:'flat', scope:'outgoing', element:'ice', amount:250 }] }] }
  ];

  function byKeysMatch(items, keys){
    const lower = keys.map(k => String(k).toLowerCase());
    const exactFirst = items.find(i => lower.includes(String(i.name).toLowerCase()));
    if (exactFirst) return [exactFirst];
    // fallback: substring match
    const sub = items.filter(i => lower.some(k => String(i.name).toLowerCase().includes(k)));
    return sub;
  }

  const seeded = [];
  for (const want of wants){
    // search in world Items
    const worldHits = byKeysMatch(game.items ?? [], want.keys);
   for (const it of worldHits){ await it.setFlag('world','custom_logic_passive', want.rules); console.log(TAG,'set rules on World Item', it.name); seeded.push(it.name); }
    // search across actors' embedded items
    for (const a of game.actors ?? []){
      const hits = byKeysMatch(a.items ?? [], want.keys);
      for (const it of hits){ await it.setFlag('world','custom_logic_passive', want.rules); console.log(TAG,'set rules on', it.name, 'owner', a.name); seeded.push(it.name+"@"+a.name); }
    }
  }

  ui.notifications.info(`Custom logic passive seeding complete. Seeded: ${seeded.length}`);
})();
