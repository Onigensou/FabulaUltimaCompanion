/**
 * Utility macro: seed passive_rules onto sample items via item flags.
 * Run as GM once to attach rules to items in the world compendium/actor inventory.
 */
(async () => {
  const TAG='[PassiveRulesSetup]';
  const targetNames = [
    { name: 'Ice Mastery (Test)', rules: [{ id:'ice-mastery-flat', label:'Ice Mastery', when:{ all:[{ action:{ elementIn:['ice'] } }] }, effects:[{ type:'flat', scope:'outgoing', element:'ice', amount:9999 }] }] },
    { name: 'Cognitive Focus', rules: [{ id:'focus-outgoing-bonus', label:'Cognitive Focus', when:{ all:[{ actor:{ flagEquals:{ ns:'oni', key:'focus.active', equals:true } } }] }, effects:[{ type:'percent', scope:'outgoing', element:'all', amount:0.25 }], options:{ recalcOnConfirm:'ifElementUnknown' } }] },
    { name: 'Hypercognition', rules: [{ id:'hyper-crit-ramp', label:'Hypercognition', when:{ all:[{ actor:{ flagCompare:{ ns:'oni', key:'focus.stacks', op:">=", value:3 } } }] }, effects:[{ type:'critMult', amount:1.5 }, { type:'flat', scope:'outgoing', element:'ice', amount:250 }] }] }
  ];

  const updates = [];
  for (const {name, rules} of targetNames) {
    // search among all actors' items on the canvas scene; extend as needed
    let found = null;
    for (const a of game.actors) {
      found = a.items.find(i => i.name === name);
      if (found) { await found.setFlag('oni','passive_rules', rules); console.log(TAG,'set rules on', name, 'owner', a.name); break; }
    }
    if (!found) console.warn(TAG, 'Item not found:', name);
  }
  ui.notifications.info('Passive rules seeding attempted; check console for details.');
})();
